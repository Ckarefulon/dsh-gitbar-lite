/**
 * The browser half, loaded the way the module loader loads it.
 *
 * There is no jsdom and no bundler here. The bundle is a classic script, so it
 * is run with `new Function(globals, source)` and handed exactly the globals the
 * shell hands it; `require` is a seven-line React stub, because nothing in
 * `apply` renders. What that buys is the failure mode with the worst blast
 * radius — *loaded but did not register its own id* — caught before a restart,
 * plus every registration pinned to the identity the host dispatches on.
 *
 * The three components with no hooks in them are exercised as plain functions
 * and asserted on their element tree, which is where the UI rules that matter
 * (a tick reflects the index, the confirmation defaults to keeping a copy)
 * actually live.
 *
 * @module dsh-gitbar-lite/test/client
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import vm from 'node:vm'

import { ACTIONS, ERROR_CODES, PLUGIN_ID, RPC_ROUTE } from '../lib/shared.js'

const root = dirname(import.meta.dirname)
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** The bundle at the path the manifest names — the only path the loader reads. */
const bundlePath = join(root, manifest.exports['./client'])
const bundle = readFileSync(bundlePath, 'utf8')

// --------------------------------------------------------------- stubs

/** `React.createElement` and the hooks `apply` touches, and nothing more. */
function createReactStub() {
  const toText = (value) => ({ type: '#text', text: String(value), props: {}, children: [] })

  const childrenOf = (list) => {
    const out = []
    const walk = (items) => {
      for (const item of items) {
        if (Array.isArray(item)) walk(item)
        else if (item === null || item === undefined || item === true || item === false) continue
        else out.push(typeof item === 'object' ? item : toText(item))
      }
    }
    walk(list)
    return out
  }

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: props === null || props === undefined ? {} : props, children: childrenOf(children) }
    },
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => undefined,
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
  }
  return React
}

/**
 * Run the published bundle and collect what `apply` registers.
 *
 * @param {{ fetchImpl?: Function }} [options]
 */
function loadBundle(options = {}) {
  const state = {
    loaded: null,
    types: [],
    injections: [],
    slots: [],
    effects: [],
    styles: [],
    dictionaries: [],
    calls: [],
    fetchCalls: [],
  }

  const require = (id) => {
    if (id === 'react') return createReactStub()
    throw new Error(`the bundle asked for a module it should not need: ${id}`)
  }

  const document = {
    querySelector: () => null,
    createElement: (tag) => ({
      tag,
      attrs: {},
      textContent: '',
      setAttribute(name, value) {
        this.attrs[name] = value
      },
      remove() {},
    }),
    head: {
      appendChild: (node) => {
        state.styles.push(node)
      },
    },
  }

  const window = {
    __ModuleLoader__: {
      load: (entry) => {
        state.loaded = entry
      },
    },
  }

  const fetchImpl =
    options.fetchImpl ??
    (async (path, init) => {
      state.fetchCalls.push({ path, init })
      return { status: 200, json: async () => ({ ok: true }) }
    })

  const source = new Function('window', 'document', 'navigator', 'globalThis', 'fetch', bundle)
  source(window, document, { language: 'zh-CN' }, window, fetchImpl)

  assert.notEqual(state.loaded, null, 'the bundle must call window.__ModuleLoader__.load')

  const ctx = {
    locale: {
      register: (ns, dicts) => {
        state.dictionaries.push({ ns, dicts })
        return () => {}
      },
      bind:
        (ns) =>
        (key, params) => {
          const table = state.loaded.factory(require).internals?.EN ?? {}
          return interpolateLike(table[key] ?? key, params)
        },
    },
    slots: {
      // Lazy in the real renderer: the callback runs when the declaration
      // exists, so the test has to fire it deliberately. `inject` also returns a
      // controller disposer there, and `apply` hands that straight to
      // `ctx.effect`, so the stub returns one too — a stub that returns nothing
      // would make the effect untracked and hide a missing cleanup.
      inject: (name, register) => {
        state.injections.push({ name, register })
        return () => {}
      },
      register: (definition, component) => {
        state.slots.push({ definition, component })
        return () => {}
      },
    },
    sidebarRightTabs: {
      register: (definition) => {
        state.types.push(definition)
        return () => {}
      },
    },
    sidebarRight: {
      openTabIn: (...args) => state.calls.push(['openTabIn', ...args]),
      openResourceIn: (...args) => state.calls.push(['openResourceIn', ...args]),
    },
    effect: (callback, label) => {
      const disposer = callback()
      state.effects.push({ label, disposer })
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
  }

  return { state, ctx, require, exports: state.loaded.factory(require) }
}

/** The `{name}` interpolation the bundle uses, restated for the test's stub. */
function interpolateLike(template, params) {
  if (params === undefined) return template
  return String(template).replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  )
}

/** Load and install, the way the runner does. */
function install(options = {}) {
  const env = loadBundle(options)
  env.exports.apply(env.ctx)
  return env
}

// --------------------------------------------------------------- tree walking

