/**
 * dsh-gitbar-lite — host half.
 *
 * A GitHub Desktop-shaped Git panel for the built-in right sidebar. The host
 * half owns everything that touches the disk or the repository:
 *
 *   - `createGit`       runs git through `ctx.subprocess` (resolved executable,
 *                       containment, a bounded output buffer, a scrubbed env);
 *   - `createRepo`      the operations themselves — status, stage, commit,
 *                       push, fetch, per-file diff, discard;
 *   - `createStore`     the workspace→repository bindings, the UI preferences,
 *                       and the plugin's own trash under `<DSH_HOME>`;
 *   - `createHandlers`  the RPC actions the browser half calls;
 *   - `createRoute`     one exact Fetch route on `connection.fetch`.
 *
 * The browser half lives in `lib/client.js` and speaks to this one only over
 * that route, so it inherits the harness Host/Origin fence and the browser
 * cookie check for free.
 *
 * @module dsh-gitbar-lite
 */

import z from '@deepseek-ai/schemastery'

import { createGit } from './host/git.js'
import { createRepo } from './host/repo.js'
import { createHandlers, createRoute } from './host/routes.js'
import { createStore } from './host/store.js'
import { PLUGIN_ID } from './shared.js'

/** Stable Loader identity; also the settings namespace and the client bundle id. */
export const name = PLUGIN_ID

/**
 * Only what the plugin cannot work without.
 *
 * `connection` is deliberately NOT here: declaring it would park the whole
 * plugin when the Web bundle is absent, and the plugin is still perfectly able
 * to run headless. It is acquired opportunistically instead (see `apply`).
 */
export const inject = ['subprocess', 'sessions']

/** Guard for a schemastery build without `volatile()`. */
const vol = (schema) => (typeof schema?.volatile === 'function' ? schema.volatile() : schema)

/**
 * Plugin configuration.
 *
 * Every field is volatile, which is what lets the user change them from the
 * settings page without a restart — and is why `cordis.patch.yml` deliberately
 * carries no `config` block: values written into the profile's own patch layer
 * must not be shadowed by this package on the next upgrade.
 */
export const Config = vol(
  z.object({
    /** Explicit git executable; empty means "whatever is on PATH". */
    gitPath: z.string().default(''),
    /** Override the plugin's state directory; empty means `<DSH_HOME>/dsh-gitbar-lite`. */
    stateDir: z.string().default(''),
    /** Per-command timeout. A push to a slow remote may need more. */
    timeoutMs: z.number().default(30000),
    /** Ceiling on one archived diff, in bytes. */
    maxDiffBytes: z.number().default(512 * 1024),
    /** Files larger than this are listed but their content is not archived or diffed. */
    maxFileBytes: z.number().default(2 * 1024 * 1024),
    /** How many trash entries to keep before the oldest are dropped. */
    trashLimit: z.number().default(200),
    /** Directory depth the repository picker scans below the workspace root. */
    scanDepth: z.number().default(3),
    /**
     * How often the panel fetches on its own, in milliseconds.
     *
     * A fetch only moves remote refs, never the working tree, so it is safe to
     * do unattended — but it does hit the network and it does write
     * `.git/FETCH_HEAD`, which is why it is opt-out rather than opt-in. Set to 0
     * to disable it; the button still works.
     */
    autoFetchMs: z.number().default(300000),
  }),
)

/** Defaults, read from the schema rather than restated. */
const DEFAULTS = new Config({}).get()

/**
 * Resolve the live config.
 *
 * A volatile schemastery root is a frozenset whose values are read through
 * `get()`; a plain one is the object itself. Both shapes have to work, because
 * whether the schema is volatile is not something this module controls.
 *
 * @param {unknown} rawConfig
 * @returns {typeof DEFAULTS}
 */
export function readConfig(rawConfig) {
  const source = typeof rawConfig?.get === 'function' ? rawConfig.get() : rawConfig
  const record = source !== null && typeof source === 'object' ? source : {}
  const resolved = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    const value = record[key]
    if (value !== undefined && value !== null) resolved[key] = value
  }
  return resolved
}

/**
 * Install the host half.
 *
 * @param {object} ctx host context
 * @param {unknown} rawConfig the Loader's config for this row
 */
export function apply(ctx, rawConfig) {
  const config = readConfig(rawConfig)
  const git = createGit(ctx, config)
  const store = createStore(ctx, config)
  const repo = createRepo(git, config)
  const handlers = createHandlers({ ctx, git, repo, store })
  const route = createRoute({ handlers, logger: ctx.logger })

  /**
   * Register the route on the preferred carrier, exactly once.
   *
   * The guard is load-bearing, not defensive: `connection` may already be
   * present when this plugin loads, in which case `ctx.inject` fires its
   * callback immediately *as well as* the direct attempt below running — and
   * `connection.fetch.register` rejects a second registration of the same path.
   * Without the flag the plugin would either throw at load or, worse, race
   * itself depending on service order.
   *
   * `connection.fetch` is the only acceptable carrier. An exact `webServer`
   * route on the same path resolves *before* the harness's `/api` prefix route,
   * which is where the Host/Origin fence and the browser-cookie check live — so
   * using one would turn this into an unauthenticated git endpoint reachable by
   * any page that can guess the path.
   */
  let registered = false
  const install = (scope) => {
    if (registered) return
    const connection = scope.get('connection', false)
    if (connection?.fetch?.register === undefined) return
    // Own the lifetime explicitly rather than relying on the service proxy's
    // call-site binding: the disposer is the registration's, so unloading the
    // plugin always unregisters the route. Assign `registered` only after the
    // effect has actually run, so a throw here leaves the plugin retryable.
    scope.effect(() => connection.fetch.register(route), 'dsh-gitbar-lite: rpc route')
    registered = true
  }

  install(ctx)
  // Services load in no guaranteed order, so wait for `connection` the public
  // way. It fires when the service arrives and stays silent if it never does.
  ctx.inject(['connection'], (scope) => install(scope))
}

/**
 * Internals exposed for the test suite.
 *
 * The suite drives real registrations against a fake context rather than
 * re-implementing the plugin, so it needs the same factories `apply` uses.
 */
export const internals = {
  readConfig,
  DEFAULTS,
  createGit,
  createRepo,
  createStore,
  createHandlers,
  createRoute,
}
