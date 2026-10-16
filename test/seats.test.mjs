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

/** The bundle, loaded the way the host loads it. */
function loadBundle() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

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
      return {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useState: (initial) => [initial, () => {}],
        useRef: (initial) => ({ current: initial }),
        useEffect: () => {},
        useCallback: (fn) => fn,
        useMemo: (fn) => fn(),
        Fragment: 'Fragment',
      }
    }
    throw new Error(`unexpected require: ${name}`)
  }

  const factory = new Function('window', 'document', 'navigator', 'globalThis', 'require', 'fetch', source)
  factory(globalThis, globalThis.document, globalThis.navigator, globalThis, require, () => {})

  assert.ok(registered !== null, 'the bundle registered itself with the module loader')
  assert.equal(typeof registered.factory, 'function', 'and it registered a factory')
  return registered.factory(require)
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