/** Every node in an element tree, depth first. */
function nodesOf(node, out = []) {
  if (node === null || node === undefined) return out
  out.push(node)
  for (const child of node.children ?? []) nodesOf(child, out)
  return out
}

/** The first node carrying an attribute, which is how the DOM hooks are named. */
function withAttr(tree, attr) {
  return nodesOf(tree).find((node) => node.props !== undefined && node.props[attr] !== undefined)
}

/** Every node carrying an attribute. */
function allWithAttr(tree, attr) {
  return nodesOf(tree).filter((node) => node.props !== undefined && node.props[attr] !== undefined)
}

/** All the text under a node, joined. */
function textOf(node) {
  return nodesOf(node)
    .filter((candidate) => candidate.type === '#text')
    .map((candidate) => candidate.text)
    .join('')
}

// --------------------------------------------------------------- the bundle

describe('the bundle itself', () => {
  it('is a classic script, not a module', () => {
    assert.doesNotThrow(() => new vm.Script(bundle))
    assert.ok(!/^\s*import\s/m.test(bundle), 'a classic script cannot use import')
    assert.ok(!/^\s*export\s/m.test(bundle), 'a classic script cannot use export')
  })

  it('requires react and nothing else', () => {
    const required = [...bundle.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((match) => match[2])
    assert.deepEqual([...new Set(required)], ['react'])
  })

  it('registers under exactly the manifest name', () => {
    const env = loadBundle()
    assert.equal(env.state.loaded.id, manifest.name)
    assert.equal(env.state.loaded.id, PLUGIN_ID)
    assert.equal(typeof env.state.loaded.factory, 'function')
  })

  it('declares itself as a web client with a real bundle path', () => {
    assert.equal(manifest.dsh.client.platform, 'web')
    assert.ok(Array.isArray(manifest.dsh.client.inject))
    for (const name of manifest.dsh.client.inject) assert.match(name, /^@deepseek-ai\/dsh-/)
    assert.equal(manifest.exports['./client'], './lib/client.js')
  })

  it('returns its exports from the factory without a module shim', () => {
    const env = loadBundle()
    assert.equal(typeof env.exports.apply, 'function')
    assert.equal(env.exports.name, PLUGIN_ID)
    assert.ok(env.exports.internals !== undefined)
  })
})

describe('the declared inject list', () => {
  it('names the services the half actually reads', () => {
    const env = loadBundle()
    assert.deepEqual(env.exports.inject, ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'])
  })
})

describe('apply: styles and dictionaries', () => {
  it('injects one stylesheet, through a marker that can be found again', () => {
    const env = install()
    assert.equal(env.state.styles.length, 1)
    assert.equal(env.state.styles[0].attrs['data-gitbar-style'], '')
    assert.ok(env.state.styles[0].textContent.includes('.gitbar-root'), 'the stylesheet has content')
  })

  it('registers both dictionaries under the package namespace, inside an effect', () => {
    const env = install()
    assert.equal(env.state.dictionaries.length, 1)
    assert.equal(env.state.dictionaries[0].ns, PLUGIN_ID)
    assert.ok(env.state.effects.some((entry) => entry.label === 'dsh-gitbar-lite: copy'))
  })
})

describe('apply: the three tab types', () => {
  const ids = () => {
    const env = install()
    return env.state.types
  }

  it('registers exactly three, with the ids the slots then key on', () => {
    const types = ids()
    assert.equal(types.length, 3)
    assert.deepEqual(
      types.map((type) => type.id),
      ['dsh-gitbar-lite/git', 'dsh-gitbar-lite/trash', 'dsh-gitbar-lite/diff'],
    )
    assert.deepEqual(
      types.map((type) => type.kind),
      ['gitbar', 'gitbar-trash', 'gitbar-diff'],
    )
  })

  it('gives every type a unique id and a unique kind', () => {
    const types = ids()
    assert.equal(new Set(types.map((type) => type.id)).size, 3)
    assert.equal(new Set(types.map((type) => type.kind)).size, 3, 'a repeated kind would throw at register time')
  })

  it('gives every type a title function, which is what the registry requires', () => {
    for (const type of ids()) assert.equal(typeof type.title, 'function', `${type.id} has no title`)
  })

  it('opens the panel from exactly one guide card, ordered among the shipped ones', () => {
    const [panel, trash, diff] = ids()
    assert.equal(Array.isArray(panel.guide), true)
    assert.equal(panel.guide.length, 1)
    assert.equal(panel.guide[0].id, 'changes')
    assert.equal(typeof panel.guide[0].title, 'function')
    assert.equal(typeof panel.guide[0].description, 'function')
    assert.equal(typeof panel.guide[0].icon, 'function')
    // The shipped cards are files(10), terminal(20), webchat(40); 30 lands
    // between them and keeps the total at four, which is the last count that
    // still shows descriptions at all.
    assert.equal(panel.guide[0].order, 30)
    assert.equal(trash.guide, undefined)
    assert.equal(diff.guide, undefined)
  })

  it('keeps the panel mounted, so a peek at a diff does not lose the tick state', () => {
    const [panel] = ids()
    assert.equal(panel.keepMounted, true)
  })

  it('makes the diff a resource type with one fixed address, which is what makes it a singleton', () => {
    const [, , diff] = ids()
    assert.deepEqual(diff.patterns, ['dsh-resource://dsh-gitbar-lite/diff/**'])
    assert.equal(typeof diff.canOpen, 'function')
    assert.equal(diff.canOpen('dsh-resource://dsh-gitbar-lite/diff/current'), true)
    assert.equal(diff.canOpen('dsh-resource://dsh-gitbar-lite/diff/current/extra'), true)
    assert.equal(diff.canOpen('dsh-resource://dsh-gitbar-lite/something-else'), false)
    assert.equal(diff.canOpen('dsh-resource://file/session/s1/x.txt'), false)
    // No `multiple`: several instances would defeat the point.
    assert.equal(diff.multiple, undefined)
  })

  it('puts the panel and the trash in the default priority band', () => {
    for (const type of ids()) {
      // `extension` is the registry's default; leaving it off is how a plugin
      // avoids shadowing a shipped type by accident. Only the diff names a
      // pattern, and it still does not claim a band.
      assert.ok(type.priority === undefined || type.priority === 'extension', `${type.id} claims priority ${type.priority}`)
    }
  })
})

describe('apply: the slot seats', () => {
  /** Fire every lazy injection the way the renderer does, and collect the registers. */
  function fireAll(env) {
    for (const injection of env.state.injections) injection.register()
    return env.state.slots
  }

  it('waits for both seats instead of registering into the void', () => {
    const env = install()
    const waited = [...new Set(env.state.injections.map((entry) => entry.name))].sort()
    assert.deepEqual(waited, ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'])
    assert.equal(env.state.slots.length, 0, 'nothing registers before the declaration exists')
  })

  it('registers a body for each type, keyed by that type id', () => {
    const env = install()
    const slots = fireAll(env)
    const bodies = slots.filter((entry) => entry.definition.name === 'sidebar.right.pane.tab')
    assert.deepEqual(
      bodies.map((entry) => entry.definition.key).sort(),
      ['dsh-gitbar-lite/diff', 'dsh-gitbar-lite/git', 'dsh-gitbar-lite/trash'],
    )
    for (const body of bodies) {
      assert.equal(typeof body.component, 'function')
      assert.equal(body.definition.locale, PLUGIN_ID, 'the seat asks for a bound translator')
      assert.equal(typeof body.definition.inject, 'function')
    }
  })

  it('registers a title for each type, under the same keys', () => {
    const env = install()
    const slots = fireAll(env)
    const titles = slots.filter((entry) => entry.definition.name === 'sidebar.right.pane.tab.title')
    assert.deepEqual(
      titles.map((entry) => entry.definition.key).sort(),
      ['dsh-gitbar-lite/diff', 'dsh-gitbar-lite/git', 'dsh-gitbar-lite/trash'],
    )
    for (const title of titles) assert.equal(typeof title.component, 'function')
  })

  it('uses ids only from the types it registered, so a rename cannot half-apply', () => {
    const env = install()
    const typeIds = new Set(env.state.types.map((type) => type.id))
    for (const entry of fireAll(env)) {
      assert.ok(typeIds.has(entry.definition.key), `${entry.definition.key} is not a registered type id`)
    }
  })

  it('every registration has a label, so a leak is attributable', () => {
    const env = install()
    // One for the dictionaries, three for the tab types, six for the seats.
    assert.equal(env.state.effects.length, 10)
    for (const entry of env.state.effects) {
      assert.equal(typeof entry.label, 'string')
      assert.ok(entry.label.startsWith('dsh-gitbar-lite: '), entry.label)
      assert.equal(typeof entry.disposer, 'function', `${entry.label} has no disposer`)
    }
  })

  it('injects the context the components call the host through', () => {
    const env = install()
    const slots = fireAll(env)
    for (const entry of slots) {
      const props = entry.definition.inject('session-1')
      assert.equal(typeof props.t, 'function', `${entry.definition.name} has no translator`)
      if (entry.definition.name === 'sidebar.right.pane.tab') {
        // A body drives the panel and the trash, so it needs the context; a
        // title only names the tab.
        assert.equal(props.ctx, env.ctx)
      }
    }
  })
})

describe('the wire contract mirrors the host', () => {
  it('uses the same route and the same action names', () => {
    const env = loadBundle()
    const { internals } = env.exports
    assert.equal(internals.RPC_ROUTE, RPC_ROUTE)
    assert.deepEqual(internals.ACTIONS, ACTIONS)
  })

  it('has copy for every failure code the host can send', () => {
    const env = loadBundle()
    const { ZH, EN } = env.exports.internals
    for (const code of Object.values(ERROR_CODES)) {
      assert.ok(ZH[`err.${code}`] !== undefined, `zh is missing err.${code}`)
      assert.ok(EN[`err.${code}`] !== undefined, `en is missing err.${code}`)
    }
  })

  it('keeps the two dictionaries in step', () => {
    const env = loadBundle()
    const { ZH, EN } = env.exports.internals
    assert.deepEqual(Object.keys(ZH).sort(), Object.keys(EN).sort())
  })
})

describe('pure helpers', () => {
  const env = loadBundle()
  const { internals } = env.exports

  it('lift a payload through the translator with its message as fallback', () => {
    const t = (key) => (key === 'err.E_CONFLICT' ? 'localized' : key)
    assert.equal(internals.errorText(t, 'E_CONFLICT', 'from the host'), 'localized')
    // An unknown code keeps the host's sentence rather than a bare code.
    assert.equal(internals.errorText(t, 'E_SOMETHING_NEW', 'from the host'), 'from the host')
    assert.equal(internals.errorText(t, 'E_SOMETHING_NEW', ''), 'E_SOMETHING_NEW')
  })

  it('interpolates the one placeholder syntax the locale service has', () => {
    assert.equal(internals.interpolate('a {x} b', { x: 1 }), 'a 1 b')
    assert.equal(internals.interpolate('a {x} b', {}), 'a {x} b')
    assert.equal(internals.interpolate('plain', undefined), 'plain')
  })

  it('pick the status mark for a change, the way Desktop picks it', () => {
    assert.equal(internals.statusKind({ kind: 'modified' }), 'modified')
    assert.equal(internals.statusKind({ kind: 'added' }), 'added')
    assert.equal(internals.statusKind({ kind: 'deleted' }), 'deleted')
    assert.equal(internals.statusKind({ kind: 'renamed' }), 'renamed')
    // Desktop's `iconForStatus` sends a new file and an untracked one to the same
    // `diff-added` mark, and the panel follows it: there is no separate mark for
    // "tracked or not".
    assert.equal(internals.statusKind({ kind: 'untracked', untracked: true }), 'added')
    assert.equal(internals.statusKind({ kind: 'conflicted', conflicted: true }), 'conflicted')
    assert.equal(internals.statusKind(null), 'modified')

    // Every mark is a component, so the row never falls back to a character.
    for (const kind of ['added', 'modified', 'deleted', 'renamed', 'conflicted']) {
      assert.equal(typeof internals.statusGlyph(kind), 'function', kind)
    }
    assert.equal(internals.statusGlyph('nonsense'), internals.statusGlyph('modified'))
  })

  it('split a path into a directory part and a file name', () => {
    assert.deepEqual(internals.splitPath('a.txt'), { dir: '', name: 'a.txt' })
    assert.deepEqual(internals.splitPath('src/deep/a.txt'), { dir: 'src/deep/', name: 'a.txt' })
    assert.deepEqual(internals.splitPath(undefined), { dir: '', name: '' })
  })

  it('render a relative time through the copy table', () => {
    const t = (key, params) => `${key}${params === undefined ? '' : `:${JSON.stringify(params)}`}`
    const now = Date.parse('2026-01-01T12:00:00.000Z')
    assert.equal(internals.formatRelative('2026-01-01T12:00:00.000Z', now, t), 'time.now')
    assert.equal(internals.formatRelative('2026-01-01T11:30:00.000Z', now, t), 'time.minutes:{"n":30}')
    assert.equal(internals.formatRelative('2026-01-01T09:00:00.000Z', now, t), 'time.hours:{"n":3}')
    assert.equal(internals.formatRelative('2025-12-30T12:00:00.000Z', now, t), 'time.days:{"n":2}')
    assert.equal(internals.formatRelative('not a date', now, t), '')
  })

  it('split a script output into a Summary and a Description', () => {
    // Everything is the Summary unless a line reads exactly `---`, so a script
    // that knows nothing about this still fills the box usefully.
    assert.deepEqual(internals.splitScriptOutput('1.4.2'), { summary: '1.4.2', description: '' })
    assert.deepEqual(internals.splitScriptOutput('one\ntwo'), { summary: 'one\ntwo', description: '' })
    assert.deepEqual(internals.splitScriptOutput('1.4.2\n---\nBumped the patch.'), {
      summary: '1.4.2',
      description: 'Bumped the patch.',
    })
    // A trailing marker is an empty body, not a missing one.
    assert.deepEqual(internals.splitScriptOutput('one line\n---\n'), { summary: 'one line', description: '' })
    assert.deepEqual(internals.splitScriptOutput('one line\n---'), { summary: 'one line', description: '' })
    // Trailing blank lines are the script's formatting, not its content.
    assert.equal(internals.splitScriptOutput('1.4.2\n\n\n').summary, '1.4.2')
    // The marker has to be the whole line, trimmed: prose is not a separator.
    assert.deepEqual(internals.splitScriptOutput('a --- b'), { summary: 'a --- b', description: '' })
    assert.deepEqual(internals.splitScriptOutput(''), { summary: '', description: '' })
    assert.deepEqual(internals.splitScriptOutput(null), { summary: '', description: '' })
    // Only the first marker counts; the rest is Description content.
    assert.deepEqual(internals.splitScriptOutput('a\n---\nb\n---\nc'), { summary: 'a', description: 'b\n---\nc' })
  })

  it('say when the repository last fetched, or that it never has', () => {
    const t = (key, params) => (params === undefined ? key : `${key}(${params.when ?? params.n})`)
    const now = Date.parse('2026-01-01T12:00:00.000Z')
    assert.equal(internals.lastFetchLabel({ lastFetchAt: '2026-01-01T09:00:00.000Z' }, now, t), 'fetch.last(time.hours(3))')
    assert.equal(internals.lastFetchLabel({ lastFetchAt: null }, now, t), 'fetch.never')
    assert.equal(internals.lastFetchLabel({ lastFetchAt: '' }, now, t), 'fetch.never')
    assert.equal(internals.lastFetchLabel(null, now, t), 'fetch.never')
  })

  it('explain why a trash entry cannot be put back', () => {
    const t = (key) => key
    // The tree moved on in a way that would lose work.
    assert.equal(internals.restoreReasonText(t, 'changed'), 'trash.restoreChanged')
    assert.equal(internals.restoreReasonText(t, 'moved'), 'trash.restoreMoved')
    // The entry is not the right one for this repository.
    assert.equal(internals.restoreReasonText(t, 'other-repo'), 'trash.restoreOtherRepo')
    assert.equal(internals.restoreReasonText(t, 'no-repo'), 'trash.restoreNoRepo')
    // The diff itself cannot be replayed.
    assert.equal(internals.restoreReasonText(t, 'truncated'), 'trash.restoreTruncated')
    assert.equal(internals.restoreReasonText(t, 'binary'), 'trash.restoreBinary')
    // Anything unrecognised still says something true rather than nothing.
    assert.equal(internals.restoreReasonText(t, 'something-new'), 'trash.restoreNoDiff')
    assert.equal(internals.restoreReasonText(t, undefined), 'trash.restoreNoDiff')
  })

  it('count only staged, non-conflicted files as committable', () => {
    const state = {
      counts: { conflicted: 0 },
      files: [
        { staged: true, conflicted: false },
        { staged: true, conflicted: true },
        { staged: false, conflicted: false },
      ],
    }
    assert.equal(internals.stagedCount(state), 1)
    assert.equal(internals.stagedCount(null), 0)
    assert.equal(internals.stagedCount({}), 0)
    assert.equal(internals.hasConflict(state), false)
    assert.equal(internals.hasConflict({ counts: { conflicted: 1 }, files: [] }), true)
  })

  it('decide what the select-all box shows', () => {
    const file = (path, staged, conflicted = false) => ({ path, staged, conflicted })
    const state = (files) => ({ counts: {}, files })

    // Nothing selectable at all: the box cannot do anything, so it is disabled.
    assert.equal(internals.selectionState(state([])), 'empty')
    assert.equal(internals.selectionState(null), 'empty')
    assert.equal(internals.selectionState(state([file('c.txt', false, true)])), 'empty')

    assert.equal(internals.selectionState(state([file('a.txt', false)])), 'none')
    assert.equal(internals.selectionState(state([file('a.txt', true)])), 'all')
    // The mixed state is the one a two-state box could not express without
    // either lying about the selection or throwing it away.
    assert.equal(internals.selectionState(state([file('a.txt', true), file('b.txt', false)])), 'some')

    // A conflicted file is not selectable, so it must not count in either
    // direction: one ticked file beside one conflict is "all", not "some",
    // because ticking the conflict is the one thing the button must never do.
    assert.equal(internals.selectionState(state([file('a.txt', true), file('c.txt', false, true)])), 'all')
    assert.equal(internals.selectionState(state([file('c.txt', true, true)])), 'empty')

    assert.deepEqual(internals.selectablePaths(state([file('a.txt', false), file('c.txt', false, true)])), ['a.txt'])
  })

  it('decide the commit buttons, and say why not', () => {
    const ready = { counts: { conflicted: 0 }, files: [{ staged: true, conflicted: false }] }
    assert.deepEqual(internals.commitReadiness(ready, 'summary', null), { canCommit: true, reasonKey: null })
    assert.deepEqual(internals.commitReadiness(ready, '   ', null), { canCommit: false, reasonKey: 'commit.needsSummary' })
    assert.deepEqual(internals.commitReadiness({ counts: {}, files: [{ staged: false }] }, 'summary', null), {
      canCommit: false,
      reasonKey: 'commit.needsStaged',
    })
    assert.deepEqual(internals.commitReadiness({ counts: { conflicted: 1 }, files: [] }, 'summary', null), {
      canCommit: false,
      reasonKey: 'err.E_CONFLICT',
    })
    assert.equal(internals.commitReadiness(ready, 'summary', 'commit').canCommit, false, 'nothing may be in flight')
  })

  it('label the context button from the branch, the way GitHub Desktop does', () => {
    assert.equal(internals.contextLabelKey({ primary: 'push' }), 'action.push')
    assert.equal(internals.contextLabelKey({ primary: 'publish' }), 'action.publish')
    assert.equal(internals.contextLabelKey({ primary: 'fetch' }), 'action.fetch')
    assert.equal(internals.contextLabelKey(null), 'action.fetch')
    assert.equal(internals.contextAction({ primary: 'push' }), 'push')
    assert.equal(internals.contextAction({ primary: 'publish' }), 'fetch', 'publishing is a push, but with no upstream it is not')
    assert.equal(internals.contextAction({ primary: 'fetch' }), 'fetch')
  })

  it('read the diff tab’s target out of its navigation params', () => {
    assert.deepEqual(internals.diffTarget({ source: 'worktree', path: 'a.txt' }), { source: 'worktree', path: 'a.txt' })
    assert.deepEqual(internals.diffTarget({ source: 'trash', id: 'abc' }), { source: 'trash', id: 'abc' })
    assert.equal(internals.diffTarget(null), null)
    assert.equal(internals.diffTarget({}), null)
    assert.equal(internals.diffTarget({ source: 'trash' }), null)
    assert.equal(internals.diffTarget({ path: '' }), null)
  })

  it('classify diff lines, with line numbers, for the renderer', () => {
    const rows = internals.diffRows(
      [
        'diff --git a/a.txt b/a.txt',
        'index 111..222 100644',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1,3 +1,3 @@',
        ' context',
        '-old',
        '+new',
        '\\ No newline at end of file',
        '',
      ].join('\n'),
    )
    const kinds = rows.map((row) => row.kind)
    assert.deepEqual(kinds, ['file', 'meta', 'meta', 'meta', 'hunk', 'ctx', 'del', 'add', 'note'])
    const add = rows.find((row) => row.kind === 'add')
    const del = rows.find((row) => row.kind === 'del')
    assert.equal(add.text, 'new')
    assert.equal(add.newLine, 2, 'the new-side counter advanced past the context line')
    assert.equal(add.oldLine, undefined)
    assert.equal(del.text, 'old')
    assert.equal(del.oldLine, 2)
    assert.equal(rows.find((row) => row.kind === 'ctx').oldLine, 1)
    assert.equal(internals.diffRows('')[0], undefined)
    assert.equal(internals.diffRows(null).length, 0)
  })
})

describe('the components without hooks', () => {
  const env = loadBundle()
  const { ChangeRow, DiscardDialog, RepositoryPicker, Banner } = env.exports.internals
  const t = env.exports.internals.interpolate

  const plainT = (key, params) => interpolateLike(key, params)

  it('draw a tick from the index, not from local state', () => {
    const calls = []
    const row = (file) =>
      ChangeRow({
        file,
        t: plainT,
        onToggle: (target) => calls.push(['toggle', target.path]),
        onDiscard: (path) => calls.push(['discard', path]),
        onOpen: (path) => calls.push(['open', path]),
      })

    const staged = withAttr(row({ path: 'a.txt', kind: 'modified', staged: true, partial: false, added: 2, deleted: 1 }), 'data-gitbar-tick')
    assert.equal(staged.props['aria-checked'], 'true')
    assert.ok(staged.props.className.includes('gitbar-tick-on'), staged.props.className)

    const unstaged = withAttr(row({ path: 'a.txt', kind: 'modified', staged: false, partial: false }), 'data-gitbar-tick')
    assert.equal(unstaged.props['aria-checked'], 'false')
    assert.ok(!unstaged.props.className.includes('gitbar-tick-on'))

    const partial = withAttr(row({ path: 'a.txt', kind: 'modified', staged: true, partial: true }), 'data-gitbar-tick')
    assert.ok(partial.props.className.includes('gitbar-tick-partial'), 'a half-staged file reads as indeterminate')

    staged.props.onClick({ stopPropagation: () => {} })
    assert.deepEqual(calls, [['toggle', 'a.txt']])

    unstaged.props.onClick({ stopPropagation: () => {} })
    // The click stops at the tick: double-click on the row opens the diff, and a
    // tick must not also fire that.
    assert.deepEqual(calls.at(-1), ['toggle', 'a.txt'])
  })

  it('lay a row out the way Desktop does: tick, directory, name, stats, mark last', () => {
    const tree = ChangeRow({
      file: { path: 'src/deep/a.txt', kind: 'added', staged: false, added: 12, deleted: 0 },
      t: plainT,
      onToggle: () => {},
      onDiscard: () => {},
      onOpen: () => {},
    })
    assert.equal(withAttr(tree, 'data-gitbar-row').props['data-gitbar-row'], 'src/deep/a.txt')
    assert.equal(withAttr(tree, 'data-gitbar-row').props['data-gitbar-kind'], 'added')

    // The mark ends the row, which leaves the checkbox and the path at the front.
    assert.deepEqual(
      tree.children.map((child) => child?.props?.className),
      ['gitbar-tick', 'gitbar-path', 'gitbar-stats', 'gitbar-rowBtn', 'gitbar-status gitbar-status-added'],
    )

    // Directory, separator, name — that order, and three nodes so the directory
    // is the part that gives way when the row is narrow.
    const path = tree.children.find((child) => child?.props?.className === 'gitbar-path')
    assert.deepEqual(
      path.children.map((child) => child?.props?.className),
      ['gitbar-dir', 'gitbar-sep', 'gitbar-name'],
    )
    assert.equal(path.children[0].children[0].text, 'src/deep')
    assert.equal(path.children[1].children[0].text, '/')
    assert.equal(path.children[2].children[0].text, 'a.txt')

    const mark = tree.children.at(-1)
    assert.equal(mark.props['data-gitbar-status'], 'added')
    assert.equal(mark.props.title, plainT('status.added'))

    const plus = nodesOf(tree).find((node) => node.props?.className === 'gitbar-plus')
    assert.equal(plus.children[0].text, '+12')
    const minus = nodesOf(tree).find((node) => node.props?.className === 'gitbar-minus')
    assert.equal(minus, undefined, 'no deletions means no minus')

    // And no letter is left anywhere: the mark is artwork, not a character.
    assert.ok(!nodesOf(tree).some((node) => node.type === '#text' && node.text === 'A'))
  })

  it('name a rename by both of its paths', () => {
    const tree = ChangeRow({
      file: { path: 'new.txt', origPath: 'old.txt', kind: 'renamed', staged: true },
      t: plainT,
      onToggle: () => {},
      onDiscard: () => {},
      onOpen: () => {},
    })
    assert.equal(withAttr(tree, 'data-gitbar-row').props.title, 'old.txt → new.txt')
  })

  it('default the discard confirmation to keeping a copy, and say so', () => {
    const pending = { paths: ['a.txt'], files: ['a.txt'], hardDelete: false }
    const tree = DiscardDialog({ pending, t: plainT, onCancel: () => {}, onHardDeleteChange: () => {}, onConfirm: () => {}})
    assert.equal(withAttr(tree, 'data-gitbar-dialog').props['data-gitbar-dialog'], 'discard')
    const box = withAttr(tree, 'data-gitbar-hard')
    assert.equal(box.props.checked, false)
    assert.ok(textOf(tree).includes('discard.keep'), 'the safe choice explains what it keeps')
    assert.ok(!textOf(tree).includes('discard.hardHint'))
  })

  it('switch the hint when the user asks for the change to be gone for good', () => {
    const pending = { paths: ['a.txt'], files: ['a.txt'], hardDelete: true }
    const tree = DiscardDialog({ pending, t: plainT, onCancel: () => {}, onHardDeleteChange: () => {}, onConfirm: () => {}})
    assert.equal(withAttr(tree, 'data-gitbar-hard').props.checked, true)
    assert.ok(textOf(tree).includes('discard.hardHint'))
    assert.ok(!textOf(tree).includes('discard.keep'))
  })

  it('report a change of the hard-delete box back to the panel', () => {
    const seen = []
    const tree = DiscardDialog({
      pending: { paths: ['a.txt'], files: ['a.txt'], hardDelete: false },
      t: plainT,
      onCancel: () => {},
      onHardDeleteChange: (next) => seen.push(next),
      onConfirm: () => {},
    })
    withAttr(tree, 'data-gitbar-hard').props.onChange({ target: { checked: true } })
    assert.deepEqual(seen, [true])
  })

  it('list the files a discard covers, truncating a long list with a count', () => {
    const files = Array.from({ length: 11 }, (_, index) => `file-${index}.txt`)
    const tree = DiscardDialog({ pending: { paths: null, files, hardDelete: false }, t: plainT, onCancel: () => {}, onHardDeleteChange: () => {}, onConfirm: () => {}})
    assert.ok(textOf(tree).includes('discard.all'))
    assert.equal(allWithAttr(tree, 'data-gitbar-dialog').length, 1)
    assert.ok(textOf(tree).includes('discard.more'), textOf(tree))
    // Eight are named in full, the rest are counted.
    assert.ok(!textOf(tree).includes('file-10.txt'))
  })

  it('render nothing at all when there is no confirmation pending', () => {
    assert.equal(DiscardDialog({ pending: null, t: plainT, onCancel: () => {}, onHardDeleteChange: () => {}, onConfirm: () => {}}), null)
  })

  it('offer every scanned repository, and a way to type a path instead', () => {
    const picked = []
    const tree = RepositoryPicker({
      candidates: [
        { path: 'C:/work/one', name: 'one', isWorkspaceRoot: true },
        { path: 'C:/work/two', name: 'two', isWorkspaceRoot: false },
      ],
      truncated: true,
      scanning: false,
      pathInput: '',
      t: plainT,
      bound: null,
      onPick: (path) => picked.push(path),
      onPath: () => picked.push('typed'),
      onPathChange: () => {},
      onRescan: () => {},
      onUnbind: () => {},
    })
    const candidates = allWithAttr(tree, 'data-gitbar-candidate')
    assert.deepEqual(candidates.map((node) => node.props['data-gitbar-candidate']), ['C:/work/one', 'C:/work/two'])
    candidates[1].props.onClick()
    assert.deepEqual(picked, ['C:/work/two'])
    assert.ok(withAttr(tree, 'data-gitbar-pathinput') !== undefined)
    assert.ok(textOf(tree).includes('bind.truncated'), 'a scan that stopped early says so')
  })

  it('say so when a scan found nothing, rather than showing an empty box', () => {
    const tree = RepositoryPicker({
      candidates: [],
      truncated: false,
      scanning: false,
      pathInput: '',
      t: plainT,
      bound: null,
      onPick: () => {},
      onPath: () => {},
      onPathChange: () => {},
      onRescan: () => {},
      onUnbind: () => {},
    })
    assert.ok(textOf(tree).includes('bind.noCandidates'))
  })

  it('tone a banner by its meaning', () => {
    assert.ok(withAttr(Banner({ tone: 'error', text: 'x' }), 'className').props.className.includes('gitbar-banner-error'))
    assert.ok(withAttr(Banner({ tone: 'warn', text: 'x' }), 'className').props.className.includes('gitbar-banner-warn'))
    assert.ok(withAttr(Banner({ tone: 'ok', text: 'x' }), 'className').props.className.includes('gitbar-banner-ok'))
    assert.equal(Banner({ tone: 'ok', text: 'x' }).props.role, 'status')
  })
})

describe('the DOM hooks a fixture would need', () => {
  it('are all present in the stylesheet and the markup', () => {
    const env = install()
    const css = env.state.styles[0].textContent
    for (const className of [
      'gitbar-root',
      'gitbar-row',
      'gitbar-tick',
      'gitbar-list',
      'gitbar-commit',
      'gitbar-overlay',
      'gitbar-dialog',
      'gitbar-diff',
      'gitbar-r-add',
      'gitbar-r-del',
      'gitbar-trashRow',
      'gitbar-tabTitle',
    ]) {
      assert.ok(css.includes(`.${className}`), `the stylesheet has no .${className}`)
    }
    // The root fills the host's tab body, which gives no height of its own.
    assert.ok(/\.gitbar-root\{[^}]*height:100%/.test(css), 'the root must claim the full height')
    assert.ok(/\.gitbar-root\{[^}]*min-height:0/.test(css), 'the root must be allowed to shrink')
  })

  /**
   * The panel's top rule has to be the conversation header's rule, continued.
   *
   * The shell puts the conversation's horizontal line at the bottom of a 38px
   * tab strip, and a tab body starts underneath it — so a header of exactly 38
   * pixels lands its own border on the same row. Both halves of that number are
   * load-bearing and both were got wrong: a content-box header with 8px/6px
   * padding and a 1px rule came to 39px (one pixel low), and the shell ships
   * `height:38px; border-bottom:.5px` on every sidebar header it owns.
   */
  it('puts the header rule exactly on the conversation header line', () => {
    const rule = /\.gitbar-head\{([^}]*)\}/.exec(bundle)
    assert.ok(rule !== null, 'the stylesheet has no .gitbar-head rule')
    const body = rule[1]

    // 38px total: border-box, so the rule is inside the height rather than added
    // to it.
    assert.ok(/box-sizing:border-box/.test(body), 'the header must be border-box, or the rule is added to its height')
    const height = /(?:^|;)height:(\d+)px/.exec(body)
    assert.ok(height !== null, 'the header must state a height, not derive one from padding')
    assert.equal(Number(height[1]), 38, 'the header must be 38px: that is what the shell\'s tab strip measures')

    // No vertical padding: with a fixed height it could only push the content
    // around, and the previous 8px/6px pair is what made the box 39px.
    const padding = /(?:^|;)padding:([^;]+)/.exec(body)
    assert.ok(padding !== null, 'the header must state its padding')
    const parts = padding[1].trim().split(/\s+/)
    // CSS shorthand: one value is all four sides, two are vertical/horizontal,
    // three are top/horizontal/bottom, four are clockwise from the top.
    const vertical = parts.length === 1 ? [parts[0], parts[0]] : parts.length === 2 ? [parts[0], parts[0]] : [parts[0], parts[2]]
    for (const part of vertical) {
      assert.equal(part, '0', `vertical padding (${padding[1]}) would fight the fixed height`)
    }

    // A hairline, like the shell's own headers, in the token it uses for them.
    assert.ok(/border-bottom:\.5px solid var\(--dsw-alias-border-l3/.test(body), 'the rule must be the shell\'s .5px border-l3 hairline')
  })

  it('never writes a literal colour, so the theme decides', () => {
    const assignments = [...bundle.matchAll(/(?:color|background|border-color)\s*:\s*([^;'}]+)/g)].map((match) => match[1].trim())
    for (const value of assignments) {
      assert.ok(
        value.startsWith('var(--') || value.startsWith('none') || value.startsWith('inherit') || value.startsWith('transparent'),
        `a literal colour slipped in: ${value}`,
      )
    }
  })
})
