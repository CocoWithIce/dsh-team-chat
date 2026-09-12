/**
 * P3 质量门 sidecar —— lib/p2/quality-sidecar.js
 *
 * t106 · P3 Slice 1（设计稿 v0.2 §3.8/§3.9/§5/§6.2）。
 *
 * 分层裁决（§3.1）：结算期审计产物（findings/rounds/repairs/escalation/pendingInputs）
 * 走 sidecar quality.json（与 store 同目录、同 tmp+rename 原子写纪律、追加式），
 * 与 P1 CAS 状态机解耦——「一次结算整行重写 + revision 空转」的反面约束。
 * P1 是唯一状态真相；sidecar 是审计投影（§3.9），崩溃以 P1 为准重放。
 *
 * 本 Slice 只交付存储层原语（gate 生命周期 / 轮结算 / 修复记录 / 升级 / 补偿契约）；
 * 循环编排与工具面接线属 Slice 2。依赖注入 fs 边界，可在裸 node 下测试。
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'

/** sidecar 自身 schema 版本（独立于 P1 store schemaVersion）。 */
export const QUALITY_SCHEMA_VERSION = 1

/** gate 状态机取值（§3.7 图）。 */
export const GATE_STATES = ['open', 'in-review', 'needs-revision', 'in-repair', 'escalated', 'closed']

/** 合法转移表（§3.7 图 + §5.4 裁决出口：escalated → A=closed / B,D=in-review）。 */
export const GATE_TRANSITIONS = {
  open: ['in-review', 'closed', 'escalated'],
  'in-review': ['closed', 'needs-revision', 'escalated'],
  'needs-revision': ['in-repair', 'escalated', 'closed'],
  'in-repair': ['in-review', 'escalated', 'closed'],
  escalated: ['closed', 'in-review'],
  closed: [],
}

/**
 * 升级原因枚举。⚠ 契约文字写「7 种」，冻结设计 §5.2/§5.3 实列 **8 种**（差异已在
 * t106 交付声明）；`sidecar-unwritable` 为 §6.2 补偿路径专用变体（manually-raised
 * 的 reason 标注），合计 9 个可接受值——枚举即真值来源，差异声明见基线。
 */
export const ESCALATION_REASONS = [
  'round-limit-exceeded',
  'repair-failed',
  'reject-no-repair',
  'reviewer-unavailable',
  'insufficient-evidence',
  'e15-breach-unresolved',
  'subject-superseded',
  'manually-raised',
  'sidecar-unwritable',
]

/** 人工裁决默认选项（§5.2 pendingDecisions 模板 A-D）。 */
export const DEFAULT_PENDING_DECISIONS = [
  'A: 接受当前版本为终态（关闭 gate）',
  'B: 追加 1 轮复核（队长确认后 maxRounds+1 或本轮豁免）',
  'C: 作废被审对象，重新规划（supersede）',
  'D: 改派 reviewer / 轮换成员后重开',
]

export const SEVERITIES = ['blocker', 'high', 'medium', 'low']

/** quality.json 路径：<teamDir>/quality.json（teamDir 末段按 P1 §7 净化规则校验）。 */
export function qualityFilePathFor(teamDir) {
  const base = basename(teamDir)
  if (!/^[A-Za-z0-9._-]+$/.test(base)) throw new Error(`quality sidecar: 非法 teamDir（§3.9 净化规则）：${base}`)
  return join(teamDir, 'quality.json')
}

/** 单条 finding 校验（§3.3）：id/severity/problem 必填；requiredFix 非低severity必填。 */
export function validateFinding(finding, index) {
  const where = `findings[${index}]`
  if (finding === null || typeof finding !== 'object') return `${where} 不是对象`
  if (typeof finding.id !== 'string' || finding.id === '') return `${where}.id 必填`
  if (!SEVERITIES.includes(finding.severity)) return `${where}.severity 必须是 ${SEVERITIES.join('|')}`
  if (typeof finding.problem !== 'string' || finding.problem === '') return `${where}.problem 必填`
  if (finding.severity !== 'low' && (typeof finding.requiredFix !== 'string' || finding.requiredFix === '')) {
    return `${where}.requiredFix 必填（非 low finding；G3 口径）`
  }
  return null
}

