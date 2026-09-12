/**
 * P3 质量门 sidecar 测试 —— test/p2-quality-sidecar.test.mjs
 *
 * t106 · P3 Slice 1。覆盖（对照 P3 设计稿 §3.8/§3.9/§5/§6.2）：
 *   - gate 生命周期：openGate → markReviewClaimed → settleRound(pass/needs_revision/reject)
 *     → closed/needs-revision/escalated；非法转移拒绝；
 *   - 一致性校验：pass 带 findings / pass 带 failed 证据 / needs_revision 无 findings /
 *     finding 缺 requiredFix（非 low）全部显式拒绝；
 *   - 修复轮：needs-revision → markRepairClaimed → in-repair → recordRepair →
 *     resolveFindings 回写 → 第二轮 settleRound（round=2）；
 *   - escalation：8 设计 reason + sidecar-unwritable 变体；digestRounds 聚合与趋势；
 *     缺关键字段显式拒绝（验收判别点）；pendingDecisions 缺省 A-D；
 *   - 持久化：tmp+rename 原子写（直接写最终路径 → 红）；损坏文件显式失败不静默清零；
 *   - §6.2 补偿契约：重试 N=3 → P1 update(failed)+insufficient-evidence；
 *     update 不可行 → escalation(sidecar-unwritable) 尽力落盘；全程不静默；
 *   - 孤儿标注与崩溃分歧检测（§3.9）。
 *
 * 判别（能变红）见 %TEMP%/dsh-t106-mutate/：
 *   mut-v2-drop（createTask 丢弃 constraints/knownRisks）→ task-state v2 用例红；
 *   mut-sc-direct-write（sidecar 直接写最终路径，绕过 tmp+rename）→ 原子写用例红；
 *   mut-sc-esc-novalidate（escalate 跳过关键字段校验）→ 校验用例红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join as join0 } from 'node:path'
import {
  QualitySidecar,
  ESCALATION_REASONS,
  GATE_STATES,
  digestRounds,
  validateFinding,
  qualityFilePathFor,
  persistWithCompensation,
} from '../lib/p2/quality-sidecar.js'
import { TaskStore } from '../lib/state/task-store.js'

const T0 = 1729000000000

/** 内存 fs（tmp+rename 语义与真实 fs 一致，记录调用序列供断言）。 */
function memfs(initial = {}) {
  const files = new Map(Object.entries(initial))
  const calls = []
  return {
    files,
    calls,
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error('ENOENT ' + p)
      return files.get(p)
    },
    existsSync: (p) => files.has(p),
    writeFileSync: (p, data) => { calls.push(['write', p]); files.set(p, data) },
    renameSync: (from, to) => { calls.push(['rename', from, to]); if (!files.has(from)) throw new Error('ENOENT ' + from); files.set(to, files.get(from)); files.delete(from) },
    mkdirSync: () => {},
  }
}

function makeSidecar(fsImpl = memfs()) {
  return new QualitySidecar({ file: '/team/quality.json', now: () => T0, fs: fsImpl })
}

function makeStore() {
  return new TaskStore({ claimLeaseMs: 60000, stallThresholdMs: 60000, suspendedUnattendedMs: 300000, maxSupersedeDepth: 16 })
}

// ────────────────────────── 基础形状 ──────────────────────────

test('枚举与常量：8 设计 reason + sidecar-unwritable 变体；gate 状态机六态', () => {
  assert.equal(ESCALATION_REASONS.length, 9)
  for (const reason of ['round-limit-exceeded', 'repair-failed', 'reject-no-repair', 'reviewer-unavailable', 'insufficient-evidence', 'e15-breach-unresolved', 'subject-superseded', 'manually-raised', 'sidecar-unwritable']) {
    assert.ok(ESCALATION_REASONS.includes(reason), reason)
  }
  assert.deepEqual(GATE_STATES, ['open', 'in-review', 'needs-revision', 'in-repair', 'escalated', 'closed'])
  assert.equal(qualityFilePathFor('/home/dsh-team-chat/trio'), join0('/home/dsh-team-chat/trio', 'quality.json'))
  assert.throws(() => qualityFilePathFor('/home/bad team'), 'teamDir 末段按 §3.9 净化规则校验（空格非法）')
})

