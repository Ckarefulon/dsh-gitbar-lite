/**
 * Repository operations: everything the panel asks for, expressed as git.
 *
 * The owning rule here is that **a tick in the file list is the real index**.
 * Ticking runs `git add`, unticking runs `git restore --staged`, and Commit runs
 * a plain `git commit` with no pathspec — so what the panel shows, what
 * `git status` in a terminal shows, and what gets committed cannot drift apart.
 * A pathspec-limited commit would look the same in the panel while quietly
 * ignoring whatever the user had staged by hand.
 *
 * Two consequences worth stating up front, because they are user-visible:
 *
 *   - A file whose change is only half staged (changed in the index and again
 *     in the worktree) cannot be represented by one tick. It renders as
 *     indeterminate and either tick re-states it as a whole.
 *   - Discarding is two steps, in this order: **archive, then restore**. The
 *     archive is the only copy of the change, and `git restore` destroys the
 *     original, so the order is not an optimization.
 *
 * @module dsh-gitbar-lite/host/repo
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'

import { DISCARD_SCOPE, ERROR_CODES, FILE_STATUS, PRIMARY_ACTIONS } from '../shared.js'
import {
  countContentLines,
  diffTotals,
  joinDiffParts,
  limitDiff,
  looksBinary,
  modeTextFor,
  synthesizeNewFileDiff,
} from './diff.js'
import { parseNumstat, parseStatus } from './parse.js'

/** Directories never worth descending into while hunting for repositories. */
const SKIP_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.nuxt',
  '.cache',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  '.gradle',
  '.m2',
  '.nuget',
  'obj',
  'bin',
  '.tox',
  '.pytest_cache',
  'coverage',
])

/** Ceiling on directories visited by one repository scan. */
const SCAN_VISIT_LIMIT = 3000

/** Concurrent reads when sizing untracked files. */
const READ_CONCURRENCY = 8

/** A typed error the route layer turns into `{ ok:false, error }` verbatim. */
export class RepoError extends Error {
  /**
   * @param {string} code one of `ERROR_CODES`
   * @param {string} message already user-facing (the client shows it as-is)
   */
  constructor(code, message) {
    super(message)
    this.name = 'RepoError'
    this.code = code
  }
}

/**
 * Wrap a path as a literal git pathspec.
 *
 * Without this, a file named `docs` would let `git restore -- docs` reach
 * `docs/anything` as well, and a file named `a[1].txt` would be treated as a
 * pattern. `:(literal)` says "this exact path, no pattern, no prefix walk",
 * which is the only semantics a per-file action can safely have.
 */
export function literal(path) {
  return `:(literal)${path}`
}

/** Every path a status entry occupies: the new one and, for a rename, the old. */
function entryPaths(entry) {
  return entry.origPath === undefined ? [entry.path] : [entry.path, entry.origPath]
}

/**
 * Join a repository-relative path onto its root, refusing an escape attempt.
 *
 * Exported because opening a file in an external program needs the same
 * containment, and a second copy of this check is a second place for it to be
 * written slightly differently.
 */
export function absoluteIn(repoRoot, path) {
  const absolute = resolve(repoRoot, path)
  const root = resolve(repoRoot)
  if (absolute !== root && !absolute.startsWith(root.endsWith(sep) ? root : root + sep)) {
    throw new RepoError(ERROR_CODES.BAD_REQUEST, `path escapes the repository: ${path}`)
  }
  return absolute
}

/** Read one untracked file, bounded, for stats and for the synthesized diff. */
async function readUntracked(repoRoot, path, maxFileBytes) {
  let stats
  try {
    stats = await stat(absoluteIn(repoRoot, path))
  } catch {
    return { missing: true, binary: false, mode: '100644', content: '', lines: 0 }
  }
  if (!stats.isFile()) return { missing: true, binary: false, mode: '100644', content: '', lines: 0 }

  const mode = modeTextFor(stats)
  if (stats.size > maxFileBytes) return { oversized: true, binary: false, mode, content: '', lines: 0, bytes: stats.size }

  let bytes
  try {
    bytes = await readFile(absoluteIn(repoRoot, path))
  } catch {
    return { missing: true, binary: false, mode, content: '', lines: 0 }
  }
  if (looksBinary(bytes)) return { binary: true, mode, content: '', lines: 0, bytes: bytes.length }
  const content = bytes.toString('utf8')
  return { binary: false, mode, content, lines: countContentLines(content), bytes: bytes.length }
}

