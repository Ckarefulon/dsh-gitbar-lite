/**
 * The host plugin entry: where the route lands, that it lands exactly once, and
 * how a thrown value becomes something a user can read.
 *
 * The carrier assertion is the one with teeth. Registering the same path as a
 * `webServer` exact route resolves *before* the harness's `/api` prefix route,
 * and that prefix route is where the Host/Origin fence, the browser-cookie check
 * and the operator peer live — so the carrier is a security boundary, not a
 * style preference. `apply` is driven against a fake context that records both
 * carriers, and a `webServer` that throws if it is ever touched.
 *
 * @module dsh-gitbar-lite/test/index
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Config, apply, inject, internals, name, readConfig } from '../lib/index.js'
import { GitFailure } from '../lib/host/git.js'
import { RepoError } from '../lib/host/repo.js'
import { describeError, json } from '../lib/host/routes.js'
import { ACTIONS, ERROR_CODES, PLUGIN_ID, RPC_ROUTE } from '../lib/shared.js'

/**
 * A context that records registrations instead of performing them.
 *
 * `inject` runs its callback synchronously, which is the *hostile* case: it
 * means both the direct attempt and the waiting attempt in `apply` fire, and a
 * missing guard shows up as two registrations of one path (which the real
 * `connection.fetch.register` rejects with a throw).
 */
