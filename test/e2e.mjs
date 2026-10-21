#!/usr/bin/env node
/**
 * End-to-end against real git.
 *
 * Everything here runs a real `git` in a real repository under a throwaway
 * directory in the system temp directory, through the real handler and route
 * layers, with only `ctx.subprocess` doubled
 * (the shipped service is not importable from a plugin repository — see
 * `test/helpers/subprocess.mjs`). Nothing is stubbed about git itself: the
 * assertions read `git status`/`git log` output back to check that what the
 * panel believes is what the repository actually contains.
 *
 * Each section builds its own repository. An earlier draft shared one and grew
 * sections that depended on the order the others ran in — which is a fixture
 * bug waiting to be mistaken for a product bug. `freshRepo()` is cheap.
 *
 * The suite is deliberately hostile about one invariant in particular: **a tick
 * is the real index**. That is the claim that makes this plugin safe to use
 * alongside a terminal, and the claim a pathspec-limited commit would quietly
 * break. `S4` proves it by reading git's own status output afterwards.
 *
 * Output is ASCII-only, because a Windows console is not guaranteed to decode
 * anything else, and the failure that matters is the one that gets printed.
 *
 * Exit 0 when every check passed, 1 otherwise. Run directly (`node test/e2e.mjs`)
 * rather than through `node --test`.
 *
 * @module dsh-gitbar-lite/test/e2e
 */

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { GitFailure, createGit } from '../lib/host/git.js'
import { createOpener } from '../lib/host/open.js'
import { createRepo } from '../lib/host/repo.js'
import { createHandlers, createRoute } from '../lib/host/routes.js'
import { createStore } from '../lib/host/store.js'
import { readConfig } from '../lib/index.js'
import { ACTIONS, ERROR_CODES, RPC_ROUTE } from '../lib/shared.js'
import { createFakeSubprocess } from './helpers/subprocess.mjs'

/**
 * Where the fixtures are built: a throwaway directory in the system temp
 * directory, deliberately **not** under the package directory.
 *
 * Several sections are about the workspace having no repository at all (`S1`),
 * or having lost the one it had (`S2`), or having a non-repository directory
 * between it and a repository (`S13`). Every one of them reads "no repository"
 * out of `git rev-parse`, which walks *upward*: a fixture inside the checkout
 * finds the checkout's own repository, and those expectations silently start
 * measuring something else instead of failing.
 *
 * That is not hypothetical. Under `test/.scratch/` the suite was green locally
 * only because the package directory happened to not be a repository yet, and
 * went red the moment it became one — the same eight checks in sections 1, 2
 * and 13, for a reason that had nothing to do with the plugin. `main()` verifies
 * the precondition and fails loudly rather than quietly changing what the suite
 * means.
 *
 * `GITBAR_E2E_SCRATCH` pins the directory instead, which is useful when looking
 * at a failure. A pinned directory is never deleted.
 */
let scratch = ''
const pinnedScratch = process.env.GITBAR_E2E_SCRATCH ?? ''

/** The session every call pretends to come from. */
const SESSION = 'session-e2e'

// ---------------------------------------------------------------- assertions

let checks = 0
let failures = 0
let sectionIndex = 0
const failingSections = []

function section(name) {
  sectionIndex += 1
  console.log(`\n== ${name}`)
  console.log(`__SECTION__ ${sectionIndex} ${name}`)
}

function describe(value) {
  if (typeof value === 'string') {
    return value.length > 400 ? `${JSON.stringify(value.slice(0, 400))}...` : JSON.stringify(value)
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function ok(label, condition, extra) {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    return true
  }
  failures += 1
  console.log(`  FAIL ${label}`)
  failingSections.push(`${sectionIndex}`)
  if (extra !== undefined) console.log(`       ${describe(extra)}`)
  return false
}

function eq(label, got, want) {
  const same = (() => {
    try {
      return JSON.stringify(got) === JSON.stringify(want)
    } catch {
      return got === want
    }
  })()
  checks += 1
  if (same) {
    console.log(`  ok   ${label}`)
    return true
  }
  failures += 1
  console.log(`  FAIL ${label}`)
  failingSections.push(`${sectionIndex}`)
  console.log(`       got:  ${describe(got)}`)
  console.log(`       want: ${describe(want)}`)
  return false
}

// ------------------------------------------------------------------ fixtures

/** Run a real git, for building the repository under test. */
function git(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => resolve({ code: -1, stdout: '', stderr: String(error.message) }))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/** Write a text file (LF endings), creating directories as needed. */
async function put(path, content) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}

/** `git init` plus the identity and line-ending settings a fixture needs. */
async function initRepo(dir) {
  await mkdir(dir, { recursive: true })
  await git(dir, ['init', '-q', '-b', 'main'])
  await git(dir, ['config', 'user.email', 'gitbar@example.invalid'])
  await git(dir, ['config', 'user.name', 'Gitbar Test'])
  // Pin the line endings: this machine's global config has core.autocrlf=true,
  // and a fixture whose bytes depend on the developer's git config is a fixture
  // that fails on someone else's machine for no reason.
  await git(dir, ['config', 'core.autocrlf', 'false'])
  await git(dir, ['config', 'commit.gpgsign', 'false'])
  await git(dir, ['config', 'core.quotepath', 'false'])
}

/** Stage everything and commit. */
async function commitAll(dir, message) {
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '-m', message])
}

/**
 * A repository with a known layout, committed, ready to be dirtied.
 *
 *   a.txt        "one\ntwo\nthree\n"
 *   third.txt    "third file\n"
 *   docs/guide.md "# guide\n"
 */
