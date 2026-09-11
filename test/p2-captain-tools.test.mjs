/**
 * 队长工具面 ×4 测试 —— test/p2-captain-tools.test.mjs
 *
 * t96 · P2 Slice 2。构造调用证据（真实 TaskStore + 真实 MemberRegistry + 真实
 * scheduler.js 接线 + 受控 wake 边界）：
 *   - team_create_task：建任务 + §2.3 触发源 1（pickMemberToWake 实际驱动一次唤醒；
 *     定向/池；wake:false 不唤醒；subject 缺失拒绝）；
 *   - team_update_task：CAS 迁移（attemptId+revision）；stale 诚实拒绝；review 任务
 *     completed 时 E15 警告载荷（经 deps.reviewGuard.compareFor）；
 *   - team_send_message：自由消息 vs kind:wake（携带 taskId 元数据 = F3 双通道主路径）；
 *     定向唤醒走 pickMemberToWake 选序（熔断成员拒发）；wake 失败记账熔断；未知成员拒绝；
 *   - team_status：注册表 + 池投影 + readyQueue。
 *
 * 判别（能变红）见 %TEMP%/dsh-t96-mutate/：mut-captain-nowake（create 跳过池检查）→ 红；
 * mut-captain-e15（completed 不比对）→ 红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TaskStore } from '../lib/state/task-store.js'
import { MemberRegistry } from '../lib/p2/scheduler-core.js'
import {
  CAPTAIN_TOOLS,
  CAPTAIN_TOOL_NAMES,
  createCaptainTask,
  updateCaptainTask,
  sendCaptainMessage,
  captainStatus,
} from '../lib/p2/captain-tools.js'
import { createReviewGuard } from '../lib/p2/review-guard.js'

const T0 = 1729000000000

function makeStore() {
  return new TaskStore({ claimLeaseMs: 60000, stallThresholdMs: 60000, suspendedUnattendedMs: 300000, maxSupersedeDepth: 16 })
}

function wakeDriver(script = {}) {
  const calls = []
  return {
    calls,
    wake(memberName, task, meta) {
      calls.push({ memberName, taskId: task?.id ?? null, meta })
      const mode = script[memberName] ?? 'ok'
      if (mode === 'ok') return Promise.resolve(true)
      if (mode === 'false') return Promise.resolve(false)
      return Promise.reject(new Error(`wake-${memberName}-down`))
    },
  }
}

function makeDeps(overrides = {}) {
  const store = overrides.store ?? makeStore()
  const registry = overrides.registry ?? new MemberRegistry({ now: () => T0 })
  const driver = overrides.driver ?? wakeDriver()
  return {
    store,
    registry,
    memberIds: overrides.memberIds ?? ['alice', 'bob'],
    wake: driver.wake,
    driver,
    now: T0,
    ...overrides.extra,
  }
}

test('DTO：四工具命名（team_ 前缀命名空间，契约名映射）与参数形状', () => {
  assert.deepEqual(CAPTAIN_TOOL_NAMES.sort(), ['team_create_task', 'team_send_message', 'team_status', 'team_update_task'])
  assert.ok(CAPTAIN_TOOLS.team_create_task.parameters.properties.subject)
  assert.deepEqual(CAPTAIN_TOOLS.team_create_task.parameters.required, ['subject'])
  assert.ok(CAPTAIN_TOOLS.team_update_task.parameters.properties.attemptId)
  assert.ok(CAPTAIN_TOOLS.team_send_message.parameters.properties.taskId, 'taskId 元数据 = F3 双通道主路径')
  assert.deepEqual(CAPTAIN_TOOLS.team_status.parameters.properties, {})
})

test('create_task：建任务 + §2.3 触发源 1（定向任务唤醒 assignee）', async () => {
  const deps = makeDeps()
  const r = await createCaptainTask(deps, { subject: '定向活', assignee: 'alice' })
  assert.equal(r.ok, true)
  assert.equal(deps.store.tasks.get(r.taskId).status, 'pending')
  assert.deepEqual(deps.driver.calls, [{ memberName: 'alice', taskId: r.taskId, meta: undefined }])
  assert.deepEqual(r.wake.woken, [{ taskId: r.taskId, member: 'alice' }])
  assert.equal(deps.registry.inFlightOf('alice').has(r.taskId), true, '唤醒后在途记账')
})

test('create_task：池任务唤醒按选序；wake:false 不唤醒；subject 缺失拒绝', async () => {
  const deps = makeDeps()
  const pool = await createCaptainTask(deps, { subject: '池活' })
  assert.equal(pool.ok, true)
  assert.equal(deps.driver.calls.length, 1, '池检查触发一次唤醒')
  assert.equal(deps.driver.calls[0].memberName, 'alice', '同闲平局名字序')

  const quiet = await createCaptainTask(deps, { subject: '不唤醒', wake: false })
  assert.equal(quiet.ok, true)
  assert.deepEqual(quiet.wake, { skipped: 'wake-disabled' })
  assert.equal(deps.driver.calls.length, 1)

  const noSubject = await createCaptainTask(deps, { assignee: 'alice' })
  assert.equal(noSubject.ok, false)
  assert.equal(noSubject.reason, 'subject-required')
})

test('update_task：CAS 迁移成功；stale/attempt 不符诚实拒绝', () => {
  const deps = makeDeps()
  const t = deps.store.createTask({ subject: 'x', dependencies: [], assignee: 'alice' }, T0).task
  deps.store.claim(t.id, { assignee: 'alice', claimedById: 'child-a' }, T0 + 1)
  const row = deps.store.tasks.get(t.id)

  const badRev = updateCaptainTask(deps, { taskId: t.id, attemptId: row.attemptId, revision: row.revision + 5, status: 'running' })
  assert.equal(badRev.ok, false)
  assert.equal(badRev.reason, 'stale-revision')

  const badAttempt = updateCaptainTask(deps, { taskId: t.id, attemptId: 'wrong', revision: row.revision, status: 'running' })
  assert.equal(badAttempt.ok, false)
  assert.equal(badAttempt.reason, 'attempt-mismatch')

  const ok = updateCaptainTask(deps, { taskId: t.id, attemptId: row.attemptId, revision: row.revision, status: 'completed' })
  assert.equal(ok.ok, true)
  assert.equal(deps.store.tasks.get(t.id).status, 'completed')
})

test('update_task：review 任务 completed → E15 警告载荷（不匹配即警告，不阻断）', () => {
  const deps = makeDeps()
  let content = 'v1'
  const guard = createReviewGuard({ readFile: (f) => { if (f !== 'spec.md') throw new Error('ENOENT ' + f); return Buffer.from(content) } })
  deps.reviewGuard = guard
  const t = deps.store.createTask({ subject: '复核', dependencies: [], assignee: 'bob', kind: 'review', inScope: ['spec.md'] }, T0).task
  // claim 时快照记录的是 v1
  guard.snapshotFor(t)
  content = 'v2-CHANGED' // 复核窗口内被修订 → E15 应告警
  deps.store.claim(t.id, { assignee: 'bob', claimedById: 'child-b' }, T0 + 1)
  const row = deps.store.tasks.get(t.id)
  const done = updateCaptainTask(deps, { taskId: t.id, attemptId: row.attemptId, revision: row.revision, status: 'completed' })
  assert.equal(done.ok, true, 'E15 不匹配不阻断')
  assert.equal(done.reviewGuard.match, false)
  assert.equal(done.reviewGuard.changed[0].file, 'spec.md')
  assert.equal(done.reviewGuard.changed[0].kind, 'modified')

  // 非 review 任务 completed → 无 reviewGuard 载荷
  const t2 = deps.store.createTask({ subject: '普通', dependencies: [], assignee: 'alice' }, T0 + 2).task
  deps.store.claim(t2.id, { assignee: 'alice', claimedById: 'child-a' }, T0 + 3)
  const row2 = deps.store.tasks.get(t2.id)
  const done2 = updateCaptainTask(deps, { taskId: t2.id, attemptId: row2.attemptId, revision: row2.revision, status: 'completed' })
  assert.equal(done2.ok, true)
  assert.equal(done2.reviewGuard, undefined)
})

test('send_message：自由消息（无 taskId）直发；wake 语义携带 taskId + kind 元数据（F3 主路径）', async () => {
  const deps = makeDeps()
  deps.registry.markActive('alice', T0)
  const free = await sendCaptainMessage(deps, { memberName: 'alice', text: '指导一下' })
  assert.equal(free.ok, true)
  assert.equal(free.kind, 'message')
  assert.deepEqual(deps.driver.calls[0].meta, { kind: 'message', text: '指导一下', taskId: undefined })

  const t = deps.store.createTask({ subject: '定向', dependencies: [], assignee: 'alice' }, T0 + 1).task
  const wake = await sendCaptainMessage(deps, { memberName: 'alice', taskId: t.id, text: '请认领 t1' })
  assert.equal(wake.ok, true)
  assert.equal(wake.kind, 'wake')
  assert.equal(deps.driver.calls[1].meta.kind, 'wake')
  assert.equal(deps.driver.calls[1].taskId, t.id, 'F3 主路径：taskId 元数据随唤醒下发')
  assert.equal(deps.registry.inFlightOf('alice').has(t.id), true)
})

test('send_message：熔断成员 free 消息仍可发（可用性门控只锁 wake）；wake 拒发；失败记账；未知成员拒绝', async () => {
  const store = makeStore()
  const registry = new MemberRegistry({ breakerThreshold: 1, now: () => T0 })
  registry.markActive('bob', T0)
  registry.recordFailure('bob', 'down', T0) // bob open
  const driver = wakeDriver()
  const deps = { store, registry, memberIds: ['alice', 'bob'], wake: driver.wake, now: T0 }

  // 自由消息不受可用性门控（设计语义：门控锁的是调度唤醒，不是人际通道）
  const freeToBroken = await sendCaptainMessage(deps, { memberName: 'bob', text: 'hi' })
  assert.equal(freeToBroken.ok, true)
  assert.equal(freeToBroken.kind, 'message')

  // wake 受选序边界约束：熔断成员不可定向唤醒（不绕过 pickMemberToWake）
  const t = store.createTask({ subject: 'x', dependencies: [], assignee: 'bob' }, T0).task
  const wakeBroken = await sendCaptainMessage(deps, { memberName: 'bob', taskId: t.id, text: 'wake' })
  assert.equal(wakeBroken.ok, false)
  assert.equal(wakeBroken.reason, 'member-unavailable', '熔断成员不可唤醒（不绕过选序）')

  // wake 边界失败 → 真实失败信号记账 → 熔断
  const registry2 = new MemberRegistry({ breakerThreshold: 1, now: () => T0 })
  registry2.markActive('alice', T0)
  const deps2 = { store, registry: registry2, memberIds: ['alice'], wake: wakeDriver({ alice: 'throw' }).wake, now: T0 }
  const fail = await sendCaptainMessage(deps2, { memberName: 'alice', text: 'hi' })
  assert.equal(fail.ok, false)
  assert.equal(fail.reason, 'wake-failed')
  assert.equal(registry2.availabilityOf('alice'), 'breaker-open', '失败信号已记账（1 连败即达阈值）')

  // 未知成员（非 memberIds）一律拒绝
  const unknown = await sendCaptainMessage(deps, { memberName: 'ghost', text: 'hi' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.reason, 'unknown-member')
})

test('status：注册表 + 池投影 + readyQueue', async () => {
  const deps = makeDeps()
  deps.registry.markActive('alice', T0)
  registryInFlight(deps, 'alice', 'ghost-task')
  const t = deps.store.createTask({ subject: 'ready', dependencies: [], assignee: 'bob' }, T0).task
  const s = captainStatus(deps)
  assert.equal(s.ok, true)
  assert.equal(s.members.length, 2)
  const alice = s.members.find((m) => m.name === 'alice')
  assert.deepEqual(alice.inFlight, ['ghost-task'])
  assert.deepEqual(s.readyQueue, [t.id])
  assert.equal(s.tasks.length, 1)
})

function registryInFlight(deps, memberId, taskId) {
  deps.registry.markInFlight(memberId, taskId)
}