/**
 * 各轮 findings 聚合（§5.2 findingsDigest）：byRound 计数 + 趋势三值。
 * 趋势口径：总数递减=converging，递增=diverging，持平（含单轮）=flat。
 */
export function digestRounds(rounds) {
  const byRound = (rounds ?? []).map((r) => {
    const counts = { round: r.round, total: (r.findings ?? []).length, blocker: 0, high: 0, medium: 0, low: 0 }
    for (const f of r.findings ?? []) {
      if (counts[f.severity] !== undefined) counts[f.severity] += 1
    }
    return counts
  })
  let trend = 'flat'
  for (let i = 1; i < byRound.length; i++) {
    const prev = byRound[i - 1].total
    const cur = byRound[i].total
    if (cur > prev) { trend = 'diverging'; break }
    if (cur < prev) trend = 'converging'
    else trend = trend === 'diverging' ? 'diverging' : 'flat'
  }
  return { byRound, trend }
}

/** EscalationRecord 校验（验收判别点：缺关键字段必须被拒）。 */
export function validateEscalationRecord(record) {
  if (record === null || typeof record !== 'object') return 'escalation 不是对象'
  if (!ESCALATION_REASONS.includes(record.reason)) return `escalation.reason 必须是 ${ESCALATION_REASONS.join('|')}`
  if (!Number.isFinite(record.roundsAttempted) || record.roundsAttempted < 0) return 'escalation.roundsAttempted 必须是非负数字'
  if (typeof record.summary !== 'string' || record.summary === '') return 'escalation.summary 必填（结论附证据入口）'
  if (record.findingsDigest !== undefined) {
    if (!Array.isArray(record.findingsDigest.byRound)) return 'escalation.findingsDigest.byRound 必须是数组'
    if (!['converging', 'flat', 'diverging'].includes(record.findingsDigest.trend)) return 'escalation.findingsDigest.trend 必须是 converging|flat|diverging'
  }
  if (record.suggestions !== undefined && !Array.isArray(record.suggestions)) return 'escalation.suggestions 必须是数组'
  if (record.pendingDecisions !== undefined && !Array.isArray(record.pendingDecisions)) return 'escalation.pendingDecisions 必须是数组'
  return null
}

/**
 * 质量门 sidecar。fs 边界可注入（测试内存 fs）；写路径 = tmp + rename 原子替换
 * （与 P1 store.save 同纪律，§3.9）。
 */
export class QualitySidecar {
  /**
   * @param options - { file, now?, retries?, fs? }
   *   file: quality.json 完整路径（宿主用 qualityFilePathFor(teamDir) 构造）。
   *   fs: { readFileSync?, existsSync?, writeFileSync?, renameSync?, mkdirSync? }（可部分注入）。
   */
  constructor(options = {}) {
    this.file = options.file
    this.retries = options.retries ?? 3
    this.now = options.now ?? (() => Date.now())
    this.fs = {
      readFileSync: options.fs?.readFileSync ?? readFileSync,
      existsSync: options.fs?.existsSync ?? existsSync,
      writeFileSync: options.fs?.writeFileSync ?? writeFileSync,
      renameSync: options.fs?.renameSync ?? renameSync,
      mkdirSync: options.fs?.mkdirSync ?? mkdirSync,
    }
    /** @type {Map<string, object>} */
    this.gates = new Map()
    this.load()
  }

