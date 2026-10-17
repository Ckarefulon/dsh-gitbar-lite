/**
 * Render every seat the bundle registers.
 *
 * Why this file exists
 * -------------------
 * `client.test.mjs` asserts on the element trees the four hook-free components
 * return. That is the right way to test those four, and it is also a blind spot:
 * the three *bodies* — GitBody, TrashBody, DiffBody — are never rendered at all,
 * so a render-time error in one of them cannot be caught. And a render-time
 * error in a tab body is not a small thing: there is no error boundary around a
 * sidebar tab, so it blanks the whole panel.
 *
 * That is not hypothetical. A `const` read by a dependency array before it was
 * declared threw a ReferenceError inside GitBody and blanked the panel on every
 * session; the rest of the suite was green throughout, because nothing rendered
 * the body. This file closes that hole by rendering all six seats.
 *
 * What it is not
 * --------------
 * A DOM test. The React here is the same seven-line stub the other client tests
 * use, which is enough to *build* a tree and to surface a ReferenceError, a
 * missing import, or a call to something that does not exist — the class of
 * failure that actually blanked the panel. Real layout is still unverified, for
 * the reasons `docs/CONTRACT.md` gives.
 *
 * @module dsh-gitbar-lite/test/seats
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * The bundle, loaded the way the host loads it.
 *
 * `initial` lets a caller seed `useState`: the stub otherwise fixes every hook at
 * its first value, so a body can only ever render its loading branch and the
 * parts that depend on loaded data stay unrendered. Seeding it is not a
 * fabrication — it is the state the host really does deliver, one tick later.
 *
 * @param {unknown[]} [initial] the values `useState` returns, in call order
 */
function loadBundle(seeds = []) {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

  let stateIndex = 0
  let initial = seeds
  // The hook calls made by one render, in order. `renderBody` resets it before
  // each render and compares lengths, which is the check React itself makes.
  let hookLog = null

  const styleElements = []
  globalThis.window = globalThis
  globalThis.document = {
    createElement: (tag) => ({ tag, style: {}, setAttribute() {}, appendChild() {}, remove() {} }),
    querySelector: (selector) => styleElements.find((el) => el.selector === selector) ?? null,
    head: { appendChild: (el) => styleElements.push(el) },
    body: { appendChild() {}, removeChild() {} },
  }

  let registered = null
  globalThis.__ModuleLoader__ = {
    load: (spec) => {
      registered = spec
    },
  }

  const require = (name) => {
    if (name === 'react') {
      // Every hook is recorded so a render can be checked for a stable hook count.
      // Without that, a hook below an early return is invisible to this stub: it
      // has no memory, so it happily answers a `useCallback` that React itself
      // would reject as "rendered more hooks than during the previous render" —
      // and that rejection blanks the panel. This is how 0.5.4 shipped broken
      // with every test green.
      const record = () => {
        if (hookLog !== null) hookLog.push(1)
      }
      return {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useState: (fallback) => {
          record()
          const value = stateIndex < initial.length ? initial[stateIndex] : fallback
          stateIndex += 1
          return [value, () => {}]
        },
        useRef: (initialRef) => {
          record()
          return { current: initialRef }
        },
        useEffect: () => {
          record()
        },
        useCallback: (fn) => {
          record()
          return fn
        },
        useMemo: (fn) => {
          record()
          return fn()
        },
        useContext: (value) => {
          record()
          return value
        },
        Fragment: 'Fragment',
      }
    }
    throw new Error(`unexpected require: ${name}`)
  }

  const factory = new Function('window', 'document', 'navigator', 'globalThis', 'require', 'fetch', source)
  factory(globalThis, globalThis.document, globalThis.navigator, globalThis, require, () => {})

  assert.ok(registered !== null, 'the bundle registered itself with the module loader')
  assert.equal(typeof registered.factory, 'function', 'and it registered a factory')

  const bundle = registered.factory(require)

  /**
   * Render one component, and check it used the same number of hooks as the last
   * render of it.
   *
   * This is the check the plain stub could not make, and its absence let a
   * `useCallback` below an early return ship in 0.5.4: the loading render skipped
   * it, the loaded render called it, and React blanked the panel. Comparing
   * counts across two renders of the same component is exactly what React does.
   *
   * @param {string} label identifies the component in the failure message
   * @param {Function} component
   * @param {object} props
   */
  const counts = new Map()
  const renderChecked = (label, component, props) => {
    hookLog = []
    const tree = component(props)
    const count = hookLog.length
    hookLog = null

    const first = counts.get(label)
    if (first === undefined) {
      counts.set(label, count)
    } else if (first !== count) {
      throw new Error(
        `${label} called ${count} hooks on this render and ${first} on the previous one — ` +
          'a hook below an early return. React rejects this and blanks the panel.',
      )
    }
    return tree
  }

  /** Point `useState` at a different set of initial values for the next render. */
  const seed = (next) => {
    initial = next
    stateIndex = 0
  }

  return { internals: bundle.internals, apply: bundle.apply, renderChecked, seed }
}

