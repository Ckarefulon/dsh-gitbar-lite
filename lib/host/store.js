/**
 * Durable state: workspace→repository bindings, UI preferences, and the plugin's
 * own trash.
 *
 * Where it lives
 * --------------
 * `<DSH_HOME>/dsh-gitbar-lite/`, falling back to `~/.dsh` exactly the way
 * `@deepseek-ai/dsh-home-paths` does. Do not read `$DSH_HOME` alone: the Host
 * process usually does *not* have it set (the variable is injected into the
 * shell the Harness spawns), so a state file written under a bare
 * `process.env.DSH_HOME` would silently land somewhere else or nowhere. This is
 * the same trap `dsh-tailscale-remote` documents in its own state-file code.
 *
 * Why not the settings service or a storage domain
 * -----------------------------------------------
 * A binding is keyed by an arbitrary absolute workspace path, and a storage
 * domain's per-record keys are restricted to `^[a-zA-Z0-9_-]+$` because they
 * become path segments — `C:\Users\...\<folder with spaces>` cannot be one
 * without hashing it, at which point the "native" option is doing less for us
 * than the twelve lines below. A settings `Config` would put a growing map of
 * machine paths into the user-visible settings form, which is worse. So this is
 * a plain JSON file the plugin owns, written through a temp file and a rename
 * so a crash mid-write cannot truncate it.
 *
 * @module dsh-gitbar-lite/host/store
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { STATE_DIR_NAME, STATE_FILES } from '../shared.js'

/** Schema version of every file this module writes. */
const STATE_VERSION = 1

/**
 * Resolve the DSH home directory, matching `resolveDshHome` from
 * `@deepseek-ai/dsh-home-paths`: explicit config wins, then a non-blank
 * `$DSH_HOME`, then `~/.dsh`.
 *
 * @param {string} configured
 * @returns {string}
 */