test('digestRounds：各轮计数 + 趋势三值（converging/flat/diverging）', () => {
  const d1 = digestRounds([
    { round: 1, findings: [{ severity: 'high' }, { severity: 'low' }, { severity: 'high' }] },
    { round: 2, findings: [{ severity: 'low' }] },
  ])
  assert.equal(d1.byRound[0].total, 3)
  assert.equal(d1.byRound[0].high, 2)
  assert.equal(d1.byRound[1].total, 1)
  assert.equal(d1.trend, 'converging')
  assert.equal(digestRounds([{ round: 1, findings: [{ severity: 'low' }] }]).trend, 'flat')
  assert.equal(digestRounds([
    { round: 1, findings: [] },
    { round: 2, findings: [{ severity: 'high' }, { severity: 'high' }] },
  ]).trend, 'diverging')
})

test('validateFinding：非 low 缺 requiredFix 拒绝（G3 口径）；low 允许留空', () => {
  assert.equal(validateFinding({ id: 'F1', severity: 'high', problem: 'p', requiredFix: 'fix' }, 0), null)
  assert.ok(validateFinding({ id: 'F1', severity: 'high', problem: 'p' }, 0).includes('requiredFix'))
  assert.equal(validateFinding({ id: 'F2', severity: 'low', problem: '风格建议' }, 1), null)
  assert.ok(validateFinding({ id: '', severity: 'low', problem: 'p' }, 2).includes('.id'))
  assert.ok(validateFinding({ id: 'F3', severity: 'critical', problem: 'p' }, 3).includes('severity'))
})

// ────────────────────────── gate 生命周期 ──────────────────────────

test('gate 生命周期：open → in-review → pass → closed（round=1）', () => {
  const sc = makeSidecar()
  const opened = sc.openGate('t9', { maxRounds: 4, constraints: ['node>=22'], knownRisks: ['quota'] })
  assert.equal(opened.ok, true)
  assert.equal(sc.gateOf('t9').gateState, 'open')
  const claimed = sc.markReviewClaimed('t9', { reviewTaskId: 't10', reviewer: 'reviewer4' })
  assert.equal(claimed.ok, true)
  assert.equal(sc.gateOf('t9').gateState, 'in-review')
  const settled = sc.settleRound('t9', {
    reviewTaskId: 't10', reviewer: 'reviewer4', verdict: 'pass',
    acceptanceResults: [{ criterion: 'a1', status: 'passed', evidence: 'e' }],
  })
  assert.equal(settled.ok, true)
  const gate = sc.gateOf('t9')
  assert.equal(gate.gateState, 'closed')
  assert.equal(gate.round, 1, '结算完成的 review 数 = round（§3.7 口径）')
  assert.equal(gate.rounds[0].verdict, 'pass')
})

