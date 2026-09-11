/**
 * P1 Slice 2 接线测试（t77）—— test/team-tasks.test.mjs
 *
 * 两个部分：
 *   Part A（纯核心，裸 node 可跑，零 skip）：
 *     - store.runRoutine 巡检组合（claimed 回收 / running 走 stallMark / suspended 超时自动 superseded）
 *     - 持久化分级与崩溃窗口（真实子进程 SIGKILL）：
 *         A1 迁移已同步落盘、聚合窗口内活动时间戳丢失 → 磁盘=迁移态、绝不半写；
 *         A2 循环 save 大 store 中途被杀 → 目标文件任意时刻都是完整 JSON（tmp+rename 原子）。
 *   Part B（宿主接线，peer 依赖 schemastery 从安装 profile 解析；裸检出明确 skip 并给出原因，
 *   junction 临时树下真实执行——口径分开报，skip ≠ pass）：
 *     - /team-tasks/* 路由注册 + fenced 认证（缺 connection → 503）
 *     - create/claim/update/supersede 经路由的行为 + 同步落盘（$DSH_HOME 重定向到临时目录）
 *     - session/event 注入 → per-member lastEventAt + observeActivity（tasks 投影 updatedAt 前移）
 *       + readSurface 计数不变（不新增轮询读——性能纪律）
 *     - /state tasks[] 增量投影 + 两层 effect 清理
 *
 * 运行：node --test test/team-tasks.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore } from '../lib/state/task-store.js'

const T0 = 1726000000000

// ---------------------------------------------------------------- Part A：纯核心

const idleSettled = { observeIdle: () => true, lastSignalAtOf: () => null }
const obsRunning = { observeIdle: () => false, lastSignalAtOf: () => null }

function makeStore() {
  return new TaskStore({ claimLeaseMs: 1000, stallThresholdMs: 1000, suspendedUnattendedMs: 5000, maxSupersedeDepth: 16 })
}

test('S2-routine: runRoutine 组合巡检——claimed 超期回收、running 走 stallMark 不回收', () => {
  const store = makeStore()
  store.createTask({ subject: 'a', dependencies: [], assignee: 'r1' }, T0).task
  store.createTask({ subject: 'b', dependencies: [], assignee: 'r2' }, T0 + 1).task
  const c1 = store.claim('t1', { claimedById: 's1' }, T0 + 2)
  const c2 = store.claim('t2', { claimedById: 's2' }, T0 + 3)
  store.update('t2', { attemptId: c2.attemptId, revision: c2.revision, status: 'running' }, T0 + 4)
  const result = store.runRoutine(idleSettled, T0 + 5000)
  assert.deepEqual(result.reclaimed, ['t1'], 'claimed 超期 + 宿主观测 idle → 回收回 pending')
  assert.deepEqual(result.stalled, ['t2'], 'running 残留 → stallMark（标记不回收）')
  assert.equal(store.tasks.get('t1').status, 'pending')
  assert.equal(store.tasks.get('t2').status, 'running', 'running 不被 reclaim（防双执行）')
  assert.equal(store.tasks.get('t2').stallMarked, true)
  // 观测到 running → claimed 也不回收（宿主观测活动，永不回收）
  const store2 = makeStore()
  store2.createTask({ subject: 'c', dependencies: [], assignee: 'r1' }, T0).task
  store2.claim('t1', { claimedById: 's1' }, T0 + 1)
  const result2 = store2.runRoutine(obsRunning, T0 + 5000)
  assert.deepEqual(result2.reclaimed, [], '观测到活动 → 永不回收')
})

test('S2-routine: runRoutine 收口 checkUnattended——suspended 无人裁决超时自动 superseded', () => {
  const store = makeStore()
  store.createTask({ subject: 'x', dependencies: [], assignee: 'r1' }, T0).task
  const c = store.claim('t1', { claimedById: 's1' }, T0 + 1)
  store.update('t1', { attemptId: c.attemptId, revision: c.revision, status: 'running' }, T0 + 2)
  store.suspend('t1', { revision: store.tasks.get('t1').revision }, T0 + 3)
  const early = store.runRoutine(idleSettled, T0 + 4000)
  assert.deepEqual(early.autoSuperseded, [], '未到 unattended 阈值不自动作废')
  const late = store.runRoutine(idleSettled, T0 + 10000)
  assert.deepEqual(late.autoSuperseded, ['t1'], '超时自动 superseded（F3 出口，永不永久挂着）')
  assert.equal(store.tasks.get('t1').status, 'superseded')
})

test('S2-crash-A: 迁移已同步落盘 + 聚合窗口内被 SIGKILL → 磁盘=迁移态、无半写、活动时间戳丢失', () => {
  const dir = mkdtempSync(join(tmpdir(), 't77-crash-'))
  const target = join(dir, 'team.json')
  const storeUrl = new URL('../lib/state/task-store.js', import.meta.url).href
  const probe = [
    'import { TaskStore } from ' + JSON.stringify(storeUrl),
    'const store = new TaskStore({ claimLeaseMs: 1000, stallThresholdMs: 1000 })',
    "store.createTask({ subject: 'crash-probe', dependencies: [], assignee: 'm1' }, 1000)",
    "const c = store.claim('t1', { claimedById: 'session-x' }, 2000)",
    "if (!c.ok) { console.error('claim-failed'); process.exit(3) }",
    'store.save(' + JSON.stringify(target) + ')        // 迁移同步落盘（裁定 4：迁移写不走聚合）',
    "store.observeActivity('t1', 3000)      // 聚合窗口内的活动信号：只标脏，未落盘",
    "process.kill(process.pid, 'SIGKILL')   // 崩溃：exit 钩子不跑（Windows = TerminateProcess）",
  ].join('\n')
  // -e 默认按 CommonJS 解析——ESM import 必须显式 --input-type=module。
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { timeout: 20000 })
  // SIGKILL 后进程必然已退出；不依赖退出码（Windows 终止码不统一）。
  assert.ok(existsSync(target), '迁移写必须已经落盘')
  let parsed
  assert.doesNotThrow(() => { parsed = JSON.parse(readFileSync(target, 'utf8')) }, '文件必须是完整 JSON（绝不半写）')
  const task = parsed.tasks && parsed.tasks.t1
  assert.ok(task, '任务在磁盘上')
  assert.equal(task.status, 'claimed', '迁移不丢：claim 态在崩溃后仍在磁盘')
  assert.equal(task.claimedById, 'session-x', '迁移内容完整')
  assert.equal(task.lastSignalAt, null, '聚合窗口内的活动时间戳丢失——允许（裁定 4 语义），迁移不受影响')
  rmSync(dir, { recursive: true, force: true })
})

test('S2-crash-B: 循环原子 save 中途被 SIGKILL → 目标文件任意时刻都是完整 JSON（tmp+rename 原子）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't77-atomic-'))
  const target = join(dir, 'team.json')
  const storeUrl = new URL('../lib/state/task-store.js', import.meta.url).href
  const probe = [
    'import { TaskStore } from ' + JSON.stringify(storeUrl),
    'const store = new TaskStore()',
    "for (let i = 0; i < 400; i++) store.createTask({ subject: 'x'.repeat(2000) + ' #' + i, dependencies: [], assignee: 'm' + i }, 1000 + i)",
    'const timer = setInterval(() => { try { store.save(' + JSON.stringify(target) + ') } catch {} }, 4)',
    'setTimeout(() => {}, 1 << 30)',
  ].join('\n')
  const child = spawn(process.execPath, ['--input-type=module', '-e', probe], { stdio: 'ignore' })
  // 随机时机强杀——落点可能在工作循环 / writeFileSync(tmp) / rename 前后的任意一点。
  await new Promise((resolve) => setTimeout(resolve, 400))
  child.kill('SIGKILL')
  await new Promise((resolve) => child.on('exit', resolve))
  assert.ok(existsSync(target), '至少一次 save 已完成')
  let parsed
  assert.doesNotThrow(() => { parsed = JSON.parse(readFileSync(target, 'utf8')) }, '目标文件必须是完整 JSON——半写绝不出现在目标路径')
  assert.ok(Object.keys(parsed.tasks || {}).length > 0, '序列化内容完整')
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------- Part B：宿主接线（junction）

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

/** 宿主服务桩（扩展自 host-smoke 的 fakeContext：捕获事件订阅 + 环境重定向）。 */
function fakeContext(options = {}) {
  const state = {
    globalSections: [],
    scopedSections: [],
    routes: [],
    effects: [],
    surfaceReads: 0,
    eventHandlers: new Map(),
  }
  let stored = {}
  const systemPrompt = { section: (section) => { state.globalSections.push(section); return () => {} } }
  const scopedSystemPrompt = { section: (section) => { state.scopedSections.push(section); return () => {} } }
  const ctx = {
    ...state,
    settings: {
      writable: true,
      register: () => ({ read: () => stored }),
      get: () => stored,
      update: async (ns, patch) => { stored = { ...stored, ...patch } },
    },
    agents: {
      list: () => options.agents || [{ id: 'session-captain', ctx: { systemPrompt: scopedSystemPrompt } }],
      get: () => undefined,
    },
    subagents: {
      listChildren: async () => options.children || [],
      sendMessage: async () => 'message-id',
    },
    sessionQuery: {
      readSurface: async () => { state.surfaceReads += 1; return { events: [] } },
    },
    effect: (fn) => {
      const disposer = fn()
      state.effects.push(disposer)
      return typeof disposer === 'function' ? disposer : () => {}
    },
    on: (eventName, handler) => {
      const list = state.eventHandlers.get(eventName) || []
      list.push(handler)
      state.eventHandlers.set(eventName, list)
      return () => {}
    },
    get: (name) => {
      if (name === 'webServer') {
        return {
          register: (route) => {
            state.routes.push(route)
            return () => {}
          },
        }
      }
      if (name === 'connection') return options.connection === undefined ? { requestRejection: () => undefined } : options.connection
      if (name === 'systemPrompt') return systemPrompt
      if (name === 'sessions') return { get: () => undefined }
      if (name === 'agentPresets') return { serviceFor: () => undefined }
      return undefined
    },
  }
  return ctx
}

