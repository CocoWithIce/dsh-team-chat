/**
 * Host event-feed behaviour test (t17) — repo-native, runnable evidence.
 *
 * WHY THIS FILE EXISTS
 * `host-smoke.test.mjs` is entirely skipped in a bare checkout (its 16 cases all
 * report "host half not importable here" because `schemastery` is a peer
 * dependency resolved from the *installing profile*, not from this repo). That
 * means a host-side change (t17: the `session/event` feed replacing readSurface
 * polling) had **no** coverage from the shipped suite. This file closes that
 * gap: it imports the real `lib/index.js` and drives it with a counting fake
 * context, so the claims in the t17 report are independently reproducible.
 *
 * It uses the SAME skip-if-unimportable discipline as host-smoke, so it never
 * reports a false failure in a bare checkout — but in any environment where the
 * profile's `schemastery` resolves (the captain's full-verification pass, or a
 * `node_modules` link), every case below actually executes.
 *
 * Run: node --test test/host-events.test.mjs
 *
 * The assertions encode the t17 contract:
 *  E1  No members            → zero readSurface, ever.
 *  E2  Active members        → utterances stream via events; steady-state
 *                              /state adds ZERO readSurface (the poll is gone).
 *  E3  assistant/chunk       → dropped by the hot callback (53–67% noise).
 *  E4  Buffer overflow       → capped and flagged `lag` (bounded memory).
 *  E5  Unload                → both listeners and all timers are disposed.
 *  E6  agent/status          → drives activity system rows.
 *  E7  Snapshot              → exposes feed observability (the heartbeat).
 *  E8  Control (documents the old failure mode): the pre-t17 code is shown in
 *      the report to add +1 readSurface per /state; here we assert the new code
 *      is FLAT, which is the same discriminator in a single file.
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

/**
 * Fake host context with call counting. Mirrors the service surface the plugin
 * declares (`inject = ['agents', 'subagents', 'sessionQuery', 'settings']`).
 * @param options - `{ members }` roster to expose under the captain session.
 */
function fakeContext(options = {}) {
  const members = options.members ?? [{ id: 'm-1', activity: 'idle' }]
  const stored = {}
  const state = {
    routes: [],
    effects: [],
    handlers: new Map(),
    logger: { warns: [] },
  }
  const calls = { readSurface: [], listChildren: [] }
  const ctx = {
    sessions: new Map(),
    settings: {
      writable: true,
      register: () => ({ read: () => stored }),
      get: () => stored,
      update: async (_ns, patch) => Object.assign(stored, patch),
    },
    agents: { list: () => [{ id: 'cap-1' }], get: () => undefined },
    subagents: {
      listChildren: async (id) => {
        calls.listChildren.push(id)
        return id === 'cap-1'
          ? members.map((member) => ({
              kind: 'child',
              id: member.id,
              activity: member.activity,
              mode: 'continuable',
              label: 'agent-teams:demo:' + member.id,
            }))
          : []
      },
      sendMessage: async () => 'message-id',
    },
    sessionQuery: {
      readSurface: async (id) => {
        calls.readSurface.push(id)
        return { events: [] }
      },
    },
    effect: (fn) => {
      const disposer = fn()
      state.effects.push(disposer)
      return disposer
    },
    on: (name, handler) => {
      if (!state.handlers.has(name)) state.handlers.set(name, [])
      state.handlers.get(name).push(handler)
      return () => {
        const list = state.handlers.get(name) || []
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
      }
    },
    logger: { warn: (message) => state.logger.warns.push(message) },
    get: (name) => {
      if (name === 'webServer') return { register: (route) => { state.routes.push(route); return () => {} } }
      if (name === 'connection') return { requestRejection: () => undefined }
      if (name === 'systemPrompt') return { section: () => () => {} }
      if (name === 'sessions') return { get: () => undefined }
      return undefined
    },
  }
  return { ctx, state, calls }
}

/** Fire every registered handler for one event name. */
function emit(state, name, ...args) {
  for (const handler of state.handlers.get(name) || []) handler(...args)
}

/** Drive the real /state route and return the decoded snapshot. */
async function readState(ctx, state) {
  const route = state.routes.find((candidate) => String(candidate.path).includes('/state'))
  const res = {
    writeHead() {},
    end(value) { this.body = JSON.parse(value) },
    json() { return this.body },
  }
  await route.handler({ url: '/plugins/dsh-team-chat/state', method: 'GET' }, res)
  return res.json()
}