  /**
   * 读取持久化文件（不存在 = 空 sidecar；损坏/形状非法 = 显式失败，不静默清零）。
   * t110 · F1 修复（t109 判 needs_revision 唯一 finding，medium）：无文件分支**先清空
   * 内存 gates 再返回**——否则「生命周期内从未成功 save」的 sidecar 在 P1 CAS 失败
   * 回滚（quality-loop settleReviewTask 的 sidecar.load()）时，内存残留幽灵 gate
   * （rounds/gateState 已变异），后续任一成功 save 会把幽灵记录持久化。
   */
  load() {
    if (!this.fs.existsSync(this.file)) {
      this.gates = new Map()
      return false
    }
    let raw
    try {
      raw = JSON.parse(this.fs.readFileSync(this.file, 'utf8'))
    } catch (e) {
      throw new Error(`quality sidecar 损坏且拒绝静默清零（${this.file}）：${String(e)}`)
    }
    if (raw === null || typeof raw !== 'object' || raw.gates === undefined || typeof raw.gates !== 'object' || Array.isArray(raw.gates)) {
      throw new Error('quality sidecar 形状非法（缺 gates）：' + this.file)
    }
    this.gates = new Map(Object.entries(raw.gates))
    return true
  }

  /** 原子写（tmp + rename）：每次状态变化后调用（低频事件写，§3.9）。 */
  save() {
    const payload = JSON.stringify({
      version: QUALITY_SCHEMA_VERSION,
      gates: Object.fromEntries(this.gates.entries()),
      savedAt: this.now(),
    }, null, 2)
    const dir = dirname(this.file)
    if (dir !== '' && dir !== this.file) {
      try { this.fs.mkdirSync(dir, { recursive: true }) } catch { /* 已存在等 */ }
    }
    const tmp = this.file + '.tmp-' + randomUUID().slice(0, 8)
    this.fs.writeFileSync(tmp, payload, 'utf8')
    this.fs.renameSync(tmp, this.file)
    return { ok: true, path: this.file }
  }

  gateOf(taskId) {
    return this.gates.get(taskId)
  }

  allGates() {
    return [...this.gates.values()]
  }

  _transition(gate, toState) {
    const allowed = GATE_TRANSITIONS[gate.gateState] ?? []
    if (!allowed.includes(toState)) {
      return `非法 gate 转移：${gate.gateState} → ${toState}（允许：${allowed.join(', ') || '无'}）`
    }
    gate.gateState = toState
    gate.updatedAt = this.now()
    return null
  }

  /**
   * 创建 gate（§3.8 QualityGate 初始形态；一任务一 gate，重复创建显式拒绝）。
   */
  openGate(taskId, { maxRounds = 4, constraints = [], knownRisks = [] } = {}) {
    if (this.gates.has(taskId)) return { ok: false, reason: 'gate-exists', taskId }
    const gate = {
      taskId,
      gateState: 'open',
      round: 0,
      maxRounds: Number.isFinite(maxRounds) && maxRounds > 0 ? Math.floor(maxRounds) : 4,
      contract: { constraints: Array.isArray(constraints) ? constraints.slice() : [], knownRisks: Array.isArray(knownRisks) ? knownRisks.slice() : [] },
      rounds: [],
      repairs: [],
      pendingInputs: [],
      escalation: null,
      updatedAt: this.now(),
    }
    this.gates.set(taskId, gate)
    return { ok: true, gate }
  }

  /** review 任务认领 → open 进入 in-review；已在 in-review（re-review 排队后认领）= no-op。 */
  markReviewClaimed(taskId, { reviewTaskId, reviewer } = {}) {
    const gate = this.gates.get(taskId)
    if (gate === undefined) return { ok: false, reason: 'gate-not-found', taskId }
    if (gate.gateState === 'in-review') {
      // t108：re-review 排队时已入 in-review（§4.4），claim 仅补认领信息。
      gate.pendingReview = { reviewTaskId: reviewTaskId ?? null, reviewer: reviewer ?? null, claimedAt: this.now() }
      return { ok: true, gate, noop: 'already-in-review' }
    }
    const err = this._transition(gate, 'in-review')
    if (err) return { ok: false, reason: 'illegal-gate-transition', detail: err, taskId }
    gate.pendingReview = { reviewTaskId: reviewTaskId ?? null, reviewer: reviewer ?? null, claimedAt: this.now() }
    return { ok: true, gate }
  }