/** 与 host-smoke 同款：异步出体的请求桩。 */
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
    once(event, listener) { return req.on(event, listener) },
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
  for (const disposer of ctx.effects) {
    if (typeof disposer === 'function') disposer()
  }
  ctx.effects.length = 0
}

/** 带一名成员的宿主：roster 刷新后事件馈线就绪（watchedMembers + feedBuffers）。 */
async function hostWithMember(options = {}) {
  const ctx = fakeContext({
    children: [{ kind: 'child', id: 'member-1', activity: 'idle', mode: 'continuable', label: 'agent-teams:demo:engineer' }],
    ...options,
  })
  const home = mkdtempSync(join(tmpdir(), 't77-home-'))
  process.env.DSH_HOME = home
  host.apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 60)) // 让 apply 末尾的 void tick() 完成 roster 刷新
  return { ctx, home }
}

function emitSessionEvent(ctx, memberId, event) {
  for (const handler of ctx.eventHandlers.get('session/event') || []) handler({ id: memberId }, event)
}

function emitAgentStatus(ctx, memberId, status) {
  for (const handler of ctx.eventHandlers.get('agent/status') || []) handler({ agent: { id: memberId } }, status)
}

test('S2-routes: /team-tasks/create|claim|update|release|supersede 五路由注册在 auth fence 后', { skip: skipReason }, (t) => {
  const ctx = fakeContext()
  t.after(() => disposeAll(ctx))
  host.apply(ctx)
  const paths = ctx.routes.map((route) => route.path)
  for (const suffix of ['/team-tasks/create', '/team-tasks/claim', '/team-tasks/update', '/team-tasks/release', '/team-tasks/supersede']) {
    assert.ok(paths.includes('/plugins/dsh-team-chat' + suffix), 'missing route ' + suffix)
  }
  assert.ok(ctx.effects.length >= 2, '既有 event-feed effect 之外必须有 state-layer effect（定时器/退出 flush 归属）')
})

