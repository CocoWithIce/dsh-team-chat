/**
 * 队长工具面 ×4 —— lib/p2/captain-tools.js
 *
 * t96 · P2 Slice 2（设计稿 v0.7 §6 最小集：create_task 75 / update_task 134 /
 * send_message 199 / status 74，合计 ≈84% 调用量，t48/t55 快照口径）。
 *
 * 形态与 B′ 成员工具（claim-channel.js）同构：DTO（平台注册面的输入形状）+
 * 依赖注入执行器（宿主侧直调 P1 store 与 scheduler.js 接线，零 HTTP）。
 * 注册名统一 `team_` 前缀（与 team_claim_task/team_report_task 同命名空间纪律，
 * 与 AgentTeams 的 agent_teams_* 结构性隔离，§9.1.1）：契约名 → 注册名映射
 * create_task→team_create_task / update_task→team_update_task /
 * send_message→team_send_message / status→team_status。
 *
 * apply 纪律不变：本模块只提供注册件与执行器；是否对 captain 会话生效由
 * 宿主装配显式决定（§9.1.1 过渡期 AgentTeams 仍在跑，apply 零自动动作）。
 */

import { readyTasksOf, dispatchBatch } from './scheduler.js'
import { pickMemberToWake } from './scheduler-core.js'
import { checkGateBusy, settleReviewTask } from './quality-loop.js'

export const CAPTAIN_TOOLS = {
  team_create_task: {
    name: 'team_create_task',
    description: '建任务（subject 必填，P1 拓扑校验拒环/自依赖/悬空）；成功后经 pickMemberToWake 触发一次池检查唤醒（§2.3 触发源 1，可关）。P3：契约四件套 + gate 感知（gate-busy）+ supersedes 取代。',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: '任务标题（必填）' },
        objective: { type: 'string', description: '可选：完成目标' },
        assignee: { type: 'string', description: '可选：定向成员名（空 = 入池）' },
        dependencies: { type: 'array', items: { type: 'string' }, description: '可选：依赖任务 id 列表' },
        kind: { type: 'string', description: '可选：任务种类（work/implementation/review/repair/verification…，review/repair 须带 sourceTaskId）' },
        inScope: { type: 'array', items: { type: 'string' }, description: '可选：范围内文件（review 任务被 E15 快照的集合）' },
        acceptance: { type: 'array', items: { type: 'string' }, description: 'implementation/repair/verification 类必填（§3.2 契约四件套）' },
        verify: { type: 'array', items: { type: 'string' }, description: '同上条件必填；应含至少一条「能变红」对照命令' },
        constraints: { type: 'string', description: '可选数组：约束（语言/版本/平台/依赖/路径规范）' },
        knownRisks: { type: 'array', items: { type: 'string' }, description: '可选数组：已知风险' },
        maxRounds: { type: 'number', description: '可选：gate 轮数上限覆盖（默认 4，G1）' },
        sourceTaskId: { type: 'string', description: 'review/repair 任务必填：被审对象 id（gate 定位 + 溯源）' },
        supersedes: {
          type: 'object',
          description: '可选：取代语义（创建成功后对目标执行 supersede；失败整体失败并回滚新任务）',
          properties: {
            taskId: { type: 'string', description: '被取代任务 id' },
            revision: { type: 'number', description: '被取代任务当前 revision（显式校验）' },
          },
          required: ['taskId', 'revision'],
        },
        wake: { type: 'boolean', description: '可选：建后是否自动唤醒（默认 true，config 可关）' },
      },
      required: ['subject'],
    },
  },
  team_update_task: {
    name: 'team_update_task',
    description: 'CAS 迁移任务状态（attemptId + revision；stale 诚实拒绝）。review 任务 completed 时自动执行 E15 指纹比对，不匹配即警告（不阻断）。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '目标任务 id' },
        attemptId: { type: 'string', description: '当前执行 attempt（claim 所得）' },
        revision: { type: 'number', description: 'CAS 期望 revision' },
        status: { type: 'string', description: '目标状态（running/completed/failed）' },
      },
      required: ['taskId', 'attemptId', 'revision', 'status'],
    },
  },
  team_send_message: {
    name: 'team_send_message',
    description: '队长↔成员消息两用（§6-3）：自由协作消息，或带 taskId 元数据的正式调度唤醒（kind:wake，F3 双通道主路径）。',
    parameters: {
      type: 'object',
      properties: {
        memberName: { type: 'string', description: '目标成员名（注册表内）' },
        taskId: { type: 'string', description: '可选：携带的任务 id（ presence 即 wake 语义，F3 主通道）' },
        text: { type: 'string', description: '消息正文' },
      },
      required: ['memberName', 'text'],
    },
  },
  team_status: {
    name: 'team_status',
    description: '团队快照：成员注册表（可用性/在途/连败）+ 任务池投影 + 可派队列。',
    parameters: { type: 'object', properties: {} },
  },
}