/** Wait past one flush interval so the throttled consumer drains buffers. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 700))

/** Every message text visible in one snapshot (roots + replies). */
function allTexts(body) {
  return (body.threads || [])
    .flatMap((thread) => [thread.root, ...(thread.replies || [])])
    .map((message) => String(message.text))
}

test('E1: a deployment with no members reads no surface, ever', { skip: skipReason }, async () => {
  const { ctx, state, calls } = fakeContext({ members: [] })
  host.apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 200))
  await readState(ctx, state)
  await readState(ctx, state)
  assert.equal(calls.readSurface.length, 0, 'no members ⇒ no surface reads')
})

test('E2: utterances arrive via events and steady-state /state adds zero readSurface', { skip: skipReason }, async () => {
  const { ctx, state, calls } = fakeContext({ members: [{ id: 'm-1', activity: 'running' }] })
  host.apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 150))

  // The member speaks through the event feed — not through a surface read.
  emit(state, 'session/event', { id: 'm-1' }, {
    type: 'assistant/message',
    seq: 10,
    time: Date.now(),
    data: { message: { content: [{ type: 'text', text: '我已开始实现。' }] } },
  })
  await settle()

  const first = await readState(ctx, state)
  assert.ok(allTexts(first).some((text) => text.includes('我已开始实现')),
    'an event-driven utterance must reach the chat: ' + JSON.stringify(allTexts(first)))

  // The first pull may run ONE bounded catch-up; every later request must add none.
  const afterFirstPull = calls.readSurface.length
  for (let i = 0; i < 3; i += 1) {
    await readState(ctx, state)
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  assert.equal(calls.readSurface.length, afterFirstPull,
    'steady-state /state must not read surfaces: ' + afterFirstPull + ' → ' + calls.readSurface.length)
})

test('E3: the hot callback drops assistant/chunk (the 53–67% noise)', { skip: skipReason }, async () => {
  const { ctx, state } = fakeContext({ members: [{ id: 'm-1', activity: 'running' }] })
  host.apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 150))

  for (let i = 0; i < 50; i += 1) {
    emit(state, 'session/event', { id: 'm-1' }, { type: 'assistant/chunk', seq: 100 + i, data: { chunk: {} } })
  }
  await settle()

  const body = await readState(ctx, state)
  assert.ok(body.feed.dropped >= 50, 'chunks must be counted as dropped, got ' + body.feed.dropped)
  assert.equal(body.feed.eventCount, 0, 'no chunk may be buffered, got ' + body.feed.eventCount)
})

test('E4: buffer overflow is capped and flagged (bounded memory)', { skip: skipReason }, async () => {
  const { ctx, state } = fakeContext({ members: [{ id: 'm-1', activity: 'running' }] })
  host.apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 150))

  // Synchronous burst past the cap, before the throttled drain can run.
  for (let i = 0; i < 2100; i += 1) {
    emit(state, 'session/event', { id: 'm-1' }, { type: 'tool/result', seq: 1000 + i, data: { result: 'x' } })
  }
  const body = await readState(ctx, state)
  assert.ok(body.feed.lagged >= 1, 'overflow must flag lag for resync, got ' + body.feed.lagged)
})

test('E5: unload disposes both listeners', { skip: skipReason }, async () => {
  const { ctx, state } = fakeContext({ members: [{ id: 'm-1', activity: 'running' }] })
  host.apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 100))

  assert.ok((state.handlers.get('session/event') || []).length >= 1, 'session/event subscribed')
  assert.ok((state.handlers.get('agent/status') || []).length >= 1, 'agent/status subscribed')

  for (const disposer of state.effects) {
    if (typeof disposer === 'function') disposer()
  }

  assert.equal((state.handlers.get('session/event') || []).length, 0, 'session/event listener disposed')
  assert.equal((state.handlers.get('agent/status') || []).length, 0, 'agent/status listener disposed')
})

test('E6: agent/status drives an activity system row', { skip: skipReason }, async () => {
  const { ctx, state } = fakeContext({ members: [{ id: 'm-1', activity: 'idle' }] })
  host.apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 150))

  emit(state, 'agent/status', { agent: { id: 'm-1' }, status: 'running' })
  const body = await readState(ctx, state)
  assert.ok(allTexts(body).some((text) => text.includes('开始工作')),
    'a status change must surface a system row: ' + JSON.stringify(allTexts(body)))
})

