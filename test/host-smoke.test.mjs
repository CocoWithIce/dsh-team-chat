/**
 * Host-half smoke test: import the real module and run `apply` against a fake
 * context, asserting the routes, settings namespace and routing section are all
 * wired — the failure modes that would break a profile boot.
 *
 * `schemastery` is a peer dependency resolved from the installing profile, so the
 * import test skips when it is not resolvable (running from a bare checkout)
 * instead of reporting a false failure.
 *
 * Run: node --test test/*.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

let host
let importError = null
try {
  host = await import('../lib/index.js')
} catch (error) {
  importError = error
}

const skipReason = importError === null
  ? false
  : 'host half not importable here (peer deps resolve from the installed profile): ' + String(importError.message)

test('host half imports and exports the plugin contract', { skip: skipReason }, () => {
  assert.equal(host.name, 'team-chat')
  assert.ok(Array.isArray(host.inject))
  assert.ok(host.inject.includes('subagents'))
  assert.ok(host.inject.includes('sessionQuery'))
  assert.equal(typeof host.apply, 'function')
  assert.equal(typeof host.Config, 'function')
})

/**
 * Minimal stand-in for the host services the plugin declares.
 * @param options - `{ noAgentPresets, agents, routes }` knobs for each scenario.
 */
function fakeContext(options = {}) {
  const state = {
    globalSections: [],
    scopedSections: [],
    scopeCalls: [],
    routes: options.routes || [],
    effects: [],
  }
  let stored = {}

  const systemPrompt = {
    section: (section) => {
      state.globalSections.push(section)
      return () => {}
    },
  }
  const scopedSystemPrompt = {
    section: (section) => {
      state.scopedSections.push(section)
      return () => {}
    },
  }

  const ctx = {
    ...state,
    settings: {
      writable: true,
      register: () => ({ read: () => stored }),
      get: () => stored,
      update: async (ns, patch) => { stored = { ...stored, ...patch } },
    },
    agents: {
      // A real Agent exposes its own context; `agent.ctx.systemPrompt` is how a
      // scoped section is registered when the preset mounts no own instance.
      list: () => options.agents || [{ id: 'session-captain', ctx: { systemPrompt: scopedSystemPrompt } }],
      get: () => undefined,
    },
    subagents: {
      listChildren: async () => [],
      sendMessage: async () => 'message-id',
    },
    sessionQuery: { readSurface: async () => ({ events: [] }) },
    effect: (fn) => {
      const disposer = fn()
      state.effects.push(disposer)
      return typeof disposer === 'function' ? disposer : () => {}
    },
    on: () => () => {},
    get: (name) => {
      if (name === 'webServer') {
        return {
          register: (route) => {
            state.routes.push(route)
            return () => {}
          },
        }
      }
      if (name === 'connection') return { requestRejection: () => undefined }
      if (name === 'systemPrompt') return systemPrompt
      if (name === 'sessions') return { get: () => undefined }
      if (name === 'agentPresets') {
        // Default: the preset mounts no systemPrompt of its own, which is the
        // real-world case that made a scoped-only design register nothing.
        if (options.noAgentPresets === true) return undefined
        return {
          serviceFor: (agent, serviceName) => {
            state.scopeCalls.push([String(agent.id), serviceName])
            return options.presetHasSystemPrompt === true && serviceName === 'systemPrompt'
              ? scopedSystemPrompt
              : undefined
          },
        }
      }
      return undefined
    },
  }
  return ctx
}

/** Run every registered effect disposer so the poller cannot hold the test open. */
function disposeAll(ctx) {
  for (const disposer of ctx.effects) {
    if (typeof disposer === 'function') disposer()
  }
  ctx.effects.length = 0
}

test('apply registers every browser route behind the auth fence', { skip: skipReason }, (t) => {
  const ctx = fakeContext()
  t.after(() => disposeAll(ctx))
  host.apply(ctx)
  const paths = ctx.routes.map((route) => route.path)
  for (const suffix of ['/state', '/speak', '/task', '/settings']) {
    assert.ok(paths.includes('/plugins/dsh-team-chat' + suffix), 'missing route ' + suffix)
  }
  assert.ok(ctx.effects.length >= 1, 'no effect was registered for cleanup')
})

test('routing always installs a global baseline section', { skip: skipReason }, (t) => {
  const ctx = fakeContext()
  t.after(() => disposeAll(ctx))
  host.apply(ctx)
  assert.equal(ctx.globalSections.length, 1, 'the baseline section is what makes routing work at all')
  assert.equal(ctx.globalSections[0].name, 'team-chat:routing')
  assert.equal(ctx.globalSections[0].order, 118)
  assert.match(ctx.globalSections[0].text(), /团队模式/)
})

test('routing also scopes a section onto an agent that can host one', { skip: skipReason }, (t) => {
  const ctx = fakeContext()
  t.after(() => disposeAll(ctx))
  host.apply(ctx)
  assert.equal(ctx.scopedSections.length, 1, 'the agent context can host a scoped section')
  assert.equal(ctx.scopedSections[0].name, 'team-chat:routing')
  // Both layers exist; the scoped one shadows the global one by name, which is
  // what lets a session use its own team while everyone else uses the default.
  assert.equal(ctx.globalSections.length, 1)
})