/** A ctx shaped like the host's, recording what the bundle registers. */
function createCtx() {
  const seats = []
  const tabDefs = []

  const slots = {
    inject: (name, factory) => {
      const registered = factory()
      for (const seat of Array.isArray(registered) ? registered : [registered]) {
        if (seat !== null && typeof seat === 'object' && typeof seat.name === 'string') {
          seats.push({ ...seat })
        }
      }
      return () => {}
    },
    register: (definition, component) => {
      seats.push({ ...definition, component })
      return () => {}
    },
  }

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    slots,
    locale: { register: () => () => {}, bind: () => (key) => key },
    sidebarRightTabs: {
      register: (definition) => {
        tabDefs.push(definition)
        return () => {}
      },
    },
    sidebarRight: { openTabIn() {}, openResourceIn() {}, closeIn() {}, tabsIn: () => [] },
    // Called once: a stub that runs the callback twice registers everything
    // twice, which reads as a duplicate registration rather than as a stub bug.
    effect: (callback) => {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    inject: (_deps, callback) => {
      callback(ctx)
      return () => {}
    },
    get: (name, fallback) => fallback,
  }

  return { ctx, seats, tabDefs }
}

/** The props the shell hands a body: the translator, the ctx, and the tab hook. */
function bodyProps(ctx, overrides = {}) {
  const tab = {
    sessionId: 'session-seats',
    visible: true,
    signal: new AbortController().signal,
    navigation: { address: 'dsh-resource://x', params: {}, revision: 1 },
    actions: { bindCommands: () => () => {} },
    ...(overrides.tab ?? {}),
  }
  return {
    t: (key, params) => (params === undefined ? key : `${key}${JSON.stringify(params)}`),
    ctx,
    sessionId: 'session-seats',
    useTabInfo: () => ({ sidebar: { expanded: true, fullscreen: false }, panel: { id: 'p1' }, tab }),
    ...overrides,
  }
}

test('the bundle registers three tabs and a body and a title for each', () => {
  const bundle = loadBundle()
  const { ctx, seats, tabDefs } = createCtx()

  bundle.apply(ctx)

  assert.deepEqual(
    tabDefs.map((definition) => `${definition.id}:${definition.kind}`),
    ['dsh-gitbar-lite/git:gitbar', 'dsh-gitbar-lite/trash:gitbar-trash', 'dsh-gitbar-lite/diff:gitbar-diff'],
  )

  for (const id of ['dsh-gitbar-lite/git', 'dsh-gitbar-lite/trash', 'dsh-gitbar-lite/diff']) {
    const body = seats.find((seat) => seat.name === 'sidebar.right.pane.tab' && seat.key === id)
    const title = seats.find((seat) => seat.name === 'sidebar.right.pane.tab.title' && seat.key === id)
    assert.equal(typeof body?.component, 'function', `${id} has a body`)
    assert.equal(typeof title?.component, 'function', `${id} has a title`)
  }
})

test('every seat renders without throwing', () => {
  const bundle = loadBundle()
  const { ctx, seats } = createCtx()

  // `apply` itself must not throw: a bundle that fails to install registers
  // nothing, and the panel shows the owner's "nothing can view this" notice
  // rather than anything recognisable.
  bundle.apply(ctx)

  assert.ok(seats.length > 0, 'something was registered')

  for (const seat of seats) {
    if (typeof seat.component !== 'function') continue
    const label = `${seat.name}${seat.key === undefined ? '' : `/${seat.key}`}`
    let threw = null
    try {
      seat.component(bodyProps(ctx))
    } catch (error) {
      threw = error
    }
    assert.equal(threw, null, `${label} rendered (${threw?.message ?? 'ok'})`)
  }
})

test('every toast the panel can show has copy in both languages', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

  // Two failures this catches, both of which happened:
  //   * copy written and never called — three trash toasts were added and never
  //     wired, so a restore said nothing at all;
  //   * a call site with no copy — the user sees the raw key.
  const used = new Set([...source.matchAll(/\bt\('(toast\.[a-zA-Z]+)'/g)].map((match) => match[1]))

  const bundle = loadBundle()
  const zh = bundle.internals.ZH
  const en = bundle.internals.EN

  const definedZh = new Set(Object.keys(zh).filter((key) => key.startsWith('toast.')))
  const definedEn = new Set(Object.keys(en).filter((key) => key.startsWith('toast.')))

  assert.deepEqual([...definedZh].sort(), [...definedEn].sort(), 'both languages carry the same toast keys')

  for (const key of used) assert.ok(definedZh.has(key), `${key} is used and has copy`)
  for (const key of definedZh) assert.ok(used.has(key), `${key} has copy and is used somewhere`)
})