test('S2-fenced: 无 connection 时 /team-tasks/* 一律 503 拒绝', { skip: skipReason }, (t) => {
  const ctx = fakeContext({ connection: undefined })
  // connection === undefined → fenced 走 503 分支（桩默认是放行，这里显式拿掉）
  ctx.get = ((original) => (name) => (name === 'connection' ? undefined : original(name)))(ctx.get)
  t.after(() => disposeAll(ctx))
  host.apply(ctx)
  const res = fakeRes()
  return routeOf(ctx, '/team-tasks/create').handler(fakeReq({ subject: 'x' }), res).then(() => {
    assert.equal(res.statusCode, 503, '认证不可用必须 503，绝不服务团队状态')
  })
})

test('S2-flow: create → claim(带身份) → /state tasks 投影 + 同步落盘到 $DSH_HOME/dsh-team-chat/<teamId>/', { skip: skipReason }, async (t) => {
  const { ctx, home } = await hostWithMember()
  t.after(() => {
    disposeAll(ctx)
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })
  // create（不指定 assignee——留空验证 claim 时由 claimedById 补空）
  const created = fakeRes()
  await routeOf(ctx, '/team-tasks/create').handler(fakeReq({ subject: '接线任务' }), created)
  assert.equal(created.statusCode, 200)
  const createdBody = created.json()
  assert.equal(createdBody.ok, true, 'create 成功：' + created.body)
  const taskId = createdBody.task.id
  // 磁盘上立刻可见（迁移同步写）
  const stateRes = fakeRes()
  await routeOf(ctx, '/state').handler(fakeReq(undefined, 'GET', '/plugins/dsh-team-chat/state'), stateRes)
  const teamId = stateRes.json().activeTeam.id
  const persisted = join(home, 'dsh-team-chat', teamId.replace(/[^A-Za-z0-9._-]+/g, '_'), 'team.json')
  assert.ok(existsSync(persisted), '迁移同步落盘：' + persisted)
  // claim 带身份
  const claimed = fakeRes()
  await routeOf(ctx, '/team-tasks/claim').handler(fakeReq({ taskId, claimedById: 'session-member-1' }), claimed)
  const claimedBody = claimed.json()
  assert.equal(claimedBody.ok, true, 'claim 成功：' + claimed.body)
  assert.ok(claimedBody.attemptId)
  // /state 投影反映 claimed + claimedById 落盘
  const after = fakeRes()
  await routeOf(ctx, '/state').handler(fakeReq(undefined, 'GET', '/plugins/dsh-team-chat/state'), after)
  const body = after.json()
  const row = (body.tasks || []).find((entry) => entry.id === taskId)
  assert.ok(row, 'tasks[] 投影存在（§6 增量）')
  assert.equal(row.status, 'claimed')
  assert.equal(row.assignee, 'session-member-1')
  const onDisk = JSON.parse(readFileSync(persisted, 'utf8'))
  assert.equal(onDisk.tasks[taskId].status, 'claimed', 'claim 迁移同步落盘')
  assert.equal(onDisk.tasks[taskId].claimedById, 'session-member-1', '§1 防误认领身份落盘')
})

