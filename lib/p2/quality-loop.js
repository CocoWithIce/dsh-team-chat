/**
 * P3 修复/复核循环引擎 —— lib/p2/quality-loop.js
 *
 * t108 · P3 Slice 2（设计稿 v0.2 §4）：把 sidecar 里的元数据变成自动运转的循环。
 *
 * **仅三个自动动作（§4.1，零其余自动化）**：
 *   ① review 结算 needs_revision → 自动创建 repair 任务（findings 附带，依赖只指成功源）；
 *   ② repair 结算 completed → 自动排队 re-review；
 *   ③ 两者创建后 → 经 dispatchBatch 唤醒（P2 触发源 1 同款）。
 * 四重安全阀（取代 P2 H7 的依据）：触顶升级（§4.5）/ repair-failed 升级（§5.3）/
 * 创建前去重（§4.3）/ 派发前可用性前置（§4.4）。框架外「自动开修复」仍然禁止。
 *
 * 事务顺序（§6.2）：sidecar 内存先动（可校验、可回滚）→ P1 CAS → sidecar save
 * （带 §6.2 补偿）。P1 CAS 失败 → sidecar.load() 丢弃内存变更（回滚）。
 *
 * 依赖纪律（§4.2，t6/t50 教训）：repair 依赖 = [被审对象]（成功源），**永不指向
 * failed 的 review**；re-review 依赖 = [repair]。
 */

import { dispatchBatch } from './scheduler.js'
import { persistWithCompensation } from './quality-sidecar.js'

/**
 * 按 taskId 找 gate（本体 / pendingReview / pendingRepair / rounds / repairs 全查）。
 */
export function findGateForTask(sidecar, taskId) {
  return (
    sidecar.gateOf(taskId) ??
    sidecar.gateByReviewTask(taskId) ??
    sidecar.gateByRepairTask(taskId)
  )
}

/**
 * gate-busy 前置校验（§6.1）：kind∈{review,repair} 创建时，目标被审对象存在 gate
 * 且 gateState ∈ {in-review, in-repair} → 拒绝，载荷附现存任务 id。
 * gateState ∈ {open, needs-revision, escalated, closed} 不受限（§6.1 明文）。
 * @returns {{busy: boolean, activeTaskId?: string}}
 */
export function checkGateBusy(sidecar, sourceTaskId) {
  const gate = sidecar.gateOf(sourceTaskId)
  if (gate === undefined) return { busy: false }
  if (!['in-review', 'in-repair'].includes(gate.gateState)) return { busy: false }
  const activeTaskId =
    gate.pendingRepair?.repairTaskId ??
    gate.pendingReview?.reviewTaskId ??
    (gate.rounds ?? []).slice(-1)[0]?.reviewTaskId ??
    null
  return { busy: true, activeTaskId, gateState: gate.gateState }
}

/**
 * 同一 gate 内 repair 去重（§4.3-1）：已存在非 terminal 的 repair 任务 → 不新建，
 * 返回既有任务 id（走 dispatchBatch 唤醒既有）。
 */
export function findOpenRepair(store, sidecar, sourceTaskId) {
  const gate = sidecar.gateOf(sourceTaskId)
  if (gate === undefined) return null
  const ids = new Set()
  if (gate.pendingRepair?.repairTaskId) ids.add(gate.pendingRepair.repairTaskId)
  for (const r of gate.repairs ?? []) if (r.repairTaskId) ids.add(r.repairTaskId)
  for (const id of ids) {
    const task = store.tasks.get(id)
    if (task !== undefined && !store.isTerminal(id)) return id
  }
  return null
}

/** needs_revision 摘要与 findings 引用文本（repair objective 组装，§4.3-3）。 */
function repairObjective(gate, findings, output) {
  const ids = findings.map((f) => f.id).join(', ')
  const head = `round ${gate.round} needs_revision：${output ?? '评审未通过'}`
  return `${head}\nfindings 全文见 quality sidecar gate(${gate.taskId})（ids: ${ids}）——按 requiredFix 逐条修复`
}

/**
 * ①+②+触顶：review 任务结算（单一写入函数，队长工具与 B′ report 共用，§6.3）。
 *
 * 事务顺序：E15 追加 finding（内存）→ sidecar.settleRound（内存，含全部一致性校验，
 * 校验失败零副作用）→ P1 CAS（失败 → sidecar.load() 回滚内存）→ sidecar.save()
 * （§6.2 补偿；补偿触发 = 结算作废，跳过循环动作）→ 循环动作（触顶升级 / 去重 /
 * 创建 repair / 唤醒）。
 *
 * @param deps - { store, sidecar, reviewGuard?, dispatch?, now? }
 *   dispatch: (task) => Promise — 创建/复用后的唤醒边界（dispatchBatch 单拍包装）。
 * @param input - { reviewTaskId, verdict, findings?, acceptanceResults?, output?,
 *                  attemptId, revision, reviewer?, repairAssignee? }
 */
