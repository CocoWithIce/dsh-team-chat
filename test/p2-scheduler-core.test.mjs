/**
 * 调度核心地基测试 —— test/p2-scheduler-core.test.mjs
 *
 * 覆盖：
 *   - MemberRegistry：四态流转（online → breaker-open（连续失败阈值）→ 显式 reset；
 *     quota-exhausted；offline）；时间窗自动复位（配 resetMs 时）；失败计数只在
 *     online 累积；markActive 刷新 lastResponseAt。
 *   - pickMemberToWake（E9 单实例唤醒）：定向优先 assignee；池任务全候选；
 *     不可用态（breaker/quota/offline）排除；无在途优先 → 成功少优先 → 久未响应优先；
 *     同闲平局名字序可复现；无可唤醒 → null。
 *   - resolveStale：无 explicit → no-auto-requeue（无自动重排路径，重排风暴反制）；
 *     explicit=supersede/reassign 经 store；未知 action 拒绝；store 缺失拒绝。
 *
 * 判别（能变红）见 %TEMP%/dsh-t92-mutate/：
 *   mut-p2-breaker.js —— 把 recordFailure 的熔断打开逻辑删掉 → 熔断用例红；
 *   mut-p2-stale.js   —— 把 resolveStale 改成默认 supersede（自动重排）→ 反制用例红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TaskStore } from '../lib/state/task-store.js'
import {
  AVAILABILITY,
  MemberRegistry,
  pickMemberToWake,
  resolveStale,
  STALE_ACTIONS,
  WAKE_ELIGIBLE,
} from '../lib/p2/scheduler-core.js'

const T0 = 1729000000000
let clock = T0
function tick() { clock += 1 }

/** 可控时钟注册表。 */
function makeRegistry(options = {}) {
  return new MemberRegistry({ now: () => clock, ...options })
}

// ────────────────────────────── MemberRegistry ──────────────────────────────

test('registry：连续失败达到阈值 → per-instance 熔断（F7.3）', () => {
  const reg = makeRegistry({ breakerThreshold: 3 })
  reg.recordFailure('r1', 'err1'); tick()
  assert.equal(reg.availabilityOf('r1'), AVAILABILITY.ONLINE)
  reg.recordFailure('r1', 'err2'); tick()
  assert.equal(reg.availabilityOf('r1'), AVAILABILITY.ONLINE)
  const third = reg.recordFailure('r1', 'err3')
  assert.equal(third.breached, true)
  assert.equal(third.availability, AVAILABILITY.BREAKER_OPEN)
  assert.equal(reg.availabilityOf('r1'), AVAILABILITY.BREAKER_OPEN)
  assert.equal(reg.consecutiveFailuresOf('r1'), 3)
  // 已熔断后不再累加
  const more = reg.recordFailure('r1', 'err4')
  assert.equal(more.consecutiveFailures, 3)
  assert.equal(reg.availabilityOf('r1'), AVAILABILITY.BREAKER_OPEN)
})

test('registry：熔断显式 reset 恢复 online 并清零计数', () => {
  const reg = makeRegistry({ breakerThreshold: 2 })
  reg.recordFailure('r1', 'a'); tick()
  reg.recordFailure('r1', 'b')
  assert.equal(reg.availabilityOf('r1'), AVAILABILITY.BREAKER_OPEN)
  reg.resetBreaker('r1')
  assert.equal(reg.availabilityOf('r1'), AVAILABILITY.ONLINE)
  assert.equal(reg.consecutiveFailuresOf('r1'), 0)
})

test('registry：配置 resetMs 时熔断窗口自动复位；缺省 null = 不自动复位', () => {
  clock = T0
  const auto = makeRegistry({ breakerThreshold: 1, breakerResetMs: 100 })
  auto.recordFailure('r1', 'a', T0)
  assert.equal(auto.availabilityOf('r1'), AVAILABILITY.BREAKER_OPEN)
  auto.availabilityOf('r1') // 窗口未过：仍 open
  clock = T0 + 101
  assert.equal(auto.availabilityOf('r1'), AVAILABILITY.ONLINE, '窗口过后自动复位')

  clock = T0
  const manual = makeRegistry({ breakerThreshold: 1, breakerResetMs: null })
  manual.recordFailure('r2', 'a', T0)
  clock = T0 + 999999
  assert.equal(manual.availabilityOf('r2'), AVAILABILITY.BREAKER_OPEN, '缺省 null：不自动复位，须显式')
})

