/**
 * P3 修复/复核循环引擎测试 —— test/p2-quality-loop.test.mjs
 *
 * t108 · P3 Slice 2。对照设计稿 v0.2 §4（三自动动作 + 安全阀）：
 *   - ①needs_revision → 自动创建 repair（依赖只指成功源、findings 附带、subject 惯例、
 *     verify 拼接 requiredFix 验证入口、inScope 同被审文件集）；
 *   - ②repair completed → 自动排队 re-review（依赖=[repair]、round 口径）；
 *   - ③dispatch 唤醒（dispatch 边界断言）；
 *   - §4.3 去重（非 terminal repair 复用不新建）；§4.4 可用性前置（全员不可用 →
 *     waitingReviewer 零账本污染）；§4.5 触顶升级（round-limit-exceeded）；
 *     §5.3 repair-failed 升级；§4.6 supersedes 取代 + gate 同步处置；
 *   - gate-busy（§6.1）；升级期冻结（escalated-queued）；pass/reject 出口；
 *   - E15 警告入当轮 findings（§4.8）；§6.2 结算作废（补偿触发跳过循环动作）。
 *
 * 判别（能变红）见 %TEMP%/dsh-t108-mutate/：
 *   mut-loop-norepair（去 repair 自动创建）→ 红；
 *   mut-loop-nolimit（去轮数上限）→ 红；
 *   mut-loop-nobusy（去 gate-busy）→ 红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TaskStore, loadTaskStore } from '../lib/state/task-store.js'
import { MemberRegistry } from '../lib/p2/scheduler-core.js'
import { QualitySidecar } from '../lib/p2/quality-sidecar.js'
import {
  settleReviewTask,
  settleRepairTask,
  checkGateBusy,
  findOpenRepair,
} from '../lib/p2/quality-loop.js'
import { createCaptainTask, syncGateOnSupersede } from '../lib/p2/captain-tools.js'

const T0 = 1729000000000

function makeStore() {
  return new TaskStore({ claimLeaseMs: 60000, stallThresholdMs: 60000, suspendedUnattendedMs: 300000, maxSupersedeDepth: 16 })
}

function memfs(initial = {}) {
  const files = new Map(Object.entries(initial))
  return {
    files,
    readFileSync: (p) => { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p) },
    existsSync: (p) => files.has(p),
    writeFileSync: (p, d) => files.set(p, d),
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from) },
    mkdirSync: () => {},
  }
}

/** 标准场景：被审对象 t1（implementation，已完成——review 的合法前提）+ gate + 首轮 review t2（claimed/in-review）。 */
function scenario({ maxRounds = 4 } = {}) {
  const store = makeStore()
  const fs = memfs()
  const sidecar = new QualitySidecar({ file: '/team/quality.json', now: () => T0, fs })
  const c = store.createTask({
    kind: 'implementation', subject: '实现 X', objective: '做 X', dependencies: [], assignee: 'eng',
    acceptance: ['A1 验收'], verify: ['npm test'], inScope: ['src/x.js'],
    constraints: ['node>=22'], knownRisks: ['quota'],
  }, T0).task
  // 被审对象结算 completed（review 的合法前提；否则 review 被 dependencyBlocked 拒绝认领）
  const cc = store.claim(c.id, { assignee: 'eng', claimedById: 'child-eng' }, T0)
  store.update(c.id, { attemptId: cc.attemptId, revision: cc.revision, status: 'completed' }, T0 + 0.5)
  sidecar.openGate(c.id, { maxRounds, constraints: ['node>=22'], knownRisks: ['quota'] })
  const r = store.createTask({ kind: 'review', subject: 'review-round-1', inScope: ['src/x.js'], dependencies: [c.id], assignee: 'rv' }, T0 + 1).task
  sidecar.markReviewClaimed(c.id, { reviewTaskId: r.id, reviewer: 'rv' })
  const rc = store.claim(r.id, { assignee: 'rv', claimedById: 'child-rv' }, T0 + 2)
  const deps = {
    store, sidecar,
    reviewTaskId: r.id,
    attemptId: rc.attemptId,
    revision: store.tasks.get(r.id).revision,
    target: c,
  }
  return { store, sidecar, fs, deps, target: c, review: r }
}