async function freshRepo(name) {
  const dir = join(scratch, name)
  await initRepo(dir)
  await put(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
  await put(join(dir, 'third.txt'), 'third file\n')
  await put(join(dir, 'docs', 'guide.md'), '# guide\n')
  await commitAll(dir, 'init')
  return dir
}

/** The plugin, wired the way the Loader wires it, on top of a doubled subprocess. */
function createHarness({ workspacePath, stateDir, summaryScript, openWith }) {
  const spawns = []
  const subprocess = createFakeSubprocess({ capture: (entry) => spawns.push(entry) })
  const services = {}

  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    subprocess,
    sessions: { get: (id) => (id === SESSION ? { header: { cwd: workspacePath } } : undefined) },
    get: (name, fallback) => (Object.prototype.hasOwnProperty.call(services, name) ? services[name] : fallback),
    effect: (callback) => {
      const disposer = callback()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    inject: (_deps, callback) => {
      callback(ctx)
      return () => {}
    },
  }

  const config = readConfig({
    stateDir,
    timeoutMs: 60000,
    ...(summaryScript === undefined ? {} : { summaryScript }),
    ...(openWith === undefined ? {} : { openWith }),
  })
  const gitRunner = createGit(ctx, config)
  const store = createStore(ctx, config)
  const repo = createRepo(gitRunner, config)
  const opener = createOpener(ctx, config)
  const handlers = createHandlers({ ctx, git: gitRunner, repo, store, opener })
  const route = createRoute({ handlers })

  /** Call one action through the real route, exactly as the browser half does. */
  async function call(action, payload = {}) {
    const request = new Request(`http://dsh.internal${RPC_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
    })
    const response = await route.fetch(request)
    const body = await response.json()
    return { status: response.status, body }
  }

  /** Assert an action failed with a specific code. */
  async function expectFailure(action, payload, code) {
    const result = await call(action, payload)
    ok(`${action} -> ${code}`, result.body?.ok === false && result.body?.error?.code === code, result.body)
    return result
  }

  /** The file entry for one path in a status payload. */
  const fileOf = (payload, path) => (payload.files ?? []).find((file) => file.path === path)

  return { ctx, subprocess, config, git: gitRunner, store, repo, opener, handlers, route, call, expectFailure, spawns, fileOf }
}

/**
 * Wait for something a fire-and-forget child does.
 *
 * Opening a file returns as soon as the child is started — an editor outlives the
 * request — so the only honest way to assert that the program really ran is to
 * wait for the mark it leaves.
 */
async function waitFor(predicate, timeoutMs = 8000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await predicate()) return true
    } catch {
      // Not there yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

/** Read a JSON file from the plugin's state directory. */
async function readState(stateDir, name) {
  return JSON.parse(await readFile(join(stateDir, name), 'utf8'))
}

/** Real `git status --porcelain -z`, as raw records so paths stay unquoted. */
async function realStatus(dir) {
  const result = await git(dir, ['status', '--porcelain=v1', '-z'])
  return result.stdout.split('\0').filter((record) => record !== '')
}

// --------------------------------------------------------------------- suite

async function main() {
  scratch = pinnedScratch === '' ? await mkdtemp(join(tmpdir(), 'dsh-gitbar-lite-e2e-')) : pinnedScratch
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })

  // The precondition the module comment above is about. If this fails, the
  // fixture root sits inside some repository, and every "nothing was detected"
  // expectation below is about to be measured against the wrong baseline.
  const enclosing = await git(scratch, ['rev-parse', '--show-toplevel'])
  ok(
    'the fixture root is outside any repository',
    enclosing.code !== 0,
    enclosing.code === 0 ? `inside ${enclosing.stdout.trim()}` : enclosing.stderr.trim(),
  )
  console.log(`# fixtures: ${scratch}`)

  // ---------------------------------------------------------------- S1: none

  section('S1 a plain directory: the workspace has no repository to bind')
  {
    const plain = join(scratch, 'plain')
    await mkdir(plain, { recursive: true })
    const harness = createHarness({ workspacePath: plain, stateDir: join(scratch, 'state-1') })

    const result = await harness.call(ACTIONS.STATUS, { sessionId: SESSION })
    eq('status is ok', result.body.ok, true)
    eq('no repository bound', result.body.repoRoot, null)
    eq('nothing was detected', result.body.source, 'none')
    eq('no candidates under a plain directory', result.body.candidates, [])
    eq('the workspace path comes back verbatim', result.body.workspacePath, plain)
    eq('a first-time user gets the safe discard default', result.body.prefs.trashHardDelete, false)

    await harness.expectFailure(ACTIONS.STAGE, { sessionId: SESSION, paths: ['a.txt'], staged: true }, ERROR_CODES.NO_REPO)
    await harness.expectFailure(ACTIONS.STATUS, {}, ERROR_CODES.BAD_REQUEST)
    await harness.expectFailure(ACTIONS.STATUS, { sessionId: 'nope' }, ERROR_CODES.NO_WORKSPACE)
  }

  // ------------------------------------------------------------- S2: auto-bind

  section('S2 a repository workspace binds itself, once, and remembers')
  {
    const workspace = await freshRepo('repo-bind')
    const stateDir = join(scratch, 'state-2')
    const harness = createHarness({ workspacePath: workspace, stateDir })

    const first = await harness.call(ACTIONS.STATUS, { sessionId: SESSION })
    eq('status is ok', first.body.ok, true)
    eq('detected the workspace root as the repository', first.body.repoRoot, workspace)
    eq('reported as detection, not as a binding', first.body.source, 'detected')
    eq('repository name', first.body.repoName, 'repo-bind')
    eq('branch head', first.body.branch.head, 'main')
    eq('nothing ahead or behind without an upstream', [first.body.branch.ahead, first.body.branch.behind], [0, 0])
    eq('with no remote the button fetches', first.body.primary, 'fetch')
    eq('clean tree', first.body.counts.files, 0)
    eq('the head commit is remembered for later diffs', first.body.head.subject, 'init')
    eq('and nobody has fetched from this repository yet', first.body.lastFetchAt, null)
    eq('the status carries the rhythm the panel should fetch on', first.body.autoFetchMs, 300000)

    const bindings = await readState(stateDir, 'bindings.json')
    const keys = Object.keys(bindings.bindings)
    eq('exactly one binding was written', keys.length, 1)
    eq('keyed by the workspace path, pointing at the repository', bindings.bindings[keys[0]].repoRoot, workspace)

    const second = await harness.call(ACTIONS.STATUS, { sessionId: SESSION })
    eq('the second look uses the binding', second.body.source, 'binding')

    // A binding whose directory is no longer a repository is dropped and
    // re-detected rather than reported as broken.
    await rm(join(workspace, '.git'), { recursive: true, force: true })
    const broken = await harness.call(ACTIONS.STATUS, { sessionId: SESSION })
    eq('a stale binding falls back to detection', broken.body.repoRoot, null)
    eq('and the dead record is gone', (await readState(stateDir, 'bindings.json')).bindings[keys[0]], undefined)
    await initRepo(workspace)
    await commitAll(workspace, 'again')
  }

  // ---------------------------------------------------------- S3: change list

  section('S3 the change list: kinds, stats, ignored files, and the untracked case')
  {
    const workspace = await freshRepo('repo-changes')
    const harness = createHarness({ workspacePath: workspace, stateDir: join(scratch, 'state-3') })

    await put(join(workspace, '.gitignore'), 'ignored.txt\n')
    await git(workspace, ['add', '.gitignore'])
    await git(workspace, ['commit', '-q', '-m', 'ignore'])
    await put(join(workspace, 'ignored.txt'), 'never listed\n')
    await put(join(workspace, 'a.txt'), 'one\nTWO\nthree\nfour\n')
    await put(join(workspace, 'untracked new.txt'), 'brand new\nlines\n')
    await rm(join(workspace, 'docs', 'guide.md'))

    const result = await harness.call(ACTIONS.STATUS, { sessionId: SESSION })
    const byPath = new Map(result.body.files.map((file) => [file.path, file]))

    eq('three changed files', result.body.files.length, 3)
    eq('modified file kind', byPath.get('a.txt')?.kind, 'modified')
    eq('modified file is unstaged', byPath.get('a.txt')?.staged, false)
    eq('modified file stats', [byPath.get('a.txt')?.added, byPath.get('a.txt')?.deleted], [2, 1])
    eq('deleted file kind', byPath.get('docs/guide.md')?.kind, 'deleted')
    eq('untracked file kind', byPath.get('untracked new.txt')?.kind, 'untracked')
    eq('untracked file is never staged', byPath.get('untracked new.txt')?.staged, false)
    eq('untracked file is flagged as synthesized', byPath.get('untracked new.txt')?.synthesized, true)
    eq('untracked line count', byPath.get('untracked new.txt')?.added, 2)
    eq('an ignored file is not in the list', byPath.has('ignored.txt'), false)
    eq('and .gitignore itself is clean now', byPath.has('.gitignore'), false)
    eq('counts agree', result.body.counts.files, 3)
    eq('nothing is staged yet', result.body.counts.staged, 0)
  }

  // ------------------------------------------------------------- S4: the index

  section('S4 a tick is the real index, and git agrees')
  {
    const workspace = join(scratch, 'repo-changes')
    const harness = createHarness({ workspacePath: workspace, stateDir: join(scratch, 'state-4') })

    const staged = await harness.call(ACTIONS.STAGE, { sessionId: SESSION, paths: ['a.txt'], staged: true })
    eq('stage is ok', staged.body.ok, true)
    eq('the ticked file now reads as staged', harness.fileOf(staged.body, 'a.txt')?.staged, true)

    const porcelain = await realStatus(workspace)
    ok('git itself shows a.txt staged', porcelain.some((record) => record === 'M  a.txt'), porcelain)
    ok('the untracked file is still untracked', porcelain.some((record) => record === '?? untracked new.txt'), porcelain)
    ok('the deleted file is still unstaged', porcelain.some((record) => record === ' D docs/guide.md'), porcelain)

    const unstaged = await harness.call(ACTIONS.STAGE, { sessionId: SESSION, paths: ['a.txt'], staged: false })
    eq('unticking clears it again', harness.fileOf(unstaged.body, 'a.txt')?.staged, false)
    ok('git agrees the index is empty again', (await realStatus(workspace)).some((record) => record === ' M a.txt'))

    // A deletion stages and unstages like anything else.
    const stagedDelete = await harness.call(ACTIONS.STAGE, { sessionId: SESSION, paths: ['docs/guide.md'], staged: true })
    eq('a deletion can be staged', harness.fileOf(stagedDelete.body, 'docs/guide.md')?.staged, true)
    ok('git shows it as a staged delete', (await realStatus(workspace)).some((record) => record === 'D  docs/guide.md'))

    // A path git does not know at all must fail loudly, not silently succeed.
    const bogus = await harness.call(ACTIONS.STAGE, { sessionId: SESSION, paths: ['no/such/file.txt'], staged: true })
    ok('staging an unknown path fails loudly', bogus.body.ok === false || bogus.status >= 400, bogus.body)

    await harness.call(ACTIONS.STAGE, { sessionId: SESSION, paths: ['docs/guide.md'], staged: false })
  }

  // ---------------------------------------------------------------- S5: commit

  section('S5 commit: the message goes in over stdin, the body survives')
  {
    const workspace = await freshRepo('repo-commit')
    const harness = createHarness({ workspacePath: workspace, stateDir: join(scratch, 'state-5') })

    await put(join(workspace, 'a.txt'), 'one\ntwo\nthree\nfour\n')
    await harness.call(ACTIONS.STAGE, { sessionId: SESSION, paths: ['a.txt'], staged: true })

    const committed = await harness.call(ACTIONS.COMMIT, {
      sessionId: SESSION,
      summary: 'from the panel',
      description: 'a body line\n\nand a second paragraph',
    })
    eq('commit is ok', committed.body.ok, true)
    eq('summary echoed back', committed.body.commit.summary, 'from the panel')
    ok('a commit oid came back', typeof committed.body.commit.oid === 'string' && committed.body.commit.oid.length > 7)
    eq('the status refreshed in the same call', committed.body.counts.files, 0)

    const log = await git(workspace, ['log', '-1', '--pretty=%s%n---%n%b'])
    ok('git stored the summary', log.stdout.includes('from the panel'), log.stdout)
    ok('git stored the description as the body', log.stdout.includes('a second paragraph'), log.stdout)

    await harness.expectFailure(ACTIONS.COMMIT, { sessionId: SESSION, summary: '   ', description: '' }, ERROR_CODES.EMPTY_SUMMARY)
    await harness.expectFailure(ACTIONS.COMMIT, { sessionId: SESSION, summary: 'nothing staged' }, ERROR_CODES.NOTHING_STAGED)

    // A summary that looks like an option must not become one.
    await put(join(workspace, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n')
    await harness.call(ACTIONS.STAGE, { sessionId: SESSION, paths: ['a.txt'], staged: true })
    const tricky = await harness.call(ACTIONS.COMMIT, { sessionId: SESSION, summary: '-not-an-option', description: '--also-not' })
    eq('a leading dash is just text', tricky.body.ok, true)
    eq('and git stored it verbatim', (await git(workspace, ['log', '-1', '--pretty=%s'])).stdout.trim(), '-not-an-option')

    // Untracked files are not committed by accident.
    await put(join(workspace, 'loose.txt'), 'never ticked\n')
    await put(join(workspace, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\n')
    await harness.call(ACTIONS.STAGE, { sessionId: SESSION, paths: ['a.txt'], staged: true })
    await harness.call(ACTIONS.COMMIT, { sessionId: SESSION, summary: 'partial' })
    ok('the untracked file was NOT committed', (await realStatus(workspace)).some((record) => record === '?? loose.txt'))
  }

  // ----------------------------------------------------------------- S6: diff

  section('S6 per-file diff, tracked and untracked')
  {
    const workspace = await freshRepo('repo-diff')
    const harness = createHarness({ workspacePath: workspace, stateDir: join(scratch, 'state-6') })

    await put(join(workspace, 'a.txt'), 'one\ntwo\nfive\n')
    const tracked = await harness.call(ACTIONS.FILE_DIFF, { sessionId: SESSION, path: 'a.txt' })
    eq('diff is ok', tracked.body.ok, true)
    eq('diff kind', tracked.body.diff.kind, 'modified')
    ok('diff has a hunk header', tracked.body.diff.text.includes('@@'), tracked.body.diff.text)
    ok('diff marks the added line', tracked.body.diff.text.includes('+five'), tracked.body.diff.text)
    ok('diff marks the removed line', tracked.body.diff.text.includes('-three'), tracked.body.diff.text)
    eq('diff line numbers agree with git', [tracked.body.diff.added, tracked.body.diff.deleted], [1, 1])

    await put(join(workspace, 'untracked new.txt'), 'brand new\nlines\n')
    const untracked = await harness.call(ACTIONS.FILE_DIFF, { sessionId: SESSION, path: 'untracked new.txt' })
    eq('untracked diff kind', untracked.body.diff.kind, 'untracked')
    ok('untracked diff is a new-file diff', untracked.body.diff.text.includes('new file mode 100644'), untracked.body.diff.text)
    ok('untracked diff has /dev/null on the left', untracked.body.diff.text.includes('--- /dev/null'), untracked.body.diff.text)
    ok('untracked diff carries the content', untracked.body.diff.text.includes('+brand new'), untracked.body.diff.text)
    eq('untracked diff counts every line as added', untracked.body.diff.added, 2)

    const clean = await harness.call(ACTIONS.FILE_DIFF, { sessionId: SESSION, path: 'docs/nothing.md' })
    eq('an unknown path is not an error, it is empty', clean.body.ok, true)
    eq('and reports nothing to show', clean.body.diff.kind, 'clean')

    const binaryPath = join(workspace, 'blob.bin')
    await writeFile(binaryPath, Buffer.from([1, 2, 3, 0, 4, 5, 6, 7]))
    const binary = await harness.call(ACTIONS.FILE_DIFF, { sessionId: SESSION, path: 'blob.bin' })
    eq('a binary file is still diffable, as a notice', binary.body.ok, true)
    eq('and is marked binary', binary.body.diff.binary, true)
    ok('without dumping bytes', binary.body.diff.text.includes('Binary files'), binary.body.diff.text)
  }

  // ------------------------------------------------- S7: discard one file, soft

  section('S7 discard one tracked file: archive first, then restore')
  {
    const workspace = await freshRepo('repo-discard-file')
    const stateDir = join(scratch, 'state-7')
    const harness = createHarness({ workspacePath: workspace, stateDir })

    await put(join(workspace, 'a.txt'), 'one\nTWO\nthree\nfour\n')
    await harness.call(ACTIONS.STAGE, { sessionId: SESSION, paths: ['a.txt'], staged: true })
    await put(join(workspace, 'a.txt'), 'one\nTWO\nthree\nfour\nSEVEN\n')

    const before = await harness.call(ACTIONS.STATUS, { sessionId: SESSION })
    const head = before.body.head

    const discarded = await harness.call(ACTIONS.DISCARD, { sessionId: SESSION, paths: ['a.txt'], hardDelete: false })
    eq('discard is ok', discarded.body.ok, true)
    eq('scope is one file', discarded.body.discard.scope, 'file')
    eq('one path was restored', discarded.body.discard.restored, ['a.txt'])
    eq('nothing was deleted from disk', discarded.body.discard.deleted, [])
    eq('the file is gone from the change list', discarded.body.files.some((file) => file.path === 'a.txt'), false)
    eq('and the status came back in the same call', discarded.body.counts.files, 0)

    eq('the file is back to its committed content', await readFile(join(workspace, 'a.txt'), 'utf8'), 'one\ntwo\nthree\n')
    ok('git agrees the tree is clean', (await realStatus(workspace)).length === 0)

    const trash = await harness.call(ACTIONS.TRASH_LIST, { sessionId: SESSION })
    eq('one trash entry', trash.body.entries.length, 1)
    const entry = trash.body.entries[0]
    eq('trash scope', entry.scope, 'file')
    eq('trash records the base commit it was a diff against', entry.base.oid, head.oid)
    eq('trash records which files were discarded', entry.files.map((file) => file.path), ['a.txt'])
    ok('trash records the base commit subject', entry.base.subject === 'init', entry.base)
    ok('the entry knows which repository it came from', entry.repoRoot === workspace, entry)
    // Both the staged edit and the second edit on top of it are part of what was
    // discarded, so the archived numbers are the whole change against HEAD.
    eq('and the per-file stats survived the archive', [entry.files[0].added, entry.files[0].deleted], [3, 1])

    const detail = await harness.call(ACTIONS.TRASH_DIFF, { sessionId: SESSION, id: entry.id })
    eq('the archived diff is readable', detail.body.ok, true)
    ok('the archived diff contains the discarded line', detail.body.text.includes('+SEVEN'), detail.body.text)
    ok('the archived diff names the file', detail.body.text.includes('a.txt'), detail.body.text)

    await harness.expectFailure(ACTIONS.TRASH_DIFF, { id: 'does-not-exist' }, ERROR_CODES.TRASH_NOT_FOUND)
  }

  // ------------------------------------------------------- S8: discard untracked

  section('S8 discard an untracked file: capture the content, then delete it')
  {
    const workspace = await freshRepo('repo-discard-untracked')
    const harness = createHarness({ workspacePath: workspace, stateDir: join(scratch, 'state-8') })

    await put(join(workspace, 'untracked new.txt'), 'brand new\nlines\n')
    const before = await harness.call(ACTIONS.STATUS, { sessionId: SESSION })
    ok('the untracked file is there first', before.body.files.some((file) => file.path === 'untracked new.txt'))

    const discarded = await harness.call(ACTIONS.DISCARD, { sessionId: SESSION, paths: ['untracked new.txt'], hardDelete: false })
    eq('discard is ok', discarded.body.ok, true)
    eq('the file was deleted from disk', discarded.body.discard.deleted, ['untracked new.txt'])
    eq('nothing needed restoring', discarded.body.discard.restored, [])

    const exists = await readFile(join(workspace, 'untracked new.txt'), 'utf8').then(
      () => true,
      () => false,
    )
    eq('and it is really gone', exists, false)

    const trash = await harness.call(ACTIONS.TRASH_LIST, { sessionId: SESSION })
    eq('one trash entry', trash.body.entries.length, 1)
    const detail = await harness.call(ACTIONS.TRASH_DIFF, { sessionId: SESSION, id: trash.body.entries[0].id })
    ok('the content survived as a new-file diff', detail.body.text.includes('+brand new'), detail.body.text)
    ok('the diff says the file is new', detail.body.text.includes('new file mode'), detail.body.text)

    // A newly-added (staged) file is the same story: it must not be left behind.
    await put(join(workspace, 'staged new.txt'), 'staged then discarded\n')
    await harness.call(ACTIONS.STAGE, { sessionId: SESSION, paths: ['staged new.txt'], staged: true })
    const second = await harness.call(ACTIONS.DISCARD, { sessionId: SESSION, paths: ['staged new.txt'], hardDelete: false })
    eq('a staged new file discards too', second.body.ok, true)
    eq('and is removed from disk as well', await readFile(join(workspace, 'staged new.txt'), 'utf8').then(() => false, () => true), true)
    eq('with a clean index afterwards', (await realStatus(workspace)).length, 0)
  }

  // ---------------------------------------------------------- S9: hard delete

  section('S9 "delete for good": no archive, and the choice is remembered')
  {
    const workspace = await freshRepo('repo-harddelete')
    const stateDir = join(scratch, 'state-9')
    const harness = createHarness({ workspacePath: workspace, stateDir })

    await put(join(workspace, 'a.txt'), 'one\ntwo\nthree\nGONE\n')
    const hard = await harness.call(ACTIONS.DISCARD, { sessionId: SESSION, paths: ['a.txt'], hardDelete: true })
    eq('discard is ok', hard.body.ok, true)
    eq('nothing was archived', hard.body.discard.trashed, null)
    eq('the file was still restored', (await readFile(join(workspace, 'a.txt'), 'utf8')).includes('GONE'), false)
    eq('the trash stayed empty', (await harness.call(ACTIONS.TRASH_LIST, { sessionId: SESSION })).body.entries.length, 0)
    eq('the last choice was persisted', (await readState(stateDir, 'prefs.json')).trashHardDelete, true)

    // And flipping it back works too, so the preference is a mirror, not a latch.
    await put(join(workspace, 'a.txt'), 'one\ntwo\nthree\nBACK\n')
    await harness.call(ACTIONS.DISCARD, { sessionId: SESSION, paths: ['a.txt'], hardDelete: false })
    eq('the preference follows the other way too', (await readState(stateDir, 'prefs.json')).trashHardDelete, false)
    eq('and this time there is an entry', (await harness.call(ACTIONS.TRASH_LIST, { sessionId: SESSION })).body.entries.length, 1)

    // Discarding nothing at all is refused rather than archiving an empty diff.
    await harness.expectFailure(ACTIONS.DISCARD, { sessionId: SESSION, paths: null, hardDelete: false }, ERROR_CODES.BAD_REQUEST)
  }

  // ------------------------------------------------------------ S10: discard all

  section('S10 discard all changes: one diff, not one per file')
  {
    const workspace = await freshRepo('repo-discard-all')
    const stateDir = join(scratch, 'state-10')
    const harness = createHarness({ workspacePath: workspace, stateDir })

    await put(join(workspace, 'a.txt'), 'one\ntwo\nthree\nALL-1\n')
    await put(join(workspace, 'third.txt'), 'third file changed\n')
    await put(join(workspace, 'brand new one.txt'), 'first new file\n')
    await put(join(workspace, 'brand new two.txt'), 'second new file\n')
    await rm(join(workspace, 'docs', 'guide.md'))

    const before = await harness.call(ACTIONS.STATUS, { sessionId: SESSION })
    eq('five changes to discard', before.body.counts.files, 5)

    const discarded = await harness.call(ACTIONS.DISCARD, { sessionId: SESSION, paths: null, hardDelete: false })
    eq('discard is ok', discarded.body.ok, true)
    eq('scope is the whole working tree', discarded.body.discard.scope, 'all')
    eq('the tree is clean afterwards', discarded.body.counts.files, 0)
    ok('the deleted file came back', await readFile(join(workspace, 'docs', 'guide.md'), 'utf8').then(() => true, () => false))
    ok('the untracked files are gone from disk', await readFile(join(workspace, 'brand new one.txt'), 'utf8').then(() => false, () => true))
    eq('two tracked paths were restored', discarded.body.discard.restored.length, 3)
    eq('two untracked paths were deleted', discarded.body.discard.deleted.length, 2)

    const trash = await harness.call(ACTIONS.TRASH_LIST, { sessionId: SESSION })
    eq('exactly one entry for the whole discard', trash.body.entries.length, 1)
    const entry = trash.body.entries[0]
    eq(
      'the entry lists every file it covered',
      entry.files.map((file) => file.path).sort(),
      ['a.txt', 'brand new one.txt', 'brand new two.txt', 'docs/guide.md', 'third.txt'],
    )
    eq('the entry scope', entry.scope, 'all')

    const detail = await harness.call(ACTIONS.TRASH_DIFF, { sessionId: SESSION, id: entry.id })
    const blocks = detail.body.text.split('diff --git ').length - 1
    eq('the archived diff is one blob containing every file', blocks, 5)
    ok('the blob carries the tracked edit', detail.body.text.includes('+ALL-1'), detail.body.text)
    ok('the blob carries the untracked content', detail.body.text.includes('+first new file'), detail.body.text)
    ok('the blob carries the deletion', detail.body.text.includes('deleted file mode'), detail.body.text)
    ok('the blob carries the synthesized new-file mode', detail.body.text.includes('new file mode 100644'), detail.body.text)

    ok('and git agrees the working tree is clean', (await realStatus(workspace)).length === 0, await realStatus(workspace))

    // Empty directories the discard emptied are pruned.
    await mkdir(join(workspace, 'emptied', 'deeper'), { recursive: true })
    await put(join(workspace, 'emptied', 'deeper', 'only.txt'), 'only\n')
    await harness.call(ACTIONS.DISCARD, { sessionId: SESSION, paths: null, hardDelete: false })
    ok(
      'the directory a discard emptied is pruned',
      await readFile(join(workspace, 'emptied'), 'utf8').then(() => false, () => true),
    )
  }

  // --------------------------------------------------- S11: renames and deletes

  section('S11 restoring a rename and a staged delete, not just an edit')
  {
    const workspace = await freshRepo('repo-rename')
    const harness = createHarness({ workspacePath: workspace, stateDir: join(scratch, 'state-11') })

    await git(workspace, ['mv', 'third.txt', 'renamed third.txt'])
    const renamed = await harness.call(ACTIONS.STATUS, { sessionId: SESSION })
    const renameEntry = harness.fileOf(renamed.body, 'renamed third.txt')
    eq('the rename is reported as a rename', renameEntry?.kind, 'renamed')
    eq('the original path travels with it', renameEntry?.origPath, 'third.txt')

    const afterRename = await harness.call(ACTIONS.DISCARD, { sessionId: SESSION, paths: ['renamed third.txt'], hardDelete: false })
    eq('discarding the rename is ok', afterRename.body.ok, true)
    ok('the original name is back', await readFile(join(workspace, 'third.txt'), 'utf8').then(() => true, () => false))
    ok('the new name is gone', await readFile(join(workspace, 'renamed third.txt'), 'utf8').then(() => false, () => true))
    eq('and the tree is clean', (await realStatus(workspace)).length, 0)

    const afterRenameTrash = await harness.call(ACTIONS.TRASH_LIST, { sessionId: SESSION })
    const renameDiff = await harness.call(ACTIONS.TRASH_DIFF, { sessionId: SESSION, id: afterRenameTrash.body.entries[0].id })
    ok('the archived diff kept the rename shape', renameDiff.body.text.includes('rename from third.txt'), renameDiff.body.text)

    await git(workspace, ['rm', '-q', 'third.txt'])
    const stagedDelete = await harness.call(ACTIONS.STATUS, { sessionId: SESSION })
    eq('the staged delete is reported as deleted', stagedDelete.body.files[0]?.kind, 'deleted')
    const afterDelete = await harness.call(ACTIONS.DISCARD, { sessionId: SESSION, paths: ['third.txt'], hardDelete: false })
    eq('discarding the staged delete is ok', afterDelete.body.ok, true)
    eq('the file is restored', await readFile(join(workspace, 'third.txt'), 'utf8'), 'third file\n')
    eq('and the tree is clean again', (await realStatus(workspace)).length, 0)
  }

  // ------------------------------------------------------------- S12: conflicts

  section('S12 a conflicted file is refused, with one clear sentence')
  {
    const workspace = join(scratch, 'conflict')
    await initRepo(workspace)
    await put(join(workspace, 'shared.txt'), 'base\n')
    await commitAll(workspace, 'base')
    await git(workspace, ['checkout', '-q', '-b', 'other'])
    await put(join(workspace, 'shared.txt'), 'from other\n')
    await commitAll(workspace, 'other side')
    await git(workspace, ['checkout', '-q', 'main'])
    await put(join(workspace, 'shared.txt'), 'from main\n')
    await commitAll(workspace, 'main side')
    const merge = await git(workspace, ['merge', 'other'])
    ok('the fixture really is in conflict', merge.code !== 0, merge)

    const harness = createHarness({ workspacePath: workspace, stateDir: join(scratch, 'state-12') })
    const status = await harness.call(ACTIONS.STATUS, { sessionId: SESSION })
    eq('the conflict is reported as a conflict', harness.fileOf(status.body, 'shared.txt')?.kind, 'conflicted')
    eq('and counted', status.body.counts.conflicted, 1)

    const refusal = await harness.expectFailure(
      ACTIONS.DISCARD,
      { sessionId: SESSION, paths: ['shared.txt'], hardDelete: false },
      ERROR_CODES.CONFLICT,
    )
    ok('the message says what to do instead', /冲突/.test(refusal.body.error.message), refusal.body.error.message)

    // Discard-all must not quietly skip the conflict either.
    await harness.expectFailure(ACTIONS.DISCARD, { sessionId: SESSION, paths: null, hardDelete: false }, ERROR_CODES.CONFLICT)

    const commitRefusal = await harness.expectFailure(
      ACTIONS.COMMIT,
      { sessionId: SESSION, summary: 'should not commit' },
      ERROR_CODES.CONFLICT,
    )
    ok('committing an unresolved conflict is refused too', /冲突/.test(commitRefusal.body.error.message), commitRefusal.body.error.message)
    ok('and nothing was committed onto main by accident', (await git(workspace, ['log', '-1', '--pretty=%s'])).stdout.includes('main side'))
  }

  // ------------------------------------------------------------- S13: binding

  section('S13 choosing a repository by hand, and refusing a bad one')
  {
    const workspace = join(scratch, 'plain-bind')
    const stateDir = join(scratch, 'state-13')
    const harness = createHarness({ workspacePath: workspace, stateDir })

    const nested = join(workspace, 'projects', 'inner')
    await initRepo(nested)
    await put(join(nested, 'inner.txt'), 'inner\n')
    await commitAll(nested, 'inner init')

    const scanned = await harness.call(ACTIONS.REPOS, { sessionId: SESSION })
    eq('the scan is ok', scanned.body.ok, true)
    const found = scanned.body.candidates.map((candidate) => candidate.path)
    ok('the scan found the nested repository', found.includes(nested), found)
    eq('and marks it as not the workspace root', scanned.body.candidates.find((c) => c.path === nested)?.isWorkspaceRoot, false)

    await harness.expectFailure(ACTIONS.BIND, { sessionId: SESSION, repoRoot: join(workspace, 'projects') }, ERROR_CODES.NO_REPO)
    await harness.expectFailure(ACTIONS.BIND, { sessionId: SESSION, repoRoot: 42 }, ERROR_CODES.BAD_REQUEST)

    const bound = await harness.call(ACTIONS.BIND, { sessionId: SESSION, repoRoot: nested })
    eq('binding succeeds', bound.body.ok, true)
    eq('and reports the repository', bound.body.repoRoot, nested)

    const after = await harness.call(ACTIONS.STATUS, { sessionId: SESSION })
    eq('the workspace now resolves to the chosen repository', after.body.repoRoot, nested)
    eq('as a binding, not a detection', after.body.source, 'binding')

    const cleared = await harness.call(ACTIONS.BIND, { sessionId: SESSION, repoRoot: null })
    eq('clearing works', cleared.body.ok, true)
    eq('and the workspace is unbound again', (await harness.call(ACTIONS.STATUS, { sessionId: SESSION })).body.repoRoot, null)
  }

  // -------------------------------------------------------------- S14: trash

  section('S14 trash management: delete one, clear the rest, filter by repository')
  {
    const workspace = await freshRepo('repo-trash')
    const stateDir = join(scratch, 'state-14')
    const harness = createHarness({ workspacePath: workspace, stateDir })

    for (const suffix of ['one', 'two', 'three']) {
      await put(join(workspace, 'a.txt'), `one\ntwo\nthree\n${suffix}\n`)
      await harness.call(ACTIONS.DISCARD, { sessionId: SESSION, paths: ['a.txt'], hardDelete: false })
    }

    const list = await harness.call(ACTIONS.TRASH_LIST, { sessionId: SESSION })
    eq('three entries', list.body.entries.length, 3)
    eq('only this repository by default', list.body.showAll, false)
    const newest = list.body.entries[0]
    eq('newest first', await harness.call(ACTIONS.TRASH_DIFF, { sessionId: SESSION, id: newest.id }).then((r) => r.body.text.includes('+three')), true)

    const middle = list.body.entries[1]
    const deleted = await harness.call(ACTIONS.TRASH_DELETE, { sessionId: SESSION, id: middle.id })
    eq('delete is ok', deleted.body.ok, true)
    eq('two entries left', (await harness.call(ACTIONS.TRASH_LIST, { sessionId: SESSION })).body.entries.length, 2)
    await harness.expectFailure(ACTIONS.TRASH_DELETE, { sessionId: SESSION, id: middle.id }, ERROR_CODES.TRASH_NOT_FOUND)
    await harness.expectFailure(ACTIONS.TRASH_DIFF, { sessionId: SESSION, id: middle.id }, ERROR_CODES.TRASH_NOT_FOUND)

    // A second repository's entries are hidden until asked for.
    const other = await freshRepo('repo-trash-other')
    const otherHarness = createHarness({ workspacePath: other, stateDir })
    await put(join(other, 'a.txt'), 'one\ntwo\nthree\nother\n')
    await otherHarness.call(ACTIONS.DISCARD, { sessionId: SESSION, paths: ['a.txt'], hardDelete: false })

    const mine = await harness.call(ACTIONS.TRASH_LIST, { sessionId: SESSION })
    eq('the other repository does not show up', mine.body.entries.length, 2)
    eq('but the total is reported', mine.body.total, 3)
    const all = await harness.call(ACTIONS.TRASH_LIST, { sessionId: SESSION, all: true })
    eq('and it appears when asked for', all.body.entries.length, 3)

    const cleared = await harness.call(ACTIONS.TRASH_CLEAR, { sessionId: SESSION })
    eq('clear reports what it removed', cleared.body.removed, 2)
    eq('nothing left for this repository', (await harness.call(ACTIONS.TRASH_LIST, { sessionId: SESSION })).body.entries.length, 0)
    eq('and the other repository kept its entry', (await harness.call(ACTIONS.TRASH_LIST, { sessionId: SESSION, all: true })).body.entries.length, 1)
    eq('the index on disk agrees', (await readState(stateDir, 'trash/index.json')).entries.length, 1)

    const swept = await harness.call(ACTIONS.TRASH_CLEAR, { sessionId: SESSION, all: true })
    eq('a global clear empties everything', swept.body.removed, 1)
    eq('index is empty', (await readState(stateDir, 'trash/index.json')).entries.length, 0)
  }

  // -------------------------------------------------------- S15: push and fetch

  section('S15 push and fetch against a local bare remote, and the failed push')
  {
    const workspace = join(scratch, 'remote-repo')
    const remote = join(scratch, 'origin.git')
    await mkdir(remote, { recursive: true })
    await git(remote, ['init', '-q', '--bare', '-b', 'main'])
    await initRepo(workspace)
    await put(join(workspace, 'a.txt'), 'one\n')
    await commitAll(workspace, 'init')
    await git(workspace, ['remote', 'add', 'origin', remote])

    const harness = createHarness({ workspacePath: workspace, stateDir: join(scratch, 'state-15') })

    const beforePush = await harness.call(ACTIONS.STATUS, { sessionId: SESSION })
    eq('the remote is listed', beforePush.body.remotes, ['origin'])
    eq('with no upstream the button publishes', beforePush.body.primary, 'publish')
    eq('and the branch has no upstream yet', beforePush.body.branch.upstream, null)

    const pushed = await harness.call(ACTIONS.PUSH, { sessionId: SESSION })
    eq('push is ok', pushed.body.ok, true)
    eq('it published the branch', pushed.body.outcome.published, true)
    eq('the branch now tracks origin/main', pushed.body.branch.upstream, 'origin/main')
    eq('nothing left to push', pushed.body.branch.ahead, 0)
    eq('so the button fetches again', pushed.body.primary, 'fetch')

    // A local commit makes the button a push again.
    await put(join(workspace, 'a.txt'), 'one\ntwo\n')
    await harness.call(ACTIONS.STAGE, { sessionId: SESSION, paths: ['a.txt'], staged: true })
    const commitAndPush = await harness.call(ACTIONS.COMMIT_PUSH, { sessionId: SESSION, summary: 'second' })
    eq('commit-and-push is ok', commitAndPush.body.ok, true)
    eq('the commit half succeeded', commitAndPush.body.commit.summary, 'second')
    eq('the push half succeeded', commitAndPush.body.push.ok, true)
    eq('and there is nothing left ahead', commitAndPush.body.branch.ahead, 0)

    const fetched = await harness.call(ACTIONS.FETCH, { sessionId: SESSION })
    eq('fetch is ok', fetched.body.ok, true)
    eq('fetch reports the action it performed', fetched.body.action, 'fetch')

    // A remote that moves on without us turns push into a rejection, and the
    // commit half of commit-and-push must still be reported as done.
    const other = join(scratch, 'other-clone')
    await git(scratch, ['clone', '-q', remote, other])
    await git(other, ['config', 'user.email', 'other@example.invalid'])
    await git(other, ['config', 'user.name', 'Other'])
    await put(join(other, 'a.txt'), 'from the other clone\n')
    await commitAll(other, 'other wins')
    await git(other, ['push', '-q', 'origin', 'main'])

    await put(join(workspace, 'a.txt'), 'locally different\n')
    await harness.call(ACTIONS.STAGE, { sessionId: SESSION, paths: ['a.txt'], staged: true })
    const rejected = await harness.call(ACTIONS.COMMIT_PUSH, { sessionId: SESSION, summary: 'will not push' })
    eq('commit-and-push still reports ok', rejected.body.ok, true)
    eq('because the commit really did happen', rejected.body.commit.summary, 'will not push')
    eq('and only the push failed', rejected.body.push.ok, false)
    eq('with a rejection code', rejected.body.push.error.code, ERROR_CODES.PUSH_REJECTED)
    ok('and a sentence that says what to do', /Pull/.test(rejected.body.push.error.message), rejected.body.push.error)
    // The push fetched first, so the refusal came from knowing the branch was
    // behind — not from the push being rejected and being told afterwards.
    eq('and it fetched before deciding', rejected.body.push.fetched, true)
    ok('and it knows how far behind it is', /落后 1 个/.test(rejected.body.push.error.message), rejected.body.push.error.message)

    const ahead = await harness.call(ACTIONS.STATUS, { sessionId: SESSION })
    // `behind` counts commits the *local* remote-tracking ref knows about. The
    // push already fetched, so the count is current rather than stale — which is
    // the whole point of fetching before pushing, and worth pinning down: without
    // it this read 0 and the panel would have offered a push that cannot succeed.
    eq('the branch is one ahead and one behind, already known', [ahead.body.branch.ahead, ahead.body.branch.behind], [1, 1])
    eq('so the button offers a push', ahead.body.primary, 'push')

    const refreshed = await harness.call(ACTIONS.FETCH, { sessionId: SESSION })
    eq('fetch is ok', refreshed.body.ok, true)
    eq('and now the branch knows it is behind too', [refreshed.body.branch.ahead, refreshed.body.branch.behind], [1, 1])
    // The panel reports when the repository last talked to a remote, and it reads
    // that off FETCH_HEAD rather than remembering it, so a fetch always shows up.
    ok('and the status says when the last fetch happened', typeof refreshed.body.lastFetchAt === 'string', refreshed.body.lastFetchAt)
    // The panel cannot read the host's config, so the rhythm it should fetch on
    // rides along with the status it already reads. Zero would mean "never,
    // alone"; this harness leaves it at the default.
    eq('the status carries the panel auto-fetch rhythm', refreshed.body.autoFetchMs, 300000)

    // No remote at all is a clear failure, not a silent no-op.
    const lonely = await freshRepo('repo-no-remote')
    const lonelyHarness = createHarness({ workspacePath: lonely, stateDir: join(scratch, 'state-15b') })
    await lonelyHarness.expectFailure(ACTIONS.FETCH, { sessionId: SESSION }, ERROR_CODES.NO_REMOTE)
    await lonelyHarness.expectFailure(ACTIONS.PUSH, { sessionId: SESSION }, ERROR_CODES.NO_REMOTE)
    // A repository with no remote still reports the rhythm: deciding *not* to
    // fetch belongs to the panel, which is the side that knows whether the tab is
    // visible, not to the repository layer.
    eq('and a repository with no remote reports it too', (await lonelyHarness.call(ACTIONS.STATUS, { sessionId: SESSION })).body.autoFetchMs, 300000)
  }

  // ------------------------------------------------------- S16: repository scan

  section('S16 the repository scan stays inside its depth budget')
  {
    const workspace = join(scratch, 'deep')
    await mkdir(join(workspace, 'a', 'b', 'c', 'd', 'e'), { recursive: true })
    await initRepo(join(workspace, 'a', 'b', 'repo-at-two'))
    await commitAll(join(workspace, 'a', 'b', 'repo-at-two'), 'x')
    await initRepo(join(workspace, 'a', 'b', 'c', 'd', 'e', 'repo-at-five'))
    await commitAll(join(workspace, 'a', 'b', 'c', 'd', 'e', 'repo-at-five'), 'x')
    // A vendored checkout inside a repository is not descended into.
    await initRepo(join(workspace, 'a', 'b', 'repo-at-two', 'node_modules', 'vendored'))
    await commitAll(join(workspace, 'a', 'b', 'repo-at-two', 'node_modules', 'vendored'), 'x')

    const harness = createHarness({ workspacePath: workspace, stateDir: join(scratch, 'state-16') })
    const scan = await harness.call(ACTIONS.REPOS, { sessionId: SESSION })
    const found = scan.body.candidates.map((candidate) => candidate.name)
    ok('a repository two levels down is offered', found.includes('repo-at-two'), found)
    eq('a repository five levels down is not (depth 3)', found.includes('repo-at-five'), false)
    eq('and nothing inside one is descended into', found.includes('vendored'), false)
    ok('the scan reports how much it looked at', scan.body.scanned > 0, scan.body.scanned)
  }

  // ------------------------------------------------------------ S17: the route

  section('S17 the route itself: guards, status codes, and no caching')
  {
    const workspace = await freshRepo('repo-route')
    const harness = createHarness({ workspacePath: workspace, stateDir: join(scratch, 'state-17') })

    const okCall = await harness.call(ACTIONS.STATUS, { sessionId: SESSION })
    eq('a good call is 200', okCall.status, 200)

    const unknown = await harness.call('nope', {})
    eq('an unknown action is a 400', unknown.status, 400)
    eq('with a code the client can branch on', unknown.body.error.code, ERROR_CODES.UNKNOWN_ACTION)

    const badJson = await harness.route.fetch(
      new Request(`http://dsh.internal${RPC_ROUTE}`, { method: 'POST', body: '{not json' }),
    )
    eq('a body that is not JSON is a 400', badJson.status, 400)
    eq('and explains itself', (await badJson.json()).error.code, ERROR_CODES.BAD_REQUEST)

    const arrayBody = await harness.route.fetch(new Request(`http://dsh.internal${RPC_ROUTE}`, { method: 'POST', body: '[]' }))
    eq('an array body is refused', arrayBody.status, 400)

    await harness.expectFailure(ACTIONS.STAGE, { sessionId: SESSION, paths: [], staged: true }, ERROR_CODES.BAD_REQUEST)
    await harness.expectFailure(ACTIONS.STAGE, { sessionId: SESSION, paths: 'a.txt', staged: true }, ERROR_CODES.BAD_REQUEST)

    const response = await harness.route.fetch(
      new Request(`http://dsh.internal${RPC_ROUTE}`, { method: 'POST', body: JSON.stringify({ action: ACTIONS.PREFS }) }),
    )
    eq('responses are never cached', response.headers.get('cache-control'), 'no-store')
    ok('and are typed as JSON', /application\/json/.test(response.headers.get('content-type') ?? ''), response.headers.get('content-type'))

    eq('the route path is under /api', harness.route.path, RPC_ROUTE)
    eq('and it is POST-only', harness.route.methods, ['POST'])
    eq('with a buffered body', harness.route.requestBody, 'buffered')
  }

  // --------------------------------------------------------------- S18: prefs

  section('S18 preferences round-trip and stay merged')
  {
    const workspace = await freshRepo('repo-prefs')
    const harness = createHarness({ workspacePath: workspace, stateDir: join(scratch, 'state-18') })

    const initial = await harness.call(ACTIONS.PREFS, {})
    eq('a first-time user gets the safe answer', initial.body.prefs.trashHardDelete, false)
    eq('and sees only their own repository', initial.body.prefs.trashShowAllRepos, false)

    const written = await harness.call(ACTIONS.PREFS, { trashShowAllRepos: true })
    eq('writing one field keeps the other', written.body.prefs.trashHardDelete, false)
    eq('and stores the new one', written.body.prefs.trashShowAllRepos, true)
    eq('it survives a reload', (await harness.call(ACTIONS.PREFS, {})).body.prefs.trashShowAllRepos, true)

    const shown = await harness.call(ACTIONS.TRASH_LIST, { sessionId: SESSION })
    eq('and the trash list honours it', shown.body.showAll, true)
  }

  // ------------------------------------ S19: a workspace nested in a repository

  section('S19 a workspace inside a repository binds to the repository root')
  {
    // This is the behaviour the old `test/.scratch/` fixtures were accidentally
    // leaning on, so it is worth stating on purpose. `git` considers the whole
    // tree above a file to be its repository, and the panel follows git: the
    // change list is repository-scoped, so a workspace in `packages/app` shows
    // paths relative to the repository root, not to the workspace.
    const outer = await freshRepo('repo-nested-workspace')
    const workspace = join(outer, 'packages', 'app')
    await mkdir(workspace, { recursive: true })
    await put(join(workspace, 'main.js'), 'console.log(1)\n')
    const harness = createHarness({ workspacePath: workspace, stateDir: join(scratch, 'state-19') })

    const result = await harness.call(ACTIONS.STATUS, { sessionId: SESSION })
    eq('status is ok', result.body.ok, true)
    eq('the workspace resolves to the repository that contains it', result.body.repoRoot, outer)
    eq('as a detection, because nobody chose it by hand', result.body.source, 'detected')
    eq('the workspace path itself is still the nested directory', result.body.workspacePath, workspace)
    eq('and the nested file is listed under its repository-relative path', result.body.files.map((file) => file.path), [
      'packages/app/main.js',
    ])
  }

  // ------------------------------------- S20: a subprocess that refuses to start

  section('S20 the process layer reports a refused spawn as a git failure')
  {
    // Read off the live service contract rather than guessed: `spawn` "throws
    // synchronously when pre-aborted or when argv, cwd, environment, or grace is
    // invalid before handle creation". A caller that only `await`s the handle
    // never sees that, so it used to reach the route layer unclassified.
    const logger = { info: () => {}, warn: () => {}, error: () => {} }
    const config = readConfig({ stateDir: join(scratch, 'state-20'), timeoutMs: 60000 })

    {
      const runner = createGit({ logger, subprocess: createFakeSubprocess() }, config)
      const controller = new AbortController()
      controller.abort()
      const failure = await runner.run(['status'], { cwd: scratch, signal: controller.signal }).then(
        () => undefined,
        (error) => error,
      )
      ok('a command aborted before it starts rejects', failure !== undefined)
      ok('as a GitFailure rather than a raw throw', failure instanceof GitFailure, failure?.name)
      ok('and says it was aborted', /aborted/i.test(String(failure?.message ?? '')), failure?.message)
      eq('with no exit code to report', failure?.exitCode, null)
    }

    {
      const refused = { ...createFakeSubprocess(), spawn: () => { throw new Error('uv_spawn ENOENT') } }
      const runner = createGit({ logger, subprocess: refused }, config)
      const failure = await runner.run(['status'], { cwd: scratch }).then(() => undefined, (error) => error)
      ok('a spawn the provider refuses outright is a GitFailure too', failure instanceof GitFailure, failure?.name)
      ok('and carries the reason the provider gave', /uv_spawn ENOENT/.test(String(failure?.message ?? '')), failure?.message)
    }

    {
      // A missing git is a distinct code, because the panel has a distinct
      // sentence for it and a generic failure would read as a broken repository.
      const runner = createGit({ logger, subprocess: createFakeSubprocess() }, readConfig({ stateDir: join(scratch, 'state-20'), gitPath: 'definitely-not-this-one' }))
      const failure = await runner.run(['status'], { cwd: scratch }).then(() => undefined, (error) => error)
      eq('an unresolvable git is tagged, not generic', failure?.code, ERROR_CODES.NO_GIT)
    }

    {
      // The environment is where three of the plugin's safety properties live,
      // and it is assembled in exactly one place.
      const seen = []
      const runner = createGit({ logger, subprocess: createFakeSubprocess({ capture: (entry) => seen.push(entry) }) }, config)
      await runner.run(['status'], { cwd: scratch })
      const env = seen.at(-1)?.env ?? {}
      eq('a credential prompt can never hang the child', env.GIT_TERMINAL_PROMPT, '0')
      eq('no optional index locks, so the overlapping reads are safe', env.GIT_OPTIONAL_LOCKS, '0')
      eq('the user git config stays out of the way', env.GIT_CONFIG_COUNT, '0')
      eq('and the output is parsed in one stable locale', env.LC_ALL, 'C')
    }
  }

  // --------------------------------------------------- S21: putting a discard back

  section('S21 a discard can be put back by replaying its diff')
  {
    const workspace = await freshRepo('repo-restore')
    const stateDir = join(scratch, 'state-21')
    const harness = createHarness({ workspacePath: workspace, stateDir })

    await put(join(workspace, 'a.txt'), 'one\ntwo\nthree\nKEEP THIS EDIT\n')
    await put(join(workspace, 'fresh untracked.txt'), 'brand new content\n')
    await put(join(workspace, 'docs', 'guide.md'), '# guide\n## edited\n')

    const discarded = await harness.call(ACTIONS.DISCARD, {
      sessionId: SESSION,
      paths: ['a.txt', 'fresh untracked.txt', 'docs/guide.md'],
      hardDelete: false,
    })
    eq('the discard is ok', discarded.body.ok, true)
    eq('the tracked edit is gone', (await readFile(join(workspace, 'a.txt'), 'utf8')).includes('KEEP THIS EDIT'), false)
    eq(
      'and the untracked file with it',
      await readFile(join(workspace, 'fresh untracked.txt'), 'utf8').then(
        () => false,
        () => true,
      ),
      true,
    )

    // The archive is one diff and nothing else: no second copy of the content.
    const trashDir = join(stateDir, 'trash')
    const archived = (await readdir(trashDir)).filter((name) => name !== 'index.json')
    eq('one file is archived per entry', archived.filter((name) => name.endsWith('.diff')).length, 1)
    eq('and nothing else is written beside it', archived.filter((name) => !name.endsWith('.diff')), [])

    const listed = await harness.call(ACTIONS.TRASH_LIST, { sessionId: SESSION })
    const entry = listed.body.entries[0]
    eq('one entry is archived', listed.body.entries.length, 1)
    eq('and it is offered for restore', entry.restorable?.ok, true)

    // Touching a file after the discard withdraws the offer, because replaying
    // the diff would land on a file that is no longer where it was cut.
    await put(join(workspace, 'a.txt'), 'one\ntwo\nthree\nA NEWER EDIT\n')
    eq('touching a file it archived withdraws the offer', (await harness.call(ACTIONS.TRASH_LIST, { sessionId: SESSION })).body.entries[0].restorable?.ok, false)
    eq('and says why', (await harness.call(ACTIONS.TRASH_LIST, { sessionId: SESSION })).body.entries[0].restorable?.reason, 'changed')
    await harness.expectFailure(ACTIONS.TRASH_RESTORE, { sessionId: SESSION, id: entry.id }, ERROR_CODES.TRASH_NOT_RESTORABLE)
    eq('and the newer edit is still there', (await readFile(join(workspace, 'a.txt'), 'utf8')).includes('A NEWER EDIT'), true)

    // Put the tree back the way the discard left it and the offer returns.
    await put(join(workspace, 'a.txt'), 'one\ntwo\nthree\n')
    eq('the offer returns once the tree matches again', (await harness.call(ACTIONS.TRASH_LIST, { sessionId: SESSION })).body.entries[0].restorable?.ok, true)

    const restored = await harness.call(ACTIONS.TRASH_RESTORE, { sessionId: SESSION, id: entry.id })
    eq('restoring is ok', restored.body.ok, true)
    eq('all three files are named', restored.body.restored.restored.length, 3)
    // The bytes, not just the fact: `git apply` reproduced exactly what was there.
    eq('the edit is back byte for byte', await readFile(join(workspace, 'a.txt'), 'utf8'), 'one\ntwo\nthree\nKEEP THIS EDIT\n')
    eq('the untracked file is recreated', await readFile(join(workspace, 'fresh untracked.txt'), 'utf8'), 'brand new content\n')
    eq('and the other edit too', await readFile(join(workspace, 'docs', 'guide.md'), 'utf8'), '# guide\n## edited\n')

    // What came back is ticked, which in this panel means staged. Read out of the
    // status payload the action itself returned — that is what the panel draws
    // its ticks from, so a check here is the same claim a user makes by looking.
    const ticked = (restored.body.files ?? []).filter((file) => file.staged === true).map((file) => file.path).sort()
    eq('everything restored comes back ticked', ticked, ['a.txt', 'docs/guide.md', 'fresh untracked.txt'])
    eq('and the payload agrees with the tick count', restored.body.counts?.staged, 3)
    eq('the host names what it staged', (restored.body.restored.staged ?? []).slice().sort(), ['a.txt', 'docs/guide.md', 'fresh untracked.txt'])

    // The tick is the real index, so git has to agree with the panel, not just
    // the payload: this is the claim a user checks by typing `git status`.
    // Porcelain v2's `1 XY …` records put the *index* status first, so a `'.'`
    // there is "not staged" whatever the worktree column says — counting `A.`
    // only would miss the two restored files that are staged *modifications*.
    const porcelain = await git(workspace, ['status', '--porcelain=v2', '-z'])
    const stagedRecords = porcelain.stdout.split('\0').filter((record) => record.startsWith('1 ') && record[2] !== '.')
    eq('git agrees that they are staged', stagedRecords.length, 3)

    // The entry is gone once it has been put back. Keeping it would leave a row
    // that can only ever be greyed out — replaying it again would apply the same
    // change a second time — so the list should not still be offering it.
    const afterRestore = await harness.call(ACTIONS.TRASH_LIST, { sessionId: SESSION })
    eq('the entry is consumed by the restore', afterRestore.body.entries.length, 0)
    await harness.expectFailure(ACTIONS.TRASH_RESTORE, { sessionId: SESSION, id: entry.id }, ERROR_CODES.TRASH_NOT_FOUND)

    // --- the reasons a diff cannot be replayed -----------------------------

    // A binary change has no content in its diff, only the words saying so.
    const binary = await freshRepo('repo-restore-binary')
    const binaryHarness = createHarness({ workspacePath: binary, stateDir: join(scratch, 'state-21b') })
    await put(join(binary, 'blob.bin'), '\u0000\u0001binary\n')
    await binaryHarness.call(ACTIONS.DISCARD, { sessionId: SESSION, paths: ['blob.bin'], hardDelete: false })
    eq(
      'a binary entry says its diff cannot be replayed',
      (await binaryHarness.call(ACTIONS.TRASH_LIST, { sessionId: SESSION })).body.entries[0].restorable?.reason,
      'binary',
    )

    // An archive whose blob was deleted by hand has nothing to apply.
    const gone = await freshRepo('repo-restore-gone')
    const goneHarness = createHarness({ workspacePath: gone, stateDir: join(scratch, 'state-21c') })
    await put(join(gone, 'a.txt'), 'one\ntwo\nthree\nX\n')
    await goneHarness.call(ACTIONS.DISCARD, { sessionId: SESSION, paths: ['a.txt'], hardDelete: false })
    const goneEntry = (await goneHarness.call(ACTIONS.TRASH_LIST, { sessionId: SESSION })).body.entries[0]
    await rm(join(scratch, 'state-21c', 'trash', `${goneEntry.id}.diff`), { force: true })
    eq(
      'an entry whose diff file is gone is not offered',
      (await goneHarness.call(ACTIONS.TRASH_LIST, { sessionId: SESSION })).body.entries[0].restorable?.reason,
      'no-diff',
    )
    await goneHarness.expectFailure(ACTIONS.TRASH_RESTORE, { sessionId: SESSION, id: goneEntry.id }, ERROR_CODES.TRASH_NOT_RESTORABLE)
  }

  // -------------------------------------------------------- S22: the summary script

  section('S22 a user script fills the Summary, and can fill the Description too')
  {
    const workspace = await freshRepo('repo-script')
    const stateDir = join(scratch, 'state-22')

    // No script configured: the action reports it did not run rather than
    // failing, and the panel renders no button at all.
    const quiet = createHarness({ workspacePath: workspace, stateDir })
    eq('with no script the action reports it did not run', (await quiet.call(ACTIONS.RUN_SCRIPT, { sessionId: SESSION })).body.ran, false)

    await put(join(workspace, 'CHANGELOG.md'), '# Changelog\n\n## 1.4.2\n\n- the thing\n\n## 1.4.1\n')
    await commitAll(workspace, 'changelog')

    // The script reads a file out of the tree, which is the whole point: it is
    // given the repository root as its working directory and nothing on stdin.
    const configured = createHarness({
      workspacePath: workspace,
      stateDir,
      summaryScript: "grep -m1 '^## ' CHANGELOG.md | sed 's/^## //'",
    })

    const filled = await configured.call(ACTIONS.RUN_SCRIPT, { sessionId: SESSION })
    eq('the script ran', filled.body.ran, true)
    eq('and exited cleanly', filled.body.exitCode, 0)
    // The whole point: it read a file out of the tree, because it was given the
    // repository root as its working directory and nothing on stdin.
    eq('its output is the version line, trimmed of the heading marker', filled.body.stdout.trim(), '1.4.2')

    // The split into Summary and Description is the panel's rule, not the
    // script's, so it is asserted in the browser half's suite.

    // A failing script is reported, not thrown: the panel shows its stderr beside
    // the button rather than turning it into an error banner.
    const failing = createHarness({ workspacePath: workspace, stateDir, summaryScript: 'exit 3' })
    const failed = await failing.call(ACTIONS.RUN_SCRIPT, { sessionId: SESSION })
    eq('a failing script still reports it ran', failed.body.ran, true)
    eq('with its exit code', failed.body.exitCode, 3)

    // A script that writes to stderr is still a success as far as git is
    // concerned; the panel decides what to do with the noise.
    const noisy = createHarness({ workspacePath: workspace, stateDir, summaryScript: "echo 'to stderr' >&2; echo '1.4.2'" })
    const noise = await noisy.call(ACTIONS.RUN_SCRIPT, { sessionId: SESSION })
    eq('a script that warns on stderr still succeeds', noise.body.exitCode, 0)
    eq('and its stdout is what gets used', noise.body.stdout.trim(), '1.4.2')
    ok('with the stderr kept for the panel to show', noise.body.stderr.includes('to stderr'), noise.body.stderr)
  }

  // -------------------------------------------------------------------- wrap-up

  // ------------------------------------- S23: the script is edited in the panel

  section('S23 the script belongs to a repository, and is written from the panel')
  {
    const workspace = await freshRepo('repo-script-prefs')
    const stateDir = join(scratch, 'state-23')
    await put(join(workspace, 'CHANGELOG.md'), '# Changelog\n\n## 2.0.0\n\n- thing\n')
    await commitAll(workspace, 'changelog')

    const script = "grep -m1 '^## ' CHANGELOG.md | sed 's/^## //'"
    const harness = createHarness({ workspacePath: workspace, stateDir })
    const first = await harness.call(ACTIONS.STATUS, { sessionId: SESSION })
    eq('a first-time panel sees no script', first.body.summaryScript, '')
    // No built-in starting point either: the panel shows what the host reports,
    // and the host reports nothing. There used to be a flag on the wire to tell
    // "never saved" apart from "cleared"; with nothing seeded the two are the
    // same value, so it is gone.
    eq('and the host carries no flag to seed one from', first.body.summaryScriptSaved, undefined)

    const saved = await harness.call(ACTIONS.SAVE_SCRIPT, { sessionId: SESSION, script })
    eq('the script is stored', saved.body.summaryScript, script)
    eq('the status reports it back', (await harness.call(ACTIONS.STATUS, { sessionId: SESSION })).body.summaryScript, script)

    const ran = await harness.call(ACTIONS.RUN_SCRIPT, { sessionId: SESSION })
    eq('the saved script runs', ran.body.ran, true)
    eq('and produces the version', ran.body.stdout.trim(), '2.0.0')

    // --- it belongs to one repository ------------------------------------

    // A second repository next door must not inherit it. This is the whole point
    // of keying by repository: a Vue project's script has no business running in
    // a Rust one.
    const other = await freshRepo('repo-script-other')
    const otherHarness = createHarness({ workspacePath: other, stateDir })
    eq('another repository starts with no script', (await otherHarness.call(ACTIONS.STATUS, { sessionId: SESSION })).body.summaryScript, '')
    eq('and running there does nothing', (await otherHarness.call(ACTIONS.RUN_SCRIPT, { sessionId: SESSION })).body.ran, false)

    // ...and giving it one leaves the first alone.
    await otherHarness.call(ACTIONS.SAVE_SCRIPT, { sessionId: SESSION, script: 'echo other' })
    eq('each repository keeps its own', (await harness.call(ACTIONS.STATUS, { sessionId: SESSION })).body.summaryScript, script)
    eq('the other one too', (await otherHarness.call(ACTIONS.STATUS, { sessionId: SESSION })).body.summaryScript, 'echo other')

    // --- the config value is only a default ---------------------------------

    // With nothing stored, a configured script is what is reported and run: the
    // box being untouched must not silently disable a script set that way.
    const configured = createHarness({
      workspacePath: workspace,
      stateDir: join(scratch, 'state-23b'),
      summaryScript: script,
    })
    eq(
      'with nothing stored the config value is reported',
      (await configured.call(ACTIONS.STATUS, { sessionId: SESSION })).body.summaryScript,
      script,
    )
    eq('and it runs', (await configured.call(ACTIONS.RUN_SCRIPT, { sessionId: SESSION })).body.stdout.trim(), '2.0.0')

    // --- clearing works ------------------------------------------------------

    await harness.call(ACTIONS.SAVE_SCRIPT, { sessionId: SESSION, script: '' })
    const cleared = await harness.call(ACTIONS.STATUS, { sessionId: SESSION })
    eq('the box can be emptied', cleared.body.summaryScript, '')
    eq(
      'and a second look puts nothing back in it',
      (await harness.call(ACTIONS.STATUS, { sessionId: SESSION })).body.summaryScript,
      '',
    )
  }

  // ------------------------- S24: opening a file in the user's own program

  section('S24 the diff tab can hand a file to the user own program')
  {
    const workspace = await freshRepo('repo-open')
    const stateDir = join(scratch, 'state-24')
    await put(join(workspace, 'a.txt'), 'first\n')
    await commitAll(workspace, 'a file to open')
    // A path that is certainly outside the repository, so the containment check
    // has something real to refuse rather than a guess.
    const outside = join(scratch, 'outside-open.txt')
    await put(outside, 'not yours\n')

    // Two configured programs, both this Node binary: the real program-open path
    // is exercised (a child really starts) without a GUI editor in the way. The
    // first writes down the file it was handed; the second only allows the argv
    // to be inspected.
    const marker = join(scratch, 'opened-by-probe.txt')
    const openWith = [
      {
        label: 'Probe',
        command: process.execPath,
        args: [
          '-e',
          'require("node:fs").writeFileSync(process.argv[2], process.argv[1], "utf8")',
          '{path}',
          marker,
        ],
      },
      { label: 'Bare', command: process.execPath, args: ['-e', 'process.exit(0)'] },
    ]
    const harness = createHarness({ workspacePath: workspace, stateDir, openWith })

    // --- the menu -----------------------------------------------------------

    const listed = await harness.call(ACTIONS.OPENERS, {})
    const ids = (listed.body.openers ?? []).map((row) => row.id)
    ok('the platform built-ins are offered', ids.includes('default') && ids.includes('reveal'), ids)
    eq('and the configured programs are too', ids.slice(-2), ['custom:0', 'custom:1'])
    eq(
      'a configured program keeps its own name, and a built-in has none to keep',
      (listed.body.openers ?? []).filter((row) => row.label !== undefined).map((row) => row.label),
      ['Probe', 'Bare'],
    )
    eq('with nothing remembered, the default is preselected', listed.body.last, 'default')

    // --- opening really starts the program ----------------------------------

    const target = join(workspace, 'a.txt')
    const opened = await harness.call(ACTIONS.OPEN_FILE, { sessionId: SESSION, path: 'a.txt', opener: 'custom:0' })
    eq('opening is accepted', opened.body.ok, true)
    eq('and names the program that was used', opened.body.opened?.id, 'custom:0')

    const spawned = harness.spawns.at(-1)
    eq('the program is the configured one', spawned?.argv[0], process.execPath)
    eq('the {path} placeholder became the absolute path', spawned?.argv[3], target)
    eq('the repository is the working directory', spawned?.cwd, workspace)
    ok(
      'and the program actually ran, with the file it was handed',
      await waitFor(async () => (await readFile(marker, 'utf8')) === target),
      await readFile(marker, 'utf8').catch(() => '(no marker)'),
    )

    // --- the choice is remembered, as a preference --------------------------

    eq('the last program used is remembered', (await harness.call(ACTIONS.OPENERS, {})).body.last, 'custom:0')
    eq('it is stored as a preference', (await harness.call(ACTIONS.PREFS, {})).body.prefs.openWith, 'custom:0')
    // A preference left behind by a config that no longer offers that entry must
    // read as "the default", not as a menu with nothing preselected in it.
    await harness.store.writePrefs({ openWith: 'from-an-older-config' })
    eq('a preference naming a program that is gone falls back to the default', (await harness.call(ACTIONS.OPENERS, {})).body.last, 'default')

    // --- an entry with no placeholder gets the path appended ---------------

    await harness.call(ACTIONS.OPEN_FILE, { sessionId: SESSION, path: 'a.txt', opener: 'custom:1' })
    const bare = harness.spawns.at(-1)
    eq('an entry with no placeholder has the path appended', bare?.argv.slice(-1), [target])
    eq('and its own arguments are left alone', bare?.argv.slice(0, 3), [process.execPath, '-e', 'process.exit(0)'])

    // --- what it refuses ----------------------------------------------------

    // git spawns children of its own while a refusal is being worked out (the
    // binding is re-resolved first), so "nothing was opened" has to count the
    // programs, not every child.
    const programs = () => harness.spawns.filter((entry) => entry.argv[0] === process.execPath).length
    const started = programs()
    // The first three are the containment rules; each is a request a browser half
    // could send, and none of them may reach an executable.
    const escaped = await harness.call(ACTIONS.OPEN_FILE, { sessionId: SESSION, path: outside, opener: 'custom:0' })
    ok('an absolute path outside the repository is refused', escaped.body.ok === false && escaped.body.error.code === ERROR_CODES.BAD_REQUEST, escaped.body)
    const climbed = await harness.call(ACTIONS.OPEN_FILE, { sessionId: SESSION, path: '../outside-open.txt', opener: 'custom:0' })
    ok('and so is a relative one that climbs out', climbed.body.ok === false && climbed.body.error.code === ERROR_CODES.BAD_REQUEST, climbed.body)
    const unknown = await harness.call(ACTIONS.OPEN_FILE, { sessionId: SESSION, path: 'a.txt', opener: 'not-a-program' })
    ok('a program the host never offered is refused', unknown.body.ok === false && unknown.body.error.code === ERROR_CODES.BAD_REQUEST, unknown.body)
    const gone = await harness.call(ACTIONS.OPEN_FILE, { sessionId: SESSION, path: 'never-existed.txt', opener: 'default' })
    ok('a file that is not on disk is a 404, not a crash', gone.status === 404 && gone.body.error.code === ERROR_CODES.NO_FILE, gone.body)
    eq('and not one of those started a program', programs(), started)

    // A configured command that does not exist is the one failure `spawn` can
    // report honestly, because it throws synchronously.
    const broken = createHarness({
      workspacePath: workspace,
      stateDir: join(scratch, 'state-24b'),
      openWith: [{ label: 'Nope', command: 'gitbar-no-such-program', args: ['{path}'] }],
    })
    const unstartable = await broken.call(ACTIONS.OPEN_FILE, { sessionId: SESSION, path: 'a.txt', opener: 'custom:0' })
    ok('a program that cannot be started says so', unstartable.body.ok === false && unstartable.body.error.code === ERROR_CODES.NO_OPENER, unstartable.body)
  }

  console.log('')
  console.log(`${checks} checks, ${failures} failures`)
  if (failures > 0) {
    console.log(`failing section numbers: ${[...new Set(failingSections)].join(', ')}`)
    console.log(`fixtures left behind: ${scratch}`)
    process.exit(1)
  }
  if (pinnedScratch === '') await rm(scratch, { recursive: true, force: true })
  console.log('e2e: all good')
}

await main().catch((error) => {
  console.error('e2e crashed:', error)
  process.exit(1)
})