  /** repair 任务认领 → needs-revision 进入 in-repair（§3.7）；保留创建期 pendingRepair 元数据。 */
  markRepairClaimed(taskId, { repairTaskId } = {}) {
    const gate = this.gates.get(taskId)
    if (gate === undefined) return { ok: false, reason: 'gate-not-found', taskId }
    const err = this._transition(gate, 'in-repair')
    if (err) return { ok: false, reason: 'illegal-gate-transition', detail: err, taskId }
    gate.pendingRepair = {
      ...(gate.pendingRepair ?? {}),
      repairTaskId: repairTaskId ?? gate.pendingRepair?.repairTaskId ?? null,
      claimedAt: gate.pendingRepair?.claimedAt ?? this.now(),
    }
    return { ok: true, gate }
  }

  /** 按 repair 任务 id 反查 gate（pendingRepair / repairs 双查，t108 循环接线用）。 */
  gateByRepairTask(repairTaskId) {
    for (const gate of this.gates.values()) {
      if (gate.pendingRepair?.repairTaskId === repairTaskId) return gate
      if ((gate.repairs ?? []).some((r) => r.repairTaskId === repairTaskId)) return gate
    }
    return undefined
  }

  /** 按 review 任务 id 反查 gate（pendingReview / rounds 双查）。 */
  gateByReviewTask(reviewTaskId) {
    for (const gate of this.gates.values()) {
      if (gate.pendingReview?.reviewTaskId === reviewTaskId) return gate
      if ((gate.rounds ?? []).some((r) => r.reviewTaskId === reviewTaskId)) return gate
    }
    return undefined
  }

  /**
   * re-review 排队（§4.4）：repair completed → in-repair 进入 in-review（下一轮）。
   * round 不在此递增（§3.7 口径：结算完成的 review 数）。
   */
  queueReview(taskId, { reviewTaskId } = {}) {
    const gate = this.gates.get(taskId)
    if (gate === undefined) return { ok: false, reason: 'gate-not-found', taskId }
    const err = this._transition(gate, 'in-review')
    if (err) return { ok: false, reason: 'illegal-gate-transition', detail: err, taskId }
    gate.pendingReview = { reviewTaskId: reviewTaskId ?? null, reviewer: null, claimedAt: null }
    gate.waitingReviewer = undefined
    gate.updatedAt = this.now()
    return { ok: true, gate }
  }

  /** 可用性前置不满足 → 记 waitingReviewer（零账本污染，§4.4）。 */
  setWaitingReviewer(taskId, { repairTaskId, since } = {}) {
    const gate = this.gates.get(taskId)
    if (gate === undefined) return { ok: false, reason: 'gate-not-found', taskId }
    gate.waitingReviewer = { since: since ?? this.now(), repairTaskId: repairTaskId ?? null }
    gate.updatedAt = this.now()
    return { ok: true, gate }
  }

  /** §5.3 reviewer-unavailable 阈值判定（事件触发的机会式检查，无定时器）。 */
  waitingReviewerExpired(taskId, thresholdMs, now = this.now()) {
    const gate = this.gates.get(taskId)
    if (gate === undefined || gate.waitingReviewer === undefined || gate.waitingReviewer === null) return false
    return now - gate.waitingReviewer.since >= thresholdMs
  }