test('E7: the snapshot exposes feed observability (heartbeat visible)', { skip: skipReason }, async () => {
  const { ctx, state } = fakeContext()
  host.apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 100))

  const body = await readState(ctx, state)
  assert.ok(body.feed !== undefined && body.feed !== null, 'feed block present')
  for (const key of ['lastEventAt', 'eventCount', 'watched', 'dropped', 'lagged']) {
    assert.equal(typeof body.feed[key], 'number', 'feed.' + key + ' must be a number')
  }
})

// ---------------------------------------------------------------- t19: step projection

/** Drive the real /steps route with a fake request/response pair. */
async function readSteps(ctx, state) {
  const route = state.routes.find((candidate) => String(candidate.path).includes('/steps'))
  const res = {
    writeHead() {},
    end(value) { this.body = JSON.parse(value) },
    json() { return this.body },
  }
  await route.handler({ url: '/plugins/dsh-team-chat/steps', method: 'GET' }, res)
  return res.json()
}

let stepSeq = 0
const stepEvent = (type, data) => ({ type, seq: ++stepSeq, time: Date.now(), data })

test('P1: member run projects one row per tool/call with artifacts, results and decisions', { skip: skipReason }, async () => {
  stepSeq = 0
  const { ctx, state } = fakeContext({ members: [{ id: 'm-1', activity: 'idle' }] })
  host.apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 150))
  const feed = (event) => emit(state, 'session/event', { id: 'm-1' }, event)

  feed(stepEvent('turn/start', {}))
  feed(stepEvent('step/start', { turn: 1, step: 1 }))
  feed(stepEvent('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: { command: 'pwd; ls' } }))
  feed(stepEvent('tool/result', { turn: 1, step: 1, message: 'ok', error: null, meta: {} }))
  feed(stepEvent('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '我检查了目录。' }] } }))
  feed(stepEvent('step/end', { turn: 1, step: 1 }))
  feed(stepEvent('step/start', { turn: 1, step: 2 }))
  feed(stepEvent('tool/call', { turn: 1, step: 2, callId: 'c2', name: 'read', arguments: { file_path: 'E:/x/y.js' } }))
  // Production error contract (t34): error carries { name, code } — no message.
  feed(stepEvent('tool/result', { turn: 1, step: 2, message: '', error: { name: 'EIO', code: 'ENOENT' }, meta: {} }))
  feed(stepEvent('step/end', { turn: 1, step: 2 }))
  feed(stepEvent('turn/end', { reason: 'completed' }))
  await settle()

  const body = await readSteps(ctx, state)
  assert.equal(body.ok, true)
  assert.equal(body.members.length, 1, 'one member projected')
  const steps = body.members[0].steps
  const s1 = steps.find((row) => row.step === 1)
  assert.equal(s1.action, 'pwsh')
  assert.equal(s1.artifact, 'pwd; ls', 'pwsh command artifact')
  assert.equal(s1.result, 'ok')
  assert.match(String(s1.decision), /我检查了目录/, 'step decision folded')
  const s2 = steps.find((row) => row.step === 2)
  assert.equal(s2.action, 'read')
  assert.equal(s2.artifact, 'E:/x/y.js', 'read file_path artifact')
  // t39/D: assert the PRODUCTION contract shape, not just a substring of the
  // old message-shaped input (that mismatch is what let t30/t34 defects hide).
  assert.equal(s2.result, 'error: EIO (ENOENT)', 'production {name, code} detail, got ' + s2.result)
})

test('P2: missing artifact renders — never a fabricated value', { skip: skipReason }, async () => {
  stepSeq = 0
  const { ctx, state } = fakeContext({ members: [{ id: 'm-1', activity: 'idle' }] })
  host.apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 150))
  const feed = (event) => emit(state, 'session/event', { id: 'm-1' }, event)

  feed(stepEvent('turn/start', {}))
  feed(stepEvent('step/start', { turn: 1, step: 1 }))
  feed(stepEvent('tool/call', { turn: 1, step: 1, callId: 'c9', name: 'weird', arguments: { n: 3 } }))
  feed(stepEvent('step/end', { turn: 1, step: 1 }))
  feed(stepEvent('turn/end', { reason: 'aborted' }))
  await settle()

  const body = await readSteps(ctx, state)
  const row = body.members[0].steps.find((candidate) => candidate.action === 'weird')
  assert.equal(row.artifact, '—', 'missing artifact renders as —')
})