/** 队长工具注册名清单（team_ 前缀命名空间）。 */
export const CAPTAIN_TOOL_NAMES = Object.keys(CAPTAIN_TOOLS)

/**
 * ① create_task：建任务 + 一次池检查唤醒（§2.3 触发源 1）。
 * t108 · P3 Slice 2（§6.1/§6.3 扩展）：
 *   - 补透传 acceptance/verify（t100 §6.1 实测缺口）与 constraints/knownRisks（store v2 列）；
 *   - 契约四件套必选性校验（§3.2：implementation/repair/verification 类 acceptance/verify 必填）；
 *   - gate 感知：kind∈{review,repair} 创建时 checkGateBusy（in-review/in-repair → gate-busy）；
 *     escalated gate → 新输入排队（§4.7/§4.8 升级期冻结）；成功后 openGate（被审对象建档）；
 *   - supersedes：创建成功后对目标执行 store.supersede（显式 revision；失败 → 回滚新任务并整体失败）。
 * @param {object} deps - { store, registry, memberIds, wake, sidecar?, reviewGuard?, now? }
 * @param {object} input - create_task 参数（subject 必填）。
 * @returns {Promise<object>} { ok, taskId?, task?, wake?, gate?, reason? }
 */
export async function createCaptainTask(deps, input) {
  if (input === undefined || typeof input.subject !== 'string' || input.subject.trim() === '') {
    return { ok: false, reason: 'subject-required' }
  }
  const now = deps.now ?? Date.now()
  const kind = input.kind === undefined || input.kind === '' ? 'work' : String(input.kind)

  // §6.1 gate 感知（review/repair 创建）先于契约必选性校验：目标态是创建可行性的前提。
  if (deps.sidecar !== undefined && (kind === 'review' || kind === 'repair')) {
    if (input.sourceTaskId === undefined || input.sourceTaskId === '') {
      return { ok: false, reason: 'source-required', detail: `${kind} 任务必须声明 sourceTaskId（被审对象）` }
    }
    const busy = checkGateBusy(deps.sidecar, input.sourceTaskId)
    if (busy.busy && input.supersedes === undefined) {
      return {
        ok: false,
        reason: 'gate-busy',
        detail: `目标 ${input.sourceTaskId} 的 gate 处于 ${busy.gateState}：已有活跃任务承载本轮循环（§6.1）`,
        activeTaskId: busy.activeTaskId,
        gateState: busy.gateState,
      }
    }
    const gate = deps.sidecar.gateOf(input.sourceTaskId)
    if (gate !== undefined && gate.gateState === 'escalated') {
      // §4.7/§4.8 升级期冻结：新输入排队不执行，人工裁决后由新任务承载。
      deps.sidecar.addPendingInput(input.sourceTaskId, {
        from: 'create_task',
        summary: `${kind} 创建请求在升级期到达，已排队：${input.subject}`,
      })
      return { ok: false, reason: 'escalated-queued', queued: true, detail: '升级期冻结：新输入已排队（pendingInputs），待人工裁决后承载' }
    }
  }

  // §3.2 必选性执行（工具层校验；store 纯核心不假设调用方语义）。
  if (['implementation', 'repair', 'verification'].includes(kind)) {
    if (!Array.isArray(input.acceptance) || input.acceptance.length === 0) {
      return { ok: false, reason: 'acceptance-required', detail: `${kind} 类任务 acceptance 必填（契约四件套 §3.2）` }
    }
    if (!Array.isArray(input.verify) || input.verify.length === 0) {
      return { ok: false, reason: 'verify-required', detail: `${kind} 类任务 verify 必填（§3.2 条件必选）` }
    }
  }

  const created = deps.store.createTask({
    subject: input.subject,
    objective: input.objective,
    assignee: input.assignee ?? '',
    dependencies: input.dependencies ?? [],
    kind,
    inScope: input.inScope,
    acceptance: input.acceptance,
    verify: input.verify,
    constraints: input.constraints,
    knownRisks: input.knownRisks,
  }, now)
  if (!created.ok) return { ok: false, reason: created.reason, detail: created }
  const task = created.task

  // gate 建档（被审对象；review/repair 挂在目标 gate 上，不建档）。supersede 失败 → 回滚新任务 + 整体失败。
  if (deps.sidecar !== undefined && ['implementation', 'repair', 'work'].includes(kind)) {
    const opened = deps.sidecar.openGate(task.id, {
      maxRounds: input.maxRounds,
      constraints: input.constraints,
      knownRisks: input.knownRisks,
    })
    if (!opened.ok && opened.reason !== 'gate-exists') return { ok: false, reason: 'gate-open-failed', detail: opened }
  }
  if (input.supersedes !== undefined && deps.sidecar !== undefined && ['review', 'repair'].includes(kind)) {
    const sup = deps.store.supersede(input.supersedes.taskId, {
      revision: input.supersedes.revision,
      supersededBy: task.id,
    }, now)
    if (!sup.ok) {
      // §6.1：取代失败则整体失败——回滚刚创建的任务（supersededBy=null 自我作废）。
      deps.store.supersede(task.id, { revision: task.revision, supersededBy: null }, now)
      return { ok: false, reason: 'supersede-failed', detail: sup, rolledBack: task.id }
    }
    syncGateOnSupersede(deps.sidecar, input.supersedes.taskId, { supersededBy: task.id, mode: 'closed' })
  }

  // §2.3 触发源 1：建任务后一次池检查（复用 scheduler.js 的 dispatchBatch；
  // E9 maxWakes=1 纪律保持；wake:false 时队长手动唤醒）。
  if (input.wake === false) {
    return { ok: true, taskId: task.id, task, gate: deps.sidecar?.gateOf(task.id) ?? undefined, wake: { skipped: 'wake-disabled' } }
  }
  const dispatch = await dispatchBatch(deps, [task])
  return { ok: true, taskId: task.id, task, gate: deps.sidecar?.gateOf(task.id) ?? undefined, wake: dispatch }
}