test('routing uses the preset instance when the composition mounts one', { skip: skipReason }, (t) => {
  const ctx = fakeContext({ presetHasSystemPrompt: true })
  t.after(() => disposeAll(ctx))
  host.apply(ctx)
  assert.deepEqual(ctx.scopeCalls, [['session-captain', 'systemPrompt']])
  assert.equal(ctx.scopedSections.length, 1)
})

test('routing keeps the baseline when the agent cannot host a scoped section', { skip: skipReason }, (t) => {
  const ctx = fakeContext({ noAgentPresets: true, agents: [{ id: 'session-captain' }] })
  t.after(() => disposeAll(ctx))
  host.apply(ctx)
  assert.equal(ctx.scopedSections.length, 0)
  assert.equal(ctx.globalSections.length, 1, 'the baseline must survive an unscopable agent')
  assert.match(ctx.globalSections[0].text(), /团队模式/)
})

test('the routing text follows the settings switches', { skip: skipReason }, async (t) => {
  const ctx = fakeContext()
  t.after(() => disposeAll(ctx))
  host.apply(ctx)
  const text = ctx.globalSections[0].text
  assert.match(text(), /团队模式/)
  await ctx.settings.update('team-chat', { enabled: false })
  assert.equal(text(), '')
})

test('no team member session is routed when the agent has a parent', { skip: skipReason }, (t) => {
  const ctx = fakeContext()
  t.after(() => disposeAll(ctx))
  // A member session: the agent exists but is a child of the captain.
  ctx.get = ((original) => (name) => {
    if (name === 'sessions') return { get: () => ({ header: { parentSession: 'session-captain' } }) }
    return original(name)
  })(ctx.get)
  host.apply(ctx)
  assert.equal(ctx.scopeCalls.length, 0)
  assert.equal(ctx.scopedSections.length, 0)
})

// ----------------------------------------------------------------- team templates

/** A request whose body is emitted asynchronously, like a real HTTP request. */
function fakeReq(body, method = 'POST', url = '/') {
  const handlers = new Map()
  const req = {
    method,
    url,
    on(event, listener) {
      const list = handlers.get(event) || []
      list.push(listener)
      handlers.set(event, list)
      return req
    },
    once(event, listener) {
      return req.on(event, listener)
    },
    off(event, listener) {
      const list = handlers.get(event) || []
      handlers.set(event, list.filter((entry) => entry !== listener))
      return req
    },
    resume() {},
  }
  setTimeout(() => {
    const payload = body === undefined ? '' : JSON.stringify(body)
    if (payload !== '') for (const listener of handlers.get('data') || []) listener(Buffer.from(payload, 'utf8'))
    for (const listener of handlers.get('end') || []) listener()
  }, 0)
  return req
}

/** Captures status + body from a route handler. */
function fakeRes() {
  const res = { statusCode: 0, body: '' }
  res.writeHead = (status) => {
    res.statusCode = status
  }
  res.end = (text) => {
    res.body = text || ''
  }
  res.json = () => JSON.parse(res.body || '{}')
  return res
}

const TWO_TEAMS = {
  teams: [
    { id: 'one', name: '一队', members: [{ name: 'alpha', role: '甲' }] },
    { id: 'two', name: '二队', members: [{ name: 'beta', role: '乙' }, { name: 'gamma' }] },
  ],
  defaultTeamId: 'one',
}

function routeOf(ctx, suffix) {
  return ctx.routes.find((route) => route.path === '/plugins/dsh-team-chat' + suffix)
}

test('apply registers the team-switch route', { skip: skipReason }, (t) => {
  const ctx = fakeContext()
  t.after(() => disposeAll(ctx))
  host.apply(ctx)
  assert.ok(routeOf(ctx, '/team') !== undefined, '/team route missing')
})

test('the routing prompt renders the default team templates roster', { skip: skipReason }, async (t) => {
  const ctx = fakeContext()
  t.after(() => disposeAll(ctx))
  await ctx.settings.update('team-chat', TWO_TEAMS)
  host.apply(ctx)
  const text = ctx.scopedSections[0].text()
  assert.match(text, /团队模板「一队」/)
  assert.match(text, /1\. alpha（甲）/)
  assert.doesNotMatch(text, /beta/)
})

