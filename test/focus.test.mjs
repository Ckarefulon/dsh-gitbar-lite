/**
 * "Looked at again": the panel re-reads the list and lets the script fill the
 * Summary — on open, on return, and never at the cost of what the user typed.
 *
 * Why this file exists
 * -------------------
 * This behaviour shipped twice without working. The first version keyed on
 * `tabInfo.tab.visible`, which in this shell stays true for as long as the
 * sidebar is expanded and the tab is its pane's active tab — so "the user came
 * back to the panel" was invisible to it. The second version listened for the
 * right events but asked *this render's closure* whether a script existed, and
 * that closure is from before the read that was just awaited — so on the panel's
 * first open it answered "no script" and never filled anything.
 *
 * Neither failure is visible to the stub-based suites, which do not run effects.
 * So this file runs the real bundle against a small but real React: state,
 * effects with dependency comparison, callbacks, refs. It is not a DOM test and
 * does not try to be one; it asserts on the calls the panel made and on the
 * values it rendered.
 *
 * @module dsh-gitbar-lite/test/focus
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// --------------------------------------------------------------- tiny React

const Fragment = Symbol('Fragment')

function createRuntime() {
  const instances = new Map()
  let currentKey = null
  let hookIndex = 0
  let effects = []
  let dirty = false
  let elements = []
  let root = null

  const sameDeps = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))

  const hooksOf = () => {
    let instance = instances.get(currentKey)
    if (instance === undefined) {
      instance = { hooks: [] }
      instances.set(currentKey, instance)
    }
    return instance.hooks
  }

  const React = {
    Fragment,
    createElement(type, props, ...children) {
      const own = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
      return { type, props: props === null ? {} : props, children: own }
    },
    useState(fallback) {
      const hooks = hooksOf()
      const index = hookIndex++
      if (hooks[index] === undefined) {
        hooks[index] = { kind: 'state', value: typeof fallback === 'function' ? fallback() : fallback }
      }
      const slot = hooks[index]
      return [
        slot.value,
        (next) => {
          const value = typeof next === 'function' ? next(slot.value) : next
          if (!Object.is(value, slot.value)) {
            slot.value = value
            dirty = true
          }
        },
      ]
    },
    useRef(initial) {
      const hooks = hooksOf()
      const index = hookIndex++
      if (hooks[index] === undefined) hooks[index] = { kind: 'ref', current: initial }
      return hooks[index]
    },
    useEffect(fn, deps) {
      const hooks = hooksOf()
      const index = hookIndex++
      if (hooks[index] === undefined) hooks[index] = { kind: 'effect', deps: undefined, cleanup: undefined }
      effects.push({ key: currentKey, index, fn, deps })
    },
    useCallback(fn, deps) {
      const hooks = hooksOf()
      const index = hookIndex++
      const slot = hooks[index]
      if (slot === undefined || slot.kind !== 'memo' || !sameDeps(slot.deps, deps)) {
        hooks[index] = { kind: 'memo', deps, value: fn }
      }
      return hooks[index].value
    },
    useMemo(fn, deps) {
      const hooks = hooksOf()
      const index = hookIndex++
      const slot = hooks[index]
      if (slot === undefined || slot.kind !== 'memo' || !sameDeps(slot.deps, deps)) {
        hooks[index] = { kind: 'memo', deps, value: fn() }
      }
      return hooks[index].value
    },
  }

  const renderNode = (node, path) => {
    if (node === null || node === undefined || node === true || node === false) return null
    if (Array.isArray(node)) return node.map((child, index) => renderNode(child, `${path}/${index}`))
    if (typeof node !== 'object') return { kind: 'text', text: String(node) }
    if (node.type === Fragment) return renderNode(node.children, path)
    if (typeof node.type === 'function') {
      const key = `${path}:${node.type.name || 'component'}`
      const parent = currentKey
      currentKey = key
      hookIndex = 0
      const rendered = node.type({ ...node.props, children: node.children })
      currentKey = parent
      return renderNode(rendered, `${key}#out`)
    }
    const host = { kind: 'host', type: node.type, props: node.props ?? {}, children: [] }
    elements.push(host)
    const kids = node.children === undefined ? [] : Array.isArray(node.children) ? node.children : [node.children]
    host.children = kids.map((child, index) => renderNode(child, `${path}/${index}`))
    return host
  }

  /** Render until nothing is pending: state updates and newly-run effects. */
  const pump = async (label = '') => {
    for (let round = 0; round < 80; round += 1) {
      dirty = false
      effects = []
      elements = []
      hookIndex = 0
      currentKey = null
      renderNode(root, 'root')

      let ran = 0
      for (const effect of effects) {
        const instance = instances.get(effect.key)
        const slot = instance?.hooks[effect.index]
        if (slot !== undefined && sameDeps(slot.deps, effect.deps)) continue
        if (typeof slot?.cleanup === 'function') slot.cleanup()
        const cleanup = effect.fn()
        instance.hooks[effect.index] = { kind: 'effect', deps: effect.deps, cleanup }
        ran += 1
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (!dirty && ran === 0) return
    }
    throw new Error(`never settled${label === '' ? '' : ` (${label})`}`)
  }

  return {
    React,
    pump,
    elements: () => elements,
    /** A fresh mount: every hook instance is forgotten, as an unmount would. */
    remount(element) {
      instances.clear()
      root = element
    },
    async mount(element, label = '') {
      this.remount(element)
      await pump(label)
    },
  }
}

