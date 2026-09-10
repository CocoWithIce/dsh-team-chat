/**
 * Client-half render smoke test.
 *
 * Loads the real module-loader bundle, installs it against a fake client
 * context, and executes both render paths (better-sidebar tab and docked
 * column) with a minimal React shim. A component that throws renders as a blank
 * panel in the app, which is indistinguishable from "no data yet" — this test
 * turns that class of failure into a hard test failure.
 *
 * Run: node --test test/*.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Minimal React surface: enough for createElement trees, hooks and boundaries. */
class Component {
  constructor(props) {
    this.props = props || {}
    this.state = {}
  }

  setState(next) {
    this.state = Object.assign({}, this.state, typeof next === 'function' ? next(this.state) : next)
  }
}

const ReactShim = {
  createElement(type, props) {
    const children = Array.prototype.slice.call(arguments, 2)
    return { type, props: Object.assign({}, props, { children }) }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, function noop() {}]
  },
  useEffect() {},
  useRef(initial) {
    return { current: initial }
  },
  Component,
}

/** Evaluate the bundle and return its exports. */
async function loadClientExports() {
  const source = await readFile(join(ROOT, 'lib/client.js'), 'utf8')
  const loaded = { definition: null }
  const windowStub = {
    __ModuleLoader__: {
      load(definition) {
        loaded.definition = definition
      },
    },
  }
  const requireShim = (name) => {
    if (name === 'react') return ReactShim
    throw new Error('unexpected require: ' + name)
  }
  // eslint-disable-next-line no-new-func
  const evaluate = new Function('window', 'console', 'fetch', 'setInterval', 'clearInterval', 'setTimeout', source)
  evaluate(windowStub, console, () => Promise.resolve({ ok: true }), () => 0, () => {}, () => 0)

  assert.ok(loaded.definition !== null, 'bundle did not call window.__ModuleLoader__.load')
  assert.equal(loaded.definition.id, 'dsh-team-chat')
  const exports = loaded.definition.factory(requireShim)
  assert.equal(typeof exports.apply, 'function')
  return exports
}

/**
 * Expand an element tree by rendering function and class components, collecting
 * every text node. This is what turns "the panel came up blank" into a testable
 * fact: if a component returns nothing, the collected text is empty.
 */
function renderTree(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) renderTree(child, out)
    return out
  }
  const type = node.type
  if (typeof type === 'function') {
    if (type.prototype instanceof Component) {
      const instance = new type(node.props || {})
      renderTree(instance.render(), out)
    } else {
      renderTree(type(node.props || {}), out)
    }
    return out
  }
  // Inputs carry their label in a prop rather than as a text child.
  if (node.props && typeof node.props.placeholder === 'string') out.push(node.props.placeholder)
  if (node.props && node.props.children !== undefined) renderTree(node.props.children, out)
  return out
}

/** A client context whose slot registrations and tab descriptor are captured. */
function fakeClientContext(options = {}) {
  const captured = { slots: [], tab: null, injectCalls: [], triggerSidebar: null }
  const service = {
    registerTab: (descriptor) => {
      captured.tab = descriptor
      return () => {}
    },
    openTab: () => {},
    getSnapshot: () => ({ prefs: { pluginSettings: { 'team-chat': options.settings || {} } } }),
  }
  // `deferSidebar` models the real load-order case: the service is not
  // resolvable at apply time and only appears later.
  let available = options.withSidebar !== false && options.deferSidebar !== true
  const resolve = () => (available ? service : undefined)

  const ctx = {
    get: (name) => (name === 'betterSidebar' ? resolve() : undefined),
    inject: (deps, callback) => {
      captured.injectCalls.push(deps)
      captured.triggerSidebar = () => {
        available = true
        callback({ get: (name) => (name === 'betterSidebar' ? resolve() : undefined) })
      }
      return () => {}
    },
    effect: (fn) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    slots: {
      inject: (slotName, callback) => {
        callback()
        return () => {}
      },
      register: (registration, component) => {
        captured.slots.push({ registration, component })
        return () => {}
      },
    },
  }
  return { ctx, captured }
}

test('client bundle exposes the module-loader contract', async () => {
  const exports = await loadClientExports()
  assert.ok(Array.isArray(exports.inject))
  assert.ok(exports.inject.includes('slots'))
})

test('with better-sidebar the tab registers and renders real content', async () => {
  const exports = await loadClientExports()
  const { ctx, captured } = fakeClientContext()
  exports.apply(ctx)

  assert.ok(captured.tab !== null, 'no better-sidebar tab was registered')
  assert.equal(captured.tab.id, 'team-chat')
  assert.equal(captured.tab.title, '团队群聊')
  assert.equal(captured.tab.single, true)

  const props = { visible: true, scope: { sessionId: 'session-abcdef123456' } }
  const text = renderTree(captured.tab.component(props)).join('\n')
  assert.match(text, /在群里说点什么/, 'composer missing from the tab render')
  assert.match(text, /tab · session-/, 'diagnostic strip missing from the tab render')
  assert.match(text, /派任务/, 'task button missing from the tab render')
})

test('the tab declares only real display switches (no dock toggle)', async () => {
  const exports = await loadClientExports()
  const { ctx, captured } = fakeClientContext()
  exports.apply(ctx)
  const toggles = captured.tab.settings.pluginToggles.map((toggle) => toggle.key)
  assert.deepEqual(toggles, ['showIncoming', 'compact', 'pollSeconds', 'autoOpen'])
  assert.ok(!toggles.includes('dockedRight'), 'dock must be capability-driven, not a switch')
})