test('一致性校验：pass 带 findings / pass 带 failed 证据 / needs_revision 无 findings / 非法 verdict 全部拒绝', () => {
  const sc = makeSidecar()
  sc.openGate('t1')
  sc.markReviewClaimed('t1', { reviewTaskId: 't2', reviewer: 'rv' })
  const badPass = sc.settleRound('t1', { verdict: 'pass', findings: [{ id: 'F1', severity: 'low', problem: 'x' }] })
  assert.equal(badPass.reason, 'pass-with-findings')

  const badEvidence = sc.settleRound('t1', {
    verdict: 'pass',
    acceptanceResults: [{ criterion: 'a', status: 'failed', evidence: 'x' }],
  })
  assert.equal(badEvidence.reason, 'pass-with-failed-evidence')

  const noFindings = sc.settleRound('t1', { verdict: 'needs_revision', findings: [] })
  assert.equal(noFindings.reason, 'findings-required')

  const badVerdict = sc.settleRound('t1', { verdict: 'blocked' })
  assert.equal(badVerdict.reason, 'verdict-invalid', 'verdict 三值裁定（blocked 归升级 reason，§3.5）')

  // 非 low finding 缺 requiredFix 拒绝
  const badFix = sc.settleRound('t1', { verdict: 'needs_revision', findings: [{ id: 'F1', severity: 'high', problem: 'p' }] })
  assert.equal(badFix.reason, 'finding-invalid')

  // 合法 needs_revision → needs-revision
  const ok = sc.settleRound('t1', { verdict: 'needs_revision', findings: [{ id: 'F1', severity: 'high', problem: 'p', requiredFix: '改成 X' }] })
  assert.equal(ok.ok, true)
  assert.equal(sc.gateOf('t1').gateState, 'needs-revision')
})

test('非法 gate 转移拒绝（状态机表驱动）', () => {
  const sc = makeSidecar()
  sc.openGate('t1')
  const r = sc.markRepairClaimed('t1', { repairTaskId: 't9' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'illegal-gate-transition', 'open 不能直接进 in-repair')
})

test('修复轮：needs-revision → in-repair → repairs 记录 → resolveFindings 回写 → 第二轮 settle（round=2）', () => {
  const sc = makeSidecar()
  sc.openGate('t1')
  sc.markReviewClaimed('t1', { reviewTaskId: 't2', reviewer: 'rv' })
  sc.settleRound('t1', { verdict: 'needs_revision', reviewTaskId: 't2', findings: [
    { id: 'F1', severity: 'high', problem: 'p1', requiredFix: 'f1' },
    { id: 'F3', severity: 'medium', problem: 'p3', requiredFix: 'f3' },
  ] })
  const claimed = sc.markRepairClaimed('t1', { repairTaskId: 't3' })
  assert.equal(claimed.ok, true)
  assert.equal(sc.gateOf('t1').gateState, 'in-repair')

  sc.recordRepair('t1', { repairTaskId: 't3', sourceFindingIds: ['F1', 'F3'] })
  assert.equal(sc.gateOf('t1').repairs.length, 1)

  // repair completed → 新 review 排队 → in-review（本轮结算前 round 不变，§3.7）
  const requeued = sc.markReviewClaimed('t1', { reviewTaskId: 't4', reviewer: 'rv' })
  assert.equal(requeued.ok, true)
  assert.equal(sc.gateOf('t1').gateState, 'in-review')
  assert.equal(sc.gateOf('t1').round, 1, '创建未结算的 re-review 不增加 round（§3.7 口径）')

  // re-review 结算：回写 resolved + round=2
  const settled = sc.settleRound('t1', { verdict: 'pass', reviewTaskId: 't4' })
  assert.equal(settled.ok, true)
  assert.equal(sc.gateOf('t1').round, 2)
  const resolvedIds = sc.gateOf('t1').rounds[0].findings.map((f) => `${f.id}:${f.resolved}`)
  assert.deepEqual(resolvedIds, ['F1:false', 'F3:false'], 're-review 未声称回写时 resolved 不变（§3.6：由 re-review 结算显式回写）')

  // resolveFindings 显式回写
  const res = sc.resolveFindings('t1', ['F1'])
  assert.deepEqual(res.resolved, [{ round: 1, id: 'F1' }])
})

test('reject → escalated（reason=reject-no-repair 自动构建）；escalate 校验与缺省 A-D', () => {
  const sc = makeSidecar()
  sc.openGate('t1')
  sc.markReviewClaimed('t1', { reviewTaskId: 't2', reviewer: 'rv' })
  sc.settleRound('t1', { verdict: 'reject', reviewTaskId: 't2', findings: [] })
  const gate = sc.gateOf('t1')
  assert.equal(gate.gateState, 'escalated')
  assert.equal(gate.escalation.reason, 'reject-no-repair')
  assert.equal(gate.escalation.roundsAttempted, 1)
  assert.equal(gate.escalation.findingsDigest.byRound.length, 1)
  assert.deepEqual(gate.escalation.pendingDecisions.slice(0, 1), ['A: 接受当前版本为终态（关闭 gate）'], '缺省 A-D 选项（§5.2）')
  assert.equal(gate.escalation.findingsDigest.trend, 'flat')

  // escalate 显式调用：缺 summary → 显式拒绝（验收判别点）
  sc.openGate('t2')
  const invalid = sc.escalate('t2', { reason: 'manually-raised' })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.reason, 'escalation-invalid')
  assert.ok(invalid.detail.includes('summary'))

  // 缺/错 reason → 显式拒绝
  const noReason = sc.escalate('t2', { summary: 's' })
  assert.equal(noReason.reason, 'escalation-invalid')

  // 合法：escalated 置顶 + 记录留存
  const ok = sc.escalate('t2', { reason: 'manually-raised', summary: '越级上报（章程 §8）' })
  assert.equal(ok.ok, true)
  assert.equal(sc.gateOf('t2').gateState, 'escalated')
  assert.equal(sc.gateOf('t2').escalation.reason, 'manually-raised')
  // closed gate 不可再升级（终态）
  sc.openGate('t3')
  sc.markReviewClaimed('t3')
  sc.settleRound('t3', { verdict: 'pass' })
  const closedEsc = sc.escalate('t3', { reason: 'manually-raised', summary: 'x' })
  assert.equal(closedEsc.reason, 'gate-closed')
})

