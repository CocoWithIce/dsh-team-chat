/**
 * 调度器接线测试（dispatchBatch / reconcileInFlight / collectStaleCandidates /
 * disposeStale）—— test/p2-scheduler-wiring.test.mjs
 *
 * t94 · P2 Slice 1b。1a 的 scheduler-core 是纯原语；本文件验证它们被**实际驱动**：
 *   - dispatchBatch 用 pickMemberToWake 的选择结果调用 wake 边界（定向/池任务各若干）；
 *   - 熔断的信号源 = wake 边界的真实失败结果（throw / false），不是直接戳 registry：
 *     3 连败 → breaker-open → 该实例被后续拍排除；显式 resetBreaker → 恢复参与；
 *   - 无可唤醒 → skipped 且 store 零改动（no-auto-requeue，重排风暴反制）；
 *   - E9 单实例：每拍至多 maxWakes（默认 1）次唤醒，其余 skipped 待下一拍；
 *   - reconcileInFlight 清终态任务的在途占位；collectStaleCandidates 收集租约过期；
 *     disposeStale 无 explicit 拒绝（store 零改动），显式 reassign（to=）/supersede 生效。
 *
 * 判别（能变红）见 %TEMP%/dsh-t94-mutate/：
 *   mut-sched-breaker.js —— dispatchBatch 吞掉 recordFailure（熔断永不 open）→ 熔断用例红；
 *   mut-sched-requeue.js —— 无可唤醒时自动 reassign → no-auto-requeue 用例红；
 *   mut-tool-names.js    —— spawn 白名单回退为字面量分叉 → 单一常量源用例红（在 p2-spawn.test.mjs）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TaskStore } from '../lib/state/task-store.js'
import { MemberRegistry, AVAILABILITY } from '../lib/p2/scheduler-core.js'
import {
  DEFAULT_MAX_WAKES_PER_TICK,
  readyTasksOf,
  dispatchBatch,
  reconcileInFlight,
  collectStaleCandidates,
  disposeStale,
  STALE_ACTIONS,
} from '../lib/p2/scheduler.js'

const T0 = 1729000000000

function makeStore() {
  return new TaskStore({ claimLeaseMs: 60000, stallThresholdMs: 60000, suspendedUnattendedMs: 300000, maxSupersedeDepth: 16 })
}

/** 受控 wake 驱动：按成员名决定成败，记录全部调用（真实信号 = 本边界的结果）。 */
function wakeDriver(script = {}) {
  const calls = []
  return {
    calls,
    wake(memberId, task) {
      calls.push({ memberId, taskId: task.id })
      const mode = script[memberId] ?? 'ok'
      if (mode === 'ok') return Promise.resolve(true)
      if (mode === 'false') return Promise.resolve(false)
      return Promise.reject(new Error(`wake-${memberId}-down`))
    },
  }
}

test('默认每拍唤醒上限 = 1（E9 常量导出）', () => {
  assert.equal(DEFAULT_MAX_WAKES_PER_TICK, 1)
})

test('readyTasksOf：pending 且依赖就绪；定向任务排前（可派集合）', () => {
  const store = makeStore()
  const tDep = store.createTask({ subject: 'dep', dependencies: [], assignee: '' }, T0).task
  const directed = store.createTask({ subject: 'd', dependencies: [], assignee: 'alice' }, T0 + 1).task
  const blocked = store.createTask({ subject: 'b', dependencies: [tDep.id], assignee: '' }, T0 + 2).task
  const pool = store.createTask({ subject: 'p', dependencies: [], assignee: '' }, T0 + 3).task
  const ready = readyTasksOf(store)
  assert.deepEqual(ready.map((t) => t.id), [directed.id, tDep.id, pool.id], '依赖未解锁的 blocked 不可派；定向排前、同组按 openedAt')
  void blocked
})