// ------------------------------------------------------------------ the panel

/**
 * Load the real bundle against a fake host and return a tiny driver.
 *
 * @param {{ script?: string, summary?: string }} [options]
 */
function createPanel(options = {}) {
  const runtime = createRuntime()
  const window = new EventTarget()
  const document = {
    querySelector: () => null,
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, remove() {} }),
    head: { appendChild() {} },
    body: { appendChild() {}, removeChild() {} },
    visibilityState: 'visible',
    addEventListener: () => {},
    removeEventListener: () => {},
  }

  const calls = []
  let stored = options.script ?? ''
  const statusFields = {
    workspacePath: 'C:/work',
    workspaceTitle: 'work',
    source: 'binding',
    repoRoot: 'C:/work/repo',
    repoName: 'repo',
    files: [],
    counts: { files: 0, staged: 0 },
    branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0 },
    remotes: ['origin'],
    prefs: {},
    primary: 'fetch',
    lastFetchAt: null,
    autoFetchMs: 0,
  }

  const answer = async (action, body) => {
    calls.push(action)
    if (action === 'status') return { ...statusFields, summaryScript: stored }
    if (action === 'saveScript') {
      stored = body.script
      return { summaryScript: stored, script: stored }
    }
    if (action === 'runScript') return { ran: true, exitCode: 0, stdout: '1.4.2\n', stderr: '' }
    return {}
  }

  const fetchImpl = async (_path, init) => {
    const body = JSON.parse(init.body)
    return { status: 200, json: async () => ({ ok: true, ...(await answer(body.action, body)) }) }
  }

  let registered = null
  window.__ModuleLoader__ = { load: (spec) => (registered = spec) }
  new Function('window', 'document', 'navigator', 'globalThis', 'require', 'fetch', source)(
    window,
    document,
    { language: 'zh-CN' },
    globalThis,
    (id) => {
      if (id !== 'react') throw new Error(`unexpected require: ${id}`)
      return runtime.React
    },
    fetchImpl,
  )
  assert.notEqual(registered, null, 'the bundle registers itself')

  const bundle = registered.factory((id) => {
    if (id !== 'react') throw new Error(`unexpected require: ${id}`)
    return runtime.React
  })

  // The seats, registered the way the shell registers them.
  const seats = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    slots: {
      inject: (_name, factoryFn) => {
        const result = factoryFn()
        for (const seat of Array.isArray(result) ? result : [result]) seats.push({ ...seat })
        return () => {}
      },
      register: (definition, component) => {
        seats.push({ ...definition, component })
        return () => {}
      },
    },
    locale: { register: () => () => {}, bind: () => (key) => key },
    sidebarRightTabs: { register: () => () => {} },
    sidebarRight: { openTabIn() {}, openResourceIn() {}, closeIn() {}, tabsIn: () => [] },
    effect: (callback) => {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    inject: (_deps, callback) => callback(ctx),
  }
  bundle.apply(ctx)

  const { ZH, GIT_ID, interpolate } = bundle.internals
  const seat = seats.find((row) => row.key === GIT_ID && typeof row.component === 'function')
  assert.ok(seat !== undefined, 'the panel registers a body')

  // Stable across renders, as the shell's is: a fresh `tab` per call would
  // restart every effect that names it. `visible` is the one field that changes,
  // when a tab is switched away from and back to.
  const tab = {
    sessionId: 'session',
    visible: true,
    signal: undefined,
    actions: Object.freeze({ bindCommands: () => () => {} }),
  }

  const element = () =>
    runtime.React.createElement(seat.component, {
      t: (key, params) => interpolate(ZH[key] ?? key, params),
      ctx,
      sessionId: 'session',
      useTabInfo: () => ({ tab }),
    })

  const summaryValue = () => {
    const input = runtime.elements().find((host) => host.props['data-gitbar-summary'] !== undefined)
    return input === undefined ? undefined : input.props.value
  }

  return {
    mount: () => runtime.mount(element(), 'open'),
    pump: runtime.pump,
    window,
    calls,
    summaryValue,
    typeSummary(value) {
      const input = runtime.elements().find((host) => host.props['data-gitbar-summary'] !== undefined)
      input.props.onChange({ target: { value } })
      return runtime.pump('type')
    },
    /** Fire a return and let the debounce plus the read settle. */
    async returnTo() {
      // Past the cooldown the panel keeps between returns: a return inside it is
      // deliberately dropped, and that is asserted on its own below.
      await new Promise((resolve) => setTimeout(resolve, 1300))
      window.dispatchEvent(new Event('focus'))
      await new Promise((resolve) => setTimeout(resolve, 220))
      await runtime.pump('return')
    },
    /** Fire a return twice, inside the cooldown. */
    async returnTwice() {
      await new Promise((resolve) => setTimeout(resolve, 1300))
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('focus'))
      await new Promise((resolve) => setTimeout(resolve, 220))
      await runtime.pump('return twice')
    },
    /**
     * Switch the tab away and back, the way the shell does: `visible` flips.
     *
     * This is the "the user opened the tab" signal, and it must be honoured even
     * when it arrives inside the cooldown — the cooldown exists to collapse a
     * burst of overlapping signals, not to drop the one that means the panel just
     * appeared.
     */
    async switchAwayAndBack() {
      tab.visible = false
      await runtime.pump('switch away')
      tab.visible = true
      // Render first — the effect that schedules the return only runs on a render —
      // then let the 150ms debounce fire and the read settle.
      await runtime.pump('switch back')
      await new Promise((resolve) => setTimeout(resolve, 220))
      await runtime.pump('switch back settled')
    },
  }
}

