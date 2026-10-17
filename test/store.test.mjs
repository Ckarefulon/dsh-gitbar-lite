/**
 * Durable state: the DSH home resolution, the binding key, and the three files
 * the plugin owns (bindings, preferences, and the trash).
 *
 * Every case here runs against a throwaway directory under `test/.scratch/`, so
 * a run never touches the real `<DSH_HOME>`.
 *
 * @module dsh-gitbar-lite/test/store
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { after, describe, it } from 'node:test'

import { canonicalize, createStore, resolveDshHome, trashId, workspaceKey } from '../lib/host/store.js'

const scratch = join(import.meta.dirname, '.scratch')
await mkdir(scratch, { recursive: true })

const made = []

/** A fresh directory for one test, cleaned up at the end of the file. */
async function tempDir(label) {
  const dir = await mkdtemp(join(scratch, `${label}-`))
  made.push(dir)
  return dir
}

after(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true })
})

/** A store bound to a throwaway directory. */
async function makeStore(config = {}) {
  const dir = await tempDir('store')
  const warnings = []
  const ctx = { logger: { warn: (message) => warnings.push(message) } }
  return {
    dir,
    warnings,
    store: createStore(ctx, { stateDir: dir, trashLimit: 200, ...config }),
  }
}

describe('resolveDshHome', () => {
  it('prefers an explicit configuration', () => {
    assert.equal(resolveDshHome('/somewhere/else'), '/somewhere/else')
  })

  it('treats a blank configuration as absent, not as a path', () => {
    assert.equal(resolveDshHome('   '), homedir() + sep + '.dsh')
    assert.equal(resolveDshHome(''), join(homedir(), '.dsh'))
    assert.equal(resolveDshHome(undefined), join(homedir(), '.dsh'))
  })

  it('falls back to $DSH_HOME when nothing is configured', () => {
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = '/from-the-environment'
    try {
      assert.equal(resolveDshHome(''), '/from-the-environment')
      // A blank environment variable counts as unset — the Host usually does not
      // have one at all, and an empty string must not become a relative path.
      process.env.DSH_HOME = '  '
      assert.equal(resolveDshHome(''), join(homedir(), '.dsh'))
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

describe('workspaceKey', () => {
  it('drops a trailing separator so two spellings are one record', () => {
    const base = join(scratch, 'a-workspace')
    assert.equal(workspaceKey(base), workspaceKey(`${base}${sep}`))
    assert.equal(workspaceKey(base), workspaceKey(`${base}${sep}${sep}`))
  })

  it('resolves relative spellings against the process cwd', () => {
    assert.equal(workspaceKey('.scratch'), workspaceKey(resolve('.scratch')))
  })

  it('folds case on Windows, where two spellings are one directory', () => {
    const base = join(scratch, 'CaseWorkspace')
    if (process.platform === 'win32') {
      assert.equal(workspaceKey(base), workspaceKey(base.toLowerCase()))
      assert.equal(workspaceKey(base), workspaceKey(base.toUpperCase()))
    } else {
      assert.notEqual(workspaceKey(base), workspaceKey(base.toLowerCase()))
    }
  })
})

describe('canonicalize', () => {
  it('returns the lexical absolute form for a path that does not exist', () => {
    const missing = join(scratch, 'not-here-at-all')
    assert.equal(canonicalize(missing), resolve(missing))
  })

  it('follows a real directory to its canonical spelling', () => {
    const real = canonicalize(scratch)
    assert.equal(canonicalize(`${scratch}${sep}.`), real)
  })
})

describe('trashId', () => {
  it('is filesystem-safe and unique per call', () => {
    const seen = new Set()
    for (let index = 0; index < 500; index += 1) {
      const id = trashId()
      assert.match(id, /^[a-z0-9-]+$/, `unsafe id: ${id}`)
      assert.equal(seen.has(id), false)
      seen.add(id)
    }
  })

  it('sorts roughly by time, so the newest entry reads first', () => {
    const older = trashId(1_700_000_000_000, () => 0.5)
    const newer = trashId(1_800_000_000_000, () => 0.5)
    assert.ok(newer > older, `${newer} should sort after ${older}`)
  })
})

describe('bindings', () => {
  it('round-trips a binding and reads it back by any spelling of the path', async () => {
    const { store } = await makeStore()
    const workspace = join(scratch, 'bound-workspace')
    const repository = join(scratch, 'bound-repo')
    await mkdir(workspace, { recursive: true })
    await mkdir(repository, { recursive: true })

    assert.equal(await store.readBinding(workspace), undefined)
    const written = await store.writeBinding(workspace, repository)
    assert.equal(written, canonicalize(repository))
    assert.equal(await store.readBinding(workspace), canonicalize(repository))
    assert.equal(await store.readBinding(`${workspace}${sep}`), canonicalize(repository))

    const document = JSON.parse(await readFile(store.bindingsPath(), 'utf8'))
    assert.equal(document.version, 1)
    const record = Object.values(document.bindings)[0]
    assert.equal(record.repoRoot, canonicalize(repository))
    assert.ok(typeof record.updatedAt === 'string')
  })

  it('clears a binding with undefined rather than writing a falsy one', async () => {
    const { store } = await makeStore()
    const workspace = join(scratch, 'cleared-workspace')
    await store.writeBinding(workspace, join(scratch, 'some-repo'))
    assert.equal(await store.writeBinding(workspace, undefined), undefined)
    assert.equal(await store.readBinding(workspace), undefined)
    assert.deepEqual(JSON.parse(await readFile(store.bindingsPath(), 'utf8')).bindings, {})
  })

  it('keeps two workspaces apart', async () => {
    const { store } = await makeStore()
    await store.writeBinding(join(scratch, 'w-one'), join(scratch, 'r-one'))
    await store.writeBinding(join(scratch, 'w-two'), join(scratch, 'r-two'))
    assert.equal(await store.readBinding(join(scratch, 'w-one')), canonicalize(join(scratch, 'r-one')))
    assert.equal(await store.readBinding(join(scratch, 'w-two')), canonicalize(join(scratch, 'r-two')))
  })

  it('survives a corrupt file instead of throwing, and says so once', async () => {
    const { store, warnings } = await makeStore()
    await mkdir(store.baseDir(), { recursive: true })
    await writeFile(store.bindingsPath(), '{ this is not json', 'utf8')
    assert.deepEqual(await store.readBindings(), {})
    assert.equal(warnings.length, 1)
    // And it is repairable: the next write replaces the garbage.
    await store.writeBinding(join(scratch, 'w'), join(scratch, 'r'))
    assert.deepEqual(Object.keys(await store.readBindings()).length, 1)
  })

  it('tolerates a structurally wrong document', async () => {
    const { store } = await makeStore()
    await mkdir(store.baseDir(), { recursive: true })
    await writeFile(store.bindingsPath(), JSON.stringify({ version: 1, bindings: 'nope' }), 'utf8')
    assert.deepEqual(await store.readBindings(), {})
  })
})

describe('preferences', () => {
  it('starts with the safe answers', async () => {
    const { store } = await makeStore()
    assert.deepEqual(await store.readPrefs(), { trashHardDelete: false, trashShowAllRepos: false, summaryScript: '' })
  })

  it('merges a patch instead of replacing the document', async () => {
    const { store } = await makeStore()
    await store.writePrefs({ trashHardDelete: true })
    await store.writePrefs({ trashShowAllRepos: true })
    assert.deepEqual(await store.readPrefs(), { trashHardDelete: true, trashShowAllRepos: true, summaryScript: '' })
  })

  it('reads back only booleans and a string, whatever was on disk', async () => {
    const { store } = await makeStore()
    await mkdir(store.baseDir(), { recursive: true })
    await writeFile(
      store.prefsPath(),
      JSON.stringify({ version: 1, trashHardDelete: 'yes', trashShowAllRepos: 1, summaryScript: 42 }),
      'utf8',
    )
    assert.deepEqual(await store.readPrefs(), { trashHardDelete: false, trashShowAllRepos: false, summaryScript: '' })
  })

  it('keeps the script across a patch that does not mention it', async () => {
    const { store } = await makeStore()
    await store.writePrefs({ summaryScript: 'echo hi' })
    // A patch about something else must not clear it: that is the difference
    // between "leave it alone" and "set it to empty".
    await store.writePrefs({ trashHardDelete: true })
    assert.equal((await store.readPrefs()).summaryScript, 'echo hi')

    // And an explicit empty string does clear it.
    await store.writePrefs({ summaryScript: '' })
    assert.equal((await store.readPrefs()).summaryScript, '')
  })
})

/** The `.diff` blobs in the trash directory, sorted — the index file lives there too. */
async function blobsOf(dir) {
  return (await readdir(dir)).filter((name) => name.endsWith('.diff')).sort()
}

describe('the trash', () => {
  const entryOf = (id, extra = {}) => ({
    id,
    at: new Date(1_700_000_000_000).toISOString(),
    repoRoot: 'C:/repo',
    repoName: 'repo',
    scope: 'file',
    files: [{ path: 'a.txt', kind: 'modified', added: 1, deleted: 0 }],
    ...extra,
  })

  it('appends an entry with its blob and lists it newest first', async () => {
    const { store } = await makeStore()
    await store.appendTrash(entryOf('first'), 'diff one\n')
    await store.appendTrash(entryOf('second'), 'diff two\n')

    const entries = await store.readTrash()
    assert.deepEqual(
      entries.map((entry) => entry.id),
      ['second', 'first'],
    )
    assert.equal(entries[0].blob, 'second.diff')
    assert.equal(await store.readTrashDiff(entries[0]), 'diff two\n')
    assert.equal((await blobsOf(store.trashDir())).join(','), 'first.diff,second.diff')
  })

  it('removes an entry and its blob together', async () => {
    const { store } = await makeStore()
    await store.appendTrash(entryOf('keep'), 'x\n')
    await store.appendTrash(entryOf('drop'), 'y\n')

    assert.equal(await store.removeTrash('drop'), true)
    assert.equal(await store.removeTrash('drop'), false, 'removing twice reports false the second time')
    assert.deepEqual((await store.readTrash()).map((entry) => entry.id), ['keep'])
    assert.deepEqual(await blobsOf(store.trashDir()), ['keep.diff'])
  })

  it('sweeps every blob on clear, so an orphaned file cannot linger', async () => {
    const { store } = await makeStore()
    await store.appendTrash(entryOf('one'), 'x\n')
    await store.appendTrash(entryOf('two'), 'y\n')
    // A blob with no index entry, as an interrupted write would leave behind.
    await writeFile(join(store.trashDir(), 'orphan.diff'), 'z\n', 'utf8')

    assert.equal(await store.clearTrash(), 2)
    assert.deepEqual(await store.readTrash(), [])
    assert.deepEqual(await blobsOf(store.trashDir()), [])
  })

  it('trims to trashLimit and deletes the blobs that fall off', async () => {
    const { store } = await makeStore({ trashLimit: 3 })
    for (const id of ['one', 'two', 'three', 'four', 'five']) {
      await store.appendTrash(entryOf(id), `diff ${id}\n`)
    }
    assert.deepEqual((await store.readTrash()).map((entry) => entry.id), ['five', 'four', 'three'])
    assert.deepEqual(await blobsOf(store.trashDir()), ['five.diff', 'four.diff', 'three.diff'])
    assert.equal(await store.readTrashEntry('one'), undefined)
  })

  it('still lists an entry whose blob was deleted by hand', async () => {
    const { store } = await makeStore()
    await store.appendTrash(entryOf('lonely'), 'x\n')
    await rm(join(store.trashDir(), 'lonely.diff'), { force: true })
    const entries = await store.readTrash()
    assert.equal(entries.length, 1)
    assert.equal(await store.readTrashDiff(entries[0]), undefined)
  })

  it('refuses a blob name that tries to climb out of the trash directory', async () => {
    const { store } = await makeStore()
    await mkdir(store.trashDir(), { recursive: true })
    const outside = join(store.baseDir(), 'outside.txt')
    await writeFile(outside, 'do not delete me\n', 'utf8')
    await store.removeTrashBlob('../outside.txt')
    assert.equal(await readFile(outside, 'utf8'), 'do not delete me\n')
  })

  it('handles a missing trash directory without creating one', async () => {
    const { store } = await makeStore()
    assert.deepEqual(await store.readTrash(), [])
    assert.equal(await store.clearTrash(), 0)
  })

  it('records which repository and which base commit an entry came from', async () => {
    const { store } = await makeStore()
    await store.appendTrash(
      entryOf('with-base', {
        scope: 'all',
        branch: { head: 'main', detached: false },
        base: { oid: 'a'.repeat(40), short: 'aaaaaaa', subject: 'init' },
        truncated: true,
        droppedLines: 12,
      }),
      'blob\n',
    )
    const [entry] = await store.readTrash()
    assert.equal(entry.scope, 'all')
    assert.equal(entry.base.short, 'aaaaaaa')
    assert.equal(entry.base.subject, 'init')
    assert.equal(entry.truncated, true)
    assert.equal(entry.droppedLines, 12)
  })
})

describe('write serialization', () => {
  it('does not lose an update when two writers overlap', async () => {
    const { store } = await makeStore()
    // Without the per-path queue this is a read-modify-write race and one of the
    // twenty bindings goes missing.
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.writeBinding(join(scratch, `concurrent-workspace-${index}`), join(scratch, `concurrent-repo-${index}`)),
      ),
    )
    const bindings = await store.readBindings()
    assert.equal(Object.keys(bindings).length, 20)
  })
})