test('pendingInputs 排队（§3.8 事故 #3 约束）', () => {
  const sc = makeSidecar()
  sc.openGate('t1')
  sc.addPendingInput('t1', { from: 'captain', summary: '补充验收口径' })
  assert.equal(sc.gateOf('t1').pendingInputs.length, 1)
  assert.equal(sc.gateOf('t1').pendingInputs[0].handledByTaskId, null)
})

// ────────────────────────── 持久化（tmp+rename 原子写） ──────────────────────────

test('原子写：先写 .tmp 再 rename；直接写最终路径 → 红（验收判别点）', () => {
  const fs = memfs()
  const sc = makeSidecar(fs)
  sc.openGate('t1')
  const saved = sc.save()
  assert.equal(saved.ok, true)
  const writes = fs.calls.filter((c) => c[0] === 'write')
  const renames = fs.calls.filter((c) => c[0] === 'rename')
  assert.ok(writes.length >= 1, '有写操作')
  for (const [, path] of writes) {
    assert.ok(path.includes('.tmp-'), `写目标是 tmp 文件（原子写纪律）：${path}`)
    assert.notEqual(path, '/team/quality.json', '不得直接写最终路径（非原子 → 判别红）')
  }
  assert.ok(renames.length >= 1, 'rename 原子替换')
  assert.ok(fs.files.has('/team/quality.json'), '最终文件存在')
  assert.ok(![...fs.files.keys()].some((k) => k.includes('.tmp-')), '无临时文件残留')
  // 重载一致
  const sc2 = makeSidecar(fs)
  assert.equal(sc2.gateOf('t1').gateState, 'open', '重载后 gate 原样恢复')
})

test('损坏文件显式失败（不静默清零）', () => {
  const fs = memfs({ '/team/quality.json': '{not-json' })
  assert.throws(() => makeSidecar(fs), /拒绝静默清零/)
  const fs2 = memfs({ '/team/quality.json': '{"version":1}' })
  assert.throws(() => makeSidecar(fs2), /形状非法/)
})

// ────────────────────────── §6.2 补偿契约 ──────────────────────────