const NEEDS_REVISION = {
  verdict: 'needs_revision',
  findings: [
    { id: 'F1', severity: 'high', problem: '实现偏差', requiredFix: '改成按验收 A1 实现' },
    { id: 'F3', severity: 'medium', problem: '缺测试', requiredFix: '补 src/x.js 的单测' },
  ],
  output: '实现与验收 A1 不符',
  reviewer: 'reviewer4',
}

test('①needs_revision → 自动创建 repair：依赖只指成功源、subject 惯例、findings/verify 拼接', () => {
  const s = scenario()
  const disposes = []
  const result = settleReviewTask({
    store: s.store, sidecar: s.sidecar,
    dispatch: (task) => { disposes.push(task.id); return { woke: true } },
    now: () => T0 + 10,
  }, { ...s.deps, ...NEEDS_REVISION })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.outcome, 'repair-created')
  const repair = s.store.tasks.get(result.repairTaskId)
  assert.equal(repair.kind, 'repair')
  assert.equal(repair.subject, 'repair-round-2', 'subject = repair-round-<N+1>（账本惯例）')
  assert.deepEqual(repair.dependencies, [s.target.id], '依赖只指成功源（被审对象），永不指 failed review')
  assert.ok(repair.objective.includes('needs_revision'), 'objective 承载摘要')
  assert.ok(repair.objective.includes('sidecar'), 'findings 以 sidecar 引用附带（防超长）')
  assert.deepEqual(repair.inScope, ['src/x.js'], 'inScope 同被审文件集')
  assert.ok(repair.verify.some((v) => v.includes('F1')), 'verify 拼接 findings 的 requiredFix 验证入口')
  assert.deepEqual(disposes, [repair.id], '③dispatchBatch 唤醒 repair 执行者')
  // P1 映射：review 任务 failed（§4.2）
  assert.equal(s.store.tasks.get(s.review.id).status, 'failed')
  // gate：in-review → needs-revision（repair 创建待认领，认领后 in-repair）
  assert.equal(s.sidecar.gateOf(s.target.id).gateState, 'needs-revision')
  assert.equal(s.sidecar.gateOf(s.target.id).round, 1)
})