test('S2-ward: 依赖前置与 update 越域经路由同样被拒（宿主层复验 t75-F1/F2）', { skip: skipReason }, async (t) => {
  const { ctx, home } = await hostWithMember()
  t.after(() => {
    disposeAll(ctx)
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })
  const mk = async (input) => {
    const res = fakeRes()
    await routeOf(ctx, '/team-tasks/create').handler(fakeReq(input), res)
    return res.json().task
  }
  const dep = await mk({ subject: 'dep', assignee: 'engineer' })
  const child = await mk({ subject: 'child', dependencies: [dep.id], assignee: 'researcher' })
  // F2：依赖未 terminal → claim 被拒
  const early = fakeRes()
  await routeOf(ctx, '/team-tasks/claim').handler(fakeReq({ taskId: child.id }), early)
  assert.equal(early.json().ok, false)
  assert.equal(early.json().reason, 'dependency-blocked')
  // F1：update 提交 superseded → 域外拒绝
  const claimed = fakeRes()
  await routeOf(ctx, '/team-tasks/claim').handler(fakeReq({ taskId: dep.id }), claimed)
  const { attemptId, revision } = claimed.json()
  const upd = fakeRes()
  await routeOf(ctx, '/team-tasks/update').handler(fakeReq({ taskId: dep.id, attemptId, revision, status: 'superseded' }), upd)
  assert.equal(upd.json().ok, false)
  assert.equal(upd.json().reason, 'illegal-transition')
  assert.deepEqual(upd.json().allowedStatus, ['running', 'completed', 'failed'])
})