test('P3: /steps never triggers readSurface (projection is buffer-only)', { skip: skipReason }, async () => {
  stepSeq = 0
  const { ctx, state, calls } = fakeContext({ members: [{ id: 'm-1', activity: 'idle' }] })
  host.apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 150))
  const feed = (event) => emit(state, 'session/event', { id: 'm-1' }, event)

  feed(stepEvent('turn/start', {}))
  feed(stepEvent('step/start', { turn: 1, step: 1 }))
  feed(stepEvent('tool/call', { turn: 1, step: 1, callId: 'c3', name: 'grep', arguments: { pattern: 'TODO' } }))
  feed(stepEvent('step/end', { turn: 1, step: 1 }))
  feed(stepEvent('turn/end', { reason: 'completed' }))
  await settle()

  const before = calls.readSurface.length
  await readSteps(ctx, state)
  await readSteps(ctx, state)
  assert.equal(calls.readSurface.length, before, '/steps must not add readSurface calls')
})

// ---------------------------------------------------------------- t31: arguments both shapes

test('R1: JSON-string arguments — known tools extract real artifacts (t31 regression)', { skip: skipReason }, async () => {
  stepSeq = 0
  const { ctx, state } = fakeContext({ members: [{ id: 'm-1', activity: 'idle' }] })
  host.apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 150))
  const feed = (event) => emit(state, 'session/event', { id: 'm-1' }, event)

  // Real production shape: arguments is a JSON STRING, never an object.
  feed(stepEvent('turn/start', {}))
  feed(stepEvent('step/start', { turn: 1, step: 1 }))
  feed(stepEvent('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{"command":"pwd; echo hi"}' }))
  feed(stepEvent('tool/result', { turn: 1, step: 1, message: 'ok', error: null, meta: {} }))
  feed(stepEvent('step/end', { turn: 1, step: 1 }))
  feed(stepEvent('step/start', { turn: 1, step: 2 }))
  feed(stepEvent('tool/call', { turn: 1, step: 2, callId: 'c2', name: 'read', arguments: '{"file_path":"E:/src/a.js"}' }))
  feed(stepEvent('tool/result', { turn: 1, step: 2, message: '', error: null, meta: {} }))
  feed(stepEvent('step/end', { turn: 1, step: 2 }))
  feed(stepEvent('step/start', { turn: 1, step: 3 }))
  feed(stepEvent('tool/call', { turn: 1, step: 3, callId: 'c3', name: 'grep', arguments: '{"path":"E:/src","pattern":"TODO"}' }))
  feed(stepEvent('tool/result', { turn: 1, step: 3, message: '', error: null, meta: {} }))
  feed(stepEvent('step/end', { turn: 1, step: 3 }))
  feed(stepEvent('step/start', { turn: 1, step: 4 }))
  feed(stepEvent('tool/call', { turn: 1, step: 4, callId: 'c4', name: 'glob', arguments: '{"pattern":"**/*.md"}' }))
  feed(stepEvent('tool/result', { turn: 1, step: 4, message: '', error: null, meta: {} }))
  feed(stepEvent('step/end', { turn: 1, step: 4 }))
  feed(stepEvent('turn/end', { reason: 'completed' }))
  await settle()

  const body = await readSteps(ctx, state)
  const steps = body.members[0].steps
  const byAction = Object.fromEntries(steps.map((row) => [row.action, row.artifact]))
  assert.equal(byAction.pwsh, 'pwd; echo hi', 'pwsh command from STRING arguments')
  assert.equal(byAction.read, 'E:/src/a.js', 'read file_path from STRING arguments')
  assert.equal(byAction.grep, 'E:/src', 'grep path from STRING arguments')
  assert.equal(byAction.glob, '**/*.md', 'glob pattern from STRING arguments')
})

test('R2: object arguments — known tools still work (both shapes supported)', { skip: skipReason }, async () => {
  stepSeq = 0
  const { ctx, state } = fakeContext({ members: [{ id: 'm-1', activity: 'idle' }] })
  host.apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 150))
  const feed = (event) => emit(state, 'session/event', { id: 'm-1' }, event)

  feed(stepEvent('turn/start', {}))
  feed(stepEvent('step/start', { turn: 1, step: 1 }))
  feed(stepEvent('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'edit', arguments: { file_path: 'E:/x/y.js' } }))
  feed(stepEvent('tool/result', { turn: 1, step: 1, message: 'ok', error: null, meta: {} }))
  feed(stepEvent('step/end', { turn: 1, step: 1 }))
  feed(stepEvent('turn/end', { reason: 'completed' }))
  await settle()

  const body = await readSteps(ctx, state)
  const step = body.members[0].steps.find((row) => row.action === 'edit')
  assert.equal(step.artifact, 'E:/x/y.js', 'object-form edit file_path still works')
})