test('补偿①：sidecar 写 3 次全败 → P1 update(failed) + insufficient-evidence findings（不静默）', () => {
  const store = makeStore()
  const t = store.createTask({ subject: 'x', dependencies: [], assignee: 'rv', kind: 'review' }, T0).task
  const c = store.claim(t.id, { assignee: 'rv', claimedById: 'child-rv' }, T0 + 1)
  store.update(t.id, { attemptId: c.attemptId, revision: c.revision, status: 'running' }, T0 + 2)
  const before = store.tasks.get(t.id)

  let attempts = 0
  const result = persistWithCompensation({
    store,
    taskId: t.id,
    attemptId: before.attemptId,
    revision: before.revision,
    retries: 3,
    write: () => { attempts += 1; throw new Error('EACCES: quality.json') },
  })
  assert.equal(result.ok, false)
  assert.equal(attempts, 3, '重试 N=3（G10 默认）')
  assert.equal(result.compensation.taken, 'p1-failed-insufficient-evidence')
  assert.equal(store.tasks.get(t.id).status, 'failed', '补偿 update 真实执行（durable 账本真相）')
  assert.equal(result.compensation.findings[0].id, 'C1')
  assert.ok(result.compensation.findings[0].problem.includes('证据链不完整'))
  assert.equal(result.compensation.detail.sidecarError.includes('EACCES'), true, 'sidecar 失败原因随返回值上抛（不静默）')
})

test('补偿②：update 不可行（已 terminal）→ escalation(sidecar-unwritable) 尽力落盘（不静默）', () => {
  const store = makeStore()
  const t = store.createTask({ subject: 'x', dependencies: [], assignee: 'rv', kind: 'work' }, T0).task
  const c = store.claim(t.id, { assignee: 'rv', claimedById: 'child-rv' }, T0 + 1)
  // 直接结算 completed（终态）→ 补偿 update 必然 illegal-transition
  store.update(t.id, { attemptId: c.attemptId, revision: c.revision, status: 'completed' }, T0 + 2)

  const fs = memfs()
  const sc = makeSidecar(fs)
  sc.openGate(t.id)

  const result = persistWithCompensation({
    store,
    taskId: t.id,
    attemptId: c.attemptId,
    revision: store.tasks.get(t.id).revision,
    retries: 2,
    sidecar: sc,
    write: () => { throw new Error('ENOSPC') },
  })
  assert.equal(result.ok, false)
  assert.equal(result.compensation.taken, 'sidecar-unwritable-escalation')
  assert.equal(result.compensation.detail.p1Failure.reason, 'illegal-transition')
  assert.equal(result.compensation.detail.escalation.ok, true, 'escalation 内存态创建')
  assert.equal(result.compensation.detail.escalationSaved, true, '尽力落盘（本次写恢复时成功）')
  assert.equal(sc.gateOf(t.id).gateState, 'escalated')
  assert.equal(sc.gateOf(t.id).escalation.reason, 'sidecar-unwritable')
})

test('补偿④首次即成功 → compensation=null（零补偿零噪音）', () => {
  const store = makeStore()
  const t = store.createTask({ subject: 'x', dependencies: [], assignee: '' }, T0).task
  const result = persistWithCompensation({
    store, taskId: t.id, attemptId: null, revision: 1, retries: 3,
    write: () => {},
  })
  assert.equal(result.ok, true)
  assert.equal(result.attempts, 1)
  assert.equal(result.compensation, null)
})

// ────────────────────────── 孤儿与崩溃分歧（§3.9） ──────────────────────────