test('dispatchBatch：pickMemberToWake 实际驱动派发（定向 + 池各若干，maxWakes=1 分拍）', async () => {
  const store = makeStore()
  const registry = new MemberRegistry({ now: () => T0 })
  const driver = wakeDriver()
  const deps = { store, registry, memberIds: ['alice', 'bob'], wake: driver.wake, maxWakes: 1, now: T0 }
  const tAlice = store.createTask({ subject: 'a', dependencies: [], assignee: 'alice' }, T0).task
  const tBob = store.createTask({ subject: 'b', dependencies: [], assignee: 'bob' }, T0 + 1).task
  const tPool = store.createTask({ subject: 'p', dependencies: [], assignee: '' }, T0 + 2).task

  // 拍 1：定向优先 → alice 被真实唤醒；其余跳过待下拍（E9 单实例）
  const r1 = await dispatchBatch(deps)
  assert.deepEqual(r1.woken, [{ taskId: tAlice.id, member: 'alice' }])
  assert.deepEqual(driver.calls, [{ memberId: 'alice', taskId: tAlice.id }])
  assert.deepEqual(r1.skipped.map((s) => s.reason).sort(), ['max-wakes-per-tick', 'max-wakes-per-tick'])

  // 拍 2：alice 有在途（刚被唤醒过）→ 定向 bob 独立可唤醒
  const r2 = await dispatchBatch(deps)
  assert.deepEqual(r2.woken, [{ taskId: tBob.id, member: 'bob' }])

  // 拍 3：池任务 → alice/bob 都有在途，仍按选序挑一个真实唤醒（在途数相同时名字序）
  const r3 = await dispatchBatch(deps)
  assert.equal(r3.woken.length, 1)
  assert.equal(driver.calls.length, 3)
  assert.equal(driver.calls[2].taskId, tPool.id)

  // 在途记账真实发生
  assert.equal(registry.inFlightOf('alice').size >= 1, true)
})

test('dispatchBatch：真实失败信号熔断——批内 3 连败 → open → 后续任务即被排除；显式 reset → 恢复', async () => {
  const store = makeStore()
  const registry = new MemberRegistry({ breakerThreshold: 3, now: () => T0 })
  const driver = wakeDriver({ w1: 'throw', w2: 'throw' })
  const deps = { store, registry, memberIds: ['w1', 'w2'], wake: driver.wake, maxWakes: 7, now: T0 }
  const tasks = []
  for (let i = 0; i < 7; i++) tasks.push(store.createTask({ subject: `t${i}`, dependencies: [], assignee: '' }, T0 + i).task)

  const r = await dispatchBatch(deps)
  // 选序轮转（连败对等时名字序）：每次唤醒失败都是 wake 边界的真实结果记账
  assert.deepEqual(r.failed.map((f) => f.member), ['w1', 'w2', 'w1', 'w2', 'w1', 'w2'])
  assert.deepEqual(r.failed.map((f) => f.breached), [false, false, false, false, true, true], '第 5/6 次失败达到阈值 → 熔断打开')
  assert.equal(registry.availabilityOf('w1'), AVAILABILITY.BREAKER_OPEN)
  assert.equal(registry.availabilityOf('w2'), AVAILABILITY.BREAKER_OPEN)
  // 批内排除：第 7 条任务不再唤醒任何人，store 零改动（no-auto-requeue）
  assert.deepEqual(r.woken, [])
  assert.deepEqual(r.skipped, [{ taskId: tasks[6].id, reason: 'no-eligible-member' }])
  for (const t of tasks) assert.equal(store.tasks.get(t.id).status, 'pending', '失败/跳过都不改 store')

  // 显式 reset 后恢复：只有 w1 回到可用 → 下一拍真实派发（w2 仍被排除，直接证据）
  registry.resetBreaker('w1')
  assert.equal(registry.availabilityOf('w1'), AVAILABILITY.ONLINE)
  assert.equal(registry.consecutiveFailuresOf('w1'), 0)
  const driver2 = wakeDriver() // 之后 wake 全成功
  const r2 = await dispatchBatch({ ...deps, wake: driver2.wake, maxWakes: 1 })
  assert.deepEqual(r2.woken, [{ taskId: tasks[0].id, member: 'w1' }], '熔断实例被排除，reset 后恢复参与（最早 ready 任务被真实派发）')
  assert.deepEqual(driver2.calls, [{ memberId: 'w1', taskId: tasks[0].id }])
})

test('dispatchBatch：定向目标熔断 → 不降级派给他人（skipped，store 零改动）', async () => {
  const store = makeStore()
  const registry = new MemberRegistry({ breakerThreshold: 1, now: () => T0 })
  registry.markActive('bob', T0)
  registry.recordFailure('bob', 'down', T0) // bob open
  const driver = wakeDriver()
  const deps = { store, registry, memberIds: ['alice', 'bob'], wake: driver.wake, maxWakes: 1, now: T0 }
  const tBob = store.createTask({ subject: 'b', dependencies: [], assignee: 'bob' }, T0).task
  const r = await dispatchBatch(deps)
  assert.deepEqual(r.woken, [], '定向目标不可用 → 不唤醒任何他人')
  assert.equal(r.skipped[0].reason, 'no-eligible-member')
  assert.equal(store.tasks.get(tBob.id).status, 'pending', '不自动改派（no-auto-requeue）')
  assert.deepEqual(driver.calls, [], 'wake 边界零调用')
})