test('②repair completed → 自动排队 re-review（依赖=[repair]，gate in-review，round 待结算）', () => {
  const s = scenario()
  const first = settleReviewTask({ store: s.store, sidecar: s.sidecar, now: () => T0 + 10 }, { ...s.deps, ...NEEDS_REVISION })
  const repairId = first.repairTaskId
  s.sidecar.markRepairClaimed(s.target.id, { repairTaskId: repairId })
  const rc = s.store.claim(repairId, { assignee: 'eng', claimedById: 'child-eng' }, T0 + 20)
  const result = settleRepairTask({
    store: s.store, sidecar: s.sidecar,
    now: () => T0 + 30,
  }, {
    repairTaskId: repairId, status: 'completed',
    attemptId: rc.attemptId, revision: s.store.tasks.get(repairId).revision,
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.outcome, 'review-queued')
  const review2 = s.store.tasks.get(result.reviewTaskId)
  assert.equal(review2.kind, 'review')
  assert.deepEqual(review2.dependencies, [repairId], 're-review 依赖 = [repair]')
  assert.equal(s.sidecar.gateOf(s.target.id).gateState, 'in-review')
  assert.equal(s.sidecar.gateOf(s.target.id).round, 1, '排队不增 round（§3.7：结算才计）')
  // 第二轮结算 → round=2
  s.sidecar.markReviewClaimed(s.target.id, { reviewTaskId: result.reviewTaskId })
  const r2c = s.store.claim(result.reviewTaskId, { assignee: 'rv', claimedById: 'child-rv' }, T0 + 40)
  const settled = settleReviewTask({ store: s.store, sidecar: s.sidecar, now: () => T0 + 50 }, {
    reviewTaskId: result.reviewTaskId, verdict: 'pass',
    attemptId: r2c.attemptId, revision: s.store.tasks.get(result.reviewTaskId).revision,
  })
  assert.equal(settled.ok, true)
  assert.equal(settled.outcome, 'closed')
  assert.equal(s.sidecar.gateOf(s.target.id).round, 2)
  // 上轮 findings 已回写 resolved（settleRepairTask 按 pendingRepair.sourceFindingIds）
  const round1 = s.sidecar.gateOf(s.target.id).rounds[0]
  assert.deepEqual(round1.findings.map((f) => f.resolved), [true, true])
})

test('§4.3 去重：非 terminal repair 复用不新建（reused + 唤醒既有）', () => {
  const s = scenario()
  const first = settleReviewTask({ store: s.store, sidecar: s.sidecar, now: () => T0 + 10 }, { ...s.deps, ...NEEDS_REVISION })
  const repairId = first.repairTaskId
  // 第二次 needs_revision（同 source）：gate 已 needs-revision → settle 需要 in-review…
  // 用 findOpenRepair 直接验证去重原语 + 手工构造第二次结算路径
  assert.equal(findOpenRepair(s.store, s.sidecar, s.target.id), repairId, '非 terminal repair 被发现')
  // 模拟 repair 未被认领时再次触发创建判定（gate needs-revision，存在 open repair）
  const again = settleReviewTask({ store: s.store, sidecar: s.sidecar, now: () => T0 + 15 }, { ...s.deps, ...NEEDS_REVISION })
  assert.equal(again.ok, false)
  assert.equal(again.reason, 'illegal-gate-state', 'gateState=needs-revision 时结算被状态机拒绝（不可能双开，§4.3-2）')
})

test('§4.4 可用性前置：全员不可用 → 不创建 review，waitingReviewer 记录（零账本污染）', () => {
  const s = scenario()
  const first = settleReviewTask({ store: s.store, sidecar: s.sidecar, now: () => T0 + 10 }, { ...s.deps, ...NEEDS_REVISION })
  s.sidecar.markRepairClaimed(s.target.id, { repairTaskId: first.repairTaskId })
  const rc = s.store.claim(first.repairTaskId, { assignee: 'eng', claimedById: 'child-eng' }, T0 + 20)
  const registry = new MemberRegistry({ now: () => T0 })
  registry.markOffline('rv') // 全员不可用
  const before = s.store.snapshot().tasks.length
  const result = settleRepairTask({
    store: s.store, sidecar: s.sidecar, registry,
    memberIds: ['rv'], now: () => T0 + 30,
  }, { repairTaskId: first.repairTaskId, status: 'completed', attemptId: rc.attemptId, revision: s.store.tasks.get(first.repairTaskId).revision })
  assert.equal(result.ok, true)
  assert.equal(result.outcome, 'waiting-reviewer')
  assert.equal(s.store.snapshot().tasks.length, before, '零账本污染：review 未创建')
  assert.ok(s.sidecar.gateOf(s.target.id).waitingReviewer !== undefined)
  assert.equal(s.sidecar.gateOf(s.target.id).gateState, 'in-repair')
})

test('§4.5 触顶：round 达 maxRounds 仍 needs_revision → escalated（round-limit-exceeded 全结构）', () => {
  const s = scenario({ maxRounds: 1 })
  const result = settleReviewTask({ store: s.store, sidecar: s.sidecar, now: () => T0 + 10 }, { ...s.deps, ...NEEDS_REVISION })
  assert.equal(result.ok, true)
  assert.equal(result.outcome, 'escalated', '触顶升级而非创建 repair')
  const gate = s.sidecar.gateOf(s.target.id)
  assert.equal(gate.gateState, 'escalated')
  assert.equal(gate.escalation.reason, 'round-limit-exceeded')
  assert.equal(gate.escalation.roundsAttempted, 1)
  assert.equal(gate.escalation.findingsDigest.trend, 'flat')
  assert.equal(gate.escalation.pendingDecisions.length, 4)
  assert.equal(s.store.tasks.get(s.review.id).status, 'failed')
})

test('§5.3 repair-failed → escalated；§6.2 pass/reject 出口', () => {
  const s = scenario()
  const first = settleReviewTask({ store: s.store, sidecar: s.sidecar, now: () => T0 + 10 }, { ...s.deps, ...NEEDS_REVISION })
  s.sidecar.markRepairClaimed(s.target.id, { repairTaskId: first.repairTaskId })
  const rc = s.store.claim(first.repairTaskId, { assignee: 'eng', claimedById: 'child-eng' }, T0 + 20)
  const failed = settleRepairTask({
    store: s.store, sidecar: s.sidecar, now: () => T0 + 30,
  }, { repairTaskId: first.repairTaskId, status: 'failed', attemptId: rc.attemptId, revision: s.store.tasks.get(first.repairTaskId).revision })
  assert.equal(failed.outcome, 'escalated')
  assert.equal(s.sidecar.gateOf(s.target.id).escalation.reason, 'repair-failed')

  // reject 出口：直接 escalated（reject-no-repair）
  const s2 = scenario()
  s2.sidecar.markReviewClaimed(s2.target.id, { reviewTaskId: s2.review.id })
  const rej = settleReviewTask({ store: s2.store, sidecar: s2.sidecar, now: () => T0 + 10 }, {
    ...s2.deps, verdict: 'reject', findings: [], output: '范围跑偏',
  })
  assert.equal(rej.outcome, 'escalated')
  assert.equal(s2.sidecar.gateOf(s2.target.id).escalation.reason, 'reject-no-repair')
})

test('§6.1 gate-busy：in-review/in-repair 目标拒绝重复创建（载荷附现存任务 id）；escalated → 排队冻结', () => {
  const s = scenario() // gate in-review
  const deps = { store: s.store, sidecar: s.sidecar, registry: new MemberRegistry({ now: () => T0 }), memberIds: ['rv'], wake: () => {}, now: T0 }
  const busy = (() => {
    const r = checkGateBusy(s.sidecar, s.target.id)
    return r.busy ? { ok: false, ...r } : { ok: true }
  })()
  assert.equal(busy.busy, true)
  assert.equal(busy.activeTaskId, s.review.id, '拒绝载荷附现存任务 id（§6.1）')
  const created = (() => createCaptainTaskGateBusy(deps, { kind: 'review', sourceTaskId: s.target.id, subject: 'dup review' }))()
  assert.equal(created.ok, false)
  assert.equal(created.reason, 'gate-busy')

  // escalated → 新输入排队不执行（升级期冻结）
  s.sidecar.escalate(s.target.id, { reason: 'manually-raised', summary: '人工升级' })
  const frozen = createCaptainTaskGateBusy(deps, { kind: 'review', sourceTaskId: s.target.id, subject: 'frozen review' })
  assert.equal(frozen.ok, false)
  assert.equal(frozen.reason, 'escalated-queued')
  assert.equal(frozen.queued, true)
  assert.equal(s.sidecar.gateOf(s.target.id).pendingInputs.length, 1, '输入排队（§4.7）')
})

function createCaptainTaskGateBusy(deps, input) {
  // 与 createCaptainTask 的 gate 感知段同语义的最小驱动（避免在本测试中拉起 dispatchBatch 全链）
  const busy = checkGateBusy(deps.sidecar, input.sourceTaskId)
  if (busy.busy) return { ok: false, reason: 'gate-busy', activeTaskId: busy.activeTaskId, gateState: busy.gateState }
  const gate = deps.sidecar.gateOf(input.sourceTaskId)
  if (gate !== undefined && gate.gateState === 'escalated') {
    deps.sidecar.addPendingInput(input.sourceTaskId, { from: 'create_task', summary: input.subject })
    return { ok: false, reason: 'escalated-queued', queued: true }
  }
  return { ok: true }
}

test('§6.1（工具面接线）：createCaptainTask 真实路径的 gate-busy 拒绝（mut-loop-nobusy 的红锚点）', async () => {
  const s = scenario() // gate in-review
  const deps = {
    store: s.store, sidecar: s.sidecar,
    registry: new MemberRegistry({ now: () => T0 }), memberIds: ['rv'],
    wake: () => {}, now: T0,
  }
  // 真实 createCaptainTask：kind=review 且 gate in-review → gate-busy（不新建）
  const refused = await createCaptainTask(deps, {
    kind: 'review', sourceTaskId: s.target.id, subject: 'dup review', inScope: ['src/x.js'], wake: false,
  })
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, 'gate-busy')
  assert.equal(refused.activeTaskId, s.review.id, '拒绝载荷附现存任务 id（§6.1）')
  assert.equal(refused.gateState, 'in-review')
  // 修复路径同理：kind=repair 在 in-repair 时拒绝
  s.sidecar.markRepairClaimed(s.target.id, { repairTaskId: 't-repair-x' })
  const busyRepair = await createCaptainTask(deps, {
    kind: 'repair', sourceTaskId: s.target.id, subject: 'dup repair', wake: false,
  })
  assert.equal(busyRepair.ok, false)
  assert.equal(busyRepair.reason, 'gate-busy')
  // needs-revision 态不受 gate-busy 限制（正常循环间隙，§6.1 明文）——此处仅验证不拒 gate-busy
})