  /**
   * review 结算（§3.7/§3.3/§3.4/§6.2 一致性校验）：
   *   pass → findings 必须为空 + acceptanceResults 不得含 failed → closed；
   *   needs_revision → findings 必填（requiredFix 校验）→ needs-revision；
   *   reject → escalated（reason=reject-no-repair，自动构建升级记录）。
   * round = gate.round + 1（口径 §3.7：结算完成的 review 数）。
   */
  settleRound(taskId, input = {}) {
    const gate = this.gates.get(taskId)
    if (gate === undefined) return { ok: false, reason: 'gate-not-found', taskId }
    if (gate.gateState !== 'in-review') {
      return { ok: false, reason: 'illegal-gate-state', detail: `结算要求 in-review，当前 ${gate.gateState}`, taskId }
    }
    const verdict = input.verdict
    if (!['pass', 'needs_revision', 'reject'].includes(verdict)) {
      return { ok: false, reason: 'verdict-invalid', detail: 'verdict 必须是 pass|needs_revision|reject', taskId }
    }
    const findings = Array.isArray(input.findings) ? input.findings : []
    if (verdict === 'pass' && findings.length > 0) {
      return { ok: false, reason: 'pass-with-findings', detail: '一致性校验：verdict=pass 时 findings 必须为空（§6.2）', taskId }
    }
    for (let i = 0; i < findings.length; i++) {
      const err = validateFinding(findings[i], i)
      if (err) return { ok: false, reason: 'finding-invalid', detail: err, taskId }
    }
    const acceptanceResults = Array.isArray(input.acceptanceResults) ? input.acceptanceResults : []
    if (verdict === 'pass' && acceptanceResults.some((r) => r?.status === 'failed')) {
      return { ok: false, reason: 'pass-with-failed-evidence', detail: '一致性校验：pass 时 acceptanceResults 不得含 failed（§3.4）', taskId }
    }
    if (verdict === 'needs_revision' && findings.length === 0) {
      return { ok: false, reason: 'findings-required', detail: 'needs_revision 必附 findings（§6.2）', taskId }
    }

    const round = {
      round: gate.round + 1,
      reviewTaskId: input.reviewTaskId ?? gate.pendingReview?.reviewTaskId ?? null,
      reviewer: input.reviewer ?? gate.pendingReview?.reviewer ?? null,
      verdict,
      findings: findings.map((f) => ({ ...f, resolved: false })),
      acceptanceResults,
      output: typeof input.output === 'string' ? input.output : undefined,
      settledAt: input.settledAt ?? this.now(),
    }
    gate.rounds.push(round)
    gate.round = round.round
    gate.pendingReview = undefined

    if (verdict === 'pass') {
      const err = this._transition(gate, 'closed')
      if (err) return { ok: false, reason: 'illegal-gate-transition', detail: err, taskId }
    } else if (verdict === 'needs_revision') {
      const err = this._transition(gate, 'needs-revision')
      if (err) return { ok: false, reason: 'illegal-gate-transition', detail: err, taskId }
    } else {
      const err = this._transition(gate, 'escalated')
      if (err) return { ok: false, reason: 'illegal-gate-transition', detail: err, taskId }
      const esc = this.buildEscalation(gate, {
        reason: 'reject-no-repair',
        summary: 'review verdict=reject：范围跑偏/证据缺失/验收被破坏，需重新规划（不进修复循环，§3.5）',
      })
      gate.escalation = esc.record
    }
    gate.updatedAt = this.now()
    return { ok: true, gate, round: round.round }
  }

  /** repair 结算登记（§3.8 repairs 追加式）；finding 回写由 re-review 结算触发 resolveFindings。 */
  recordRepair(taskId, { repairTaskId, sourceFindingIds = [], settledAt } = {}) {
    const gate = this.gates.get(taskId)
    if (gate === undefined) return { ok: false, reason: 'gate-not-found', taskId }
    gate.repairs.push({
      repairTaskId: repairTaskId ?? null,
      round: gate.round,
      sourceFindingIds: Array.isArray(sourceFindingIds) ? sourceFindingIds.slice() : [],
      settledAt: settledAt ?? this.now(),
    })
    gate.updatedAt = this.now()
    return { ok: true, gate }
  }

  /** re-review 结算时逐条回写 resolved（§3.6：repair 声称的 finding id 集）。 */
  resolveFindings(taskId, findingIds) {
    const gate = this.gates.get(taskId)
    if (gate === undefined) return { ok: false, reason: 'gate-not-found', taskId }
    const wanted = new Set(Array.isArray(findingIds) ? findingIds : [])
    const resolved = []
    for (const round of gate.rounds) {
      for (const finding of round.findings) {
        if (wanted.has(finding.id) && finding.resolved !== true) {
          finding.resolved = true
          resolved.push({ round: round.round, id: finding.id })
        }
      }
    }
    gate.updatedAt = this.now()
    return { ok: true, resolved }
  }