export function resolveDshHome(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/**
 * Canonicalize a path so two spellings of one directory share a record: resolve
 * relatives, drop a trailing separator, and (best effort) follow junctions and
 * symlinks to their real target. Falls back to the lexical form when the path
 * does not exist yet.
 *
 * @param {string} input
 * @returns {string}
 */
export function canonicalize(input) {
  let absolute
  try {
    absolute = resolve(input)
  } catch {
    return String(input)
  }
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

/**
 * The binding key for a workspace path: canonical, separator-normalized, and
 * case-folded on Windows, where `C:\Foo` and `c:\foo` are one directory.
 *
 * @param {string} workspacePath
 */
export function workspaceKey(workspacePath) {
  const canonical = canonicalize(workspacePath).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

/** A filesystem-safe, roughly sortable id for a trash entry. */
export function trashId(now = Date.now(), random = Math.random) {
  const suffix = Math.floor(random() * 0xffffffff)
    .toString(36)
    .padStart(7, '0')
  return `${now.toString(36)}-${suffix}`
}

/**
 * Build the store bound to one plugin instance.
 *
 * @param {object} ctx host context (for `logger` only)
 * @param {object} config resolved plugin config
 */
export function createStore(ctx, config) {
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(message)
    } catch {
      // Logging must never be the thing that breaks a request.
    }
  }

  const baseDir = () =>
    typeof config.stateDir === 'string' && config.stateDir.trim() !== ''
      ? config.stateDir.trim()
      : join(resolveDshHome(process.env.DSH_HOME), STATE_DIR_NAME)

  const bindingsPath = () => join(baseDir(), STATE_FILES.BINDINGS)
  const prefsPath = () => join(baseDir(), STATE_FILES.PREFS)
  const scriptsPath = () => join(baseDir(), STATE_FILES.SCRIPTS)
  const trashIndexPath = () => join(baseDir(), STATE_FILES.TRASH_INDEX)
  const trashDir = () => join(baseDir(), 'trash')

  /**
   * Serialize writes per file.
   *
   * Two tabs (or the panel and its trash tab) can issue overlapping mutations,
   * and a read-modify-write that interleaves loses one of them. Chaining per
   * path is enough: every writer goes through `mutateJson`.
   */
  const queues = new Map()
  function serialize(path, work) {
    const previous = queues.get(path) ?? Promise.resolve()
    const next = previous.then(work, work)
    queues.set(
      path,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  /** Read JSON, returning `fallback` for anything missing or malformed. */
  async function readJson(path, fallback) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'))
      if (parsed === null || typeof parsed !== 'object') return fallback
      return parsed
    } catch (error) {
      if (error?.code !== 'ENOENT') warn(`dsh-gitbar-lite: ignoring unreadable ${path}: ${String(error?.message ?? error)}`)
      return fallback
    }
  }

  /** Write JSON through a temp file plus rename, so a crash cannot truncate it. */
  async function writeJson(path, value) {
    const temporary = `${path}.tmp`
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
  }

  /** Read-modify-write under the per-path queue. */
  function mutateJson(path, fallback, mutate) {
    return serialize(path, async () => {
      const current = await readJson(path, fallback)
      const next = await mutate(current)
      await writeJson(path, next)
      return next
    })
  }

  return {
    baseDir,
    trashDir,
    bindingsPath,
    prefsPath,
    trashIndexPath,
    readJson,
    writeJson,

    // ---------------------------------------------------------------- bindings

    /** Every binding, keyed by `workspaceKey`. */
    async readBindings() {
      const document = await readJson(bindingsPath(), { version: STATE_VERSION, bindings: {} })
      const bindings = document?.bindings
      return bindings !== null && typeof bindings === 'object' ? bindings : {}
    },

    /** The repository bound to one workspace path, or `undefined`. */
    async readBinding(workspacePath) {
      const bindings = await this.readBindings()
      const record = bindings[workspaceKey(workspacePath)]
      return typeof record?.repoRoot === 'string' && record.repoRoot !== '' ? record.repoRoot : undefined
    },

    /**
     * Bind (or, with `undefined`, unbind) one workspace path.
     *
     * @returns {Promise<string | undefined>} the repository now bound
     */
    async writeBinding(workspacePath, repoRoot) {
      const key = workspaceKey(workspacePath)
      const canonicalWorkspace = canonicalize(workspacePath)
      let result
      await mutateJson(bindingsPath(), { version: STATE_VERSION, bindings: {} }, (document) => {
        const bindings = document?.bindings !== null && typeof document?.bindings === 'object' ? { ...document.bindings } : {}
        if (repoRoot === undefined) {
          delete bindings[key]
          result = undefined
        } else {
          bindings[key] = {
            repoRoot: canonicalize(repoRoot),
            workspacePath: canonicalWorkspace,
            updatedAt: new Date().toISOString(),
          }
          result = bindings[key].repoRoot
        }
        return { version: STATE_VERSION, bindings }
      })
      return result
    },

    // ------------------------------------------------------------------- prefs

    /** Preferences, with defaults applied. */
    async readPrefs() {
      const document = await readJson(prefsPath(), { version: STATE_VERSION })
      return {
        /**
         * Whether the discard confirmation starts with "delete for good" ticked.
         * Default false: the safe answer is the one that keeps a copy.
         */
        trashHardDelete: document?.trashHardDelete === true,
        /** Whether the trash lists entries from every repository, not just the bound one. */
        trashShowAllRepos: document?.trashShowAllRepos === true,
      }
    },

    /** Merge a preferences patch. */
    async writePrefs(patch) {
      let result
      await mutateJson(prefsPath(), { version: STATE_VERSION }, (document) => {
        result = {
          version: STATE_VERSION,
          trashHardDelete: (patch?.trashHardDelete ?? document?.trashHardDelete) === true,
          trashShowAllRepos: (patch?.trashShowAllRepos ?? document?.trashShowAllRepos) === true,
        }
        return result
      })
      return result
    },

    // ----------------------------------------------------------------- scripts

    /**
     * The Summary script for one repository, or `''` when it has none.
     *
     * Keyed by repository rather than stored once: a script is a property of a
     * project ("read the top version out of *this* CHANGELOG"), and one shared
     * value would silently run a Vue project's script in a Rust one. The key is
     * the same canonical, case-folded form the bindings use, so two spellings of
     * one repository share a script.
     *
     * @param {string} repoRoot
     * @returns {Promise<string>}
     */
    async readScript(repoRoot) {
      const document = await readJson(scriptsPath(), { version: STATE_VERSION, scripts: {} })
      const scripts = document?.scripts !== null && typeof document?.scripts === 'object' ? document.scripts : {}
      const value = scripts[workspaceKey(repoRoot)]
      return typeof value === 'string' ? value : ''
    },

    /**
     * Store one repository's Summary script. An empty string deletes the entry
     * rather than keeping a blank one, so "no script" has a single representation.
     *
     * @param {string} repoRoot
     * @param {string} script
     */
    async writeScript(repoRoot, script) {
      const key = workspaceKey(repoRoot)
      await mutateJson(scriptsPath(), { version: STATE_VERSION, scripts: {} }, (document) => {
        const scripts = document?.scripts !== null && typeof document?.scripts === 'object' ? { ...document.scripts } : {}
        if (typeof script === 'string' && script !== '') scripts[key] = script
        else delete scripts[key]
        return { version: STATE_VERSION, scripts }
      })
    },

    // ------------------------------------------------------------------- trash

    /**
     * The trash index: metadata for every archived discard, newest first.
     *
     * Entries whose blob is missing are still listed — the metadata (which
     * repository, which base commit, which files) is worth keeping even if
     * someone deleted the `.diff` by hand.
     */
    async readTrash() {
      const document = await readJson(trashIndexPath(), { version: STATE_VERSION, entries: [] })
      const entries = Array.isArray(document?.entries) ? document.entries : []
      return entries.filter((entry) => entry !== null && typeof entry?.id === 'string')
    },

    /**
     * Append one entry, trimming the index to `config.trashLimit` and deleting
     * the blobs of whatever falls off the end.
     *
     * The diff is the whole archive. It is what the panel shows, and it is also
     * what a restore replays — so nothing else is stored beside it, and an
     * archive is one file.
     *
     * @param {object} entry
     * @param {string} diffText
     */
    async appendTrash(entry, diffText) {
      const blobName = `${entry.id}.diff`

      // The blob is written before the index on purpose. The index is the only
      // thing that makes an archive real, so whatever it points at exists first:
      // a crash between the two leaves an unreferenced blob (swept by
      // `clearTrash`, harmless) rather than an entry naming a file that never
      // landed.
      await mkdir(trashDir(), { recursive: true })
      await writeFile(join(trashDir(), blobName), diffText, 'utf8')

      let dropped = []
      await mutateJson(trashIndexPath(), { version: STATE_VERSION, entries: [] }, (document) => {
        const existing = Array.isArray(document?.entries) ? document.entries : []
        const limit = Number.isFinite(config.trashLimit) && config.trashLimit > 0 ? config.trashLimit : 200
        const combined = [{ ...entry, blob: blobName }, ...existing]
        dropped = combined.slice(limit)
        return { version: STATE_VERSION, entries: combined.slice(0, limit) }
      })

      for (const stale of dropped) {
        if (typeof stale?.blob === 'string') await this.removeTrashBlob(stale.blob)
      }
      return entry
    },

    /** One entry's metadata, or `undefined`. */
    async readTrashEntry(id) {
      const entries = await this.readTrash()
      return entries.find((entry) => entry.id === id)
    },

    /** One entry's archived diff text, or `undefined` when the blob is gone. */
    async readTrashDiff(entry) {
      const blob = typeof entry?.blob === 'string' && entry.blob !== '' ? entry.blob : `${entry?.id}.diff`
      try {
        return await readFile(join(trashDir(), blob), 'utf8')
      } catch (error) {
        if (error?.code !== 'ENOENT') warn(`dsh-gitbar-lite: reading trash blob failed: ${String(error?.message ?? error)}`)
        return undefined
      }
    },

    /** Delete one blob, tolerating its absence. */
    async removeTrashBlob(blob) {
      const name = String(blob).replace(/[\\/]/g, '')
      if (name === '' || name.includes('..')) return
      try {
        await rm(join(trashDir(), name), { force: true })
      } catch (error) {
        warn(`dsh-gitbar-lite: removing trash blob failed: ${String(error?.message ?? error)}`)
      }
    },

    /**
     * Drop one entry and its blob.
     *
     * @returns {Promise<boolean>} whether an entry was actually removed
     */
    async removeTrash(id) {
      const entry = await this.readTrashEntry(id)
      if (entry === undefined) return false
      await mutateJson(trashIndexPath(), { version: STATE_VERSION, entries: [] }, (document) => {
        const existing = Array.isArray(document?.entries) ? document.entries : []
        return { version: STATE_VERSION, entries: existing.filter((candidate) => candidate.id !== id) }
      })
      if (typeof entry.blob === 'string') await this.removeTrashBlob(entry.blob)
      return true
    },

    /**
     * Empty the trash.
     *
     * The blobs are swept by directory listing rather than by index, so a blob
     * orphaned by an interrupted write goes too.
     *
     * @returns {Promise<number>} how many entries were removed
     */
    async clearTrash() {
      const entries = await this.readTrash()
      await writeJson(trashIndexPath(), { version: STATE_VERSION, entries: [] })
      try {
        for (const name of await readdir(trashDir())) {
          if (name.endsWith('.diff')) await this.removeTrashBlob(name)
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') warn(`dsh-gitbar-lite: sweeping trash failed: ${String(error?.message ?? error)}`)
      }
      return entries.length
    },
  }
}