/**
 * §4.6 supersede 执行路径的 gate 同步处置（t102 v0.2）：被作废任务存在非 closed gate →
 * 二选一（默认 escalated/subject-superseded；supersededBy 显式承接时 closed+标注）+ 挂起循环。
 * @returns {object|null} 处置记录（无 gate 时 null）。
 */
export function syncGateOnSupersede(sidecar, supersededTaskId, { supersededBy, mode } = {}) {
  const gate = sidecar.gateOf(supersededTaskId)
  if (gate === undefined || gate.gateState === 'closed') return null
  if (mode === 'closed') {
    gate.gateState = 'closed'
    gate.supersededBy = supersededBy ?? null
  } else {
    sidecar.escalate(supersededTaskId, {
      reason: 'subject-superseded',
      summary: `被审对象 ${supersededTaskId} 被作废（supersededBy=${supersededBy ?? 'null'}）：保留审计现场待人工（§4.6）`,
    })
  }
  gate.loopSuspended = true
  gate.updatedAt = Date.now()
  return { taskId: supersededTaskId, gateState: gate.gateState, supersededBy: gate.supersededBy ?? null, loopSuspended: true }
}

/**
 * ② update_task：CAS 迁移；review 任务结算（verdict/findings）经循环引擎
 * （settleReviewTask 单一写入函数，与 B′ report 共用，§6.3/§6.2）；非 review 或
 * 未带 verdict → 纯 CAS（E15 比对保留）。
 * @param {object} deps - { store, sidecar?, reviewGuard?, now? }
 * @param {object} input - { taskId, attemptId, revision, status?, verdict?, findings?, acceptanceResults?, output? }。
 */
export function updateCaptainTask(deps, input) {
  if (input === undefined || input.taskId === undefined) return { ok: false, reason: 'taskId-required' }
  const task = deps.store.tasks.get(input.taskId)
  if (task === undefined) return { ok: false, reason: 'task-not-found', taskId: input.taskId }
  // P3 §6.2：review 任务带 verdict 结算 → 循环引擎（needs_revision 自动 repair /
  // 触顶升级 / pass 关门；P1 映射 pass→completed、其余→failed 在引擎内）。
  if (deps.sidecar !== undefined && task.kind === 'review' && input.verdict !== undefined) {
    return settleReviewTask(deps, {
      reviewTaskId: input.taskId,
      verdict: input.verdict,
      findings: input.findings,
      acceptanceResults: input.acceptanceResults,
      output: input.output,
      attemptId: input.attemptId,
      revision: input.revision,
    })
  }
  const res = deps.store.update(input.taskId, {
    attemptId: input.attemptId,
    revision: input.revision,
    status: input.status,
  }, deps.now ?? Date.now())
  if (!res.ok) {
    // CAS 诚实失败：stale-revision / attempt-mismatch / illegal-transition 原样上抛。
    return { ok: false, reason: res.reason, taskId: input.taskId, currentRevision: res.currentRevision, from: res.from, to: res.to }
  }
  const result = { ok: true, taskId: input.taskId, status: input.status, revision: res.revision }
  // E15：review 任务 completed → 自动比对指纹（设计 §10：不匹配即警告，不阻断）。
  if (input.status === 'completed' && task.kind === 'review' && deps.reviewGuard !== undefined) {
    result.reviewGuard = deps.reviewGuard.compareFor(task)
  }
  return result
}