  /** 复核/升级期到达的新输入排队（§3.8 pendingInputs；事故 #3 约束）。 */
  addPendingInput(taskId, { from, summary, receivedAt } = {}) {
    const gate = this.gates.get(taskId)
    if (gate === undefined) return { ok: false, reason: 'gate-not-found', taskId }
    gate.pendingInputs.push({
      receivedAt: receivedAt ?? this.now(),
      from: from ?? null,
      summary: summary ?? '',
      handledByTaskId: null,
    })
    gate.updatedAt = this.now()
    return { ok: true, gate }
  }

  /**
   * 构建 EscalationRecord（§5.2）：reason 枚举校验 + findingsDigest 自动聚合 +
   * pendingDecisions 缺省 A-D。**缺关键字段显式拒绝**（验收判别点）。
   */
  buildEscalation(gate, input = {}) {
    const record = {
      reason: input.reason,
      roundsAttempted: input.roundsAttempted ?? gate.round,
      summary: input.summary,
      findingsDigest: input.findingsDigest ?? digestRounds(gate.rounds),
      suggestions: Array.isArray(input.suggestions) ? input.suggestions.slice() : [],
      pendingDecisions: Array.isArray(input.pendingDecisions) ? input.pendingDecisions.slice() : DEFAULT_PENDING_DECISIONS.slice(),
      escalatedAt: input.escalatedAt ?? this.now(),
    }
    const err = validateEscalationRecord(record)
    if (err) return { ok: false, reason: 'escalation-invalid', detail: err }
    return { ok: true, record }
  }

  /**
   * 升级（§5.3/§5.4）：构建记录 → gate 置 escalated（从任何非 closed 态可达）。
   * 升级记录永不删除（追加式审计语义：记录留存于 gate.escalation）。
   */
  escalate(taskId, input = {}) {
    const gate = this.gates.get(taskId)
    if (gate === undefined) return { ok: false, reason: 'gate-not-found', taskId }
    if (gate.gateState === 'closed') return { ok: false, reason: 'gate-closed', taskId }
    const esc = this.buildEscalation(gate, input)
    if (!esc.ok) return esc
    const err = this._transition(gate, 'escalated')
    if (err) return { ok: false, reason: 'illegal-gate-transition', detail: err, taskId }
    gate.escalation = esc.record
    gate.updatedAt = this.now()
    return { ok: true, gate, escalation: esc.record }
  }

  /**
   * 孤儿标注（§3.9 崩溃恢复）：gate 指向的 taskId 在 P1 中不存在/已 superseded →
   * gate.orphaned = true（**保留不删**——不静默抹数据，人工处置）。
   * @param store - P1 TaskStore（唯一状态真相）。
   */
  sweepOrphans(store) {
    const orphans = []
    for (const gate of this.gates.values()) {
      const task = store.tasks.get(gate.taskId)
      const orphaned = task === undefined || task.status === 'superseded'
      if (orphaned && gate.orphaned !== true) {
        gate.orphaned = true
        gate.updatedAt = this.now()
        orphans.push(gate.taskId)
      }
    }
    return orphans
  }

  /**
   * 崩溃窗口分歧检测（§3.9 重放前置）：gateState ∈ {in-review,in-repair} 而对应
   * P1 任务已 terminal → 以 P1 为准重放转移（Slice 2 接线的检测原语）。
   */
  findDivergedGates(store) {
    const diverged = []
    for (const gate of this.gates.values()) {
      if (!['in-review', 'in-repair'].includes(gate.gateState)) continue
      const task = store.tasks.get(gate.taskId)
      if (task !== undefined && store.isTerminal(task.id)) {
        diverged.push({ taskId: gate.taskId, gateState: gate.gateState, p1Status: task.status })
      }
    }
    return diverged
  }
}

