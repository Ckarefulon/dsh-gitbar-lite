/**
 * The RPC surface: one exact Fetch route, one action per operation.
 *
 * Why one route and not one per action: `connection.fetch` matches on the exact
 * pathname and method, and every client call already carries a `sessionId` plus
 * whichever fields the action needs. A single `POST` with an `action` field
 * keeps the wire contract in one place (mirrored verbatim in the browser half)
 * instead of spreading seven path literals across two languages.
 *
 * Registration must go on `connection.fetch`, never on `webServer.register({
 * kind: 'exact' })`: the web server resolves exact routes *before* its `/api`
 * prefix route, and the fence, the browser-cookie check and the operator peer
 * all hang off that prefix route. An exact route on the same path would shadow
 * all three and silently expose an unauthenticated git surface.
 *
 * Failures are reported twice on purpose — a meaningful HTTP status *and* a
 * `{ ok: false, error }` body — because the browser half reads the body and a
 * non-2xx status must not be the only signal.
 *
 * @module dsh-gitbar-lite/host/routes
 */

import { resolve } from 'node:path'

import { ACTIONS, ERROR_CODES, RPC_ROUTE } from '../shared.js'
import { classifyGitFailure, RepoError } from './repo.js'
import { trashId, workspaceKey } from './store.js'
import { requireWorkspace } from './workspace.js'

/** HTTP status per failure code. The body carries the code as well. */
const HTTP_STATUS = {
  [ERROR_CODES.BAD_REQUEST]: 400,
  [ERROR_CODES.UNKNOWN_ACTION]: 400,
  [ERROR_CODES.EMPTY_SUMMARY]: 400,
  [ERROR_CODES.TRASH_NOT_FOUND]: 404,
  [ERROR_CODES.NO_WORKSPACE]: 409,
  [ERROR_CODES.NO_REPO]: 409,
  [ERROR_CODES.NOTHING_STAGED]: 409,
  [ERROR_CODES.CONFLICT]: 409,
  [ERROR_CODES.NO_REMOTE]: 409,
  [ERROR_CODES.NO_UPSTREAM]: 409,
  [ERROR_CODES.PUSH_REJECTED]: 409,
  [ERROR_CODES.AUTH]: 401,
  [ERROR_CODES.GIT_FAILED]: 500,
  [ERROR_CODES.INTERNAL]: 500,
  [ERROR_CODES.NO_GIT]: 503,
}

/** A JSON response that is never cached. */
export function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Read a required non-empty string field. */
function stringField(payload, name) {
  const value = payload?.[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RepoError(ERROR_CODES.BAD_REQUEST, `缺少字段 ${name}。`)
  }
  return value
}

/** Read an optional array of non-empty strings. */
function stringArrayField(payload, name) {
  const value = payload?.[name]
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item === '')) {
    throw new RepoError(ERROR_CODES.BAD_REQUEST, `字段 ${name} 必须是非空字符串数组。`)
  }
  return [...new Set(value)]
}

/** Normalize any thrown value into `{ code, message, status }`. */
export function describeError(error) {
  if (error instanceof RepoError) {
    return { code: error.code, message: error.message, status: HTTP_STATUS[error.code] ?? 400 }
  }
  if (typeof error?.code === 'string' && HTTP_STATUS[error.code] !== undefined) {
    return { code: error.code, message: String(error.message ?? error), status: HTTP_STATUS[error.code] }
  }
  if (error?.name === 'GitFailure') {
    const mapped = classifyGitFailure(error)
    return { code: mapped.code, message: mapped.message, status: HTTP_STATUS[mapped.code] ?? 500 }
  }
  return {
    code: ERROR_CODES.INTERNAL,
    message: String(error?.message ?? error),
    status: HTTP_STATUS[ERROR_CODES.INTERNAL],
  }
}

/**
 * Build the action handlers.
 *
 * @param {object} deps
 * @param {object} deps.ctx host context
 * @param {object} deps.git runner from `createGit`
 * @param {object} deps.repo facade from `createRepo`
 * @param {object} deps.store from `createStore`
 */
