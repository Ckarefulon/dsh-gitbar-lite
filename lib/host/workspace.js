/**
 * Which directory is this session's workspace?
 *
 * The answer is taken from the same place the shipped
 * `@deepseek-ai/dsh-api-workspace-files` takes it: the session header's `cwd`,
 * falling back to the sandbox policy's `workspaceRoot`. That is the authoritative
 * answer — a workspace record's `sessionIds` is *not*, because the registry only
 * indexes sessions that existed when the Host booted, so a session created a
 * minute ago is filtered out of its own workspace's list.
 *
 * Every value here is optional-chained: a plugin must not turn a missing
 * optional service into a thrown error that blanks a panel.
 *
 * @module dsh-gitbar-lite/host/workspace
 */

import { ERROR_CODES } from '../shared.js'
import { RepoError } from './repo.js'

/**
 * The header of one session, live when possible and persisted otherwise.
 *
 * @param {object} ctx host context
 * @param {string} sessionId
 * @returns {Promise<object | undefined>}
 */
async function headerOf(ctx, sessionId) {
  const live = ctx.sessions?.get?.(sessionId)?.header
  if (live !== undefined && live !== null) return live
  const persistence = ctx.get?.('sessionPersistence', false)
  if (persistence === undefined || typeof persistence.stat !== 'function') return undefined
  try {
    return (await persistence.stat(sessionId))?.header
  } catch {
    return undefined
  }
}

/**
 * The workspace directory a session works in.
 *
 * @param {object} ctx host context
 * @param {string} sessionId
 * @returns {Promise<{ sessionId: string, cwd: string, workspaceTitle: string | null } | undefined>}
 */
export async function workspaceOf(ctx, sessionId) {
  const header = await headerOf(ctx, sessionId)
  if (header === undefined) return undefined

  const fromPolicy = ctx.get?.('sandboxPolicy', false)?.workspaceRoot
  const cwd = typeof header.cwd === 'string' && header.cwd !== '' ? header.cwd : typeof fromPolicy === 'string' ? fromPolicy : ''
  if (cwd === '') return undefined

  let workspaceTitle = null
  const registry = ctx.get?.('workspaceRegistry', false)
  if (registry !== undefined && typeof registry.resolveByPath === 'function') {
    try {
      workspaceTitle = (await registry.resolveByPath(cwd))?.title ?? null
    } catch {
      // `resolveByPath` realpaths and therefore rejects for a missing directory;
      // the cwd we already have is still the right answer.
      workspaceTitle = null
    }
  }

  return { sessionId, cwd, workspaceTitle }
}

/**
 * `workspaceOf`, or a `RepoError` carrying the user-facing reason.
 *
 * @param {object} ctx host context
 * @param {string} sessionId
 */
export async function requireWorkspace(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new RepoError(ERROR_CODES.BAD_REQUEST, '缺少 sessionId。')
  }
  const workspace = await workspaceOf(ctx, sessionId)
  if (workspace === undefined) {
    throw new RepoError(ERROR_CODES.NO_WORKSPACE, '拿不到这个会话的工作区目录，无法定位仓库。')
  }
  return workspace
}