/** Run `work` over `items` with a small concurrency ceiling, preserving order. */
async function mapLimit(items, limit, work) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = new Array(Math.min(limit, items.length)).fill(undefined).map(async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await work(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/** Turn a git failure into something a user can act on. */
export function classifyGitFailure(error, fallbackCode = ERROR_CODES.GIT_FAILED) {
  // stdout matters as much as stderr here: `git commit` with nothing staged
  // exits 1 and says "nothing to commit, working tree clean" on **stdout**,
  // leaving stderr empty — so a stderr-only matcher would report that as an
  // unexplained internal failure.
  const text = `${error?.stderr ?? ''}\n${error?.stdout ?? ''}\n${error?.message ?? ''}`
  if (/would be overwritten by merge|local changes/i.test(text)) {
    return new RepoError(ERROR_CODES.CONFLICT, '有未提交的本地改动会被覆盖，请先处理这些文件。')
  }
  if (/non-fast-forward|fetch first|\[rejected\]|failed to push some refs/i.test(text)) {
    return new RepoError(ERROR_CODES.PUSH_REJECTED, '推送被拒绝：远端有你本地没有的提交，先 Fetch 一下再推。')
  }
  if (/Authentication failed|could not read Username|Permission denied \(publickey\)|terminal prompts disabled|Invalid username or password|403/i.test(text)) {
    return new RepoError(ERROR_CODES.AUTH, '推送认证失败：本机 git 没有可用的凭据，先在终端里成功 push 一次，或配上凭据助手。')
  }
  if (/no upstream branch|has no upstream branch/i.test(text)) {
    return new RepoError(ERROR_CODES.NO_UPSTREAM, '这个分支还没有上游，先发布一次。')
  }
  if (/nothing to commit|no changes added to commit/i.test(text)) {
    return new RepoError(ERROR_CODES.NOTHING_STAGED, '没有勾选任何改动：先在文件列表里勾上要提交的文件。')
  }
  if (/CONFLICT|unmerged|needs merge|Committing is not possible/i.test(text)) {
    return new RepoError(ERROR_CODES.CONFLICT, '仓库里还有未解决的冲突，先解决它们再提交。')
  }
  return new RepoError(fallbackCode, String(error?.message ?? error))
}

/**
 * The mtime of `FETCH_HEAD`, as an ISO string, or `null` when there is none.
 *
 * Every `git fetch` and `git pull` writes that file, which makes its mtime the
 * honest answer to "when did this repository last talk to a remote" — including
 * for a checkout this plugin has never seen, and including a fetch run in a
 * terminal. A missing file means nobody has fetched yet, which is not an error.
 *
 * @param {{ exitCode: number | null, stdout: string }} gitDirResult the outcome of `rev-parse --absolute-git-dir`
 * @returns {Promise<string | null>}
 */
async function fetchTimeOf(gitDirResult) {
  if (gitDirResult.exitCode !== 0) return null
  const dir = gitDirResult.stdout.trim()
  if (dir === '') return null
  try {
    return (await stat(join(dir, 'FETCH_HEAD'))).mtime.toISOString()
  } catch {
    return null
  }
}

/** Resolved once per plugin instance: which shell a script is written for. */
let scriptShell = null

/**
 * The argv prefix that runs one script string.
 *
 * `sh` if the machine has one, and `cmd.exe /d /s /c` otherwise.
 *
 * Why the hunt for `sh` and not simply "use it on Unix, cmd on Windows": the
 * script is text a user types into a settings field, and the shell it is written
 * in decides whether `grep`, `sed` and `awk` work. Git for Windows ships a full
 * `usr/bin` beside the git binary — but it does *not* add it to `PATH`, so a bare
 * `sh` lookup fails on most Windows machines even though one is installed. The
 * git binary's own location is therefore the place to look: it is the one
 * executable this plugin is certain exists, and its neighbour `usr/bin/sh.exe`
 * is the one that has the POSIX tools beside it.
 *
 * @param {object} git the runner from `createGit`, for executable resolution
 * @param {AbortSignal} [signal]
 * @returns {Promise<readonly string[]>}
 */
async function scriptPrefix(git, signal) {
  if (scriptShell !== null) return scriptShell
  if (process.platform !== 'win32') {
    scriptShell = ['sh', '-c']
    return scriptShell
  }

  try {
    const gitPath = await git.executable('git', signal)
    const candidate = resolve(dirname(dirname(gitPath)), 'usr', 'bin', 'sh.exe')
    await stat(candidate)
    scriptShell = [candidate, '-c']
  } catch {
    scriptShell = ['cmd.exe', '/d', '/s', '/c']
  }
  return scriptShell
}

/**
 * Build the repository facade for one plugin instance.
 *
 * @param {object} git the runner from `createGit`
 * @param {object} config resolved plugin config
 */
export function createRepo(git, config) {
  /**
   * How often the panel should fetch on its own, in milliseconds, or 0 for
   * "never". Resolved once: the value rides along with every status payload,
   * because a client bundle cannot read the host's config.
   */
  const autoFetchMs = Number.isFinite(config.autoFetchMs) && config.autoFetchMs > 0 ? Math.floor(config.autoFetchMs) : 0

  /**
   * Identity, branch and working-tree status of one repository.
   *
   * @param {string} repoRoot
   * @param {AbortSignal} [signal]
   */
  async function readStatus(repoRoot, signal) {
    // The probes are independent, so they share one round of latency.
    // `GIT_OPTIONAL_LOCKS=0` (set by the runner) is what makes the index reads
    // safe to overlap.
    const [statusResult, numstatResult, remotesResult, headResult, gitDirResult] = await Promise.all([
      git.run(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { cwd: repoRoot, signal }),
      git.run(['diff', '--numstat', '-z', '--find-renames', 'HEAD'], { cwd: repoRoot, signal }),
      git.run(['remote'], { cwd: repoRoot, signal }),
      git.run(['log', '-1', '--pretty=%H%x00%h%x00%s'], { cwd: repoRoot, signal }),
      // Where `.git` really is, so FETCH_HEAD can be found without assuming a
      // plain directory: a worktree's git directory lives somewhere else, and a
      // submodule's is inside the parent's.
      git.run(['rev-parse', '--absolute-git-dir'], { cwd: repoRoot, signal }),
    ])

    if (statusResult.exitCode !== 0) {
      throw classifyGitFailure({ ...statusResult, message: `git status failed: ${statusResult.stderr.trim()}` })
    }

    const { branch, files } = parseStatus(statusResult.stdout)
    const remotes =
      remotesResult.exitCode === 0
        ? remotesResult.stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '')
        : []

    let head = null
    if (headResult.exitCode === 0) {
      const [oid, short, ...rest] = headResult.stdout.replace(/\n$/, '').split('\0')
      if (typeof oid === 'string' && oid !== '') head = { oid, short, subject: rest.join('\0') }
    }

    // `git diff HEAD` cannot run in a repository with no commits, and every
    // untracked file is new anyway — the synthesized diffs carry the numbers.
    const stats = numstatResult.exitCode === 0 ? parseNumstat(numstatResult.stdout) : new Map()

    const untrackedPaths = files.filter((file) => file.untracked).map((file) => file.path)
    const untrackedDetails = await mapLimit(untrackedPaths, READ_CONCURRENCY, (path) =>
      readUntracked(repoRoot, path, config.maxFileBytes),
    )
    const untrackedByPath = new Map(untrackedPaths.map((path, index) => [path, untrackedDetails[index]]))

    const enriched = files.map((file) => {
      const fromGit = stats.get(file.path)
      const detail = untrackedByPath.get(file.path)
      const binary = fromGit?.binary === true || detail?.binary === true
      return {
        ...file,
        added: fromGit !== undefined ? fromGit.added : detail?.lines ?? 0,
        deleted: fromGit !== undefined ? fromGit.deleted : 0,
        binary,
        ...(file.untracked && detail?.oversized === true ? { oversized: true } : {}),
        ...(file.untracked ? { synthesized: true } : {}),
      }
    })

    const counts = enriched.reduce(
      (sum, file) => ({
        files: sum.files + 1,
        staged: sum.staged + (file.staged ? 1 : 0),
        partial: sum.partial + (file.partial ? 1 : 0),
        conflicted: sum.conflicted + (file.conflicted ? 1 : 0),
        additions: sum.additions + (file.added ?? 0),
        deletions: sum.deletions + (file.deleted ?? 0),
      }),
      { files: 0, staged: 0, partial: 0, conflicted: 0, additions: 0, deletions: 0 },
    )

    const primary =
      branch.ahead > 0
        ? PRIMARY_ACTIONS.PUSH
        : branch.upstream === null && remotes.length > 0
          ? PRIMARY_ACTIONS.PUBLISH
          : PRIMARY_ACTIONS.FETCH

    // When the last fetch happened, asked of git rather than remembered by this
    // plugin: `git fetch` (and `git pull`) rewrites FETCH_HEAD every time, so a
    // fetch run in a terminal counts as well, and there is no state of ours to
    // lose or to disagree with the repository.
    const lastFetchAt = await fetchTimeOf(gitDirResult)

    return {
      repoRoot,
      repoName: basename(repoRoot),
      branch,
      head,
      remotes,
      files: enriched,
      counts,
      primary,
      lastFetchAt,
      // The panel cannot read the host's config (a client bundle has no access to
      // it), so the rhythm it should fetch on travels with the status it is
      // already reading. Zero means "never, on your own".
      autoFetchMs,
      // ...and so does the script, so the panel can offer the button only when
      // there is a script to run.
      summaryScript: typeof config.summaryScript === 'string' ? config.summaryScript : '',
    }
  }

  /** The status entries for one repository, plus its branch info. */
  async function statusOf(repoRoot, signal) {
    const result = await git.run(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], {
      cwd: repoRoot,
      signal,
    })
    if (result.exitCode !== 0) {
      throw classifyGitFailure({ ...result, message: `git status failed: ${result.stderr.trim()}` })
    }
    return parseStatus(result.stdout)
  }

  /**
   * Stage or unstage exactly the given paths.
   *
   * @param {string} repoRoot
   * @param {readonly string[]} paths status paths as git spelled them
   * @param {boolean} staged
   * @param {AbortSignal} [signal]
   */
  async function setStaged(repoRoot, paths, staged, signal) {
    if (paths.length === 0) return
    const args = staged
      ? // `-A` so a deletion is staged too; without it `git add` refuses a path
        // that no longer exists.
        ['add', '-A', '--', ...paths.map(literal)]
      : ['restore', '--staged', '--', ...paths.map(literal)]
    const result = await git.run(args, { cwd: repoRoot, signal })
    if (result.exitCode !== 0) {
      throw classifyGitFailure({ ...result, message: `git ${args[0]} failed: ${result.stderr.trim()}` })
    }
  }

  /**
   * Commit what is staged, with no pathspec.
   *
   * The message goes in over stdin (`-F -`) rather than as `-m`: a summary with
   * a quote, a newline or a leading dash is then just text, not an argument, and
   * a multi-line Description arrives as the commit body with no extra escaping.
   *
   * @param {string} repoRoot
   * @param {{ summary: string, description?: string }} message
   * @param {AbortSignal} [signal]
   */
  async function commit(repoRoot, message, signal) {
    const summary = String(message?.summary ?? '').trim()
    if (summary === '') throw new RepoError(ERROR_CODES.EMPTY_SUMMARY, 'Summary 不能为空。')
    const description = String(message?.description ?? '').trim()
    const text = description === '' ? `${summary}\n` : `${summary}\n\n${description}\n`

    const result = await git.run(['commit', '-F', '-'], { cwd: repoRoot, stdin: text, signal })
    if (result.exitCode !== 0) {
      throw classifyGitFailure({ ...result, message: `git commit failed: ${result.stderr.trim()}` })
    }

    const head = await git.run(['log', '-1', '--pretty=%H%x00%h%x00%s'], { cwd: repoRoot, signal })
    if (head.exitCode !== 0) return { summary, oid: null, short: null }
    const [oid, short, ...subject] = head.stdout.replace(/\n$/, '').split('\0')
    return { summary, oid: oid ?? null, short: short ?? null, subject: subject.join('\0') }
  }

  /** The remote to push to: `origin` when it exists, else the first one. */
  function pickRemote(remotes) {
    if (remotes.length === 0) {
      throw new RepoError(ERROR_CODES.NO_REMOTE, '这个仓库没有配置远端（remote），没法 push 或 fetch。')
    }
    return remotes.includes('origin') ? 'origin' : remotes[0]
  }

  /**
   * Push the current branch, publishing it when it has no upstream yet.
   *
   * @param {string} repoRoot
   * @param {AbortSignal} [signal]
   */
  /**
   * Push the current branch, publishing it when it has no upstream yet.
   *
   * A fetch runs first. GitHub Desktop goes further — fetch, then pull, then push
   * — but a pull rewrites the working tree, and this panel's whole model is that
   * a tick is the real index: a merge commit appearing under the user between
   * their tick and their push would quietly invalidate what they selected. So the
   * fetch is followed by a check instead, and the push is refused with a sentence
   * when the branch has fallen behind.
   *
   * That refusal is the honest outcome, not a limitation: git never merges on
   * push, so a behind branch is rejected either way. What the fetch buys is that
   * the answer is known *before* the push attempt, and that the upstream tracking
   * ref the ahead/behind count is read from is current rather than however stale
   * it was when the panel opened.
   *
   * The fetch itself is best-effort: if it fails (offline, no credential) the
   * push still goes ahead, because the fetch's failure says nothing about whether
   * the push can work, and silently refusing to push would be worse.
   *
   * @param {string} repoRoot
   * @param {AbortSignal} [signal]
   */
  async function push(repoRoot, signal) {
    const remotesResult = await git.run(['remote'], { cwd: repoRoot, signal })
    const remotes =
      remotesResult.exitCode === 0
        ? remotesResult.stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '')
        : []
    const remote = pickRemote(remotes)

    let fetched = false
    const preFetch = await git.run(['fetch', '--prune', remote], { cwd: repoRoot, signal, maxBytes: 1024 * 1024 })
    if (preFetch.exitCode === 0) fetched = true

    // Re-read after the fetch: the branch's upstream and its ahead/behind counts
    // are exactly what the fetch may have changed.
    const { branch } = await statusOf(repoRoot, signal)

    // Only refuse when we *know* we are behind, which requires both an upstream
    // and a fetch that actually told us something. Without an upstream this is a
    // publish, and a failed fetch leaves the counts unknown — neither should be
    // turned into a refusal.
    if (fetched && branch.upstream !== null && branch.behind > 0) {
      const refusal = new RepoError(
        ERROR_CODES.PUSH_REJECTED,
        `远端有新提交（落后 ${branch.behind} 个），先 Pull 或 Rebase 再推。`,
      )
      // Carried on the error so the route can report "we did look" alongside the
      // refusal, rather than the caller having to guess whether a fetch happened.
      refusal.fetched = true
      throw refusal
    }

    const args =
      branch.upstream === null ? ['push', '--set-upstream', remote, 'HEAD'] : ['push', remote]
    const result = await git.run(args, { cwd: repoRoot, signal, maxBytes: 1024 * 1024 })
    if (result.exitCode !== 0) {
      throw classifyGitFailure({ ...result, message: `git push failed: ${result.stderr.trim()}` })
    }
    return { remote, published: branch.upstream === null, fetched, output: `${result.stdout}${result.stderr}`.trim() }
  }

  /**
   * Fetch, pruning remote-tracking branches the remote has deleted — the same
   * behaviour GitHub Desktop's Fetch has.
   *
   * @param {string} repoRoot
   * @param {AbortSignal} [signal]
   */
  async function fetch(repoRoot, signal) {
    const remotesResult = await git.run(['remote'], { cwd: repoRoot, signal })
    const remotes =
      remotesResult.exitCode === 0
        ? remotesResult.stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '')
        : []
    pickRemote(remotes)

    const result = await git.run(['fetch', '--prune'], { cwd: repoRoot, signal, maxBytes: 1024 * 1024 })
    if (result.exitCode !== 0) {
      throw classifyGitFailure({ ...result, message: `git fetch failed: ${result.stderr.trim()}` })
    }
    return { output: `${result.stdout}${result.stderr}`.trim() }
  }

  /**
   * One path's unified diff against HEAD, for the preview tab.
   *
   * @param {string} repoRoot
   * @param {string} path
   * @param {AbortSignal} [signal]
   */
  async function fileDiff(repoRoot, path, signal) {
    const scoped = await git.run(
      ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--', literal(path)],
      { cwd: repoRoot, signal },
    )
    if (scoped.exitCode !== 0) {
      throw classifyGitFailure({ ...scoped, message: `git status failed: ${scoped.stderr.trim()}` })
    }
    const { files } = parseStatus(scoped.stdout)
    const entry = files[0]

    if (entry === undefined) {
      return { path, kind: 'clean', text: '', truncated: false, added: 0, deleted: 0, binary: false }
    }
    if (entry.conflicted) {
      throw new RepoError(ERROR_CODES.CONFLICT, '这个文件有未解决的冲突，diff 不能作为一次更改来看。')
    }

    if (entry.untracked) {
      const detail = await readUntracked(repoRoot, path, config.maxFileBytes)
      const text = synthesizeNewFileDiff({
        path,
        content: detail.content,
        binary: detail.binary,
        mode: detail.mode,
      })
      const limited = limitDiff(text, config.maxDiffBytes)
      return {
        path,
        kind: FILE_STATUS.UNTRACKED,
        text: limited.text,
        truncated: limited.truncated,
        added: detail.lines,
        deleted: 0,
        binary: detail.binary,
      }
    }

    const args = ['diff', '--no-color', '--find-renames', 'HEAD', '--', ...entryPaths(entry).map(literal)]
    const result = await git.run(args, { cwd: repoRoot, signal, maxBytes: config.maxDiffBytes + 64 * 1024 })
    if (result.exitCode !== 0) {
      throw classifyGitFailure({ ...result, message: `git diff failed: ${result.stderr.trim()}` })
    }
    const limited = limitDiff(result.stdout, config.maxDiffBytes)
    const totals = diffTotals(limited.text)
    return {
      path,
      kind: entry.kind,
      origPath: entry.origPath,
      text: limited.text,
      truncated: limited.truncated || result.truncated,
      added: totals.added,
      deleted: totals.deleted,
      binary: /^Binary files /m.test(result.stdout),
    }
  }

  /**
   * Discard changes: archive the diff, then restore the files.
   *
   * @param {object} input
   * @param {string} input.repoRoot
   * @param {string} [input.workspacePath]
   * @param {string} [input.sessionId]
   * @param {readonly string[] | null} input.paths `null` means every changed file
   * @param {boolean} input.hardDelete skip the archive entirely
   * @param {(entry: object, diffText: string) => Promise<object>} input.archive
   * @param {AbortSignal} [input.signal]
   */
  async function discard(input) {
    const { repoRoot, paths, hardDelete, archive, signal } = input
    const status = await statusOf(repoRoot, signal)

    const chosen =
      paths === null
        ? status.files
        : status.files.filter((file) => paths.includes(file.path) || (file.origPath !== undefined && paths.includes(file.origPath)))

    if (chosen.length === 0) {
      throw new RepoError(ERROR_CODES.BAD_REQUEST, '没有匹配到任何要舍弃的更改（工作区可能已经干净了）。')
    }

    const conflicted = chosen.filter((file) => file.conflicted)
    if (conflicted.length > 0) {
      throw new RepoError(
        ERROR_CODES.CONFLICT,
        `有 ${conflicted.length} 个文件处于冲突状态，舍弃更改不能处理它们，请先解决冲突。`,
      )
    }

    const tracked = chosen.filter((file) => !file.untracked)
    const untracked = chosen.filter((file) => file.untracked)

    // ---- 1. Build the archive, before anything is destroyed. ----------------

    const trackedPathspec = tracked.flatMap(entryPaths).map(literal)

    // The blob and the per-file numbers come from two calls, not N: one diff for
    // the archive body, one numstat for the table the trash list shows. Asking
    // git once per file would be N process spawns on Windows for a table it can
    // already compute in one.
    let trackedDiff = ''
    let trackedStats = new Map()
    if (tracked.length > 0) {
      const [diffResult, numstatResult] = await Promise.all([
        git.run(['diff', '--no-color', '--find-renames', 'HEAD', '--', ...trackedPathspec], {
          cwd: repoRoot,
          signal,
          maxBytes: config.maxDiffBytes + 64 * 1024,
        }),
        git.run(['diff', '--numstat', '-z', '--find-renames', 'HEAD', '--', ...trackedPathspec], {
          cwd: repoRoot,
          signal,
          maxBytes: 1024 * 1024,
        }),
      ])
      if (diffResult.exitCode !== 0) {
        throw classifyGitFailure({ ...diffResult, message: `git diff failed: ${diffResult.stderr.trim()}` })
      }
      trackedDiff = diffResult.stdout
      if (numstatResult.exitCode === 0) trackedStats = parseNumstat(numstatResult.stdout)
    }

    // Untracked files are invisible to `git diff HEAD` but discarding one
    // deletes it, so their content is captured here or lost.
    const untrackedPaths = untracked.map((file) => file.path)
    const details = await mapLimit(untrackedPaths, READ_CONCURRENCY, (path) =>
      readUntracked(repoRoot, path, config.maxFileBytes),
    )
    const detailByPath = new Map(untrackedPaths.map((path, index) => [path, details[index]]))

    const parts = []
    if (trackedDiff !== '') parts.push({ path: '', text: trackedDiff })
    for (const file of untracked) {
      const detail = detailByPath.get(file.path)
      parts.push({
        path: file.path,
        text: synthesizeNewFileDiff({
          path: file.path,
          content: detail?.content ?? '',
          binary: detail?.binary === true,
          mode: detail?.mode ?? '100644',
        }),
      })
    }

    const assembled = joinDiffParts(parts)
    const limited = limitDiff(assembled, config.maxDiffBytes)

    // ---- 2. Record it (unless the user asked for it to be gone for good). --

    let entry = null
    if (!hardDelete) {
      const head = await git.run(['log', '-1', '--pretty=%H%x00%h%x00%s'], { cwd: repoRoot, signal })
      let base = null
      if (head.exitCode === 0) {
        const [oid, short, ...subject] = head.stdout.replace(/\n$/, '').split('\0')
        if (typeof oid === 'string' && oid !== '') base = { oid, short, subject: subject.join('\0') }
      }

      const files = chosen.map((file) => {
        if (file.untracked) {
          const detail = detailByPath.get(file.path)
          return {
            path: file.path,
            kind: file.kind,
            added: detail?.lines ?? 0,
            deleted: 0,
            binary: detail?.binary === true,
            synthesized: true,
            ...(detail?.oversized === true ? { oversized: true } : {}),
          }
        }
        const fromGit = trackedStats.get(file.path)
        return {
          path: file.path,
          ...(file.origPath === undefined ? {} : { origPath: file.origPath }),
          kind: file.kind,
          added: fromGit?.added ?? 0,
          deleted: fromGit?.deleted ?? 0,
          binary: fromGit?.binary === true,
        }
      })

      entry = await archive(
        {
          repoRoot,
          repoName: basename(repoRoot),
          workspacePath: input.workspacePath ?? null,
          sessionId: input.sessionId ?? null,
          scope: paths === null ? DISCARD_SCOPE.ALL : DISCARD_SCOPE.FILE,
          branch: { head: status.branch.head, detached: status.branch.detached },
          base,
          files,
          bytes: Buffer.byteLength(limited.text, 'utf8'),
          truncated: limited.truncated,
          droppedLines: limited.droppedLines,
        },
        limited.text,
      )
    }

    // ---- 3. Restore. -------------------------------------------------------

    if (tracked.length > 0) {
      const pathspec = tracked.flatMap(entryPaths).map(literal)
      const result = await git.run(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...pathspec], {
        cwd: repoRoot,
        signal,
      })
      if (result.exitCode !== 0) {
        throw classifyGitFailure({ ...result, message: `git restore failed: ${result.stderr.trim()}` })
      }
    }

    // Untracked paths are not in HEAD, so `git restore` cannot reach them: a
    // mixed pathspec makes the whole command fail (verified), which is why they
    // are handled here instead of in one call.
    const deleted = []
    for (const file of untracked) {
      try {
        await rm(absoluteIn(repoRoot, file.path), { force: true })
        deleted.push(file.path)
      } catch (error) {
        throw new RepoError(ERROR_CODES.INTERNAL, `删除未跟踪文件失败：${file.path}（${String(error?.message ?? error)}）`)
      }
    }
    await pruneEmptyDirectories(repoRoot, untracked.map((file) => file.path))

    return {
      scope: paths === null ? DISCARD_SCOPE.ALL : DISCARD_SCOPE.FILE,
      hardDelete: hardDelete === true,
      restored: tracked.map((file) => file.path),
      deleted,
      trashed: entry,
    }
  }

  /**
   * Remove directories the discard just emptied, walking up to — but never
   * including — the repository root.
   */
  async function pruneEmptyDirectories(repoRoot, paths) {
    const root = resolve(repoRoot)
    const candidates = new Set()
    for (const path of paths) {
      let parent = resolve(root, path)
      for (;;) {
        parent = resolve(parent, '..')
        if (parent === root || !parent.startsWith(root)) break
        candidates.add(parent)
      }
    }
    const deepestFirst = [...candidates].sort((left, right) => right.length - left.length)
    for (const directory of deepestFirst) {
      try {
        const remaining = await readdir(directory)
        if (remaining.length === 0) await rm(directory, { force: true })
      } catch {
        // A directory that is gone, or not empty, or not ours to remove: all fine.
      }
    }
  }

  /**
   * Candidate repositories for the picker: the workspace root first, then
   * repositories anywhere beneath it, breadth-first and depth-capped.
   *
   * @param {string} workspacePath
   * @param {AbortSignal} [signal]
   */
  async function scanRepos(workspacePath, signal) {
    const root = resolve(workspacePath)
    const depth = Number.isFinite(config.scanDepth) && config.scanDepth > 0 ? config.scanDepth : 3
    const found = []
    const queue = [{ path: root, depth: 0 }]
    let visited = 0

    // The root itself may or may not be a repository; either way it is offered,
    // because "the workspace is a repository" is the common case and a wasted
    // probe costs one process.
    while (queue.length > 0 && visited < SCAN_VISIT_LIMIT) {
      const current = queue.shift()
      visited += 1
      let isRepo = false
      try {
        isRepo =
          (await stat(join(current.path, '.git')).then(
            () => true,
            () => false,
          )) === true
      } catch {
        isRepo = false
      }
      if (isRepo) {
        found.push({
          path: current.path,
          name: basename(current.path),
          isWorkspaceRoot: current.depth === 0,
        })
        // Nested repositories inside a repository are almost always vendored
        // checkouts; do not descend.
        continue
      }
      if (current.depth >= depth) continue
      let entries
      try {
        entries = await readdir(current.path, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith('.')) continue
        if (SKIP_DIRECTORIES.has(entry.name)) continue
        queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 })
      }
    }

    return { scanned: visited, truncated: queue.length > 0, repos: found }
  }

  /**
   * Whether one archived discard could be put back right now.
   *
   * The rule the panel promises, in one line: *the archive was taken against a
   * base, and restoring is offered only while that base is still what is on
   * disk.* Two things can make it untrue, and both have to be checked:
   *
   *   - **HEAD moved and took the file with it.** The archived diff was cut
   *     against `base.oid`; if the file has changed since, its context lines no
   *     longer match and `git apply` would fail (or, worse, apply in the wrong
   *     place). Comparing the recorded oid with the current HEAD catches the
   *     commit-level drift.
   *   - **The file was edited after the discard, without a commit.** HEAD is
   *     unchanged, so the oid still matches, but the working tree is not what the
   *     discard left. `git diff --quiet HEAD -- <paths>` is what catches that,
   *     and it is the check that actually protects the user's newer work.
   *
   * An archive whose diff is unusable — truncated on the way in, or a binary file
   * whose diff is only the words "Binary files differ" — is refused for that
   * reason instead, because applying it would restore something incomplete.
   *
   * @param {string} repoRoot
   * @param {object} entry the trash entry
   * @param {string | undefined} diffText the archived diff
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ ok: boolean, reason?: string }>}
   */
  async function canRestore(repoRoot, entry, diffText, signal) {
    // An entry recorded against a different repository cannot be restored into
    // this one: the paths mean something else there.
    if (typeof entry?.repoRoot === 'string' && entry.repoRoot !== '' && resolve(entry.repoRoot) !== resolve(repoRoot)) {
      return { ok: false, reason: 'other-repo' }
    }

    if (typeof diffText !== 'string' || diffText.trim() === '') return { ok: false, reason: 'no-diff' }
    // A diff we cut short cannot be replayed: the tail of the change is not in it.
    if (entry?.truncated === true) return { ok: false, reason: 'truncated' }
    if (/^Binary files .* differ$/m.test(diffText)) return { ok: false, reason: 'binary' }

    const paths = (Array.isArray(entry?.files) ? entry.files : []).flatMap(entryPaths).map(literal)
    if (paths.length === 0) return { ok: false, reason: 'no-diff' }

    // Commit-level drift: the base the diff was cut against is no longer HEAD.
    const baseOid = typeof entry?.base?.oid === 'string' && entry.base.oid !== '' ? entry.base.oid : null
    if (baseOid !== null) {
      const head = await git.run(['rev-parse', 'HEAD'], { cwd: repoRoot, signal })
      const current = head.exitCode === 0 ? head.stdout.trim() : ''
      if (current !== '' && current !== baseOid) return { ok: false, reason: 'moved' }
    }

    // Working-tree drift: nothing was committed, but the file was touched after
    // the discard, so putting the old change back would overwrite the newer one.
    const untouched = await git.run(['diff', '--quiet', 'HEAD', '--', ...paths], { cwd: repoRoot, signal })
    if (untouched.exitCode === 0) return { ok: true }
    if (untouched.exitCode === 1) return { ok: false, reason: 'changed' }
    return { ok: false, reason: 'unknown' }
  }

  /**
   * Put one archived discard back into the working tree.
   *
   * The archive is a diff, and a diff is what goes back: `git apply` replays it
   * against the working tree, which reproduces the exact bytes the user discarded
   * — including a new file that the discard deleted, because that case is
   * archived as a proper new-file diff.
   *
   * Nothing is written unless `canRestore` says the tree is still where the
   * archive was cut; that function is the single source of truth for both the
   * button's enabled state and this call, so a button that renders as available
   * cannot turn into a refusal, and a refused one cannot half-apply.
   *
   * **The restored paths are staged.** This panel's tick *is* the index, so
   * "ticked by default" — the rule every other changed file gets — would
   * otherwise not reach a restored file: the panel's automatic select-all is
   * skipped when the same set of paths was already seen and left unticked, and
   * the set a restore produces is exactly the set the discard consumed. Staging
   * here rather than in the browser half is what makes the list read correctly
   * even when nobody is looking at it, and it keeps the tick honest: the index
   * really does hold these paths, so `git status` in a terminal agrees.
   *
   * @param {string} repoRoot
   * @param {object} entry the trash entry
   * @param {string | undefined} diffText the archived diff
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ restored: string[], staged: string[] }>}
   */
  async function restore(repoRoot, entry, diffText, signal) {
    const eligibility = await canRestore(repoRoot, entry, diffText, signal)
    if (!eligibility.ok) {
      const message =
        eligibility.reason === 'changed'
          ? '这些文件在舍弃之后又被改过了，恢复会盖掉后来的改动。要恢复请先提交或再舍弃一次。'
          : eligibility.reason === 'moved'
            ? '这条记录基于的提交已经不是当前 HEAD 了，先把它应用到一个对得上的版本上。'
            : eligibility.reason === 'other-repo'
              ? '这条记录属于另一个仓库，不能恢复到当前仓库。'
              : eligibility.reason === 'truncated'
                ? '这条记录的 diff 在归档时被截断了，恢复出来会缺内容。'
                : eligibility.reason === 'binary'
                  ? '这是二进制文件的改动，diff 里没有内容，无法重放。'
                  : '这条记录里没有可应用的 diff。'
      throw new RepoError(ERROR_CODES.TRASH_NOT_RESTORABLE, message)
    }

    // `--whitespace=nowarn` keeps a harmless trailing-space difference from
    // turning a correct replay into a refusal on a repository with strict
    // settings; `--recount` tolerates a hunk header whose counts drifted, which is
    // what a diff that was stored and reloaded can legitimately have.
    const applied = await git.run(['apply', '--whitespace=nowarn', '--recount', '-'], {
      cwd: repoRoot,
      signal,
      stdin: diffText,
      maxBytes: 1024 * 1024,
    })
    if (applied.exitCode !== 0) {
      throw classifyGitFailure({ ...applied, message: `git apply failed: ${applied.stderr.trim()}` })
    }

    const restored = (Array.isArray(entry?.files) ? entry.files : []).map((file) => file.path)

    // Stage what the replay produced, so the list comes back with them ticked.
    //
    // This cannot be folded into the `git apply` above: `apply` accepts no
    // pathspec, and a file the discard had deleted is only a deletion until
    // HEAD sees the restored content — so the pathspec has to run after the
    // apply, against the tree it just wrote. `-A` is required for the same
    // reason it is in `setStaged`: a path that was deleted and is now back (or
    // the reverse) is only stageable with it.
    //
    // A failure here is not fatal to the restore — the files are on disk either
    // way — but it does mean "ticked by default" did not happen, so it is
    // reported rather than swallowed. The caller decides what to say.
    let staged = []
    if (restored.length > 0) {
      const stageResult = await git.run(['add', '-A', '--', ...restored.map(literal)], { cwd: repoRoot, signal })
      if (stageResult.exitCode === 0) staged = restored
    }

    return { restored, staged }
  }

  /**
   * Run the user's Summary script and report what it printed.
   *
   * The script is text from the settings page, run with the repository root as
   * its working directory, so `grep -m1 '^## ' CHANGELOG.md | sed 's/^## //'` is
   * a valid script. It is handed nothing on stdin: the inputs worth naming in a
   * commit are files in the tree, and a script that wants the diff can ask git
   * for it itself.
   *
   * A non-zero exit is reported rather than thrown — a script that finds nothing
   * is an ordinary outcome, and the panel shows its stderr beside the button.
   *
   * @param {string} repoRoot
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ ran: boolean, exitCode?: number, stdout?: string, stderr?: string }>}
   */
  async function runScript(repoRoot, signal, scriptText) {
    // The caller passes the script: the panel edits it in place, so the stored
    // preference wins over the config default. `config.summaryScript` stays as the
    // fallback for a caller that has nothing better to offer.
    const source = typeof scriptText === 'string' ? scriptText : config.summaryScript
    const script = typeof source === 'string' ? source.trim() : ''
    if (script === '') return { ran: false }

    const shell = await scriptPrefix(git, signal)
    // Git for Windows' `sh` is a MinGW program whose tools (`grep`, `sed`, `awk`)
    // live in its own `usr/bin`, which git does *not* add to PATH — so a script
    // that uses them finds nothing unless that directory is put back. This is
    // what git's own `git-bash` wrapper does, and it is the difference between a
    // script that works and one that reports "grep: command not found".
    const env =
      process.platform === 'win32' && shell.length > 0 && shell[0].includes('usr')
        ? { PATH: `${dirname(shell[0])}${process.env.PATH === undefined ? '' : `;${process.env.PATH}`}` }
        : {}

    const result = await git.runAny([...shell, script], { cwd: repoRoot, signal, env })

    return {
      ran: true,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    }
  }

  return {
    readStatus,
    statusOf,
    setStaged,
    commit,
    push,
    fetch,
    fileDiff,
    discard,
    restore,
    canRestore,
    scanRepos,
    runScript,
  }
}