test('the panel header offers a select-all box, and it reflects the selection', () => {
  const status = (files) => ({
    ok: true,
    repoRoot: 'C:/repo',
    repoName: 'repo',
    branch: { head: 'main', detached: false, ahead: 0, behind: 0, upstream: 'origin/main' },
    head: { oid: 'a'.repeat(40), short: 'aaaaaaa', subject: 'init' },
    remotes: ['origin'],
    lastFetchAt: null,
    autoFetchMs: 0,
    summaryScript: '',
    files,
    counts: { files: files.length, staged: files.filter((f) => f.staged).length, partial: 0, conflicted: 0, additions: 0, deletions: 0 },
    primary: 'fetch',
    workspacePath: 'C:/repo',
  })

  const file = (path, staged) => ({
    path,
    index: 'M',
    worktree: '.',
    kind: 'modified',
    untracked: false,
    ignored: false,
    conflicted: false,
    staged,
    partial: false,
    added: 1,
    deleted: 0,
    binary: false,
  })

  // One bundle, two renders of the same component. The loading render comes
  // first on purpose: it is the one that skips every hook below the early return,
  // so comparing the two hook counts is what catches a hook that only exists on
  // the loaded path — which is the bug that blanked the panel in 0.5.4.
  const renderWith = (files) => {
    const bundle = loadBundle()
    const { ctx, seats } = createCtx()
    bundle.apply(ctx)
    const body = seats.find((seat) => seat.name === 'sidebar.right.pane.tab' && seat.key === 'dsh-gitbar-lite/git')
    const props = bodyProps(ctx)

    bundle.seed([null, 'loading'])
    bundle.renderChecked('GitBody', body.component, props)

    bundle.seed([status(files), 'ready'])
    return bundle.renderChecked('GitBody', body.component, props)
  }

  // The React stub keeps `h(type, props, [children])` as a single array child
  // rather than flattening it, so the walk has to descend into arrays too.
  const findSelectAll = (node) => {
    if (node === null || node === undefined) return null
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = findSelectAll(child)
        if (found !== null) return found
      }
      return null
    }
    if (typeof node !== 'object') return null
    if (node.props?.['data-gitbar-selectall'] !== undefined) return node
    for (const child of node.children ?? []) {
      const found = findSelectAll(child)
      if (found !== null) return found
    }
    return null
  }

  const none = findSelectAll(renderWith([file('a.txt', false), file('b.txt', false)]))
  assert.ok(none !== null, 'the header tick is rendered')
  assert.equal(none.props['data-gitbar-selectall'], 'none')
  assert.equal(none.props['aria-checked'], 'false')
  assert.equal(none.props.disabled, false, 'it is clickable when there is something to tick')

  const some = findSelectAll(renderWith([file('a.txt', true), file('b.txt', false)]))
  assert.equal(some.props['data-gitbar-selectall'], 'some')
  assert.equal(some.props['aria-checked'], 'mixed', 'a partial selection reads as mixed')

  const all = findSelectAll(renderWith([file('a.txt', true), file('b.txt', true)]))
  assert.equal(all.props['data-gitbar-selectall'], 'all')
  assert.equal(all.props['aria-checked'], 'true')

  // Nothing changed means nothing to tick, so the control is disabled rather
  // than offering to do something it cannot.
  const empty = findSelectAll(renderWith([]))
  assert.equal(empty.props['data-gitbar-selectall'], 'empty')
  assert.equal(empty.props.disabled, true)
})

test('each body also renders when its tab is hidden and when it has no session', () => {
  const bundle = loadBundle()
  const { ctx, seats } = createCtx()
  bundle.apply(ctx)

  const bodies = seats.filter((seat) => seat.name === 'sidebar.right.pane.tab' && typeof seat.component === 'function')
  assert.equal(bodies.length, 3, 'three bodies')

  for (const seat of bodies) {
    const label = `${seat.name}/${seat.key}`

    // Hidden: every body branches on `tab.visible`, and the hidden branch is
    // where a body most often forgets a guard.
    assert.doesNotThrow(() => seat.component(bodyProps(ctx, { tab: { visible: false } })), `${label} hidden`)

    // No session: a body with no session must render its empty state rather than
    // read `sessionId` off an undefined tab.
    assert.doesNotThrow(
      () => seat.component(bodyProps(ctx, { sessionId: undefined, tab: { sessionId: undefined } })),
      `${label} with no session`,
    )
  }
})