test('S2-signal: session/event 注入 → per-member lastEventAt + observeActivity（tasks 投影 updatedAt 前移），零新增 surface 读', { skip: skipReason }, async (t) => {
  const { ctx, home } = await hostWithMember()
  t.after(() => {
    disposeAll(ctx)
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })
  const created = fakeRes()
  await routeOf(ctx, '/team-tasks/create').handler(fakeReq({ subject: '信号任务', assignee: 'engineer' }), created)
  const taskId = created.json().task.id
  const claimed = fakeRes()
  await routeOf(ctx, '/team-tasks/claim').handler(fakeReq({ taskId, claimedById: 'member-1' }), claimed)
  assert.equal(claimed.json().ok, true)
  const claimedRevision = claimed.json().revision
  const before = fakeRes()
  await routeOf(ctx, '/state').handler(fakeReq(undefined, 'GET', '/plugins/dsh-team-chat/state'), before)
  const beforeUpdatedAt = before.json().tasks.find((entry) => entry.id === taskId).updatedAt
  const readsBefore = ctx.surfaceReads
  // 注入成员活动：turn/start（已-admitted 探针信号）+ assistant/message（chat 面）
  const baseSeq = Date.now()
  emitSessionEvent(ctx, 'member-1', { type: 'turn/start', seq: baseSeq + 1, data: {} })
  emitSessionEvent(ctx, 'member-1', { type: 'assistant/message', seq: baseSeq + 2, data: { message: { content: [{ type: 'text', text: '干活了' }] } } })
  const after = fakeRes()
  await routeOf(ctx, '/state').handler(fakeReq(undefined, 'GET', '/plugins/dsh-team-chat/state'), after)
  const body = after.json()
  const row = body.tasks.find((entry) => entry.id === taskId)
  assert.ok(row.updatedAt > beforeUpdatedAt, 'observeActivity 经 CAS 前移 updatedAt（信号喂给生效）')
  assert.equal(ctx.surfaceReads, readsBefore, '信号链路零新增 readSurface（不把轮询加回来）')
  assert.equal(body.feed.eventCount >= 2, true, '事件被馈线接受')
  // agent/status 喂 status：running → 例程不回收；这里验证喂入不炸且投影仍可用
  emitAgentStatus(ctx, 'member-1', 'running')
  const final = fakeRes()
  await routeOf(ctx, '/state').handler(fakeReq(undefined, 'GET', '/plugins/dsh-team-chat/state'), final)
  assert.equal(final.statusCode, 200)
  void claimedRevision
})