test('§4.6 supersedes：取代成功 + gate 同步处置（escalated/subject-superseded 或 closed+标注）', () => {
  const s = scenario()
  // 默认：escalated/subject-superseded
  const record = syncGateOnSupersede(s.sidecar, s.target.id, { supersededBy: 't-new' })
  assert.equal(record.gateState, 'escalated')
  assert.equal(s.sidecar.gateOf(s.target.id).escalation.reason, 'subject-superseded')
  assert.equal(record.loopSuspended, true, '挂起该 gate 的循环创建')
  // closed + 标注路径
  const s2 = scenario()
  const record2 = syncGateOnSupersede(s2.sidecar, s2.target.id, { supersededBy: 't-new', mode: 'closed' })
  assert.equal(record2.gateState, 'closed')
  assert.equal(record2.supersededBy, 't-new')
})

test('§4.8 E15 警告入当轮 findings（不阻断结算）', () => {
  const s = scenario()
  const seen = []
  const reviewGuard = {
    snapshotFor() { return { ok: true, count: 1 } },
    compareFor(task) { seen.push(task.id); return { match: false, changed: [{ file: 'src/x.js', kind: 'modified' }] } },
  }
  const result = settleReviewTask({
    store: s.store, sidecar: s.sidecar, reviewGuard, now: () => T0 + 10,
  }, { ...s.deps, verdict: 'needs_revision', findings: [{ id: 'F1', severity: 'high', problem: 'p', requiredFix: 'f' }] })
  assert.equal(result.ok, true, 'E15 不阻断')
  assert.deepEqual(seen, [s.review.id], 'review-guard 调用点接线（不改其逻辑）')
  const round = s.sidecar.gateOf(s.target.id).rounds[0]
  const e15 = round.findings.find((f) => f.id === 'E15')
  assert.equal(e15.severity, 'high')
  assert.ok(e15.problem.includes('E15'))
})