export function settleReviewTask(deps, input) {
  const { store, sidecar } = deps
  const now = deps.now ?? (() => Date.now())
  const reviewTask = store.tasks.get(input.reviewTaskId)
  if (reviewTask === undefined) return { ok: false, reason: 'task-not-found', taskId: input.reviewTaskId }
  if (reviewTask.kind !== 'review') return { ok: false, reason: 'not-a-review-task', taskId: input.reviewTaskId }
  const gate = sidecar.gateByReviewTask(input.reviewTaskId)
  if (gate === undefined) return { ok: false, reason: 'gate-not-found', taskId: input.reviewTaskId }
  const sourceTaskId = gate.taskId

  // §4.8：E15 警告不阻断结算，但必须写入当轮 findings（severity=high）。
  const findings = (input.findings ?? []).map((f) => ({ ...f }))
  if (deps.reviewGuard !== undefined) {
    const compare = deps.reviewGuard.compareFor({ id: input.reviewTaskId, inScope: reviewTask.inScope })
    if (compare && compare.match === false) {
      findings.push({
        id: 'E15',
        severity: 'high',
        problem: `E15 复核窗口零修订被破坏：${(compare.changed ?? []).length} 个被审文件在复核窗口内被修改`,
        requiredFix: '回滚未声明的修改，或由队长按升级裁决（A-D）处置',
        resolved: false,
      })
    }
  }

  // 先 sidecar 内存结算（全部一致性校验在此，失败零副作用）。
  const settled = sidecar.settleRound(sourceTaskId, {
    reviewTaskId: input.reviewTaskId,
    reviewer: input.reviewer,
    verdict: input.verdict,
    findings,
    acceptanceResults: input.acceptanceResults,
    output: input.output,
    settledAt: now(),
  })
  if (!settled.ok) return { ok: false, reason: settled.reason, detail: settled.detail, taskId: input.reviewTaskId }

  // P1 CAS（§4.2 映射：pass→completed；needs_revision/reject→failed）。
  const mapped = input.verdict === 'pass' ? 'completed' : 'failed'
  const updated = store.update(input.reviewTaskId, {
    attemptId: input.attemptId,
    revision: input.revision,
    status: mapped,
  }, now())
  if (!updated.ok) {
    sidecar.load() // 回滚内存变更（磁盘为准）
    return { ok: false, reason: 'p1-update-failed', detail: { reason: updated.reason, from: updated.from, to: updated.to }, taskId: input.reviewTaskId }
  }

  // sidecar 落盘（§6.2 补偿契约：重试 N → 补偿 update / escalation；补偿触发 =
  // 结算作废，循环动作不继续）。
  const persisted = persistWithCompensation({
    store,
    taskId: input.reviewTaskId,
    attemptId: input.attemptId,
    revision: updated.revision,
    write: () => sidecar.save(),
    sidecar,
    retries: deps.retries,
    now,
  })
  if (persisted.ok === false) {
    return {
      ok: false,
      reason: 'settlement-voided',
      detail: '§6.2：sidecar 持久化失败且补偿已执行（结算作废为证据链不完整）',
      compensation: persisted.compensation,
      taskId: input.reviewTaskId,
    }
  }

  const round = settled.round
  const result = { ok: true, outcome: null, round, sourceTaskId, reviewTaskId: input.reviewTaskId, dispatch: null }

  if (input.verdict === 'pass') {
    result.outcome = 'closed'
    return result
  }
  if (input.verdict === 'reject') {
    result.outcome = 'escalated'
    result.escalation = sidecar.gateOf(sourceTaskId).escalation
    return result
  }

  // needs_revision：§4.5 触顶检查（round 达 maxRounds → 升级，不再创建 repair）。
  if (gate.round >= gate.maxRounds) {
    const esc = sidecar.escalate(sourceTaskId, {
      reason: 'round-limit-exceeded',
      summary: `round ${gate.round} 已达 maxRounds=${gate.maxRounds} 仍 needs_revision：触顶升级，交人工裁决（§4.5；「再多来一轮就好」之外的规格/范围问题见 pendingInputs）`,
    })
    const saved = scSave(deps)
    result.outcome = 'escalated'
    result.escalation = esc.ok ? sidecar.gateOf(sourceTaskId).escalation : { invalid: esc }
    result.escalationSave = saved
    return result
  }

  // §4.3 去重：已存在非 terminal repair → 复用并唤醒，不新建。
  const existing = findOpenRepair(store, sidecar, sourceTaskId)
  if (existing !== null) {
    result.outcome = 'repair-reused'
    result.repairTaskId = existing
    result.dispatch = dispatchCreated(deps, existing)
    return result
  }

  // 自动创建 repair（§4.2 依赖只指成功源；§4.3-3 创建参数）。
  const target = store.tasks.get(sourceTaskId)
  const created = store.createTask({
    kind: 'repair',
    subject: `repair-round-${gate.round + 1}`,
    objective: repairObjective(gate, findings, input.output),
    acceptance: ['本轮 findings（F*）逐条 resolved', '不破坏既有验收：被审对象原 acceptance 重跑全绿'],
    inScope: (target?.inScope ?? reviewTask.inScope ?? []).slice(),
    verify: [
      ...(target?.verify ?? []),
      ...findings.filter((f) => typeof f.requiredFix === 'string' && f.requiredFix !== '').map((f) => `验证 ${f.id}: ${f.requiredFix}`),
    ],
    dependencies: [sourceTaskId],
    assignee: input.repairAssignee ?? '',
  }, now())
  if (!created.ok) return { ok: false, reason: 'repair-create-failed', detail: created }
  sidecar.gateOf(sourceTaskId).pendingRepair = {
    repairTaskId: created.task.id,
    sourceFindingIds: findings.map((f) => f.id),
    claimedAt: null,
  }
  result.outcome = 'repair-created'
  result.repairTaskId = created.task.id
  result.repairTask = created.task
  result.dispatch = dispatchCreated(deps, created.task)
  return result
}