test('without better-sidebar the dock registers and renders real content', async () => {
  const exports = await loadClientExports()
  const { ctx, captured } = fakeClientContext({ withSidebar: false })
  exports.apply(ctx)

  const dock = captured.slots.find((entry) => entry.registration.id === 'team-chat-dock')
  assert.ok(dock !== undefined, 'dock slot was not registered')

  const text = renderTree(dock.component()).join('\n')
  assert.match(text, /多角色协作群聊/, 'dock title missing')
  assert.match(text, /dock · no-session/, 'dock should report that it has no session scope')
  assert.match(text, /在群里说点什么/, 'composer missing from the dock render')
  assert.ok(captured.tab === null, 'no tab should register without better-sidebar')
})

test('the settings page and sidebar action are always contributed', async () => {
  const exports = await loadClientExports()
  const { ctx, captured } = fakeClientContext()
  exports.apply(ctx)
  const ids = captured.slots.map((entry) => entry.registration.id)
  assert.ok(ids.includes('team-chat'), 'settings section missing')
  assert.ok(ids.includes('team-chat-open'), 'sidebar action missing')
})

test('a late better-sidebar registration claims the tab and stands the dock down', async () => {
  const exports = await loadClientExports()
  const { ctx, captured } = fakeClientContext({ deferSidebar: true })
  exports.apply(ctx)

  assert.equal(captured.tab, null, 'no tab before the service exists')
  assert.ok(captured.injectCalls.some((deps) => deps.includes('betterSidebar')), 'no deferred injection was registered')

  const dock = captured.slots.find((entry) => entry.registration.id === 'team-chat-dock')
  assert.ok(dock !== undefined, 'dock was not registered')
  assert.notEqual(dock.component(), null, 'the dock is the fallback while the tab cannot register')

  captured.triggerSidebar()

  assert.ok(captured.tab !== null, 'the tab registers once the service appears')
  assert.equal(captured.tab.id, 'team-chat')
  assert.equal(dock.component(), null, 'the dock stands down once the tab exists')
})

test('the settings page renders without throwing', async () => {
  const exports = await loadClientExports()
  const { ctx, captured } = fakeClientContext()
  exports.apply(ctx)
  const section = captured.slots.find((entry) => entry.registration.id === 'team-chat')
  const text = renderTree(section.component({ close: () => {} })).join('\n')
  assert.match(text, /团队群聊/, 'settings page title missing')
  for (const label of ['启用团队功能', '新会话自动建立团队', '建队免审批', 'IM 会话播报团队进度', '主动推送团队进度到 IM']) {
    assert.ok(text.includes(label), 'switch row missing: ' + label)
  }
})

test('every settings switch is covered by the switch-state mapping', async () => {
  const exports = await loadClientExports()
  const internals = exports.__internals
  // A key missing from the mapping renders a checkbox that never changes — the
  // exact bug this test exists to prevent.
  assert.deepEqual(internals.SWITCH_KEYS, ['enabled', 'autoCreateTeam', 'autoApproveTeam', 'imProgress', 'imPush'])

  assert.deepEqual(internals.switchStateOf({}), {
    enabled: true,
    autoCreateTeam: true,
    autoApproveTeam: true,
    imProgress: true,
    imPush: false,
  })

  const stored = internals.switchStateOf({ enabled: false, imPush: true })
  assert.equal(stored.enabled, false)
  assert.equal(stored.imPush, true)
  assert.equal(stored.autoCreateTeam, true, 'missing keys fall back to their default')
})

const TEMPLATE_MEMBER = {
  name: 'analyst',
  role: '分析师',
  provider: '',
  model: 'gpt-5.6',
  reasoningEffort: 'high',
  soul: '先看数据',
  skills: ['understand'],
  plugins: [],
  mcp: ['postgres'],
  memory: 'bank:1',
  executionPrompt: '',
}

test('the member editor renders its identity and actions', async () => {
  const exports = await loadClientExports()
  const internals = exports.__internals
  const text = renderTree(internals.MemberEditor({
    member: TEMPLATE_MEMBER,
    onPatch: () => {},
    onRemove: () => {},
  })).join('\n')
  assert.match(text, /analyst/)
  assert.match(text, /分析师/)
  assert.match(text, /1 技能/)
  assert.match(text, /编辑/)
  assert.match(text, /删除/)
})

test('the team editor lists every member and the add control', async () => {
  const exports = await loadClientExports()
  const internals = exports.__internals
  const team = {
    id: 'duo',
    name: '双人组',
    description: '快',
    members: [TEMPLATE_MEMBER, { name: 'fixer', role: '修复者', skills: [], plugins: [], mcp: [] }],
  }
  const text = renderTree(internals.TeamEditor({
    team,
    onPatchTeam: () => {},
    onPatchMember: () => {},
    onRemoveMember: () => {},
  })).join('\n')
  assert.match(text, /团队显示名/)
  assert.match(text, /团队 id：duo/)
  assert.match(text, /analyst/)
  assert.match(text, /fixer/)
  assert.match(text, /添加成员/)
})

test('a member chip surfaces role, model and skill count', async () => {
  const exports = await loadClientExports()
  const internals = exports.__internals
  const configured = internals.MemberChip({
    member: { id: 'm1', name: 'analyst', activity: 'running', role: '分析师', model: 'gpt-5.6', skillCount: 2, configured: true },
    compact: false,
  })
  assert.match(configured.props.title, /分析师/)
  assert.match(configured.props.title, /gpt-5\.6/)
  assert.match(renderTree(configured).join('\n'), /分析师 · 工作中/)

  const unconfigured = internals.MemberChip({
    member: { id: 'm2', name: 'ghost', activity: 'idle', role: '', model: '', skillCount: 0, configured: false },
    compact: false,
  })
  assert.match(renderTree(unconfigured).join('\n'), /不在当前团队/)
})