test('dispatchBatch：wake 返回 false 同样记真实失败（信号通路②）', async () => {
  const store = makeStore()
  const registry = new MemberRegistry({ breakerThreshold: 1, now: () => T0 })
  const driver = wakeDriver({ solo: 'false' })
  const deps = { store, registry, memberIds: ['solo'], wake: driver.wake, maxWakes: 1, now: T0 }
  store.createTask({ subject: 'x', dependencies: [], assignee: '' }, T0)
  const r = await dispatchBatch(deps)
  assert.equal(r.failed.length, 1)
  assert.equal(r.failed[0].error, 'wake-reported-failure')
  assert.equal(registry.availabilityOf('solo'), AVAILABILITY.BREAKER_OPEN)
})

test('reconcileInFlight：终态任务清在途占位（防假占坑）', async () => {
  const store = makeStore()
  const registry = new MemberRegistry({ now: () => T0 })
  const t = store.createTask({ subject: 'x', dependencies: [], assignee: 'alice' }, T0).task
  registry.markInFlight('alice', t.id)
  store.claim(t.id, { assignee: 'alice', claimedById: 'child-a' }, T0 + 1)
  assert.deepEqual(reconcileInFlight({ store, registry, memberIds: ['alice'] }), [], '未终态不清')
  store.update(t.id, { attemptId: store.tasks.get(t.id).attemptId, revision: store.tasks.get(t.id).revision, status: 'completed' }, T0 + 2)
  assert.deepEqual(reconcileInFlight({ store, registry, memberIds: ['alice'] }), [t.id])
  assert.equal(registry.inFlightOf('alice').has(t.id), false)
})

test('stale：collectStaleCandidates 收集租约过期候选；disposeStale 缺省拒绝且 store 零改动', () => {
  const store = makeStore()
  const t = store.createTask({ subject: 'x', dependencies: [], assignee: 'alice' }, T0).task
  store.claim(t.id, { assignee: 'alice', claimedById: 'child-a' }, T0 + 1)
  const before = store.tasks.get(t.id)

  assert.deepEqual(collectStaleCandidates({ store, now: T0 + 60001 }), [], '租约未到期不算 stale')
  const candidates = collectStaleCandidates({ store, now: T0 + 60002 })
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].taskId, t.id)
  assert.equal(candidates[0].attemptId, before.attemptId)

  // 无自动重排：缺省 explicit → 拒绝，任务原地不动（attemptId/assignee/status 全等）
  const refused = disposeStale({ store, now: T0 + 60003 }, candidates[0])
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, 'no-auto-requeue')
  const none = disposeStale({ store, now: T0 + 60003 }, candidates[0], { explicit: 'none' })
  assert.equal(none.ok, false)
  assert.equal(none.reason, 'no-auto-requeue')
  const after = store.tasks.get(t.id)
  assert.equal(after.status, 'claimed')
  assert.equal(after.attemptId, before.attemptId)
  assert.equal(after.assignee, 'alice')
})

test('stale：显式 reassign（to= 新 assignee，P1 契约字段）经接线生效，新 attemptId', () => {
  const store = makeStore()
  const t = store.createTask({ subject: 'x', dependencies: [], assignee: 'alice' }, T0).task
  store.claim(t.id, { assignee: 'alice', claimedById: 'child-a' }, T0 + 1)
  const before = store.tasks.get(t.id)
  const candidate = collectStaleCandidates({ store, now: T0 + 60002 })[0]
  const done = disposeStale({ store, now: T0 + 60003 }, candidate, {
    explicit: STALE_ACTIONS.REASSIGN,
    input: { to: 'carol' },
  })
  assert.equal(done.ok, true, '显式 reassign 是唯一非人工出口（input.to 为 P1 契约字段，task-store.js:530）')
  const after = store.tasks.get(t.id)
  assert.equal(after.status, 'claimed')
  assert.equal(after.assignee, 'carol')
  assert.notEqual(after.attemptId, before.attemptId)
})

test('stale：显式 supersede 经接线生效；候选不存在的任务拒绝', () => {
  const store = makeStore()
  const t1 = store.createTask({ subject: 'x', dependencies: [], assignee: 'alice' }, T0).task
  const t2 = store.createTask({ subject: 'y', dependencies: [], assignee: '' }, T0 + 1).task
  store.claim(t1.id, { assignee: 'alice', claimedById: 'child-a' }, T0 + 2)
  const candidate = collectStaleCandidates({ store, now: T0 + 60003 })[0]
  const done = disposeStale({ store, now: T0 + 60003 }, candidate, {
    explicit: STALE_ACTIONS.SUPERSEDE,
    input: { supersededBy: t2.id },
  })
  assert.equal(done.ok, true)
  assert.equal(store.tasks.get(t1.id).status, 'superseded')

  const ghost = disposeStale({ store, now: T0 }, { taskId: 't-ghost' })
  assert.equal(ghost.ok, false)
  assert.equal(ghost.reason, 'task-not-found')
})