/**
 * ② repair 结算（completed → 排队 re-review；failed → 升级 repair-failed）。
 * 事务顺序同 settleReviewTask：P1 CAS 先行（此路径 sidecar 动作均在 CAS 之后，
 * CAS 失败零 sidecar 副作用）→ sidecar（recordRepair/resolveFindings/升级/排队）
 * → save（补偿）→ 唤醒。
 * @param input - { repairTaskId, status: 'completed'|'failed', attemptId, revision,
 *                  output?, sourceFindingIds?, reviewAssignee? }
 */
export function settleRepairTask(deps, input) {
  const { store, sidecar } = deps
  const now = deps.now ?? (() => Date.now())
  const repairTask = store.tasks.get(input.repairTaskId)
  if (repairTask === undefined) return { ok: false, reason: 'task-not-found', taskId: input.repairTaskId }
  const gate = sidecar.gateByRepairTask(input.repairTaskId)
  if (gate === undefined) return { ok: false, reason: 'gate-not-found', taskId: input.repairTaskId }
  const sourceTaskId = gate.taskId

  const updated = store.update(input.repairTaskId, {
    attemptId: input.attemptId,
    revision: input.revision,
    status: input.status,
  }, now())
  if (!updated.ok) {
    return { ok: false, reason: 'p1-update-failed', detail: { reason: updated.reason, from: updated.from, to: updated.to }, taskId: input.repairTaskId }
  }

  const sourceFindingIds = input.sourceFindingIds ?? gate.pendingRepair?.sourceFindingIds ?? []
  sidecar.recordRepair(sourceTaskId, {
    repairTaskId: input.repairTaskId,
    sourceFindingIds,
    settledAt: now(),
  })
  sidecar.resolveFindings(sourceTaskId, sourceFindingIds)

  if (input.status === 'failed') {
    // §5.3 repair-failed：修复本身失败——不给「无限修复」出口。
    sidecar.escalate(sourceTaskId, {
      reason: 'repair-failed',
      summary: `repair 任务 ${input.repairTaskId} 结算 failed：修复本身失败，交人工裁决（§5.3）`,
    })
    const saved = scSave(deps)
    return { ok: true, outcome: 'escalated', sourceTaskId, escalation: gate.escalation, escalationSave: saved }
  }

  // §4.4 可用性前置：全员不可用 → 不创建 review（零账本污染），记 waitingReviewer。
  if (deps.registry !== undefined && deps.memberIds !== undefined) {
    const anyAvailable = deps.memberIds.some((id) => deps.registry.availabilityOf(id) === 'online')
    if (!anyAvailable) {
      sidecar.setWaitingReviewer(sourceTaskId, { repairTaskId: input.repairTaskId })
      const saved = scSave(deps)
      return { ok: true, outcome: 'waiting-reviewer', sourceTaskId, save: saved }
    }
  }

  // 自动排队 re-review（§4.4：依赖 = [repair]，inScope 同被审文件集）。
  const target = store.tasks.get(sourceTaskId)
  const created = store.createTask({
    kind: 'review',
    subject: `review-round-${gate.round + 1}`,
    objective: `对照被审对象 ${sourceTaskId} 的 acceptance 逐条验收 + 上轮 findings 逐条 resolved 复核`,
    inScope: (target?.inScope ?? []).slice(),
    acceptance: (target?.acceptance ?? []).slice(),
    verify: [],
    dependencies: [input.repairTaskId],
    assignee: input.reviewAssignee ?? '',
  }, now())
  if (!created.ok) return { ok: false, reason: 'review-create-failed', detail: created }
  const queued = sidecar.queueReview(sourceTaskId, { reviewTaskId: created.task.id })
  if (!queued.ok) return { ok: false, reason: 'queue-review-failed', detail: queued }
  const saved = scSave(deps)
  return { ok: true, outcome: 'review-queued', sourceTaskId, reviewTaskId: created.task.id, reviewTask: created.task, save: saved, dispatch: dispatchCreated(deps, created.task) }
}

