/**
 * "Looked at again": the panel re-reads the list and lets the script fill the
 * Summary — on open, on return, and never at the cost of what the user typed.
 * A re-read also decides which files look newly arrived and tick them, so this
 * file covers that rule too: what a refresh ticks, and what it must not.
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
 * @param {{ script?: string, files?: Array<{ path: string, staged?: boolean, partial?: boolean, conflicted?: boolean, kind?: string }> }} [options]
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
  const stages = []
  let stored = options.script ?? ''
  const statusFields = {
    workspacePath: 'C:/work',
    workspaceTitle: 'work',
    source: 'binding',
    repoRoot: 'C:/work/repo',
    repoName: 'repo',
    branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0 },
    remotes: ['origin'],
    prefs: {},
    primary: 'fetch',
    lastFetchAt: null,
    autoFetchMs: 0,
  }

  // A working tree the test can move: the panel's tick *is* the index, so a fake
  // host has to answer `status` from a real mutable list and let `stage` change
  // it, or the select-by-default rule cannot be observed at all.
  const repo = {
    files: (options.files ?? []).map((file) => ({
      staged: false,
      partial: false,
      conflicted: false,
      kind: 'modified',
      ...file,
    })),
    /** The worktree changed: a new path shows up unticked. */
    add(file) {
      this.files.push({ staged: false, partial: false, conflicted: false, kind: 'untracked', ...file })
    },
    /** What `git add` / `git restore --staged` did, as the host would report it. */
    apply(paths, staged) {
      const wanted = new Set(paths)
      for (const file of this.files) {
        if (!wanted.has(file.path)) continue
        file.staged = staged === true
        file.partial = false
      }
    },
    ticked(path) {
      return this.files.find((file) => file.path === path)?.staged === true
    },
  }

  const snapshot = () => repo.files.map((file) => ({ ...file }))
  const tally = () => ({
    files: repo.files.length,
    staged: repo.files.filter((file) => file.staged === true && file.conflicted !== true).length,
    conflicted: repo.files.filter((file) => file.conflicted === true).length,
  })
  const status = () => ({ ...statusFields, files: snapshot(), counts: tally(), summaryScript: stored })

  const answer = async (action, body) => {
    calls.push(action)
    if (action === 'status') return status()
    if (action === 'stage') {
      stages.push({ paths: [...body.paths], staged: body.staged === true })
      repo.apply(body.paths, body.staged)
      return status()
    }
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
    stages,
    repo,
    summaryValue,
    typeSummary(value) {
      const input = runtime.elements().find((host) => host.props['data-gitbar-summary'] !== undefined)
      input.props.onChange({ target: { value } })
      return runtime.pump('type')
    },
    /** Press one row's tick, the way a user unticking a file does. */
    async untick(path) {
      const row = runtime.elements().find((host) => host.props['data-gitbar-tick'] === path)
      assert.ok(row !== undefined, `the row for ${path} is rendered`)
      row.props.onClick({ stopPropagation() {} })
      await runtime.pump('untick')
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

// ------------------------------------------------- which paths a refresh ticks

test('opening a repository with an empty index ticks every changed file', async () => {
  const panel = createPanel({ files: [{ path: 'a.txt' }, { path: 'b.txt' }, { path: 'new.txt', kind: 'untracked' }] })
  await panel.mount()
  assert.deepEqual(panel.stages, [{ paths: ['a.txt', 'b.txt', 'new.txt'], staged: true }])
  assert.equal(panel.repo.ticked('new.txt'), true)
  // One read, one select-all call, and nothing after it: the list it produced is
  // fully ticked, so there is nothing left to offer.
  assert.deepEqual(panel.calls, ['status', 'stage'])
})

test('a file that appears while the panel is away is ticked, and the one the user unticked is not', async () => {
  const panel = createPanel({ files: [{ path: 'a.txt' }, { path: 'b.txt' }] })
  await panel.mount()
  assert.deepEqual(panel.stages.at(-1).paths, ['a.txt', 'b.txt'])

  // The user decides b.txt is not part of this commit.
  await panel.untick('b.txt')
  assert.equal(panel.repo.ticked('b.txt'), false)

  // The worktree moves on while the panel is not being looked at.
  panel.repo.add({ path: 'c.txt', kind: 'untracked' })
  await panel.returnTo()

  // Only the newcomer is ticked. Keying on the whole list — which is what this
  // did before — would have re-ticked b.txt here, because the list no longer
  // matched the set the guard had recorded, and that is the bug this asserts.
  assert.deepEqual(panel.stages.at(-1), { paths: ['c.txt'], staged: true })
  assert.equal(panel.repo.ticked('c.txt'), true)
  assert.equal(panel.repo.ticked('b.txt'), false)
  assert.equal(panel.repo.ticked('a.txt'), true)
})

test('a return with nothing new ticks nothing', async () => {
  const panel = createPanel({ files: [{ path: 'a.txt' }] })
  await panel.mount()
  await panel.untick('a.txt')
  const before = panel.stages.length
  await panel.returnTo()
  assert.equal(panel.stages.length, before, 'the untick survived the refresh')
  assert.equal(panel.repo.ticked('a.txt'), false)
})

test('opening a repository whose index is not empty leaves the existing choice alone', async () => {
  // Somebody had already curated the index — here: a.txt staged, b.txt not. The
  // first look has no earlier list to compare against, so it must not re-tick on
  // top of a choice it cannot see the history of.
  const panel = createPanel({ files: [{ path: 'a.txt', staged: true }, { path: 'b.txt' }] })
  await panel.mount()
  assert.deepEqual(panel.stages, [])
  assert.equal(panel.repo.ticked('b.txt'), false)

  // From then on the list is remembered, so a newcomer is still ticked.
  panel.repo.add({ path: 'c.txt', kind: 'untracked' })
  await panel.returnTo()
  assert.deepEqual(panel.stages, [{ paths: ['c.txt'], staged: true }])
})

test('a conflicted path is never ticked by the rule, and neither is a half-staged one', async () => {
  const panel = createPanel({ files: [{ path: 'a.txt' }] })
  await panel.mount()
  assert.deepEqual(panel.stages, [{ paths: ['a.txt'], staged: true }])

  // A merge clash, a path somebody half-staged in a terminal, and an ordinary
  // newcomer, all arriving at once.
  panel.repo.add({ path: 'clash.txt', conflicted: true })
  panel.repo.add({ path: 'half.txt', partial: true })
  panel.repo.add({ path: 'd.txt', kind: 'untracked' })
  await panel.returnTo()

  // `git add` on a conflicted file records a resolution nobody made, and `MM` is
  // a state somebody chose that one tick cannot express. Only d.txt is ticked.
  assert.deepEqual(panel.stages.at(-1), { paths: ['d.txt'], staged: true })
  assert.equal(panel.repo.ticked('clash.txt'), false)
  assert.equal(panel.repo.ticked('half.txt'), false)
})
