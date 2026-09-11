/**
 * 成员退役通道测试 —— test/p2-retire.test.mjs
 *
 * t96 · P2 Slice 2。覆盖：
 *   - planRetire：未知成员拒绝；有未终态任务且无 disposition → 拒绝并列出（§7 不自动处置）；
 *     带 disposition（supersede/reassign-to=）→ 计划成立且逐条处置成功；
 *   - applyRetire：markOffline + 移出 memberIds + 无孤儿终校验；孤儿残留 → 如实上报；
 *   - retireMember 组合：plan → dispose（受控边界，恰好一次）→ apply；
 *     双重退役 → unknown-member（已移出）。
 *
 * 判别（能变红）见 %TEMP%/dsh-t96-mutate/：mut-retire-nocheck（plan 跳过 open-task
 * 检查直接放行）→ 红；mut-retire-nodrain（retireMember 跳过 dispose/drain 接线）→ 红；
 * mut-retire-nooffline（apply 摘除失败仍报 ok）→ 红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TaskStore } from '../lib/state/task-store.js'
import { MemberRegistry, AVAILABILITY, STALE_ACTIONS } from '../lib/p2/scheduler-core.js'
import { planRetire, applyRetire, retireMember, makeDrainDispose, annotateChildren } from '../lib/p2/retire.js'
import { dispatchBatch } from '../lib/p2/scheduler.js'

const T0 = 1729000000000

function makeStore() {
  return new TaskStore({ claimLeaseMs: 60000, stallThresholdMs: 60000, suspendedUnattendedMs: 300000, maxSupersedeDepth: 16 })
}

function makeDeps(overrides = {}) {
  const store = overrides.store ?? makeStore()
  const registry = overrides.registry ?? new MemberRegistry({ now: () => T0 })
  const memberIds = overrides.memberIds ?? ['alice', 'bob']
  return { store, registry, memberIds, now: T0 }
}

function wakeDriver() {
  const calls = []
  return {
    calls,
    wake(memberName, task) { calls.push({ memberName, taskId: task?.id ?? null }); return Promise.resolve(true) },
  }
}

test('planRetire：未知成员 / 缺成员名拒绝', () => {
  const deps = makeDeps()
  const ghost = planRetire(deps, { memberId: 'ghost' })
  assert.equal(ghost.ok, false)
  assert.equal(ghost.reason, 'unknown-member')
  const none = planRetire(deps, {})
  assert.equal(none.ok, false)
  assert.equal(none.reason, 'member-required')
})

test('planRetire：有未终态任务且无 disposition → 拒绝并列出（不自动处置）', () => {
  const deps = makeDeps()
  const t = deps.store.createTask({ subject: 'x', dependencies: [], assignee: 'alice' }, T0).task
  deps.store.claim(t.id, { assignee: 'alice', claimedById: 'child-a' }, T0 + 1)
  const p = planRetire(deps, { memberId: 'alice' })
  assert.equal(p.ok, false)
  assert.equal(p.reason, 'member-has-open-tasks')
  assert.equal(p.openTasks[0].taskId, t.id)
  assert.equal(p.openTasks[0].status, 'claimed')
  // store 零改动
  assert.equal(deps.store.tasks.get(t.id).status, 'claimed')
})

test('planRetire：带显式 disposition（supersede）→ 计划成立；reassign(to=) 亦然', () => {
  const deps = makeDeps()
  const t1 = deps.store.createTask({ subject: 'x', dependencies: [], assignee: 'alice' }, T0).task
  const t2 = deps.store.createTask({ subject: 'grave', dependencies: [], assignee: '' }, T0 + 1).task
  deps.store.claim(t1.id, { assignee: 'alice', claimedById: 'child-a' }, T0 + 2)
  const p = planRetire(deps, {
    memberId: 'alice',
    disposition: { explicit: STALE_ACTIONS.SUPERSEDE, input: { supersededBy: t2.id } },
  })
  assert.equal(p.ok, true, JSON.stringify(p))
  assert.deepEqual(p.plan.openTaskDispositions, [{ taskId: t1.id, action: 'supersede', ok: true, reason: undefined }])
  assert.equal(deps.store.tasks.get(t1.id).status, 'superseded')

  // reassign 分支
  const deps2 = makeDeps()
  const t3 = deps2.store.createTask({ subject: 'y', dependencies: [], assignee: 'bob' }, T0).task
  deps2.store.claim(t3.id, { assignee: 'bob', claimedById: 'child-b' }, T0 + 1)
  const p2 = planRetire(deps2, { memberId: 'bob', disposition: { explicit: STALE_ACTIONS.REASSIGN, input: { to: 'carol' } } })
  assert.equal(p2.ok, true)
  assert.equal(deps2.store.tasks.get(t3.id).assignee, 'carol')
})

test('applyRetire：offline + 移出 memberIds + 无孤儿；孤儿残留如实上报', () => {
  const deps = makeDeps()
  deps.registry.markActive('alice', T0)
  const r = applyRetire(deps, 'alice', { disposeReceipt: { interrupted: true } })
  assert.equal(r.ok, true)
  assert.equal(deps.registry.availabilityOf('alice'), AVAILABILITY.OFFLINE, '调度面摘除：不再派活')
  assert.equal(deps.memberIds.includes('alice'), false, '选序不可见')
  assert.deepEqual(r.orphans, [])
  assert.deepEqual(r.receipt, { interrupted: true })

  // 孤儿场景：先造 in-flight + claimed 残留再摘
  const deps2 = makeDeps()
  const t = deps2.store.createTask({ subject: 'x', dependencies: [], assignee: 'bob' }, T0).task
  deps2.store.claim(t.id, { assignee: 'bob', claimedById: 'child-b' }, T0 + 1)
  deps2.registry.markInFlight('bob', t.id)
  const r2 = applyRetire(deps2, 'bob')
  assert.equal(r2.ok, false)
  assert.equal(r2.reason, 'orphan-detected')
  assert.deepEqual(r2.orphans.inFlight, [t.id])
  assert.equal(r2.orphans.residual[0].taskId, t.id)
})

test('retireMember 组合：plan → dispose（恰好一次）→ apply；重复退役 = 显式 no-op（验收 c）', async () => {
  const deps = makeDeps()
  deps.registry.markActive('alice', T0)
  const disposes = []
  const r = await retireMember({
    ...deps,
    dispose: async (memberId) => {
      disposes.push(memberId)
      return { disposed: memberId }
    },
  }, { memberId: 'alice' })
  assert.equal(r.ok, true)
  assert.deepEqual(disposes, ['alice'], 'dispose 边界恰好一次')
  assert.equal(deps.memberIds.includes('alice'), false)
  assert.equal(deps.registry.isRetired('alice'), true, '注销标记入册（reviewer4 规格）')
  assert.deepEqual(deps.registry.retiredMembers(), ['alice'])

  // 重复退役 = 显式 no-op：不再触发 dispose（drain 无意义），也不报错
  const again = await retireMember({
    ...deps,
    dispose: async (memberId) => { disposes.push(memberId); return {} },
  }, { memberId: 'alice' })
  assert.equal(again.ok, true)
  assert.equal(again.noop, 'already-retired')
  assert.deepEqual(disposes, ['alice'], 'no-op 不再触发 dispose')

  // 非本队/不存在成员 → 显式失败（不静默）
  const ghost = await retireMember({ ...deps, dispose: async () => ({}) }, { memberId: 'ghost' })
  assert.equal(ghost.ok, false)
  assert.equal(ghost.reason, 'unknown-member')
})

// ── t96 范围追加（reviewer4 规格 · 五条验收）─────────────────────────────

test('验收 a：retire 后 dispatchBatch 不再 pick 该成员（定向拒绝 + 池改选他人）', async () => {
  const store = makeStore()
  const registry = new MemberRegistry({ now: () => T0 })
  const memberIds = ['alice', 'bob']
  registry.markActive('alice', T0)
  registry.markActive('bob', T0)
  const disposes = []
  await retireMember({ store, registry, memberIds, now: T0, dispose: async (m) => { disposes.push(m); return {} } }, { memberId: 'alice' })
  assert.deepEqual(disposes, ['alice'])

  // 定向任务指向已退役成员 → 选序返回 null → skipped（不降级给他人）
  const directed = store.createTask({ subject: 'd', dependencies: [], assignee: 'alice' }, T0 + 1).task
  const r1 = await dispatchBatch({ store, registry, memberIds, wake: wakeDriver().wake, maxWakes: 1, now: T0 })
  assert.deepEqual(r1.woken, [], '已退役成员不被唤醒')
  assert.equal(r1.skipped[0].reason, 'no-eligible-member')
  assert.equal(store.tasks.get(directed.id).status, 'pending')

  // 池任务 → 只会在剩余成员中选
  store.createTask({ subject: 'p', dependencies: [], assignee: '' }, T0 + 2)
  const r2 = await dispatchBatch({ store, registry, memberIds, wake: wakeDriver().wake, maxWakes: 1, now: T0 })
  assert.deepEqual(r2.woken.map((w) => w.member), ['bob'])
})

test('验收 b：drain 接线——retire 触发 drainChildren(parent,[childId])；冷态记录标注 retired 而非伪装删除', async () => {
  const deps = makeDeps()
  deps.registry.markActive('alice', T0)
  const drainCalls = []
  const dispose = makeDrainDispose({
    parent: 'PARENT-AGENT',
    drainChildren: async (parent, childIds) => { drainCalls.push({ parent, childIds }) },
  })
  const r = await retireMember({ ...deps, dispose }, { memberId: 'alice' })
  assert.equal(r.ok, true)
  assert.deepEqual(drainCalls, [{ parent: 'PARENT-AGENT', childIds: ['alice'] }], '精确按 [childId] 释放（drainContinuableChildren 契约）')
  assert.deepEqual(r.receipt, { drained: 'alice' })

  // 发现面：listChildren 行（含冷态 durable 记录）→ annotateChildren 标注，不删除
  const rows = [
    { id: 'alice', label: 'dsh-team-chat:demo:alice', mode: 'continuable' },
    { id: 'bob', label: 'dsh-team-chat:demo:bob', mode: 'continuable' },
  ]
  const snapshot = structuredClone(rows)
  const marked = annotateChildren(rows, deps.registry)
  assert.equal(marked.find((x) => x.id === 'alice').retired, true, '已退役：明确标注')
  assert.equal(marked.find((x) => x.id === 'bob').retired, false)
  assert.deepEqual(rows, snapshot, '输入行不改写（冷态记录保留，不伪装已删除）')
})

test('验收 e：前缀隔离不回退——retire 对 agent-teams:* 名义显式失败且零副作用', () => {
  const deps = makeDeps()
  const before = deps.store.serialize()
  const p = planRetire(deps, { memberId: 'agent-teams:other-team:member' })
  assert.equal(p.ok, false, 'AgentTeams 名义成员不在本队 memberIds → 显式失败')
  assert.equal(p.reason, 'unknown-member')
  const after = deps.store.serialize()
  assert.deepEqual(after, before, 'store 零改动')
  assert.equal(deps.registry.isRetired('agent-teams:other-team:member'), false)
  assert.deepEqual(deps.registry.retiredMembers(), [], '注销集合零污染')
})

test('retireMember：无 dispose 边界拒绝（不静默跳过子会话处置）', async () => {
  const deps = makeDeps()
  const r = await retireMember(deps, { memberId: 'bob' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'dispose-boundary-required')
})