function fakeContext({ connectionPresent = true, injectFires = true } = {}) {
  const fetchRoutes = []
  const effects = []
  const logs = []
  const routesSeen = new Set()

  const connection = connectionPresent
    ? {
        fetch: {
          register(route) {
            // Mirrors the real registry: a second registration of one path throws.
            if (routesSeen.has(route.path)) {
              throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`)
            }
            routesSeen.add(route.path)
            fetchRoutes.push(route)
            return () => {
              routesSeen.delete(route.path)
            }
          },
        },
      }
    : undefined

  const webServer = {
    register() {
      throw new Error('a webServer route would shadow the /api prefix route and bypass the fence')
    },
  }

  const services = {}
  if (connection !== undefined) services.connection = connection
  services.webServer = webServer

  const ctx = {
    logger: { info: () => {}, warn: (message) => logs.push(`warn:${message}`), error: () => {} },
    get: (serviceName, fallback) => (Object.prototype.hasOwnProperty.call(services, serviceName) ? services[serviceName] : fallback),
    effect: (callback, label) => {
      const disposer = callback()
      effects.push({ label, disposer })
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    inject: (deps, callback) => {
      if (injectFires) callback(ctx)
      return () => {}
    },
    // Services the handlers read lazily; the status action is never called here.
    sessions: undefined,
    subprocess: {
      resolveExecutable: async () => 'git',
      spawn: () => {
        throw new Error('no git child should be spawned by a registration test')
      },
    },
  }

  return { ctx, fetchRoutes, effects, logs, routesSeen }
}

describe('the plugin manifest', () => {
  it('is keyed by the package name the client bundle registers under', () => {
    assert.equal(name, PLUGIN_ID)
    assert.equal(PLUGIN_ID, 'dsh-gitbar-lite')
  })

  it('declares only the services it cannot run without', () => {
    assert.deepEqual(inject, ['subprocess', 'sessions'])
    // `connection` is deliberately absent: declaring it would park the whole
    // plugin on a composition without the Web bundle, and the plugin is still
    // useful headless. It is acquired opportunistically in `apply` instead.
    assert.equal(inject.includes('connection'), false)
  })

  it('exposes the factories the suite drives, rather than a second copy of them', () => {
    for (const key of ['readConfig', 'DEFAULTS', 'createGit', 'createRepo', 'createStore', 'createHandlers', 'createRoute']) {
      assert.ok(internals[key] !== undefined, `internals.${key} is missing`)
    }
  })
})

describe('Config', () => {
  it('has exactly the documented fields, with the documented defaults', () => {
    const defaults = new Config({}).get()
    assert.deepEqual(defaults, {
      gitPath: '',
      stateDir: '',
      timeoutMs: 30000,
      maxDiffBytes: 512 * 1024,
      maxFileBytes: 2 * 1024 * 1024,
      trashLimit: 200,
      scanDepth: 3,
      autoFetchMs: 300000,
      summaryScript: '',
      openWith: [],
    })
  })

  it('is volatile, which is what lets the settings page edit it without a restart', () => {
    assert.equal(Config.meta?.volatile, true)
  })

  it('reads a plain object, a volatile frozenset, and nothing at all', () => {
    assert.equal(readConfig({ timeoutMs: 5 }).timeoutMs, 5)
    assert.equal(readConfig({ timeoutMs: 5 }).maxDiffBytes, 512 * 1024, 'unspecified fields keep their defaults')

    // A volatile schemastery root exposes `get()`; a caller may hand us either.
    const frozenset = { get: () => ({ trashLimit: 7 }) }
    assert.equal(readConfig(frozenset).trashLimit, 7)
    assert.equal(readConfig(frozenset).timeoutMs, 30000)

    assert.deepEqual(readConfig(undefined), new Config({}).get())
    assert.deepEqual(readConfig(null), new Config({}).get())
  })

  it('ignores an explicit null rather than letting it erase a default', () => {
    assert.equal(readConfig({ timeoutMs: null }).timeoutMs, 30000)
  })
})

describe('apply: the route carrier', () => {
  it('registers one route on connection.fetch and never touches webServer', () => {
    const env = fakeContext()
    apply(env.ctx, {})

    assert.equal(env.fetchRoutes.length, 1, 'exactly one route')
    assert.equal(env.fetchRoutes[0].path, RPC_ROUTE)
    assert.deepEqual(env.fetchRoutes[0].methods, ['POST'])
    assert.equal(env.fetchRoutes[0].requestBody, 'buffered')
    assert.equal(typeof env.fetchRoutes[0].fetch, 'function')
    assert.ok(RPC_ROUTE.startsWith('/api/'), 'the path must sit under the fenced /api prefix')
  })

  it('registers exactly once even when the service is already present and inject fires immediately', () => {
    // The regression this pins: `apply` tries the service directly and also
    // waits through `ctx.inject`. When `connection` is already provided, both run
    // — and the second `register` for one path throws, so the plugin would fail
    // to load depending on service order.
    const env = fakeContext({ connectionPresent: true, injectFires: true })
    assert.doesNotThrow(() => apply(env.ctx, {}))
    assert.equal(env.fetchRoutes.length, 1)
  })

  it('waits for connection when it is absent, and registers when it arrives', () => {
    const env = fakeContext({ connectionPresent: false, injectFires: false })
    apply(env.ctx, {})
    assert.equal(env.fetchRoutes.length, 0, 'nothing to register onto yet')

    // Now let the service arrive, the way `ctx.inject` delivers it.
    const late = fakeContext()
    env.ctx.inject = (deps, callback) => {
      callback(late.ctx)
      return () => {}
    }
    apply(env.ctx, {})
    assert.equal(late.fetchRoutes.length, 1)
  })

  it('owns the registration through an effect, so unloading unregisters it', () => {
    const env = fakeContext()
    apply(env.ctx, {})
    const entry = env.effects.find((record) => record.label === 'dsh-gitbar-lite: rpc route')
    assert.ok(entry !== undefined, 'the route is installed through ctx.effect with a label')
    assert.equal(typeof entry.disposer, 'function')
    assert.equal(env.routesSeen.has(RPC_ROUTE), true)
    entry.disposer()
    assert.equal(env.routesSeen.has(RPC_ROUTE), false, 'the disposer really unregisters')
  })

  it('stays silent, rather than throwing, when no carrier is ever offered', () => {
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      get: () => undefined,
      effect: () => () => {},
      inject: () => () => {},
      subprocess: { resolveExecutable: async () => 'git' },
    }
    assert.doesNotThrow(() => apply(ctx, {}))
  })
})

describe('describeError', () => {
  it('passes a RepoError through with its own code and a matching status', () => {
    const described = describeError(new RepoError(ERROR_CODES.CONFLICT, '有冲突'))
    assert.deepEqual(described, { code: ERROR_CODES.CONFLICT, message: '有冲突', status: 409 })
  })

  it('keeps a coded error raised deep in another layer (E_NO_GIT)', () => {
    const error = new Error('找不到 git 可执行文件')
    error.code = ERROR_CODES.NO_GIT
    const described = describeError(error)
    assert.equal(described.code, ERROR_CODES.NO_GIT)
    assert.equal(described.status, 503)
  })

  it('classifies a GitFailure, including the "nothing to commit" case git puts on stdout', () => {
    const nothingStaged = new GitFailure('git commit', {
      exitCode: 1,
      // git writes this to stdout and leaves stderr empty — a stderr-only matcher
      // would report it as an unexplained internal failure.
      stdout: 'nothing to commit, working tree clean\n',
      stderr: '',
    })
    assert.equal(describeError(nothingStaged).code, ERROR_CODES.NOTHING_STAGED)

    const rejected = new GitFailure('git push', { exitCode: 1, stdout: '', stderr: '! [rejected] main -> main (fetch first)' })
    assert.equal(describeError(rejected).code, ERROR_CODES.PUSH_REJECTED)

    const denied = new GitFailure('git push', { exitCode: 128, stdout: '', stderr: 'fatal: Authentication failed for https://example.invalid' })
    assert.equal(describeError(denied).code, ERROR_CODES.AUTH)

    const unnamed = new GitFailure('git rev-parse', { exitCode: 128, stdout: '', stderr: 'fatal: something else entirely' })
    assert.equal(describeError(unnamed).code, ERROR_CODES.GIT_FAILED)
  })

  it('falls back to an internal error for anything else, without leaking a stack', () => {
    const described = describeError(new TypeError('x is not a function'))
    assert.equal(described.code, ERROR_CODES.INTERNAL)
    assert.equal(described.status, 500)
    assert.equal(described.message, 'x is not a function')
    assert.equal(describeError('a bare string').message, 'a bare string')
  })
})

describe('json', () => {
  it('answers JSON that is never cached', async () => {
    const response = json({ ok: true })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.match(response.headers.get('content-type') ?? '', /application\/json/)
    assert.deepEqual(await response.json(), { ok: true })
  })

  it('carries a non-200 status when asked', () => {
    assert.equal(json({ ok: false }, 409).status, 409)
  })
})

describe('the action surface', () => {
  it('names every action the client sends', () => {
    // The browser half repeats these literals; `test/check.mjs` compares the two
    // lists, and this asserts the list itself has not grown a hole.
    assert.deepEqual(Object.values(ACTIONS).sort(), [
      'bind',
      'commit',
      'commitAndPush',
      'discard',
      'fetch',
      'fileDiff',
      'openFile',
      'openers',
      'prefs',
      'push',
      'repos',
      'runScript',
      'saveScript',
      'stage',
      'status',
      'trashClear',
      'trashDelete',
      'trashDiff',
      'trashList',
      'trashRestore',
    ])
  })

  it('has a distinct code for every failure the UI branches on', () => {
    const codes = Object.values(ERROR_CODES)
    assert.equal(new Set(codes).size, codes.length)
    for (const code of codes) assert.match(code, /^E_[A-Z_]+$/)
  })
})