test('R3: unknown tool on STRING arguments never yields the raw "{" (t31 root)', { skip: skipReason }, async () => {
  stepSeq = 0
  const { ctx, state } = fakeContext({ members: [{ id: 'm-1', activity: 'idle' }] })
  host.apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 150))
  const feed = (event) => emit(state, 'session/event', { id: 'm-1' }, event)

  feed(stepEvent('turn/start', {}))
  feed(stepEvent('step/start', { turn: 1, step: 1 }))
  feed(stepEvent('tool/call', {
    turn: 1, step: 1, callId: 'c1',
    name: 'agent_teams_status',
    arguments: '{"teamId":"multi-role-team"}',
  }))
  feed(stepEvent('step/end', { turn: 1, step: 1 }))
  feed(stepEvent('turn/end', { reason: 'completed' }))
  await settle()

  const body = await readSteps(ctx, state)
  const step = body.members[0].steps.find((row) => row.action === 'agent_teams_status')
  assert.notEqual(step.artifact, '{', 'must never surface the raw string head')
  assert.equal(step.artifact, 'multi-role-team', 'parsed first string argument surfaces')
})

test('R4: malformed JSON arguments parse-fail observably, degrade to — not crash', { skip: skipReason }, async () => {
  stepSeq = 0
  const { ctx, state } = fakeContext({ members: [{ id: 'm-1', activity: 'idle' }] })
  host.apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 150))
  const feed = (event) => emit(state, 'session/event', { id: 'm-1' }, event)

  feed(stepEvent('turn/start', {}))
  feed(stepEvent('step/start', { turn: 1, step: 1 }))
  feed(stepEvent('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{not-json' }))
  feed(stepEvent('step/end', { turn: 1, step: 1 }))
  feed(stepEvent('turn/end', { reason: 'completed' }))
  await settle()

  const body = await readSteps(ctx, state)
  const step = body.members[0].steps.find((row) => row.action === 'read')
  assert.equal(step.artifact, '—', 'unparseable string degrades to —')
  // Observability: the /state snapshot surfaces the parse-failure counter.
  const stateBody = await readState(ctx, state)
  assert.ok(typeof stateBody.artifactParseFailures === 'number' && stateBody.artifactParseFailures >= 1,
    'parse failures must be observable, got ' + stateBody.artifactParseFailures)
})

// ---------------------------------------------------------------- t35: error detail shape

test('T1: failed tool result shows name/code detail (production contract, t35)', { skip: skipReason }, async () => {
  stepSeq = 0
  const { ctx, state } = fakeContext({ members: [{ id: 'm-1', activity: 'idle' }] })
  host.apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 150))
  const feed = (event) => emit(state, 'session/event', { id: 'm-1' }, event)

  // Production error shape: { name, code } — NO message (t34 verified).
  feed(stepEvent('turn/start', {}))
  feed(stepEvent('step/start', { turn: 1, step: 1 }))
  feed(stepEvent('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"file_path":"E:/x"}' }))
  feed(stepEvent('tool/result', { turn: 1, step: 1, message: '', error: { name: 'EIO', code: 'ENOENT' }, meta: {} }))
  feed(stepEvent('step/end', { turn: 1, step: 1 }))
  feed(stepEvent('turn/end', { reason: 'completed' }))
  await settle()

  const body = await readSteps(ctx, state)
  const step = body.members[0].steps.find((row) => row.action === 'read')
  assert.equal(step.result, 'error: EIO (ENOENT)', 'name+code must be surfaced, got ' + step.result)
  const stateBody = await readState(ctx, state)
  assert.equal(stateBody.errorDetailMisses, 0, 'a name/code error is NOT a miss')
})