/**
 * §6.2 补偿契约（store 成功后 sidecar 写失败，v0.2 契约条款）：
 *   1. sidecar 写入重试 N 次（默认 3，§9-G10；backoffMs 可注入）；
 *   2. 全败 → 二选一补偿（按失败点自动判定）：
 *      ①P1 update(failed) + insufficient-evidence findings（本轮结算作废为
 *      「证据链不完整」——评审已发生但门记录丢失，防幽灵 pass/needs_revision）；
 *      ②①不可行（任务已 terminal / 并发取代）→ 在 sidecar 内存态创建 escalation
 *      （reason=sidecar-unwritable）并尽力落盘一次，现场交给人工；
 *   3. **绝不静默**：补偿动作、结果与 insufficient-evidence findings 全部随返回值
 *      上抛（compensation 字段；findings 同时是 P1 failed 结算的伴随证据——
 *      sidecar 不可写时随工具返回值进宿主侧会话事件日志留痕）。
 *
 * @param deps - { store, taskId, attemptId, revision, write, sidecar?, retries?, backoffMs?, now? }
 *   write:   ()=>void —— 执行本次 sidecar 落盘的闭包（调用方构造，含 gate 状态转移）。
 *   sidecar: QualitySidecar —— ②路径的 escalation 内存落点（可选；缺省且①不可行时只上抛）。
 * @returns {ok, attempts?, compensation: null | {taken, detail, findings}}
 */
export function persistWithCompensation(deps) {
  const retries = deps.retries ?? 3
  const now = deps.now ?? (() => Date.now())
  let lastError = null
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      deps.write()
      return { ok: true, attempts: attempt, compensation: null }
    } catch (e) {
      lastError = String(e)
      // G10 的「退避」由 Slice 2 异步层承载：本函数为同步原语，不做忙等。
    }
  }
  // N 次全败 → 补偿二选一（按失败点自动判定，全程留痕上抛）。
  const compensation = {
    taken: null,
    detail: { sidecarError: lastError, retries },
    findings: [{
      id: 'C1',
      severity: 'high',
      problem: `sidecar 写入在 ${retries} 次尝试后仍失败（${lastError}）：门记录丢失，本轮结算按「证据链不完整」作废（§6.2）`,
      requiredFix: '恢复 quality.json 持久化后重开本轮复核',
      resolved: false,
    }],
  }
  const comp = deps.store.update(deps.taskId, {
    attemptId: deps.attemptId,
    revision: deps.revision,
    status: 'failed',
  }, now())
  if (comp.ok) {
    // ① 主补偿：P1 failed（durable 账本真相）+ insufficient-evidence findings（随返回值留痕）。
    compensation.taken = 'p1-failed-insufficient-evidence'
    compensation.detail.p1 = { status: 'failed', revision: comp.revision }
    return { ok: false, compensation }
  }
  // ② 次补偿：update 不可行（已 terminal / 并发取代）→ escalation(sidecar-unwritable)。
  compensation.detail.p1Failure = { reason: comp.reason, from: comp.from, to: comp.to }
  if (deps.sidecar !== undefined) {
    const esc = deps.sidecar.escalate(deps.taskId, {
      reason: 'sidecar-unwritable',
      summary: `sidecar 写入 ${retries} 次失败且补偿 update 不可行（${comp.reason}）：现场交人工（§6.2 补偿路径②）`,
    })
    compensation.detail.escalation = esc.ok
      ? { ok: true, reason: 'sidecar-unwritable', gateState: deps.sidecar.gateOf(deps.taskId)?.gateState ?? null }
      : { ok: false, reason: esc.reason, detail: esc.detail }
    try {
      deps.sidecar.save()
      compensation.detail.escalationSaved = true
    } catch (e) {
      // sidecar 持续不可写：escalation 仅存内存态，仍随返回值上抛（不静默）。
      compensation.detail.escalationSaved = false
      compensation.detail.escalationSaveError = String(e)
    }
  } else {
    compensation.detail.escalation = { ok: false, reason: 'sidecar-instance-missing' }
  }
  compensation.taken = 'sidecar-unwritable-escalation'
  return { ok: false, compensation }
}