/** re-review 排队后的唤醒（由调用方在可用后触发；waiting-reviewer 复活入口）。 */
export function retryWaitingReview(deps, sourceTaskId, { reviewAssignee } = {}) {
  const { store, sidecar, registry, memberIds } = deps
  const gate = sidecar.gateOf(sourceTaskId)
  if (gate === undefined || gate.waitingReviewer === undefined) return { ok: false, reason: 'no-waiting-review' }
  if (registry !== undefined && memberIds !== undefined) {
    const anyAvailable = memberIds.some((id) => registry.availabilityOf(id) === 'online')
    if (!anyAvailable) return { ok: false, reason: 'still-unavailable' }
  }
  const repairTaskId = gate.waitingReviewer.repairTaskId
  const target = store.tasks.get(sourceTaskId)
  const created = store.createTask({
    kind: 'review',
    subject: `review-round-${gate.round + 1}`,
    objective: `对照被审对象 ${sourceTaskId} 的 acceptance 逐条验收 + 上轮 findings 逐条 resolved 复核`,
    inScope: (target?.inScope ?? []).slice(),
    acceptance: (target?.acceptance ?? []).slice(),
    verify: [],
    dependencies: [repairTaskId],
    assignee: reviewAssignee ?? '',
  }, deps.now?.() ?? Date.now())
  if (!created.ok) return { ok: false, reason: 'review-create-failed', detail: created }
  const queued = sidecar.queueReview(sourceTaskId, { reviewTaskId: created.task.id })
  if (!queued.ok) return { ok: false, reason: 'queue-review-failed', detail: queued }
  return { ok: true, outcome: 'review-queued', reviewTaskId: created.task.id, reviewTask: created.task }
}

/** §5.3 reviewer-unavailable 阈值升级（机会式检查，无定时器；建议阈值 30min=§9 同 P1 D8）。 */
export function escalateIfWaitingTooLong(deps, sourceTaskId, thresholdMs) {
  const { sidecar } = deps
  if (!sidecar.waitingReviewerExpired(sourceTaskId, thresholdMs)) return { ok: false, reason: 'not-expired' }
  const esc = sidecar.escalate(sourceTaskId, {
    reason: 'reviewer-unavailable',
    summary: `waitingReviewer 持续 ${thresholdMs}ms 无可用成员：按 §5.3 升级交人工（D：轮换/复位后重开）`,
  })
  const saved = scSave(deps)
  return { ok: esc.ok, outcome: 'escalated', escalation: sidecar.gateOf(sourceTaskId)?.escalation, escalationSave: saved }
}

// ────────────────────────── 内部 ──────────────────────────

/** 结算落盘（§6.2 补偿）：gates 内存态 → quality.json。 */
function persistSettle(deps, round) {
  if (deps.sidecar === undefined) return { ok: true }
  try {
    return { ...deps.sidecar.save(), round }
  } catch (e) {
    // save 本身不抛（fs 注入可能抛）——走补偿契约由调用方语义承接。
    const compensation = { taken: 'sidecar-save-threw', detail: String(e) }
    return { ok: false, compensation }
  }
}

function scSave(deps) {
  if (deps.sidecar === undefined) return { ok: true, noop: true }
  try {
    return deps.sidecar.save()
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/** 创建/复用后的唤醒（③ dispatchBatch，E9 单拍）。 */
function dispatchCreated(deps, task) {
  if (deps.dispatch === undefined) return { skipped: 'no-dispatch-bound' }
  try {
    const r = deps.dispatch(task)
    return { dispatched: true, result: r === undefined ? null : r }
  } catch (e) {
    return { dispatched: false, error: String(e) }
  }
}
