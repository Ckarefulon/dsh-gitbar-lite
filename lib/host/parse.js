/**
 * Parsers for the two git outputs this plugin reads.
 *
 * Both are pure: no `ctx`, no filesystem, no clock. That is deliberate — the
 * status parser is the single place where a wrong assumption turns into a
 * plausible-looking but wrong file list, and `test/status.test.mjs` pins it
 * against bytes captured from real repositories (including a rename, a staged
 * delete, an intent-to-add, a non-ASCII path, and a conflicted index).
 *
 * Format reference (all read from `git status --porcelain=v2 --branch -z` with
 * `core.quotepath=false`):
 *
 *   # branch.oid <oid>|(initial)
 *   # branch.head <name>|(detached)
 *   # branch.upstream <name>            (only when an upstream is configured)
 *   # branch.ab +<ahead> -<behind>      (only when an upstream is configured)
 *   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
 *   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
 *   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
 *   ? <path>
 *   ! <path>
 *
 * With `-z` every record is NUL-terminated and paths are raw bytes, never
 * quoted — which is why the parsers split on NUL and then count *fields* from
 * the left instead of splitting on spaces: a path may contain spaces, and with
 * `-z` git gives us no quoting to lean on.
 *
 * @module dsh-lite-git/host/parse
 */

import { FILE_STATUS } from '../shared.js'

/** Split a `-z` stream into records, dropping the trailing empty field. */
function splitNul(raw) {
  const text = typeof raw === 'string' ? raw : ''
  if (text === '') return []
  const fields = text.split('\0')
  if (fields.length > 0 && fields[fields.length - 1] === '') fields.pop()
  return fields
}

/**
 * Peel `count` space-separated tokens off the front of `text`.
 *
 * @returns {{ tokens: string[], rest: string }} `rest` is everything after the
 *   last token, verbatim (so it may be empty, and may itself contain spaces).
 */
function takeTokens(text, count) {
  const tokens = []
  let rest = text
  for (let index = 0; index < count; index += 1) {
    const space = rest.indexOf(' ')
    if (space < 0) return { tokens, rest: '' }
    tokens.push(rest.slice(0, space))
    rest = rest.slice(space + 1)
  }
  return { tokens, rest }
}

/**
 * Bucket one `XY` pair into the status the UI shows.
 *
 * `U` anywhere, and the `AA`/`DD` both-added/both-deleted pairs, are conflicts:
 * git reports those on `u` records, but the same letters can appear on an
 * ordinary record once a merge has left the index dirty, so both are checked.
 *
 * @param {string} type record tag: `1`, `2`, `u`, `?` or `!`
 * @param {string} index the `X` (index) status character
 * @param {string} worktree the `Y` (worktree) status character
 */
export function classify(type, index, worktree) {
  if (type === '?') return FILE_STATUS.UNTRACKED
  const conflicted =
    type === 'u' ||
    index === 'U' ||
    worktree === 'U' ||
    (index === 'A' && worktree === 'A') ||
    (index === 'D' && worktree === 'D')
  if (conflicted) return FILE_STATUS.CONFLICTED
  if (index === 'R' || index === 'C') return FILE_STATUS.RENAMED
  if (index === 'A') return FILE_STATUS.ADDED
  if (index === 'D' || worktree === 'D') return FILE_STATUS.DELETED
  return FILE_STATUS.MODIFIED
}

/** Build the normalized file entry both halves speak about. */
function makeEntry({ type, xy, path, origPath }) {
  const index = xy.slice(0, 1)
  const worktree = xy.slice(1, 2)
  const kind = classify(type, index, worktree)
  const untracked = type === '?'
  const ignored = type === '!'
  return {
    /** Repository-relative path, git's own spelling (forward slashes). */
    path,
    /** Present only for a rename/copy: the path it came from. */
    ...(origPath === undefined ? {} : { origPath }),
    index,
    worktree,
    kind,
    untracked,
    ignored,
    conflicted: kind === FILE_STATUS.CONFLICTED,
    /**
     * Whether *all* of this file's change is in the index.
     *
     * This is what the client's tick box mirrors: a ticked file is fully
     * staged, so `git commit` (plain, no pathspec) commits exactly the ticked
     * set. An untracked file is by definition not staged.
     */
    staged: !untracked && !ignored && index !== '.',
    /** Both sides dirty — the tick box renders as indeterminate. */
    partial: !untracked && !ignored && index !== '.' && worktree !== '.',
  }
}

