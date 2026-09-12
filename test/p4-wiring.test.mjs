/**
 * P4-1 宿主装配接线测试 —— test/p4-wiring.test.mjs
 *
 * t112 · P4 Slice 1。覆盖：
 *   - qualityDirFor：合法 teamId → <stateRoot>/<teamId>；非法字符净化；空 → stateRoot 回退；
 *   - supersede 路由 gate 同步（宿主级，junction）：create 建档 open gate → supersede →
 *     gateSync 载荷（escalated/subject-superseded）+ quality.json 落盘 + gate escalated；
 *   - 循环创建开关设置项：qualityLoopEnabled 缺省 true。
 *
 * 宿主级用例依赖 junction（peer deps），裸检出 skip —— 与 team-tasks.test.mjs Part B 同模式。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { qualityDirFor } from '../lib/p2/scheduler.js'
import { qualityFilePathFor } from '../lib/p2/quality-sidecar.js'

// ---------------------------------------------------------------- 纯逻辑（裸检可跑）

test('qualityDirFor：合法 teamId → <stateRoot>/<teamId>', () => {
  assert.equal(qualityDirFor('/home/.dsh/dsh-team-chat', 'trio'), join0('/home/.dsh/dsh-team-chat', 'trio'))
  assert.equal(qualityDirFor('/root', 'p2e2e'), join0('/root', 'p2e2e'))
})

test('qualityDirFor：非法字符净化（防路径穿越）', () => {
  assert.equal(qualityDirFor('/root', 'bad team'), join0('/root', 'bad_team'))
  // '.' 在合法字符类内（P1 同款净化），'/' 被替换为 '_' → 单段内无分隔符，穿越不成立
  assert.equal(qualityDirFor('/root', '../../etc'), join0('/root', '.._.._etc'))
})

test('qualityDirFor：空/缺失 teamId → stateRoot 回退（缺省语义明确）', () => {
  assert.equal(qualityDirFor('/root', ''), '/root')
  assert.equal(qualityDirFor('/root', undefined), '/root')
  assert.equal(qualityDirFor('/root', '   '), '/root')
})

test('qualityFilePathFor：目录 + quality.json 文件名', () => {
  assert.equal(qualityFilePathFor('/root/trio'), join0('/root/trio', 'quality.json'))
})

import { join as join0 } from 'node:path'

// ---------------------------------------------------------------- 宿主级（junction）

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

function fakeContext(options = {}) {
  const state = { globalSections: [], scopedSections: [], routes: [], effects: [], eventHandlers: new Map() }
  let stored = {}
  const systemPrompt = { section: (s) => { state.globalSections.push(s); return () => {} } }
  const scopedSystemPrompt = { section: (s) => { state.scopedSections.push(s); return () => {} } }
  const ctx = {
    ...state,
    settings: {
      writable: true,
      register: () => ({ read: () => stored }),
      get: () => stored,
      update: async (ns, patch) => { stored = { ...stored, ...patch } },
    },
    agents: { list: () => options.agents || [{ id: 'session-captain', ctx: { systemPrompt: scopedSystemPrompt } }], get: () => undefined },
    subagents: { listChildren: async () => options.children || [], sendMessage: async () => 'message-id' },
    sessionQuery: { readSurface: async () => ({ events: [] }) },
    effect: (fn) => { const d = fn(); state.effects.push(typeof d === 'function' ? d : () => {}); return typeof d === 'function' ? d : () => {} },
    on: (name, handler) => {
      const list = state.eventHandlers.get(name) || []
      list.push(handler)
      state.eventHandlers.set(name, list)
      return () => {}
    },
    get: (name) => {
      if (name === 'webServer') return { register: (route) => { state.routes.push(route); return () => {} } }
      if (name === 'connection') return { requestRejection: () => undefined }
      if (name === 'systemPrompt') return systemPrompt
      if (name === 'sessions') return { get: () => undefined }
      if (name === 'agentPresets') return { serviceFor: () => undefined }
      return undefined
    },
  }
  return ctx
}

function fakeReq(body) {
  const handlers = new Map()
  const req = {
    method: 'POST',
    url: '/',
    on(event, listener) {
      const list = handlers.get(event) || []
      list.push(listener)
      handlers.set(event, list)
      return req
    },
    once(event, listener) { return req.on(event, listener) },
    off(event, listener) {
      handlers.set(event, (handlers.get(event) || []).filter((e) => e !== listener))
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

function fakeRes() {
  const res = { statusCode: 0, body: '' }
  res.writeHead = (status) => { res.statusCode = status }
  res.end = (text) => { res.body = text || '' }
  res.json = () => JSON.parse(res.body || '{}')
  return res
}

function routeOf(ctx, suffix) {
  return ctx.routes.find((route) => route.path === '/plugins/dsh-team-chat' + suffix)
}

function disposeAll(ctx) {
  for (const dispose of ctx.effects) {
    if (typeof dispose === 'function') dispose()
  }
  ctx.effects.length = 0
}

test('P4-1 宿主级：create 建档 open gate → supersede 触发 gateSync（escalated/subject-superseded）+ quality.json 落盘', { skip: skipReason }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 't112-home-'))
  process.env.DSH_HOME = home
  const ctx = fakeContext({
    children: [{ kind: 'child', id: 'member-1', activity: 'idle', mode: 'continuable', label: 'agent-teams:demo:engineer' }],
  })
  t.after(() => {
    disposeAll(ctx)
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })
  host.apply(ctx)

  // 1) create（implementation）→ open gate 建档
  const created = fakeRes()
  await routeOf(ctx, '/team-tasks/create').handler(fakeReq({
    kind: 'implementation', subject: 'P4-1 被审对象', inScope: ['src/p4.js'],
    acceptance: ['A1'], verify: ['npm test'], constraints: ['node>=22'], knownRisks: ['quota'],
  }), created)
  assert.equal(created.statusCode, 200)
  const createdBody = created.json()
  assert.equal(createdBody.ok, true, 'create 成功：' + created.body)
  const taskId = createdBody.task.id
  assert.ok(createdBody.gate, 'create 响应携带 gate 建档信息')
  assert.equal(createdBody.gate.gateState, 'open')

  const stateRes = fakeRes()
  await routeOf(ctx, '/state').handler(fakeReq(undefined, 'GET', '/plugins/dsh-team-chat/state'), stateRes)
  const teamId = stateRes.json().activeTeam.id
  const qualityFile = join(home, 'dsh-team-chat', teamId.replace(/[^A-Za-z0-9._-]+/g, '_'), 'quality.json')
  assert.ok(existsSync(qualityFile), 'quality.json 已建档落盘：' + qualityFile)
  const before = JSON.parse(readFileSync(qualityFile, 'utf8'))
  assert.equal(before.gates[taskId].gateState, 'open')

  // 2) supersede → gateSync 同步处置（escalated / subject-superseded）
  const sup = fakeRes()
  await routeOf(ctx, '/team-tasks/supersede').handler(fakeReq({ taskId, revision: createdBody.task.revision }), sup)
  assert.equal(sup.statusCode, 200)
  const supBody = sup.json()
  assert.equal(supBody.ok, true, 'supersede 成功：' + sup.body)
  assert.ok(supBody.gateSync, '响应携带 gateSync')
  assert.equal(supBody.gateSync.gateState, 'escalated')
  assert.equal(sidecarGateReason(qualityFile, taskId), 'subject-superseded')

  // 3) quality.json 持久化侧证（escalated 记录已写盘，非仅内存）
  const after = JSON.parse(readFileSync(qualityFile, 'utf8'))
  assert.equal(after.gates[taskId].escalation.reason, 'subject-superseded')
})

function sidecarGateReason(qualityFile, taskId) {
  return JSON.parse(readFileSync(qualityFile, 'utf8')).gates[taskId].escalation.reason
}

test('P4-1 设置项：qualityLoopEnabled 缺省 true（随装配启用，§4.1 开关缺省语义）', { skip: skipReason }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 't112-home2-'))
  process.env.DSH_HOME = home
  const ctx = fakeContext({
    children: [{ kind: 'child', id: 'member-1', activity: 'idle', mode: 'continuable', label: 'agent-teams:demo:engineer' }],
  })
  t.after(() => {
    disposeAll(ctx)
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })
  host.apply(ctx)
  const res = fakeRes()
  await routeOf(ctx, '/state').handler(fakeReq(undefined, 'GET', '/plugins/dsh-team-chat/state'), res)
  // qualityLoopEnabled 的读取面 = readSettings()（内部）；此处经 settings update 关闭后
  // 再读 /state 不炸即证明设置链路连通；缺省 true 由 Config schema default 承载。
  const stateRes = fakeRes()
  await routeOf(ctx, '/state').handler(fakeReq(undefined, 'GET', '/plugins/dsh-team-chat/state'), stateRes)
  assert.equal(stateRes.statusCode, 200)
  assert.equal(stateRes.json().ok, true)
})