/**
 * ③ send_message：自由消息 + wake 双用（F3 双通道主路径）。
 * 携带 taskId = 正式调度唤醒（kind:wake 元数据，便于统计区分自由消息——§6-3）。
 * @param {object} deps - { registry, memberIds, wake, now? }
 *   wake(memberName, task, meta) — 与 dispatchBatch 同一边界（生产=sendMessage）。
 * @param {object} input - { memberName, taskId?, text }。
 */
export async function sendCaptainMessage(deps, input) {
  if (input === undefined || typeof input.memberName !== 'string' || input.memberName === '') {
    return { ok: false, reason: 'member-required' }
  }
  if (typeof input.text !== 'string' || input.text === '') return { ok: false, reason: 'text-required' }
  if (!deps.memberIds.includes(input.memberName)) {
    return { ok: false, reason: 'unknown-member', memberName: input.memberName }
  }
  const now = deps.now ?? Date.now()
  const isWake = input.taskId !== undefined && input.taskId !== ''
  const meta = { kind: isWake ? 'wake' : 'message', text: input.text, taskId: isWake ? input.taskId : undefined }
  let wakePayload = null
  if (isWake) {
    wakePayload = deps.store.tasks.get(input.taskId) ?? { id: input.taskId }
    // 定向唤醒走真实选序边界（不绕过熔断/可用性——E9 语义）。
    const picked = pickMemberToWake(deps.registry, { id: input.taskId, assignee: input.memberName }, deps.memberIds)
    if (picked !== input.memberName) {
      return { ok: false, reason: picked === null ? 'member-unavailable' : 'member-not-eligible', memberName: input.memberName }
    }
  }
  let delivered = true
  let error = null
  try {
    delivered = await deps.wake(input.memberName, wakePayload ?? { id: null }, meta) !== false
    if (!delivered) error = 'wake-reported-failure'
  } catch (e) {
    delivered = false
    error = String(e)
  }
  if (!delivered) {
    // 与 dispatchBatch 同款真实信号记账（熔断数据源一致）。
    const rec = deps.registry.recordFailure(input.memberName, error, now)
    return { ok: false, reason: 'wake-failed', error, breached: rec.breached, availability: rec.availability, memberName: input.memberName }
  }
  // 只有调度唤醒（送达）才记账活动——自由消息不改变可用性（不洗白熔断，E9 语义）。
  if (isWake) {
    deps.registry.markActive(input.memberName, now)
    deps.registry.markInFlight(input.memberName, input.taskId)
  }
  return { ok: true, memberName: input.memberName, kind: meta.kind, taskId: isWake ? input.taskId : undefined }
}

/**
 * ④ status：注册表 + 任务池投影 + 可派队列 + gate 视图（§6.4：escalated 置顶）。
 * @param {object} deps - { store, registry, memberIds, sidecar? }
 */
export function captainStatus(deps) {
  const members = deps.memberIds.map((id) => ({
    name: id,
    availability: deps.registry.availabilityOf(id),
    consecutiveFailures: deps.registry.consecutiveFailuresOf(id),
    lastResponseAt: deps.registry.lastResponseAtOf(id),
    inFlight: [...deps.registry.inFlightOf(id)],
  }))
  const result = {
    ok: true,
    members,
    tasks: deps.store.snapshot().tasks,
    readyQueue: readyTasksOf(deps.store).map((t) => t.id),
  }
  // §6.4 gate 视图（P3）：escalated 置顶；明细不进 status（防载荷膨胀）。
  if (deps.sidecar !== undefined) {
    const lastVerdict = (gate) => (gate.rounds ?? []).slice(-1)[0]?.verdict ?? null
    result.gates = (deps.sidecar.allGates() ?? [])
      .map((gate) => ({
        taskId: gate.taskId,
        gateState: gate.gateState,
        round: gate.round,
        maxRounds: gate.maxRounds,
        lastVerdict: lastVerdict(gate),
        waitingReviewer: gate.waitingReviewer !== undefined && gate.waitingReviewer !== null,
        escalationDigest: gate.escalation === null || gate.escalation === undefined
          ? null
          : { reason: gate.escalation.reason, trend: gate.escalation.findingsDigest?.trend ?? null },
        pendingInputsCount: (gate.pendingInputs ?? []).length,
        orphaned: gate.orphaned === true,
      }))
      .sort((a, b) => {
        const ea = a.gateState === 'escalated' ? 0 : 1
        const eb = b.gateState === 'escalated' ? 0 : 1
        if (ea !== eb) return ea - eb
        return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0
      })
  }
  return result
}