test('sweepOrphans：gate 指向不存在/superseded 任务 → 标注 orphaned（保留不删）', () => {
  const store = makeStore()
  const t1 = store.createTask({ subject: 'a', dependencies: [], assignee: '' }, T0).task
  const t2 = store.createTask({ subject: 'b', dependencies: [], assignee: '' }, T0).task
  const fs = memfs()
  const sc = makeSidecar(fs)
  sc.openGate(t1.id)
  sc.openGate(t2.id)
  sc.openGate('t-ghost')
  store.supersede(t2.id, { revision: store.tasks.get(t2.id).revision, supersededBy: null }, T0 + 1)
  const orphans = sc.sweepOrphans(store)
  assert.deepEqual(orphans.sort(), [t2.id, 't-ghost'].sort())
  assert.equal(sc.gateOf('t-ghost').orphaned, true, '保留不删（不静默抹数据）')
  assert.equal(sc.gateOf(t1.id).orphaned, undefined)
})

test('findDivergedGates：gate in-review/in-repair 而 P1 已 terminal → 分歧清单（§3.9 重放前置）', () => {
  const store = makeStore()
  const t = store.createTask({ subject: 'x', dependencies: [], assignee: '' }, T0).task
  const c = store.claim(t.id, { assignee: '', claimedById: 'c' }, T0 + 1)
  store.update(t.id, { attemptId: c.attemptId, revision: c.revision, status: 'completed' }, T0 + 2)
  const fs = memfs()
  const sc = makeSidecar(fs)
  sc.openGate(t.id)
  sc.markReviewClaimed(t.id, { reviewTaskId: 't9', reviewer: 'rv' })
  const diverged = sc.findDivergedGates(store)
  assert.equal(diverged.length, 1)
  assert.equal(diverged[0].gateState, 'in-review')
  assert.equal(diverged[0].p1Status, 'completed')
})

// ---------------------------------------------------------------- t110 · F1 判别（幽灵 gate）

test('t110-txA（F1 判别）：从未 save 的 sidecar 上内存变异后 load() → gates 清空（无幽灵）', () => {
  const fs = memfs() // 无 quality.json 文件 —— 「生命周期内从未成功 save」
  const sc = makeSidecar(fs)
  sc.openGate('t1')
  sc.markReviewClaimed('t1', { reviewTaskId: 't2', reviewer: 'rv' })
  sc.settleRound('t1', { verdict: 'needs_revision', reviewTaskId: 't2', findings: [
    { id: 'F1', severity: 'high', problem: 'p', requiredFix: 'f' },
  ] })
  assert.equal(sc.gateOf('t1').gateState, 'needs-revision', '前置：内存已变异（round=1 / needs-revision）')
  // P1 CAS 失败的回滚分支（quality-loop settleReviewTask 同款调用）：load() 必须清空内存
  sc.load()
  assert.equal(sc.gates.size, 0, 'F1 修复：load() 无文件分支清空内存 gates（未修复版本此处残留幽灵 gate → 红）')
  assert.equal(sc.gateOf('t1'), undefined, '幽灵 gate 不存在')
})

test('t110-txB：磁盘有文件时 load() → 回滚到磁盘态（rolledBackToDisk=true 语义）', () => {
  const fs = memfs()
  const sc = makeSidecar(fs)
  sc.openGate('t1')
  sc.save() // 磁盘已有文件（open 态，round=0）
  // 内存变异（模拟结算）
  sc.markReviewClaimed('t1', { reviewTaskId: 't2', reviewer: 'rv' })
  sc.settleRound('t1', { verdict: 'needs_revision', reviewTaskId: 't2', findings: [
    { id: 'F1', severity: 'high', problem: 'p', requiredFix: 'f' },
  ] })
  assert.equal(sc.gateOf('t1').gateState, 'needs-revision')
  // P1 CAS 失败回滚：load() → 回到磁盘态（open / round=0）
  sc.load()
  const gate = sc.gateOf('t1')
  assert.equal(gate.gateState, 'open', '回滚到磁盘态（rolledBackToDisk）')
  assert.equal(gate.round, 0)
  assert.equal(sc.gates.size, 1, '磁盘 gate 原样恢复（不是清空，是回滚）')
})