test('registry：quota-exhausted / offline / markActive 流转', () => {
  const reg = makeRegistry()
  reg.markQuotaExhausted('r1', '429 quota')
  assert.equal(reg.availabilityOf('r1'), AVAILABILITY.QUOTA_EXHAUSTED)
  assert.equal(WAKE_ELIGIBLE.includes(reg.availabilityOf('r1')), false)
  reg.markOffline('r1')
  assert.equal(reg.availabilityOf('r1'), AVAILABILITY.OFFLINE)
  reg.markActive('r1')
  assert.equal(reg.availabilityOf('r1'), AVAILABILITY.ONLINE)
  assert.equal(reg.lastResponseAtOf('r1'), clock)
  // 未注册成员 availabilityOf → online（视作宿主尚未观察；以事实覆盖）
  assert.equal(reg.availabilityOf('ghost'), AVAILABILITY.ONLINE)
})

test('registry：inFlight 集合记录/清理', () => {
  const reg = makeRegistry()
  reg.markInFlight('r1', 't1')
  assert.equal(reg.inFlightOf('r1').has('t1'), true)
  reg.clearInFlight('r1', 't1')
  assert.equal(reg.inFlightOf('r1').has('t1'), false)
})

// ────────────────────────────── 单实例唤醒（E9） ──────────────────────────────

function taskOf(id, assignee) {
  return { id, assignee }
}

test('pickMemberToWake：池任务选最闲（无在途 → 成功少 → 久未响应 → 名字序）', () => {
  const reg = makeRegistry()
  // r3 最近有响应（不最闲）、r2 有 1 次失败、r1 完全空闲
  reg.markActive('r1', T0 + 0)
  reg.markActive('r2', T0 + 0)
  reg.markActive('r3', T0 + 500)
  reg.recordFailure('r2', 'x', T0 + 1)
  const picked = pickMemberToWake(reg, taskOf('t-pool', ''), ['r1', 'r2', 'r3'])
  assert.equal(picked, 'r1', '全部无在途时：失败最少（0）→ 响应最早 → r1')
})

test('pickMemberToWake：在途实例排后（无在途优先）', () => {
  const reg = makeRegistry()
  reg.markActive('r1', T0 + 0)
  reg.markActive('r2', T0 + 0)
  reg.markInFlight('r1', 't1')
  const picked = pickMemberToWake(reg, taskOf('t-pool', ''), ['r1', 'r2'])
  assert.equal(picked, 'r2', 'r1 有在途 → 选无在途的 r2')
})

test('pickMemberToWake：连续失败少优先（同为无在途）', () => {
  const reg = makeRegistry()
  reg.markActive('r1', T0 + 0)
  reg.markActive('r2', T0 + 0)
  reg.recordFailure('r1', 'e', T0 + 1)
  const picked = pickMemberToWake(reg, taskOf('t-pool', ''), ['r1', 'r2'])
  assert.equal(picked, 'r2', 'r2 失败更少')
})

test('pickMemberToWake：定向任务只在该 assignee 名下选', () => {
  const reg = makeRegistry()
  reg.markActive('engineer2-i1', T0 + 0)
  reg.markActive('engineer2-i2', T0 + 0)
  reg.markActive('researcher2', T0 + 0)
  const picked = pickMemberToWake(reg, taskOf('t-x', 'engineer2-i2'), ['engineer2-i1', 'engineer2-i2', 'researcher2'])
  assert.equal(picked, 'engineer2-i2', '定向 assignee 匹配')
})

test('pickMemberToWake：不可用态（熔断/配额/离线）一律排除', () => {
  const reg = makeRegistry({ breakerThreshold: 1 })
  reg.markActive('r1', T0)
  reg.markActive('r2', T0)
  reg.markActive('r3', T0)
  reg.recordFailure('r1', 'e', T0 + 1) // breaker-open
  reg.markQuotaExhausted('r2')
  reg.markOffline('r3')
  const picked = pickMemberToWake(reg, taskOf('t-pool', ''), ['r1', 'r2', 'r3'])
  assert.equal(picked, null, '全部不可用 → 不唤醒任何实例（单实例纪律）')
})