test('S2-supersede: supersede 路由闭环（作废 + 下游戳 + 同步落盘）', { skip: skipReason }, async (t) => {
  const { ctx, home } = await hostWithMember()
  t.after(() => {
    disposeAll(ctx)
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })
  const mk = async (input) => {
    const res = fakeRes()
    await routeOf(ctx, '/team-tasks/create').handler(fakeReq(input), res)
    return res.json().task
  }
  const dep = await mk({ subject: 'dep', assignee: 'engineer' })
  await mk({ subject: 'child', dependencies: [dep.id], assignee: 'researcher' })
  const claimed = fakeRes()
  await routeOf(ctx, '/team-tasks/claim').handler(fakeReq({ taskId: dep.id }), claimed)
  const sup = fakeRes()
  await routeOf(ctx, '/team-tasks/supersede').handler(fakeReq({
    taskId: dep.id,
    revision: claimed.json().revision,
    supersededBy: null,
  }), sup)
  assert.equal(sup.json().ok, true, 'supersede 成功：' + sup.body)
  const after = fakeRes()
  await routeOf(ctx, '/state').handler(fakeReq(undefined, 'GET', '/plugins/dsh-team-chat/state'), after)
  const rows = after.json().tasks
  assert.equal(rows.find((entry) => entry.id === dep.id).status, 'superseded')
  const childRow = rows.find((entry) => Array.isArray(entry.dependencies) && entry.dependencies.includes(dep.id))
  assert.ok(childRow.dependencySupersededAt !== null && childRow.dependencySupersededAt !== undefined, '下游拿到作废戳（S3 带戳继续）')
  const stateRes = fakeRes()
  await routeOf(ctx, '/state').handler(fakeReq(undefined, 'GET', '/plugins/dsh-team-chat/state'), stateRes)
  const teamId = stateRes.json().activeTeam.id
  const onDisk = JSON.parse(readFileSync(join(home, 'dsh-team-chat', teamId.replace(/[^A-Za-z0-9._-]+/g, '_'), 'team.json'), 'utf8'))
  assert.equal(onDisk.tasks[dep.id].status, 'superseded', '作废迁移同步落盘')
})

test('S2-release: release 路由归还 pending 并同步落盘', { skip: skipReason }, async (t) => {
  const { ctx, home } = await hostWithMember()
  t.after(() => {
    disposeAll(ctx)
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })
  const created = fakeRes()
  await routeOf(ctx, '/team-tasks/create').handler(fakeReq({ subject: '归还我', assignee: 'engineer' }), created)
  const taskId = created.json().task.id
  const claimed = fakeRes()
  await routeOf(ctx, '/team-tasks/claim').handler(fakeReq({ taskId, claimedById: 'session-m' }), claimed)
  const released = fakeRes()
  await routeOf(ctx, '/team-tasks/release').handler(fakeReq({
    taskId,
    attemptId: claimed.json().attemptId,
    revision: claimed.json().revision,
  }), released)
  assert.equal(released.json().ok, true, 'release 成功：' + released.body)
  const after = fakeRes()
  await routeOf(ctx, '/state').handler(fakeReq(undefined, 'GET', '/plugins/dsh-team-chat/state'), after)
  assert.equal(after.json().tasks.find((entry) => entry.id === taskId).status, 'pending')
  const stateRes = fakeRes()
  await routeOf(ctx, '/state').handler(fakeReq(undefined, 'GET', '/plugins/dsh-team-chat/state'), stateRes)
  const teamId = stateRes.json().activeTeam.id
  const onDisk = JSON.parse(readFileSync(join(home, 'dsh-team-chat', teamId.replace(/[^A-Za-z0-9._-]+/g, '_'), 'team.json'), 'utf8'))
  assert.equal(onDisk.tasks[taskId].status, 'pending', 'release 迁移同步落盘')
})