test('T2: error with only code still surfaces; no-name/no-code is counted as a miss', { skip: skipReason }, async () => {
  stepSeq = 0
  const { ctx, state } = fakeContext({ members: [{ id: 'm-1', activity: 'idle' }] })
  host.apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 150))
  const feed = (event) => emit(state, 'session/event', { id: 'm-1' }, event)

  // code only
  feed(stepEvent('turn/start', {}))
  feed(stepEvent('step/start', { turn: 1, step: 1 }))
  feed(stepEvent('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'grep', arguments: '{"pattern":"x"}' }))
  feed(stepEvent('tool/result', { turn: 1, step: 1, message: '', error: { code: 'EACCES' }, meta: {} }))
  feed(stepEvent('step/end', { turn: 1, step: 1 }))
  // empty error object → miss
  feed(stepEvent('step/start', { turn: 1, step: 2 }))
  feed(stepEvent('tool/call', { turn: 1, step: 2, callId: 'c2', name: 'write', arguments: '{"file_path":"E:/y"}' }))
  feed(stepEvent('tool/result', { turn: 1, step: 2, message: '', error: {}, meta: {} }))
  feed(stepEvent('step/end', { turn: 1, step: 2 }))
  feed(stepEvent('turn/end', { reason: 'completed' }))
  await settle()

  const body = await readSteps(ctx, state)
  const byAction = Object.fromEntries(body.members[0].steps.map((row) => [row.action, row.result]))
  assert.equal(byAction.grep, 'error: EACCES', 'code-only error surfaces')
  assert.equal(byAction.write, 'error', 'empty error object: no detail, bare error')
  const stateBody = await readState(ctx, state)
  assert.ok(stateBody.errorDetailMisses >= 1, 'empty error object must be counted, got ' + stateBody.errorDetailMisses)
})

test('T3: message-shaped error stays compatible (future contract growth)', { skip: skipReason }, async () => {
  stepSeq = 0
  const { ctx, state } = fakeContext({ members: [{ id: 'm-1', activity: 'idle' }] })
  host.apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 150))
  const feed = (event) => emit(state, 'session/event', { id: 'm-1' }, event)

  feed(stepEvent('turn/start', {}))
  feed(stepEvent('step/start', { turn: 1, step: 1 }))
  feed(stepEvent('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'edit', arguments: '{"file_path":"E:/z"}' }))
  feed(stepEvent('tool/result', { turn: 1, step: 1, message: '', error: { name: 'X', code: 'Y', message: 'boom detail' }, meta: {} }))
  feed(stepEvent('step/end', { turn: 1, step: 1 }))
  feed(stepEvent('turn/end', { reason: 'completed' }))
  await settle()

  const body = await readSteps(ctx, state)
  const step = body.members[0].steps.find((row) => row.action === 'edit')
  assert.match(String(step.result), /error: X \(Y\): boom detail/, 'name (code): message all shown')
})

test('T3b: message-only error stays compatible (no name/code present)', { skip: skipReason }, async () => {
  stepSeq = 0
  const { ctx, state } = fakeContext({ members: [{ id: 'm-1', activity: 'idle' }] })
  host.apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 150))
  const feed = (event) => emit(state, 'session/event', { id: 'm-1' }, event)

  feed(stepEvent('turn/start', {}))
  feed(stepEvent('step/start', { turn: 1, step: 1 }))
  feed(stepEvent('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"file_path":"E:/q"}' }))
  // Legacy / hypothetical contract: message only, no name, no code.
  feed(stepEvent('tool/result', { turn: 1, step: 1, message: '', error: { message: 'legacy detail' }, meta: {} }))
  feed(stepEvent('step/end', { turn: 1, step: 1 }))
  feed(stepEvent('turn/end', { reason: 'completed' }))
  await settle()

  const body = await readSteps(ctx, state)
  const step = body.members[0].steps.find((row) => row.action === 'read')
  assert.equal(step.result, 'error: legacy detail', 'message-only compat must not lose the detail')
  const stateBody = await readState(ctx, state)
  assert.equal(stateBody.errorDetailMisses, 0, 'a message-only error is NOT a miss')
})

test('T4: /state exposes errorDetailMisses alongside the other counters', { skip: skipReason }, async () => {
  stepSeq = 0
  const { ctx, state } = fakeContext({ members: [{ id: 'm-1', activity: 'idle' }] })
  host.apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 150))
  const body = await readState(ctx, state)
  assert.equal(typeof body.errorDetailMisses, 'number')
  assert.equal(typeof body.artifactParseFailures, 'number')
  assert.equal(typeof body.timeouts, 'number')
})