test('pickMemberToWake：全在线但目标不可用 → null（定向拒绝降级）', () => {
  const reg = makeRegistry({ breakerThreshold: 1 })
  reg.markActive('engineer2-i2', T0 + 0)
  reg.recordFailure('engineer2-i2', 'e', T0 + 1)
  const picked = pickMemberToWake(reg, taskOf('t-x', 'engineer2-i2'), ['engineer2-i2', 'researcher2'])
  assert.equal(picked, null, '定向目标熔断 → 不唤醒他人（避免误派）')
})

test('pickMemberToWake：平局名字字典序（可复现）', () => {
  const reg = makeRegistry()
  reg.markActive('aa', T0)
  reg.markActive('bb', T0)
  const picked = pickMemberToWake(reg, taskOf('t-pool', ''), ['bb', 'aa'])
  assert.equal(picked, 'aa', '完全同闲 → 名字序')
})

// ────────────────────────────── stale 取代（反重排风暴） ──────────────────────────────

test('resolveStale：无 explicit → no-auto-requeue（无自动重排路径）', () => {
  const store = new TaskStore({ claimLeaseMs: 60000, stallThresholdMs: 60000, suspendedUnattendedMs: 300000, maxSupersedeDepth: 16 })
  const t = store.createTask({ subject: 'x', dependencies: [], assignee: 'r1' }, T0).task
  const res = resolveStale(store.tasks.get(t.id), {})
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'no-auto-requeue', '非 terminal 任务不得自动处置')
  const none = resolveStale(store.tasks.get(t.id), { explicit: 'none' })
  assert.equal(none.ok, false)
  assert.equal(none.reason, 'no-auto-requeue')
})

test('resolveStale：显式 supersede 经 store 迁移；终态后不可再处置', () => {
  const store = new TaskStore({ claimLeaseMs: 60000, stallThresholdMs: 60000, suspendedUnattendedMs: 300000, maxSupersedeDepth: 16 })
  const t1 = store.createTask({ subject: 'x', dependencies: [], assignee: 'r1' }, T0).task
  const t2 = store.createTask({ subject: 'y', dependencies: [], assignee: 'r2' }, T0 + 1).task
  const sup = resolveStale(store.tasks.get(t1.id), {
    explicit: STALE_ACTIONS.SUPERSEDE,
    store,
    input: { supersededBy: t2.id },
    now: T0 + 2,
  })
  assert.equal(sup.ok, true)
  assert.equal(store.tasks.get(t1.id).status, 'superseded')
  // 终态不可再处置（store 本身的状态机拒绝）
  const again = resolveStale(store.tasks.get(t1.id), { explicit: STALE_ACTIONS.SUPERSEDE, store, input: { supersededBy: t2.id }, now: T0 + 3 })
  assert.equal(again.ok, false)
})

test('resolveStale：显式 reassign 经 store 迁移（新 attemptId）', () => {
  const store = new TaskStore({ claimLeaseMs: 60000, stallThresholdMs: 60000, suspendedUnattendedMs: 300000, maxSupersedeDepth: 16 })
  const t = store.createTask({ subject: 'x', dependencies: [], assignee: 'r1' }, T0).task
  store.claim(t.id, { assignee: 'r1', claimedById: 'c1' }, T0 + 1)
  const before = store.tasks.get(t.id).attemptId
  const rr = resolveStale(store.tasks.get(t.id), {
    explicit: STALE_ACTIONS.REASSIGN,
    store,
    input: { to: 'r2' },
    now: T0 + 2,
  })
  assert.equal(rr.ok, true)
  assert.equal(store.tasks.get(t.id).status, 'claimed')
  assert.equal(store.tasks.get(t.id).assignee, 'r2')
  assert.notEqual(store.tasks.get(t.id).attemptId, before, '转派生成新 attemptId（§4.3）')
})

test('resolveStale：unknown action / store 缺失拒绝', () => {
  const store = new TaskStore({ claimLeaseMs: 60000, stallThresholdMs: 60000, suspendedUnattendedMs: 300000, maxSupersedeDepth: 16 })
  const t = store.createTask({ subject: 'x', dependencies: [], assignee: 'r1' }, T0).task
  const unknown = resolveStale(store.tasks.get(t.id), { explicit: 'delete-everything' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.reason, 'unknown-action')
  const noStore = resolveStale(store.tasks.get(t.id), { explicit: STALE_ACTIONS.SUPERSEDE })
  assert.equal(noStore.ok, false)
  assert.equal(noStore.reason, 'store-required')
})