// -------------------------------------------------------------------- checks

test('opening the panel reads the list and fills the Summary', async () => {
  const panel = createPanel({ script: 'echo 1.4.2' })
  await panel.mount()
  // The script half has to work on the FIRST open, when this render's closure
  // still describes a panel with no script at all.
  assert.deepEqual(panel.calls, ['status', 'runScript'])
  assert.equal(panel.summaryValue(), '1.4.2')
})

test('opening with no script is one read, and nothing else', async () => {
  const panel = createPanel({ script: '' })
  await panel.mount()
  assert.deepEqual(panel.calls, ['status'])
  assert.equal(panel.summaryValue(), '')
})

test('returning to the panel reads the list and fills an empty Summary', async () => {
  const panel = createPanel({ script: 'echo 1.4.2' })
  await panel.mount()
  await panel.returnTo()
  // mount + return, each a read; the second one also fills.
  assert.deepEqual(panel.calls, ['status', 'runScript', 'status', 'runScript'])
})

test('a Summary the user typed is never replaced', async () => {
  const panel = createPanel({ script: 'echo 1.4.2' })
  await panel.mount()
  await panel.typeSummary('hand written')
  await panel.returnTo()
  // The read still happens — the list may be stale — but the script stays away.
  assert.deepEqual(panel.calls, ['status', 'runScript', 'status'])
  assert.equal(panel.summaryValue(), 'hand written')
})

test('a Summary the script wrote is refilled on a return', async () => {
  const panel = createPanel({ script: 'echo 1.4.2' })
  await panel.mount()
  await panel.returnTo()
  assert.equal(panel.summaryValue(), '1.4.2')
  assert.equal(panel.calls.filter((action) => action === 'runScript').length, 2)
})

test('a burst of returns is one read', async () => {
  const panel = createPanel({ script: '' })
  await panel.mount()
  await panel.returnTwice()
  assert.deepEqual(panel.calls, ['status', 'status'])
})

test('switching the tab away and back is a return even inside the cooldown', async () => {
  const panel = createPanel({ script: 'echo 1.4.2' })
  await panel.mount()
  // Straight from the open, well inside the cooldown.
  await panel.switchAwayAndBack()
  assert.deepEqual(panel.calls, ['status', 'runScript', 'status', 'runScript'])
})