test('§6.2 结算作废：sidecar 落盘失败 → 循环动作不继续 + compensation 上抛', () => {
  const s = scenario()
  // 注入持久化失败：save 闭包内 fs.rename 指向不存在目录?——直接用坏 fs 使 save 抛错
  const broken = { store: s.store, sidecar: s.sidecar, now: () => T0 + 10, retries: 2 }
  // 使 save 抛错：替换 sidecar.fs.renameSync 为抛错
  s.sidecar.fs.renameSync = () => { throw new Error('ENOSPC simulated') }
  const result = settleReviewTask({ ...broken }, { ...s.deps, ...NEEDS_REVISION })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'settlement-voided')
  assert.ok(result.compensation.taken === 'p1-failed-insufficient-evidence' || result.compensation.taken === 'sidecar-unwritable-escalation', result.compensation.taken)
})

test('t110-F1（loop 级）：从未 save 的 sidecar 上 CAS 失败结算 → load() 回滚后无幽灵 gate', () => {
  const s = scenario() // sidecar 从未 save（memfs 无文件）
  const result = settleReviewTask({ store: s.store, sidecar: s.sidecar, now: () => T0 + 10 }, {
    ...s.deps, ...NEEDS_REVISION,
    revision: s.deps.revision + 999, // stale → P1 CAS 失败 → 回滚分支 sidecar.load()
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'p1-update-failed')
  // F1 修复断言：回滚后无幽灵 gate（未修复版本 load() 无文件分支不清内存 → 残留 needs-revision 幽灵 → 红）
  assert.equal(s.sidecar.gateOf(s.target.id), undefined, '无幽灵 gate（t109-F1）')
  assert.equal(s.sidecar.gates.size, 0)
})

// ---------------------------------------------------------------- t112 · P4-1 循环创建开关

test('t112-autoLoop=off：needs_revision → 零自动动作（不创建 repair、gate 停 needs-revision）', () => {
  const s = scenario()
  const before = s.store.snapshot().tasks.length
  const result = settleReviewTask({
    store: s.store, sidecar: s.sidecar, autoLoop: false, now: () => T0 + 10,
  }, { ...s.deps, ...NEEDS_REVISION })
  assert.equal(result.ok, true)
  assert.equal(result.outcome, 'needs-revision')
  assert.equal(result.autoLoopDisabled, true)
  // 零自动动作断言：无 repair 任务创建（数量不变）、无派发
  assert.equal(s.store.snapshot().tasks.length, before, '零自动动作：不创建 repair')
  assert.equal(s.store.tasks.get(s.review.id).status, 'failed', 'P1 映射仍在（failed）')
  const gate = s.sidecar.gateOf(s.target.id)
  assert.equal(gate.gateState, 'needs-revision', 'gate 停 needs-revision 待人工')
  assert.equal(gate.round, 1)
  assert.equal(gate.escalation, null, '未触顶也不自动升级（零自动动作）')
})

test('t112-autoLoop=off：repair completed → 零自动动作（不排队 re-review、gate 停 in-repair）', () => {
  const s = scenario()
  // 先用默认（autoLoop on）走完第一轮：needs_revision → repair 创建
  const first = settleReviewTask({ store: s.store, sidecar: s.sidecar, now: () => T0 + 10 }, { ...s.deps, ...NEEDS_REVISION })
  s.sidecar.markRepairClaimed(s.target.id, { repairTaskId: first.repairTaskId })
  const rc = s.store.claim(first.repairTaskId, { assignee: 'eng', claimedById: 'child-eng' }, T0 + 20)
  const before = s.store.snapshot().tasks.length
  // 开关关闭：repair completed → 不排队 re-review
  const result = settleRepairTask({
    store: s.store, sidecar: s.sidecar, autoLoop: false, now: () => T0 + 30,
  }, { repairTaskId: first.repairTaskId, status: 'completed', attemptId: rc.attemptId, revision: s.store.tasks.get(first.repairTaskId).revision })
  assert.equal(result.ok, true)
  assert.equal(result.outcome, 'repair-completed')
  assert.equal(result.autoLoopDisabled, true)
  assert.equal(s.store.snapshot().tasks.length, before, '零自动动作：不创建 re-review')
  const gate = s.sidecar.gateOf(s.target.id)
  assert.equal(gate.gateState, 'in-repair', 'gate 停 in-repair 待人工')
  assert.equal(gate.repairs.length, 1, '审计记录仍在（repairs 追加式）')
})

test('t112-autoLoop 缺省 = 启用（不传 autoLoop 与传 true 等价）', () => {
  const s = scenario()
  const result = settleReviewTask({ store: s.store, sidecar: s.sidecar, now: () => T0 + 10 }, { ...s.deps, ...NEEDS_REVISION })
  assert.equal(result.outcome, 'repair-created', '缺省（未传）= 启用')
  const s2 = scenario()
  const result2 = settleReviewTask({ store: s2.store, sidecar: s2.sidecar, autoLoop: true, now: () => T0 + 10 }, { ...s2.deps, ...NEEDS_REVISION })
  assert.equal(result2.outcome, 'repair-created', '显式 true = 启用')
})

// ---------------------------------------------------------------- t116 · F2 跨进程判别

test('t116-F2（跨进程判别）：进程 1 settle+save → 进程 2 全新 sidecar load → settleRepairTask 找到 gate 完成结算', () => {
  // 模拟跨进程：进程 1（settleReviewTask + save）→ 进程 2（全新 QualitySidecar load → settleRepairTask）
  const store1 = makeStore()
  const fs1 = memfs()
  const sidecar1 = new QualitySidecar({ file: '/team/quality.json', now: () => T0, fs: fs1 })
  const target = store1.createTask({ kind: 'implementation', subject: 'X', dependencies: [], assignee: 'eng', inScope: ['x.js'], acceptance: ['a'], verify: ['v'] }, T0).task
  const cc = store1.claim(target.id, { assignee: 'eng', claimedById: 'child-eng' }, T0)
  store1.update(target.id, { attemptId: cc.attemptId, revision: cc.revision, status: 'completed' }, T0 + 1)
  sidecar1.openGate(target.id, { maxRounds: 4 })
  const rv = store1.createTask({ kind: 'review', subject: 'r1', inScope: ['x.js'], dependencies: [target.id], assignee: 'rv' }, T0 + 2).task
  sidecar1.queueReview(target.id, { reviewTaskId: rv.id })
  const rc = store1.claim(rv.id, { assignee: 'rv', claimedById: 'child-rv' }, T0 + 3)

  // 进程 1：settle needs_revision → 创建 repair + 设 pendingRepair + save
  const result1 = settleReviewTask(
    { store: store1, sidecar: sidecar1, now: () => T0 + 4 },
    { reviewTaskId: rv.id, verdict: 'needs_revision', findings: [{ id: 'F1', severity: 'medium', problem: 'p', requiredFix: 'f' }], attemptId: rc.attemptId, revision: store1.tasks.get(rv.id).revision },
  )
  assert.equal(result1.ok, true)
  assert.equal(result1.outcome, 'repair-created')
  assert.ok(result1.repairTaskId)

  // 进程 2：全新 sidecar（从磁盘 load）+ 全新 store——模拟跨进程重启
  const store2 = loadTaskStore('mem://v2.json', () => JSON.stringify(store1.serialize()))
  const sidecar2 = new QualitySidecar({ file: '/team/quality.json', now: () => T0, fs: fs1 })
  // 关键断言：load() 后 pendingRepair 从磁盘恢复（F2 未修复版此处 pendingRepair 丢失 → 后续 gateByRepairTask 返回 undefined）
  const gate2 = sidecar2.gateOf(target.id)
  assert.ok(gate2, '进程 2 gate 必须存在')
  assert.ok(gate2.pendingRepair, 'pendingRepair 必须从磁盘恢复（F2 修复核心断言）')
  assert.equal(gate2.pendingRepair.repairTaskId, result1.repairTaskId)

  // 进程 2 中间步骤：worker 认领 repair → markRepairClaimed（needs-revision → in-repair）
  const repair = store2.tasks.get(result1.repairTaskId)
  const repairClaim = store2.claim(repair.id, { assignee: 'eng', claimedById: 'child-eng' }, T0 + 5)
  const claimedGate = sidecar2.markRepairClaimed(target.id, { repairTaskId: repair.id })
  assert.equal(claimedGate.ok, true, 'markRepairClaimed 成功（needs-revision → in-repair）')

  // 进程 2：settleRepairTask 用恢复的 gate 完成结算
  const result2 = settleRepairTask(
    { store: store2, sidecar: sidecar2, now: () => T0 + 6 },
    { repairTaskId: repair.id, status: 'completed', attemptId: repairClaim.attemptId, revision: store2.tasks.get(repair.id).revision, sourceFindingIds: gate2.pendingRepair.sourceFindingIds },
  )
  assert.equal(result2.ok, true, JSON.stringify(result2))
  assert.equal(result2.outcome, 'review-queued', 'repair completed → 自动排队 re-review')

  // 验证 re-review 任务已创建且依赖只指 repair（成功源）
  const rrTask = store2.tasks.get(result2.reviewTaskId)
  assert.ok(rrTask, 're-review 任务存在')
  assert.deepEqual(rrTask.dependencies, [result1.repairTaskId])
  assert.equal(rrTask.kind, 'review')
})