/**
 * Parse `git status --porcelain=v2 --branch -z`.
 *
 * @param {string} raw the command's stdout
 * @returns {{
 *   branch: {
 *     oid: string | null, head: string | null, upstream: string | null,
 *     ahead: number, behind: number, detached: boolean, unborn: boolean,
 *   },
 *   files: ReturnType<typeof makeEntry>[],
 * }}
 */
export function parseStatus(raw) {
  const branch = {
    oid: null,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
    unborn: false,
  }
  const files = []
  const fields = splitNul(raw)

  for (let cursor = 0; cursor < fields.length; cursor += 1) {
    const field = fields[cursor]
    if (field === '') continue
    const tag = field.slice(0, 1)

    if (tag === '#') {
      const body = field.slice(2)
      const space = body.indexOf(' ')
      const key = space < 0 ? body : body.slice(0, space)
      const value = space < 0 ? '' : body.slice(space + 1)
      if (key === 'branch.oid') {
        branch.oid = value
        branch.unborn = value === '(initial)'
      } else if (key === 'branch.head') {
        branch.head = value
        branch.detached = value === '(detached)'
      } else if (key === 'branch.upstream') {
        branch.upstream = value
      } else if (key === 'branch.ab') {
        const match = /^\+(\d+)\s+-(\d+)$/.exec(value)
        if (match !== null) {
          branch.ahead = Number(match[1])
          branch.behind = Number(match[2])
        }
      }
      continue
    }

    if (tag === '1') {
      const { tokens, rest } = takeTokens(field.slice(2), 7)
      if (tokens.length < 7) continue
      files.push(makeEntry({ type: '1', xy: tokens[0], path: rest }))
      continue
    }

    if (tag === '2') {
      const { tokens, rest } = takeTokens(field.slice(2), 8)
      if (tokens.length < 8) continue
      // With -z the original path is its own NUL-terminated field, so consume it.
      const origPath = fields[cursor + 1]
      cursor += 1
      files.push(makeEntry({ type: '2', xy: tokens[0], path: rest, origPath }))
      continue
    }

    if (tag === 'u') {
      // `u XY sub m1 m2 m3 mW h1 h2 h3 <path>` — nine fixed fields after the
      // tag, then the path. Counting ten here consumes the first word of the
      // path and yields an entry whose path is empty, which is a *silent* wrong
      // answer: the conflict simply vanishes from the list.
      const { tokens, rest } = takeTokens(field.slice(2), 9)
      if (tokens.length < 9) continue
      files.push(makeEntry({ type: 'u', xy: tokens[0], path: rest }))
      continue
    }

    if (tag === '?' || tag === '!') {
      files.push(makeEntry({ type: tag, xy: tag === '?' ? '??' : '!!', path: field.slice(2) }))
      continue
    }
  }

  return { branch, files }
}

/**
 * Parse `git diff --numstat -z --find-renames`.
 *
 * Records are `<added>\t<deleted>\t<path>`, except a rename, where the path is
 * empty and the next two NUL fields carry the old and new path. A binary file
 * reports `-` for both counts.
 *
 * @param {string} raw the command's stdout
 * @returns {Map<string, { path: string, origPath?: string, added: number, deleted: number, binary: boolean }>}
 *   keyed by the new path
 */
export function parseNumstat(raw) {
  const result = new Map()
  const fields = splitNul(raw)
  let cursor = 0

  while (cursor < fields.length) {
    const record = fields[cursor]
    cursor += 1
    if (record === '') continue

    const firstTab = record.indexOf('\t')
    if (firstTab < 0) continue
    const secondTab = record.indexOf('\t', firstTab + 1)
    if (secondTab < 0) continue

    const addedText = record.slice(0, firstTab)
    const deletedText = record.slice(firstTab + 1, secondTab)
    let path = record.slice(secondTab + 1)
    let origPath

    if (path === '') {
      origPath = fields[cursor]
      path = fields[cursor + 1]
      cursor += 2
      if (path === undefined) break
    }

    const binary = addedText === '-'
    result.set(path, {
      path,
      ...(origPath === undefined ? {} : { origPath }),
      added: binary ? 0 : Number(addedText) || 0,
      deleted: binary ? 0 : Number(deletedText) || 0,
      binary,
    })
  }

  return result
}

/**
 * Parse `git diff --name-only -z`, used to learn the path list a bare
 * `git diff HEAD` would cover without materializing the diff itself.
 *
 * @param {string} raw the command's stdout
 * @returns {string[]}
 */
export function parseNameOnly(raw) {
  return splitNul(raw)
}