test('switching a session team changes that session prompt immediately', { skip: skipReason }, async (t) => {
  const ctx = fakeContext()
  t.after(() => disposeAll(ctx))
  await ctx.settings.update('team-chat', TWO_TEAMS)
  host.apply(ctx)
  const section = ctx.scopedSections[0]
  assert.match(section.text(), /团队模板「一队」/)

  const res = fakeRes()
  await routeOf(ctx, '/team').handler(fakeReq({ sessionId: 'session-captain', teamId: 'two' }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().activeTeam.id, 'two')
  assert.match(section.text(), /团队模板「二队」/)
  assert.match(section.text(), /1\. beta（乙）/)

  const reset = fakeRes()
  await routeOf(ctx, '/team').handler(fakeReq({ sessionId: 'session-captain', teamId: '' }), reset)
  assert.equal(reset.json().activeTeam.id, 'one')
  assert.match(section.text(), /团队模板「一队」/)
})

test('the team route rejects an unknown team', { skip: skipReason }, async (t) => {
  const ctx = fakeContext()
  t.after(() => disposeAll(ctx))
  await ctx.settings.update('team-chat', TWO_TEAMS)
  host.apply(ctx)
  const res = fakeRes()
  await routeOf(ctx, '/team').handler(fakeReq({ sessionId: 'session-captain', teamId: 'ghost' }), res)
  assert.equal(res.statusCode, 404)
  assert.equal(res.json().ok, false)
})

test('the state snapshot reports the active team and member config', { skip: skipReason }, async (t) => {
  const ctx = fakeContext()
  t.after(() => disposeAll(ctx))
  await ctx.settings.update('team-chat', TWO_TEAMS)
  // One live member whose name matches a member of the SECOND team.
  ctx.subagents.listChildren = async (parentId) => (parentId === 'session-captain'
    ? [{ kind: 'child', id: 'member-1', activity: 'idle', mode: 'continuable', label: 'agent-teams:demo:beta' }]
    : [])
  host.apply(ctx)

  // Before the switch the default team ('one') does not describe 'beta', so the
  // live member carries no template config.
  const before = fakeRes()
  await routeOf(ctx, '/state').handler(fakeReq(undefined, 'GET', '/plugins/dsh-team-chat/state'), before)
  const beforeBody = before.json()
  assert.equal(beforeBody.activeTeam.id, 'one')
  assert.equal(beforeBody.members.length, 1)
  assert.equal(beforeBody.members[0].configured, false)

  // After switching, the snapshot describes the live member from that team.
  const switched = fakeRes()
  await routeOf(ctx, '/team').handler(fakeReq({ sessionId: 'session-captain', teamId: 'two' }), switched)
  const after = fakeRes()
  await routeOf(ctx, '/state').handler(fakeReq(undefined, 'GET', '/plugins/dsh-team-chat/state'), after)
  const body = after.json()
  assert.equal(body.ok, true)
  assert.equal(body.activeTeam.id, 'two')
  assert.equal(body.defaultTeamId, 'one', 'the default is unchanged by a per-session switch')
  assert.deepEqual(body.teams.map((team) => team.id), ['one', 'two'])
  assert.equal(body.members.length, 1)
  assert.equal(body.members[0].role, '乙', 'member summarises its template config')
  assert.equal(body.members[0].configured, true)
})

test('the state snapshot reports the IM origin of the session', { skip: skipReason }, async (t) => {
  const ctx = fakeContext()
  t.after(() => disposeAll(ctx))
  // The captain session opened with an IM source block.
  ctx.subagents.listChildren = async (parentId) => (parentId === 'session-captain'
    ? [{ kind: 'child', id: 'member-1', activity: 'idle', mode: 'continuable', label: 'agent-teams:demo:researcher' }]
    : [])
  ctx.sessionQuery.readSurface = async (sessionId) => (sessionId === 'session-captain'
    ? {
        events: [{
          type: 'user/message',
          seq: 1,
          data: {
            content: [{
              type: 'text',
              text: '<dsh_im_source>{"channel":"feishu","conversationType":"group","chatId":"oc_a","threadId":"omt_b","botId":"bot_c"}</dsh_im_source>\n任务',
            }],
          },
        }],
      }
    : { events: [] })
  host.apply(ctx)
  const res = fakeRes()
  await routeOf(ctx, '/state').handler(fakeReq(undefined, 'GET', '/plugins/dsh-team-chat/state'), res)
  const body = res.json()
  assert.equal(body.im.botId, 'bot_c')
  assert.equal(body.im.targetId, 'group:oc_a:thread:omt_b')
  assert.equal(body.imPush, false, 'pushing is opt-in')
})

test('a non-IM session reports no IM origin', { skip: skipReason }, async (t) => {
  const ctx = fakeContext()
  t.after(() => disposeAll(ctx))
  host.apply(ctx)
  const res = fakeRes()
  await routeOf(ctx, '/state').handler(fakeReq(undefined, 'GET', '/plugins/dsh-team-chat/state'), res)
  assert.equal(res.json().im, null)
})

test('the settings route accepts and normalizes a teams patch', { skip: skipReason }, async (t) => {
  const ctx = fakeContext()
  t.after(() => disposeAll(ctx))
  host.apply(ctx)
  const res = fakeRes()
  await routeOf(ctx, '/settings').handler(fakeReq({
    teams: [{ id: 'Bad Id', members: [{ name: 'x' }] }, { id: 'good', members: [{ name: 'x' }, { name: 'x' }] }],
    defaultTeamId: 'good',
  }), res)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.settings.teams.map((team) => team.id), ['good'], 'the illegal team is dropped before persisting')
  assert.deepEqual(body.settings.teams[0].members.map((member) => member.name), ['x'], 'the duplicate member is dropped')
  assert.equal(body.settings.defaultTeamId, 'good')
})