export function createHandlers({ ctx, git, repo, store }) {
  /**
   * Resolve the repository this session should be looking at, persisting a
   * successful auto-detection so the binding survives a restart.
   *
   * A stale binding (the directory moved, or `.git` was removed) is dropped and
   * re-detected rather than reported: a broken binding the user cannot clear
   * from the UI is worse than re-deciding.
   */
  async function resolveBinding(workspacePath, signal) {
    const bound = await store.readBinding(workspacePath)
    if (bound !== undefined) {
      const verified = await git.isRepoRoot(bound, signal)
      if (verified !== undefined) return { repoRoot: resolve(verified), source: 'binding' }
      await store.writeBinding(workspacePath, undefined)
    }
    const detected = await git.repoRootOf(workspacePath, signal)
    if (detected === undefined) return { repoRoot: undefined, source: 'none' }
    const persisted = await store.writeBinding(workspacePath, detected)
    return { repoRoot: resolve(persisted ?? detected), source: 'detected' }
  }

  /** Resolve the bound repository or fail with the reason the UI should show. */
  async function requireRepoRoot(payload, signal) {
    const workspace = await requireWorkspace(ctx, stringField(payload, 'sessionId'))
    const binding = await resolveBinding(workspace.cwd, signal)
    if (binding.repoRoot === undefined) {
      throw new RepoError(ERROR_CODES.NO_REPO, '这个工作区还没有绑定 Git 仓库，先在上面的仓库选择里挑一个。')
    }
    return { workspace, repoRoot: binding.repoRoot, source: binding.source }
  }

  /** The whole panel state for one session. */
  async function status(payload, request) {
    const workspace = await requireWorkspace(ctx, stringField(payload, 'sessionId'))
    const prefs = await store.readPrefs()
    const binding = await resolveBinding(workspace.cwd, request.signal)

    if (binding.repoRoot === undefined) {
      const scan = await repo.scanRepos(workspace.cwd, request.signal)
      return {
        workspacePath: workspace.cwd,
        workspaceTitle: workspace.workspaceTitle,
        repoRoot: null,
        source: binding.source,
        candidates: scan.repos,
        scanTruncated: scan.truncated,
        // No repository means no script: a script is stored per repository, so
        // there is nothing to report until one is bound.
        summaryScript: '',
        prefs,
      }
    }

    const [state, script] = await Promise.all([
      repo.readStatus(binding.repoRoot, request.signal),
      store.readScript(binding.repoRoot),
    ])
    return {
      workspacePath: workspace.cwd,
      workspaceTitle: workspace.workspaceTitle,
      source: binding.source,
      prefs,
      ...state,
      // The stored script is the whole answer; `state.summaryScript` is only the
      // config default, and it is empty unless the user set one there. Nothing is
      // seeded: an empty value means the panel shows an empty box.
      summaryScript: script !== '' ? script : state.summaryScript,
    }
  }

  /** Bind this workspace to a chosen repository, or clear the binding. */
  async function bind(payload, request) {
    const workspace = await requireWorkspace(ctx, stringField(payload, 'sessionId'))
    const requested = payload?.repoRoot

    if (requested === null) {
      await store.writeBinding(workspace.cwd, undefined)
      return { cleared: true, workspacePath: workspace.cwd }
    }
    if (typeof requested !== 'string' || requested.trim() === '') {
      throw new RepoError(ERROR_CODES.BAD_REQUEST, 'repoRoot 必须是非空路径字符串，或 null。')
    }

    const verified = await git.isRepoRoot(requested.trim(), request.signal)
    if (verified === undefined) {
      throw new RepoError(ERROR_CODES.NO_REPO, `这个目录不是 Git 仓库的根：${requested.trim()}`)
    }
    const repoRoot = await store.writeBinding(workspace.cwd, verified)
    return { workspacePath: workspace.cwd, repoRoot: resolve(repoRoot ?? verified), bound: true }
  }

  /** Candidate repositories for the picker. */
  async function repos(payload, request) {
    const workspace = await requireWorkspace(ctx, stringField(payload, 'sessionId'))
    const binding = await resolveBinding(workspace.cwd, request.signal)
    const scan = await repo.scanRepos(workspace.cwd, request.signal)
    return {
      workspacePath: workspace.cwd,
      workspaceTitle: workspace.workspaceTitle,
      repoRoot: binding.repoRoot ?? null,
      source: binding.source,
      candidates: scan.repos,
      scanned: scan.scanned,
      scanTruncated: scan.truncated,
    }
  }

  /**
   * The single context button, which is either a push or a fetch.
   *
   * GitHub Desktop's rule, and the client's too: a branch with local commits the
   * upstream does not have offers Push; otherwise the useful thing to do is
   * refresh the remote, so it offers Fetch. The host does not re-decide here —
   * the client already knows which one it drew, and re-deriving it would let the
   * button and the action disagree.
   */
  async function primaryAction(kind, payload, request) {
    const { workspace, repoRoot } = await requireRepoRoot(payload, request.signal)
    const outcome = kind === 'push' ? await repo.push(repoRoot, request.signal) : await repo.fetch(repoRoot, request.signal)
    return withFreshStatus(workspace, repoRoot, request.signal, { action: kind, outcome })
  }

  /**
   * The answer to every action that changed a repository: the fresh status, plus
   * whatever the action itself has to report.
   *
   * Every mutating handler ends this way, and they all end the same way for a
   * reason: the panel replaces its whole snapshot from one payload, so a status
   * read *after* the mutation is the only thing that keeps the panel and the
   * repository agreeing. Spelling it out seven times invited one of them to be
   * written before the mutation instead of after.
   *
   * @param {object} workspace
   * @param {string} repoRoot
   * @param {AbortSignal} signal
   * @param {object} [extra] fields the action reports on top of the status
   */
  async function withFreshStatus(workspace, repoRoot, signal, extra) {
    const [state, script] = await Promise.all([repo.readStatus(repoRoot, signal), store.readScript(repoRoot)])
    return {
      ...(extra ?? {}),
      repoRoot,
      workspacePath: workspace.cwd,
      ...state,
      // Last, so it wins over the config default `readStatus` carries. Keyed by
      // repository: a script belongs to a project, not to the plugin, so two
      // repositories never share one.
      summaryScript: script !== '' ? script : state.summaryScript,
    }
  }

  return {
    [ACTIONS.STATUS]: status,

    [ACTIONS.BIND]: bind,

    [ACTIONS.REPOS]: repos,

    async [ACTIONS.STAGE](payload, request) {
      const { workspace, repoRoot } = await requireRepoRoot(payload, request.signal)
      const paths = stringArrayField(payload, 'paths')
      if (paths.length === 0) throw new RepoError(ERROR_CODES.BAD_REQUEST, 'paths 不能为空。')
      await repo.setStaged(repoRoot, paths, payload?.staged === true, request.signal)
      return withFreshStatus(workspace, repoRoot, request.signal)
    },

    async [ACTIONS.COMMIT](payload, request) {
      const { workspace, repoRoot } = await requireRepoRoot(payload, request.signal)
      const commit = await repo.commit(
        repoRoot,
        { summary: payload?.summary, description: payload?.description },
        request.signal,
      )
      return withFreshStatus(workspace, repoRoot, request.signal, { commit })
    },

    /**
     * Commit, then push, reporting the two halves separately.
     *
     * If the push fails the commit has already happened, and saying "it failed"
     * would be a lie the user acts on. So the commit result is returned as
     * success and the push carries its own failure.
     */
    async [ACTIONS.COMMIT_PUSH](payload, request) {
      const { workspace, repoRoot } = await requireRepoRoot(payload, request.signal)
      const commit = await repo.commit(
        repoRoot,
        { summary: payload?.summary, description: payload?.description },
        request.signal,
      )

      let push
      try {
        push = { ok: true, ...(await repo.push(repoRoot, request.signal)) }
      } catch (error) {
        // `fetched` is carried out of a refusal because it is the difference
        // between "the push was rejected, fetch and try again" and "we already
        // looked, and the branch really is behind" — the same sentence reads very
        // differently depending on which one it is.
        push = { ok: false, error: describeError(error), fetched: error?.fetched === true }
      }

      return withFreshStatus(workspace, repoRoot, request.signal, { commit, push })
    },

    [ACTIONS.PUSH]: (payload, request) => primaryAction('push', payload, request),

    [ACTIONS.FETCH]: (payload, request) => primaryAction('fetch', payload, request),

    async [ACTIONS.DISCARD](payload, request) {
      const { workspace, repoRoot } = await requireRepoRoot(payload, request.signal)
      const paths = payload?.paths === null || payload?.paths === undefined ? null : stringArrayField(payload, 'paths')
      const hardDelete = payload?.hardDelete === true

      const discard = await repo.discard({
        repoRoot,
        workspacePath: workspace.cwd,
        sessionId: workspace.sessionId,
        paths,
        hardDelete,
        signal: request.signal,
        // The entry id is minted here rather than in `repo.discard` so the git
        // layer stays free of any notion of where archives are stored.
        archive: (entry, diffText) => store.appendTrash({ ...entry, id: trashId(), at: new Date().toISOString() }, diffText),
      })

      // Remember the choice: the confirmation box opens on whatever the user
      // picked last time, and a first-time user gets the safe answer (unticked).
      await store.writePrefs({ trashHardDelete: hardDelete })

      return withFreshStatus(workspace, repoRoot, request.signal, { discard })
    },

    async [ACTIONS.FILE_DIFF](payload, request) {
      const { repoRoot } = await requireRepoRoot(payload, request.signal)
      const path = stringField(payload, 'path')
      const diff = await repo.fileDiff(repoRoot, path, request.signal)
      return { repoRoot, diff }
    },

    /**
     * Run the user's Summary script and hand back what it printed.
     *
     * The panel does the splitting, because the protocol is a presentation rule
     * (`---` separates Summary from Description) rather than anything the
     * repository needs to know about.
     */
    async [ACTIONS.RUN_SCRIPT](payload, request) {
      const { repoRoot } = await requireRepoRoot(payload, request.signal)
      const stored = await store.readScript(repoRoot)
      // No stored script for this repository means the configured default (if
      // any) is what to run. Passing `''` through would shadow it, and a script
      // configured the old way would silently stop working.
      const script = stored !== '' ? stored : undefined
      const result = await repo.runScript(repoRoot, request.signal, script)
      return { repoRoot, ...result }
    },

    async [ACTIONS.TRASH_LIST](payload, request) {
      const workspace = await requireWorkspace(ctx, stringField(payload, 'sessionId'))
      const prefs = await store.readPrefs()
      const binding = await resolveBinding(workspace.cwd, request.signal)
      const showAll = payload?.all === true || (payload?.all === undefined && prefs.trashShowAllRepos)
      const all = await store.readTrash()

      const filtered =
        showAll || binding.repoRoot === undefined
          ? all
          : all.filter((entry) => typeof entry.repoRoot === 'string' && workspaceKey(entry.repoRoot) === workspaceKey(binding.repoRoot))

      const entries = []
      for (const entry of filtered) {
        // Which repository this entry belongs to: the bound one when we are not
        // showing every repository, and the entry's own recorded root otherwise.
        // An entry whose root no longer resolves simply cannot be restored.
        const root = showAll ? entry.repoRoot : binding.repoRoot
        entries.push({
          id: entry.id,
          at: entry.at,
          repoRoot: entry.repoRoot,
          repoName: entry.repoName,
          workspacePath: entry.workspacePath ?? null,
          scope: entry.scope,
          branch: entry.branch ?? null,
          base: entry.base ?? null,
          files: Array.isArray(entry.files)
            ? entry.files.map((file) => ({
                path: file.path,
                origPath: file.origPath ?? null,
                kind: file.kind,
                added: file.added ?? 0,
                deleted: file.deleted ?? 0,
                binary: file.binary === true,
                oversized: file.oversized === true,
              }))
            : [],
          bytes: entry.bytes ?? 0,
          truncated: entry.truncated === true,
          droppedLines: entry.droppedLines ?? 0,
          // The same question the restore action will ask, answered from the same
          // place, so a button that renders as available cannot turn into a
          // refusal. Answering it needs the diff (to spot a binary one), which is
          // one small read per listed entry.
          restorable:
            typeof root === 'string' && root !== ''
              ? await repo.canRestore(root, entry, await store.readTrashDiff(entry), request.signal)
              : { ok: false, reason: 'no-repo' },
        })
      }

      return {
        workspacePath: workspace.cwd,
        repoRoot: binding.repoRoot ?? null,
        showAll,
        total: all.length,
        entries,
      }
    },

    async [ACTIONS.TRASH_DIFF](payload) {
      const entry = await store.readTrashEntry(stringField(payload, 'id'))
      if (entry === undefined) throw new RepoError(ERROR_CODES.TRASH_NOT_FOUND, '这条回收站记录已经不存在了。')
      const text = await store.readTrashDiff(entry)
      if (text === undefined) {
        throw new RepoError(ERROR_CODES.TRASH_NOT_FOUND, '这条记录的 diff 文件已经不在了（可能被手工删掉了）。')
      }
      return {
        entry: { id: entry.id, at: entry.at, scope: entry.scope, base: entry.base ?? null, truncated: entry.truncated === true },
        text,
      }
    },

    /**
     * Put one archived discard back.
     *
     * The refusal lives in the repository layer, because that is where the
     * comparison against the current working tree is made — the route only turns
     * it into the payload the panel disables the button with.
     */
    async [ACTIONS.TRASH_RESTORE](payload, request) {
      const workspace = await requireWorkspace(ctx, stringField(payload, 'sessionId'))
      const entry = await store.readTrashEntry(stringField(payload, 'id'))
      if (entry === undefined) throw new RepoError(ERROR_CODES.TRASH_NOT_FOUND, '这条回收站记录已经不存在了。')
      if (typeof entry.repoRoot !== 'string' || entry.repoRoot === '') {
        throw new RepoError(ERROR_CODES.NO_REPO, '这条记录没有记下是哪个仓库的，无法恢复。')
      }

      // The archive is the diff, so that is what goes back: `git apply` replays it
      // against the working tree, and the paths it produced are staged so the list
      // comes back with them ticked (see `repo.restore`).
      const diffText = await store.readTrashDiff(entry)
      const restored = await repo.restore(entry.repoRoot, entry, diffText, request.signal)

      // The entry has done its job, so it goes. Restoring is the reverse of the
      // discard that created it, and an archive kept after that is worse than no
      // archive: replaying it a second time would apply the same change twice, so
      // the only thing it could still be is a permanently greyed-out row. The
      // removal happens after the apply, never before — an entry that failed to
      // restore is the one case where the user still needs it.
      await store.removeTrash(entry.id)

      return withFreshStatus(workspace, entry.repoRoot, request.signal, { restored })
    },

    async [ACTIONS.TRASH_DELETE](payload) {
      const id = stringField(payload, 'id')
      const removed = await store.removeTrash(id)
      if (!removed) throw new RepoError(ERROR_CODES.TRASH_NOT_FOUND, '这条回收站记录已经不存在了。')
      return { removed: id }
    },

    async [ACTIONS.TRASH_CLEAR](payload, request) {
      if (payload?.all === true) return { removed: await store.clearTrash() }

      const workspace = await requireWorkspace(ctx, stringField(payload, 'sessionId'))
      const binding = await resolveBinding(workspace.cwd, request.signal)
      if (binding.repoRoot === undefined) {
        throw new RepoError(ERROR_CODES.NO_REPO, '没有绑定仓库，无法确定要清空哪个仓库的回收站。')
      }
      const all = await store.readTrash()
      const mine = all.filter(
        (entry) => typeof entry.repoRoot === 'string' && workspaceKey(entry.repoRoot) === workspaceKey(binding.repoRoot),
      )
      for (const entry of mine) await store.removeTrash(entry.id)
      return { removed: mine.length }
    },

    async [ACTIONS.PREFS](payload) {
      const hasWrite = payload?.trashHardDelete !== undefined || payload?.trashShowAllRepos !== undefined
      if (!hasWrite) return { prefs: await store.readPrefs() }
      const prefs = await store.writePrefs({
        trashHardDelete: payload?.trashHardDelete,
        trashShowAllRepos: payload?.trashShowAllRepos,
      })
      return { prefs }
    },

    /**
     * Store this repository's Summary script, or clear it with an empty string.
     *
     * A separate action from PREFS rather than a field on it, because the script
     * is keyed by repository and a preference is not: one is a property of the
     * project, the other of the user.
     */
    async [ACTIONS.SAVE_SCRIPT](payload, request) {
      const { repoRoot } = await requireRepoRoot(payload, request.signal)
      const script = typeof payload?.script === 'string' ? payload.script : ''
      await store.writeScript(repoRoot, script)
      const state = await repo.readStatus(repoRoot, request.signal)
      return {
        repoRoot,
        summaryScript: script !== '' ? script : state.summaryScript,
        script,
      }
    },
  }
}

