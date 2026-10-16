/**
 * Diff text assembly.
 *
 * Everything here is pure: strings and Buffers in, strings out. That matters
 * because the archived copy in the trash is the *only* record of a discarded
 * change — `git restore` has already thrown the change away by the time anyone
 * reads it — so the assembly has to be verifiable without a repository, and
 * `test/diff.test.mjs` pins it line by line.
 *
 * Two jobs:
 *
 *   1. `synthesizeNewFileDiff` fills the one hole `git diff HEAD` leaves.
 *      Untracked paths are invisible to a diff against HEAD (they are not in
 *      HEAD and not in the index), yet discarding one deletes it, so without a
 *      synthesized diff the trash entry would say "one file, no content".
 *
 *   2. `limitDiff` caps what gets archived. A discarding user is having a bad
 *      day already; a 200 MB generated file must not turn into a 200 MB JSON
 *      write that then fails. The cap cuts on a *line* boundary, never
 *      mid-character, and records how many lines it dropped.
 *
 * @module dsh-gitbar-lite/host/diff
 */

/** Bytes scanned when deciding whether a file is binary. */
const SNIFF_BYTES = 8000

/**
 * Whether a file should be treated as binary, using git's own heuristic: a NUL
 * byte within the first 8000 bytes.
 *
 * @param {Buffer | Uint8Array} bytes
 */
export function looksBinary(bytes) {
  const end = Math.min(bytes.length, SNIFF_BYTES)
  for (let index = 0; index < end; index += 1) {
    if (bytes[index] === 0) return true
  }
  return false
}

/** The `100644`/`100755` git mode text for a `fs.Stats`-like object. */
export function modeTextFor(stats) {
  const mode = typeof stats?.mode === 'number' ? stats.mode : 0
  return (mode & 0o111) !== 0 ? '100755' : '100644'
}

/**
 * A unified diff for a file git does not track, shaped like the one git would
 * have produced.
 *
 * Trailing `\r` is stripped from each line, matching what git shows for a
 * repository with `text=auto` (this machine's global config has
 * `core.autocrlf=true`, so a CRLF worktree file would otherwise diff
 * differently from every tracked file next to it).
 *
 * @param {object} input
 * @param {string} input.path repository-relative path
 * @param {string} input.content decoded file content (ignored when binary)
 * @param {boolean} [input.binary]
 * @param {string} [input.mode] git mode text, from `modeTextFor`
 * @returns {string}
 */
export function synthesizeNewFileDiff({ path, content, binary = false, mode = '100644' }) {
  const header = [`diff --git a/${path} b/${path}`, `new file mode ${mode}`]
  if (binary) return `${[...header, `Binary files /dev/null and b/${path} differ`].join('\n')}\n`

  const body = ['--- /dev/null', `+++ b/${path}`]
  if (content === '') return `${[...header, ...body].join('\n')}\n`

  const endsWithNewline = content.endsWith('\n')
  const lines = content.split('\n')
  if (endsWithNewline) lines.pop()
  const textLines = lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))

  const hunks = [`@@ -0,0 +1,${textLines.length} @@`, ...textLines.map((line) => `+${line}`)]
  if (!endsWithNewline) hunks.push('\\ No newline at end of file')
  return `${[...header, ...body, ...hunks].join('\n')}\n`
}

/**
 * Cap a diff on a line boundary.
 *
 * @param {string} text
 * @param {number} maxBytes ceiling for the returned text, in UTF-8 bytes
 * @returns {{ text: string, truncated: boolean, droppedLines: number }}
 */
export function limitDiff(text, maxBytes) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return { text, truncated: false, droppedLines: 0 }
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false, droppedLines: 0 }

  const lines = text.split('\n')
  const kept = []
  let used = 0
  for (const line of lines) {
    const cost = Buffer.byteLength(line, 'utf8') + 1
    if (used + cost > maxBytes) break
    kept.push(line)
    used += cost
  }

  const dropped = lines.length - kept.length
  const marker = `[dsh-gitbar-lite] diff truncated: ${dropped} more lines, ${Buffer.byteLength(text, 'utf8') - used} more bytes\n`
  return { text: `${kept.join('\n')}\n${marker}`, truncated: true, droppedLines: dropped }
}

/**
 * The path each block of a multi-file diff belongs to, for the reader's table
 * of contents.
 *
 * `diff --git a/x b/y` is genuinely ambiguous when a path contains a space, so
 * the more specific lines are preferred, in the order git emits them:
 * `rename to` first, then the `+++`/`---` pair, then the header as a fallback.
 *
 * @param {string} text a full (possibly multi-file) diff
 * @returns {{ path: string, text: string }[]}
 */
export function splitDiffByFile(text) {
  if (text === '') return []

  const lines = text.split('\n')
  const starts = []
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith('diff --git ')) starts.push(index)
  }
  if (starts.length === 0) return []

  const blocks = []
  for (let index = 0; index < starts.length; index += 1) {
    const from = starts[index]
    const to = index + 1 < starts.length ? starts[index + 1] : lines.length
    const block = lines.slice(from, to)
    blocks.push({ path: pathOfBlock(block), text: block.join('\n') })
  }
  return blocks
}

/** Recover the new path from one `diff --git` block. */
function pathOfBlock(block) {
  for (const line of block) {
    if (line.startsWith('rename to ')) return line.slice('rename to '.length).trim()
  }
  for (const line of block) {
    if (line.startsWith('+++ ')) {
      const value = line.slice(4)
      if (value === '/dev/null') continue
      const path = value.startsWith('b/') ? value.slice(2) : value
      const tab = path.indexOf('\t')
      return (tab < 0 ? path : path.slice(0, tab)).trim()
    }
  }
  for (const line of block) {
    if (line.startsWith('--- ')) {
      const value = line.slice(4)
      if (value === '/dev/null') continue
      const path = value.startsWith('a/') ? value.slice(2) : value
      const tab = path.indexOf('\t')
      return (tab < 0 ? path : path.slice(0, tab)).trim()
    }
  }
  const header = block.find((line) => line.startsWith('diff --git '))
  if (header === undefined) return ''
  // Last resort: `diff --git a/x b/y` with no quoting (we always run with
  // quotepath=false, so a path with spaces simply makes this ambiguous).
  const body = header.slice('diff --git '.length)
  const halves = body.split(' ')
  const right = halves.length >= 2 ? halves[halves.length - 1] : body
  return right.startsWith('b/') ? right.slice(2) : right
}

/**
 * Join per-path diffs into the single blob a "discard all changes" entry
 * archives, and report the per-file stats.
 *
 * @param {{ path: string, text: string }[]} parts
 * @returns {string}
 */
export function joinDiffParts(parts) {
  return parts.map((part) => (part.text.endsWith('\n') ? part.text : `${part.text}\n`)).join('')
}

/**
 * Count the `+`/`-` lines one diff block contributes, mirroring what
 * `--numstat` reports (so the UI's numbers match whether they came from git or
 * from a synthesized untracked diff).
 *
 * @param {string} text
 * @returns {{ added: number, deleted: number }}
 */
export function diffTotals(text) {
  let added = 0
  let deleted = 0
  let inHunk = false
  for (const line of text.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (line.startsWith('diff --git ')) {
      inHunk = false
      continue
    }
    if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) deleted += 1
  }
  return { added, deleted }
}

/** Number of lines a brand-new file contributes (its `+` count). */
export function countContentLines(content) {
  if (content === '') return 0
  const endsWithNewline = content.endsWith('\n')
  const count = content.split('\n').length - (endsWithNewline ? 1 : 0)
  return count
}
