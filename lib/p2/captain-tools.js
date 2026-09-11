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

export const CAPTAIN_TOOLS = {
  team_create_task: {
    name: 'team_create_task',
    description: '建任务（subject 必填，P1 拓扑校验拒环/自依赖/悬空）；成功后经 pickMemberToWake 触发一次池检查唤醒（§2.3 触发源 1，可关）。',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: '任务标题（必填）' },
        objective: { type: 'string', description: '可选：完成目标' },
        assignee: { type: 'string', description: '可选：定向成员名（空 = 入池）' },
        dependencies: { type: 'array', items: { type: 'string' }, description: '可选：依赖任务 id 列表' },
        kind: { type: 'string', description: '可选：任务种类（work/review/…，review 触发 E15 指纹守卫）' },
        inScope: { type: 'array', items: { type: 'string' }, description: '可选：范围内文件（review 任务被 E15 快照的集合）' },
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
 * @param {object} deps - { store, registry, memberIds, wake, now? }
 * @param {object} input - create_task 参数（subject 必填）。
 * @returns {Promise<object>} { ok, taskId?, task?, wake?, reason? }
 */
export async function createCaptainTask(deps, input) {
  if (input === undefined || typeof input.subject !== 'string' || input.subject.trim() === '') {
    return { ok: false, reason: 'subject-required' }
  }
  const now = deps.now ?? Date.now()
  const created = deps.store.createTask({
    subject: input.subject,
    objective: input.objective,
    assignee: input.assignee ?? '',
    dependencies: input.dependencies ?? [],
    kind: input.kind,
    inScope: input.inScope,
  }, now)
  if (!created.ok) return { ok: false, reason: created.reason, detail: created }
  const task = created.task
  // §2.3 触发源 1：建任务后一次池检查（复用 scheduler.js 的 dispatchBatch；
  // E9 maxWakes=1 纪律保持；wake:false 时队长手动唤醒）。
  if (input.wake === false) {
    return { ok: true, taskId: task.id, task, wake: { skipped: 'wake-disabled' } }
  }
  const dispatch = await dispatchBatch(deps, [task])
  return { ok: true, taskId: task.id, task, wake: dispatch }
}

/**
 * ② update_task：CAS 迁移；review 任务完成时 E15 比对（不匹配即警告，不阻断）。
 * @param {object} deps - { store, reviewGuard?, now? }
 *   reviewGuard: { compareFor(task): { match, changed?, reason? } | null }（E15 接线，可省）。
 * @param {object} input - { taskId, attemptId, revision, status }。
 */
export function updateCaptainTask(deps, input) {
  if (input === undefined || input.taskId === undefined) return { ok: false, reason: 'taskId-required' }
  const task = deps.store.tasks.get(input.taskId)
  if (task === undefined) return { ok: false, reason: 'task-not-found', taskId: input.taskId }
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
 * ④ status：注册表 + 任务池投影 + 可派队列。
 * @param {object} deps - { store, registry, memberIds }
 */
export function captainStatus(deps) {
  const members = deps.memberIds.map((id) => ({
    name: id,
    availability: deps.registry.availabilityOf(id),
    consecutiveFailures: deps.registry.consecutiveFailuresOf(id),
    lastResponseAt: deps.registry.lastResponseAtOf(id),
    inFlight: [...deps.registry.inFlightOf(id)],
  }))
  return {
    ok: true,
    members,
    tasks: deps.store.snapshot().tasks,
    readyQueue: readyTasksOf(deps.store).map((t) => t.id),
  }
}