/**
 * The exact Fetch route to register on `connection.fetch`.
 *
 * @param {object} options
 * @param {Record<string, (payload: object, request: Request) => Promise<object>>} options.handlers
 * @param {{ warn: (message: string) => void }} [options.logger]
 */
export function createRoute({ handlers, logger }) {
  return {
    path: RPC_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    /**
     * @param {Request} request
     * @returns {Promise<Response>}
     */
    async fetch(request) {
      let payload
      try {
        payload = await request.json()
      } catch {
        return json({ ok: false, error: { code: ERROR_CODES.BAD_REQUEST, message: '请求体不是合法 JSON。' } }, 400)
      }
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        return json({ ok: false, error: { code: ERROR_CODES.BAD_REQUEST, message: '请求体必须是一个 JSON 对象。' } }, 400)
      }

      const action = typeof payload.action === 'string' ? payload.action : ''
      const handler = Object.prototype.hasOwnProperty.call(handlers, action) ? handlers[action] : undefined
      if (typeof handler !== 'function') {
        return json(
          { ok: false, error: { code: ERROR_CODES.UNKNOWN_ACTION, message: `未知的 action：${JSON.stringify(action)}` } },
          400,
        )
      }

      try {
        const data = await handler(payload, request)
        return json({ ok: true, ...data })
      } catch (error) {
        const described = describeError(error)
        if (described.code === ERROR_CODES.INTERNAL) {
          logger?.warn?.(`dsh-gitbar-lite: action ${action} failed: ${described.message}`)
        }
        return json({ ok: false, error: { code: described.code, message: described.message } }, described.status)
      }
    },
  }
}
