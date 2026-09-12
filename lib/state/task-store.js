/**
 * P1 状态层核心（v4.3 设计稿 §1–§7）—— lib/state/task-store.js
 *
 * 纯核心模块：不 import lib/index.js / lib/client.js，不依赖插件运行时，
 * 可在裸 node 下单元测试（node --test test/task-state.test.mjs）。
 *
 * 章节 → 实现对照（可追溯性）：
 *   §1  TaskRecord schema          → createTask 构造的任务字段（status/attemptId/
 *                                     attempt/revision/claimedAt/startedAt/
 *                                     lastSignalAt/supersededBy/
 *                                     dependencySupersededAt/dependencyFailedAt/
 *                                     stallMarked/suspended/createdAt/updatedAt）
 *   §2  状态机 + S1/S2             → TRANSITIONS 合法迁移表 + transitionAllowed
 *                                   （拒绝非法迁移，明确错误）；S1/S2 环/自依赖 →
 *                                   createTask 入口 Kahn 拓扑排序（findCycle）
 *   §2.1 S6 supersede 链           → _validateSupersedeChain（visited + 深度上限）
 *   §3  依赖失效                   → terminal + dependencyBlocked + taskOpen +
 *                                    dependencySupersededAt/dependencyFailedAt 传播
 *   §4  可判定性 reclaim 谓词      → canReclaim（宿主注入 observeIdle / 信号观察，
 *                                   startedAt 仅记录不参与判定；未知态保守不回收）
 *   §4.3 S7B 原子化                → 仅 claimed 可 reclaim；running 走 stall→suspended
 *   §4.5 修法⑦ activity 续租       → observeActivity：suspended 收到新活动自动回 running
 *   §5  停滞判定 + F3 出口         → stallMark + suspend + resume/reassign/supersede
 *                                   三出口 + checkUnattended 超时自动 superseded
 *                                   （「永远挂着」不可达）
 *   §6  API / S13 claim 原子性     → claim 用 compareAndSet(pending→claimed, rev++)
 *                                   （claim 免带 revision 的显式豁免）；非 pending →
 *                                   task-not-claimable 无新 attemptId；终态 → task-terminal
 *   §7  持久化                     → save（临时文件 + rename 原子写）/ load
 *                                   （磁盘为准，revision 连续）
 *
 * 错误码集中在 ERR；所有拒绝都返回 { ok:false, reason, ... }，绝不静默改写。
 *
 * t75 修复（t74 needs_revision 的 F1-F4，本文件承载；F5 在测试口径、F6 在设计稿 §2 回填）：
 *   F1 update 域限制（§6:250 形状）→ UPDATE_STATUS 域检查：superseded/suspended
 *      只能走 supersede/suspend 专用端点，带戳传播不可再被 update 绕过；
 *   F2 claim 依赖前置（§3 taskOpen 的依赖半边）→ ERR.DEPENDENCY_BLOCKED + blockedBy；
 *   F3 悬空依赖语义统一 → 悬空=阻塞（§3 权威语义），环检测只管图内环，入口
 *      createTask/editDependencies 返回 warnings 告警（不再静默永不就绪）；
 *   F4 claim 写入 claimedById/assignee（§1 防误认领；新增可选 options 参数，旧
 *      number 签名完全兼容）。
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'

export const TERMINAL = ['completed', 'failed', 'superseded']
/** claim 在这些状态下被拒（§6 S13 表：CAS 失败语义）。 */
export const NOT_CLAIMABLE = ['claimed', 'running', 'suspended']
/** §6:250 形状——update 可提交的 status 域（t75-F1）。superseded/suspended 走专用端点。 */
export const UPDATE_STATUS = ['running', 'completed', 'failed']
/**
 * t106 · P3 Slice 1：任务记录 schema 版本（v2 = +constraints/knownRisks 两扩展列）。
 * 版本化声明（P1 契约增量清单）见 docs/optimization/p3-impl-baseline.md；
 * loadTaskStore 对 v1 文件（无 schemaVersion、记录缺列）零迁移兼容（缺列补空数组）。
 */
export const SCHEMA_VERSION = 2

/** 字符串列表规整（v2 扩展列共用）：非数组→[]，过滤非字符串项。 */
function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string').map((item) => item) : []
}
/** 建议初值（D1/D3/D8，需实测，设计稿 §9）。 */
export const DEFAULT_CLAIM_LEASE_MS = 600000
export const DEFAULT_STALL_THRESHOLD_MS = 600000
export const DEFAULT_MAX_SUPERSEDE_DEPTH = 16
export const DEFAULT_SUSPENDED_UNATTENDED_MS = 1800000

export const ERR = {
  TASK_NOT_FOUND: 'task-not-found',
  STALE_REVISION: 'stale-revision',
  ILLEGAL_TRANSITION: 'illegal-transition',
  TASK_NOT_CLAIMABLE: 'task-not-claimable',
  TASK_TERMINAL: 'task-terminal',
  ATTEMPT_MISMATCH: 'attempt-mismatch',
  SELF_DEPENDENCY: 'self-dependency',
  CYCLE: 'cycle',
  SUPERSEDE_DEPTH: 'supersede-depth',
  SUPERSEDE_CYCLE: 'supersede-cycle',
  /** t75-F2：claim 的依赖前置拒绝（§3 taskOpen 语义）。 */
  DEPENDENCY_BLOCKED: 'dependency-blocked',
}

/**
 * 合法迁移表（§2 状态图 + §5 suspended 出口 + §3 supersede 对非终态）。
 * 终态（terminal）不在 from 列 → 终态不可再迁移。
 */
const TRANSITIONS = {
  pending: ['claimed', 'superseded'],
  claimed: ['running', 'pending', 'superseded', 'completed', 'failed'], // pending = release/reclaim；completed/failed = 直接结算
  running: ['completed', 'failed', 'superseded', 'suspended'], // suspended = 中断不可确认（人工）
  suspended: ['running', 'claimed', 'completed', 'failed', 'superseded'], // resume/续租/结算/作废
  completed: [],
  failed: [],
  superseded: [],
}

function transitionAllowed(from, to) {
  return (TRANSITIONS[from] || []).includes(to)
}

/** 克隆任务记录（写前快照，防外部引用可变）。 */
function cloneTask(task) {
  return JSON.parse(JSON.stringify(task))
}

/**
 * Kahn 拓扑排序 + 环路径报告（§2.1 S1/S2）。
 * @param tasks - 全任务图（Map<id, {id, dependencies}>）
 * @returns null 当无环；否则 { path: ["t2","t1","t2"] }。
 */
export function findCycle(tasks) {
  const ids = [...tasks.values()].map((task) => task.id)
  const indegree = new Map(ids.map((id) => [id, 0]))
  const dependents = new Map() // depId -> 依赖它的任务 id
  for (const task of tasks.values()) {
    for (const dep of task.dependencies || []) {
      // 图外依赖（悬空/前向引用）不参与环计算——环是图内节点间的性质。就绪性由
      // dependencyBlocked 单独判定（§3：悬空=阻塞），入口对悬空发 warnings 告警
      //（t75-F3：两处语义分工明确，不再是矛盾）。
      if (!tasks.has(dep)) continue
      indegree.set(task.id, (indegree.get(task.id) || 0) + 1)
      if (!dependents.has(dep)) dependents.set(dep, [])
      dependents.get(dep).push(task.id)
    }
  }
  const queue = ids.filter((id) => (indegree.get(id) || 0) === 0)
  const removed = new Set()
  while (queue.length > 0) {
    const id = queue.shift()
    if (removed.has(id)) continue
    removed.add(id)
    for (const dependent of dependents.get(id) || []) {
      indegree.set(dependent, indegree.get(dependent) - 1)
      if (indegree.get(dependent) === 0) queue.push(dependent)
    }
  }
  const remaining = ids.filter((id) => !removed.has(id))
  if (remaining.length === 0) return null
  // 从任一剩余节点沿依赖回溯，得到环路径。
  const seen = new Set()
  const path = []
  let cursor = remaining[0]
  while (!seen.has(cursor)) {
    seen.add(cursor)
    path.push(cursor)
    const task = tasks.get(cursor)
    cursor = (task.dependencies || []).find((dep) => !removed.has(dep))
    if (cursor === undefined) break
  }
  path.push(cursor)
  return { path }
}

/**
 * P1 状态层核心 store。
 * 所有写都经 _cas（读-改-CAS-写，§7）；revision 单调递增。
 */
export class TaskStore {
  /**
   * @param options - { claimLeaseMs, stallThresholdMs, maxSupersedeDepth,
   *   suspendedUnattendedMs }（D1/D3/D8 可注入，测试用短超时）。
   */
  constructor(options = {}) {
    this.tasks = new Map()
    this.nextSeq = 1
    this.claimLeaseMs = options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS
    this.stallThresholdMs = options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS
    this.maxSupersedeDepth = options.maxSupersedeDepth ?? DEFAULT_MAX_SUPERSEDE_DEPTH
    this.suspendedUnattendedMs = options.suspendedUnattendedMs ?? DEFAULT_SUSPENDED_UNATTENDED_MS
  }

  // ── 内部：CAS（§7 每次状态写原子）──────────────────────────────

  _cas(taskId, expectedRevision, mutate, now) {
    const task = this.tasks.get(taskId)
    if (task === undefined) return { ok: false, reason: ERR.TASK_NOT_FOUND }
    if (task.revision !== expectedRevision) {
      return { ok: false, reason: ERR.STALE_REVISION, currentRevision: task.revision, expectedRevision }
    }
    const next = cloneTask(task)
    mutate(next)
    next.revision += 1
    next.updatedAt = now
    this.tasks.set(taskId, next)
    return { ok: true, task: next, revision: next.revision }
  }

  // ── 创建 / 环检测（§1 / §2.1 S1/S2）────────────────────────────

  /**
   * 创建任务（入口拓扑校验：自依赖 + Kahn 环检测，拒绝并报告路径）。
   * @param input - { kind, subject, objective, inScope, acceptance, verify,
   *   dependencies, assignee, constraints?, knownRisks? }；id 自动分配（t<seq>，§1 单调）。
   *   t106 · P3 Slice 1（schema v2）：constraints/knownRisks 扩展列收编（创建期契约
   *   字段，P3 设计稿 §3.1-3 最小必要候选①）。版本化声明见 p3-impl-baseline.md
   *   「P1 契约增量清单」；v1 JSON 零迁移兼容（loadTaskStore 对缺失列补缺省空数组）。
   */
  createTask(input, now = Date.now()) {
    const dependencies = Array.isArray(input.dependencies) ? input.dependencies.slice() : []
    const id = 't' + this.nextSeq
    if (dependencies.includes(id)) {
      return { ok: false, reason: ERR.SELF_DEPENDENCY, message: '任务不能依赖自身：' + id, taskId: id }
    }
    // 候选图 = 现有 + 新任务，跑 Kahn（S11：本 schema 全部任务入口共享同一校验）。
    const graph = new Map(this.tasks)
    graph.set(id, { id, dependencies })
    const cycle = findCycle(graph)
    if (cycle !== null) {
      return {
        ok: false,
        reason: ERR.CYCLE,
        message: '依赖图存在环（Kahn 拒绝）：' + cycle.path.join(' → '),
        cycle: cycle.path,
        taskId: id,
      }
    }
    const seq = this.nextSeq
    this.nextSeq += 1
    // t75-F3：悬空依赖不拒绝（前向引用合法——id 单调分配，未来任务可满足它），
    // 但必须可观测：返回值带 warnings 告警；就绪性由 §3「悬空=阻塞」把守，
    // 拼错的 id 从「静默永不就绪」变为「创建即告警 + 永不就绪可见」。
    const warnings = dependencies
      .filter((dep) => !this.tasks.has(dep))
      .map((dep) => 'dangling-dependency: ' + dep + '（当前任务图中不存在；就绪前必须由未来创建的任务满足）')
    const task = {
      id,
      seq,
      kind: String(input.kind || 'work'),
      subject: String(input.subject || ''),
      objective: String(input.objective || ''),
      inScope: Array.isArray(input.inScope) ? input.inScope.slice() : [],
      acceptance: Array.isArray(input.acceptance) ? input.acceptance.slice() : [],
      verify: Array.isArray(input.verify) ? input.verify.slice() : [],
      // t106 · schema v2 扩展列（创建期契约字段）：缺省空数组，旧调用零感知。
      constraints: stringList(input.constraints),
      knownRisks: stringList(input.knownRisks),
      dependencies,
      status: 'pending',
      assignee: String(input.assignee || ''),
      claimedById: null,
      attemptId: null,
      attempt: 0,
      revision: 1,
      openedAt: now,
      claimedAt: null,
      startedAt: null,
      lastSignalAt: null,
      supersededBy: null,
      dependencySupersededAt: null,
      dependencyFailedAt: null,
      claimLeaseMs: this.claimLeaseMs,
      stallThresholdMs: this.stallThresholdMs,
      stallMarked: false,
      suspended: false,
      createdAt: now,
      updatedAt: now,
    }
    this.tasks.set(id, task)
    return { ok: true, task: cloneTask(task), revision: 1, warnings }
  }

  /**
   * 批量改依赖（设计稿 §2.1 S11：editPlan 入口，与 createTask 共用拓扑校验）。
   * 自依赖与环都在原子写入前被拒绝；环错误信息指明路径。
   */
  editDependencies(taskId, input, now = Date.now()) {
    const task = this.tasks.get(taskId)
    if (task === undefined) return { ok: false, reason: ERR.TASK_NOT_FOUND, taskId }
    if (task.revision !== input.revision) {
      return { ok: false, reason: ERR.STALE_REVISION, currentRevision: task.revision, taskId }
    }
    const dependencies = Array.isArray(input.dependencies)
      ? input.dependencies.filter((dep) => typeof dep === 'string')
      : []
    if (dependencies.includes(taskId)) {
      return { ok: false, reason: ERR.SELF_DEPENDENCY, message: '任务不能依赖自身：' + taskId, taskId }
    }
    const graph = new Map(this.tasks)
    graph.set(taskId, { id: taskId, dependencies })
    const cycle = findCycle(graph)
    if (cycle !== null) {
      return {
        ok: false,
        reason: ERR.CYCLE,
        message: '依赖图存在环（Kahn 拒绝）：' + cycle.path.join(' → '),
        cycle: cycle.path,
        taskId,
      }
    }
    // t75-F3：与 createTask 同款悬空告警（S11：全部任务入口同一语义）。
    const warnings = dependencies
      .filter((dep) => !this.tasks.has(dep))
      .map((dep) => 'dangling-dependency: ' + dep + '（当前任务图中不存在；就绪前必须由未来创建的任务满足）')
    const res = this._cas(taskId, task.revision, (next) => {
      next.dependencies = dependencies
    }, now)
    return res.ok ? { ok: true, revision: res.revision, warnings } : { ok: false, reason: res.reason, taskId }
  }

  // ── claim 原子性（§6 S13：CAS(pending→claimed, rev++)，双 owner 结构性不可能）──

  /**
   * claim：前置条件由宿主原子检查（§6 S13 豁免声明：claim 请求本身免带
   * revision）。成功生成 attemptId + claimedAt + revision++。
   * 非 pending：claimed/running/suspended → task-not-claimable（无新 attemptId）；
   * 终态 → task-terminal；依赖未全 terminal → dependency-blocked（t75-F2，§3）。
   * @param optionsOrNow - 旧签名传 number（= now，行为不变）；新签名传
   *   { claimedById?, assignee? }（t75-F4：§1 防误认领身份，由宿主注入）。
   * @param maybeNow - options 形式下的时间戳（缺省 Date.now()）。
   */
  claim(taskId, optionsOrNow = Date.now(), maybeNow) {
    const options = optionsOrNow !== null && typeof optionsOrNow === 'object' ? optionsOrNow : {}
    const now = typeof optionsOrNow === 'number' ? optionsOrNow : (maybeNow === undefined ? Date.now() : maybeNow)
    const task = this.tasks.get(taskId)
    if (task === undefined) return { ok: false, reason: ERR.TASK_NOT_FOUND, taskId }
    if (TERMINAL.includes(task.status)) {
      return { ok: false, reason: ERR.TASK_TERMINAL, currentStatus: task.status, taskId }
    }
    if (task.status !== 'pending') {
      return { ok: false, reason: ERR.TASK_NOT_CLAIMABLE, currentStatus: task.status, taskId }
    }
    // t75-F2：§3 DAG 调度语义——taskOpen 的依赖半边在唯一认领入口把守
    // （taskOpen = pending && !dependencyBlocked；pending 半边已由上一行检查）。
    // 依赖未全 terminal 的任务不可被认领，拒绝指明阻塞来源，不生成 attemptId。
    if (this.dependencyBlocked(taskId)) {
      return {
        ok: false,
        reason: ERR.DEPENDENCY_BLOCKED,
        currentStatus: task.status,
        taskId,
        blockedBy: (task.dependencies || []).filter((dep) => !this.isTerminal(dep)),
      }
    }
    const res = this._cas(taskId, task.revision, (next) => {
      next.status = 'claimed'
      next.attempt += 1
      next.attemptId = randomUUID()
      next.claimedAt = now
      // t75-F4：§1 防误认领字段——身份由宿主注入；未提供时保持原值（纯核心层
      // 不假设调用方可观测身份）。assignee 显式传入优先，否则由 claimedById 补空。
      if (options.claimedById !== undefined) next.claimedById = String(options.claimedById)
      if (options.assignee !== undefined) next.assignee = String(options.assignee)
      else if (options.claimedById !== undefined && next.assignee === '') next.assignee = String(options.claimedById)
    }, now)
    if (!res.ok) return { ok: false, reason: res.reason, taskId }
    return {
      ok: true,
      taskId,
      attemptId: res.task.attemptId,
      claimedAt: res.task.claimedAt,
      leaseExpiresAt: res.task.claimedAt + res.task.claimLeaseMs,
      revision: res.task.revision,
    }
  }

  // ── update（§6：attemptId + revision CAS）────────────────────

  /**
   * 状态写：running（首次宿主观测到活动）/ completed / failed（§6:250 域，
   * t75-F1：域外值一律拒绝——superseded 只能走 supersede 端点（其 CAS 内完成
   * dependencySupersededAt 传播），suspended 只能走 suspend 端点（人工确认），
   * 带戳传播不可被 update 绕过）。非法迁移拒绝；attemptId 不匹配拒绝；
   * revision stale 拒绝。
   */
  update(taskId, input, now = Date.now()) {
    const task = this.tasks.get(taskId)
    if (task === undefined) return { ok: false, reason: ERR.TASK_NOT_FOUND, taskId }
    // §7/S5：stale revision 优先拒绝（后写覆盖结构性不可能；重读后再提交）。
    if (task.revision !== input.revision) {
      return { ok: false, reason: ERR.STALE_REVISION, currentRevision: task.revision, expectedRevision: input.revision, taskId }
    }
    const status = input.status
    // t75-F1：§6:250 形状——update 只接受 UPDATE_STATUS 域。域外值（含
    // superseded/suspended）在此拒绝，S3「带戳继续供人工复核」恢复有效。
    if (!UPDATE_STATUS.includes(status)) {
      return {
        ok: false,
        reason: ERR.ILLEGAL_TRANSITION,
        from: task.status,
        to: status,
        taskId,
        allowedStatus: UPDATE_STATUS.slice(),
      }
    }
    if (!transitionAllowed(task.status, status)) {
      return { ok: false, reason: ERR.ILLEGAL_TRANSITION, from: task.status, to: status, taskId }
    }
    if (task.attemptId !== input.attemptId) {
      return { ok: false, reason: ERR.ATTEMPT_MISMATCH, taskId }
    }
    const res = this._cas(taskId, input.revision, (next) => {
      if (status === 'running') {
        // §2：claimed→running 由宿主观测到首次活动驱动；startedAt 仅记录（§4.4）。
        if (next.startedAt === null) next.startedAt = now
        next.lastSignalAt = now
        next.stallMarked = false
      } else if (status === 'completed' || status === 'failed') {
        next.lastSignalAt = now
        next.stallMarked = false
        next.suspended = false
      }
      next.status = status
    }, now)
    if (!res.ok) return { ok: false, reason: res.reason, currentRevision: res.currentRevision, taskId }
    if (status === 'failed') this._propagateDepState(taskId, 'dependencyFailedAt', now)
    return { ok: true, revision: res.revision, task: res.task }
  }

  /** 宿主观测到成员活动（§4.1 lastSignalAt 核心 + §4.5 修法⑦ 续租）。 */
  observeActivity(taskId, signalAt = Date.now()) {
    const task = this.tasks.get(taskId)
    if (task === undefined) return { ok: false, reason: ERR.TASK_NOT_FOUND, taskId }
    const res = this._cas(taskId, task.revision, (next) => {
      next.lastSignalAt = signalAt
      if (next.status === 'suspended') {
        // 修法⑦：suspended 不冻结 activity 续租——观测到新活动自动回 running。
        next.status = 'running'
        next.suspended = false
      }
    }, signalAt)
    return res.ok
      ? { ok: true, status: res.task.status, revision: res.task.revision }
      : { ok: false, reason: res.reason, taskId }
  }

  // ── release / reclaim（§4.2 + §6）────────────────────────────

  /** 显式归还 pending（§6 /team-tasks/release，CAS）。 */
  release(taskId, input, now = Date.now()) {
    const task = this.tasks.get(taskId)
    if (task === undefined) return { ok: false, reason: ERR.TASK_NOT_FOUND, taskId }
    if (task.revision !== input.revision) {
      return { ok: false, reason: ERR.STALE_REVISION, currentRevision: task.revision, taskId }
    }
    if (task.status !== 'claimed') {
      return { ok: false, reason: ERR.ILLEGAL_TRANSITION, from: task.status, to: 'pending', taskId }
    }
    if (task.attemptId !== input.attemptId) {
      return { ok: false, reason: ERR.ATTEMPT_MISMATCH, taskId }
    }
    const res = this._cas(taskId, input.revision, (next) => {
      next.status = 'pending'
      next.attemptId = null
      next.claimedAt = null
    }, now)
    return res.ok ? { ok: true, revision: res.revision } : { ok: false, reason: res.reason, taskId }
  }

  /**
   * reclaim 谓词（§4.2 canReclaim + F4-b）：
   *   仅 claimed 可回收；宿主注入 observeIdle(assigneeId) 型信号
   *   （stateOf==='settled' 才为 idle；未知第三态保守不回收）；
   *   startedAt 不参与判定（仅记录）。
   * @param observe - { observeIdle(id) => boolean, lastSignalAtOf(id) => number|null }
   */
  canReclaim(taskId, observe, now = Date.now()) {
    const task = this.tasks.get(taskId)
    if (task === undefined) return false
    if (task.status !== 'claimed') return false
    if (now - task.claimedAt <= task.claimLeaseMs) return false
    if (observe.observeIdle(task.assignee) !== true) return false // 未知态/非 idle → 不回收（保守）
    const last = observe.lastSignalAtOf ? observe.lastSignalAtOf(task.assignee) : task.lastSignalAt
    if (last !== null && last !== undefined && now - last <= task.stallThresholdMs) return false
    return true
  }

  /** 后台 reclaim：可回收 → CAS claimed→pending（attemptId 清空，attempt 代数保留）。 */
  reclaim(taskId, observe, now = Date.now()) {
    const task = this.tasks.get(taskId)
    if (task === undefined) return { ok: false, reason: ERR.TASK_NOT_FOUND, taskId }
    if (!this.canReclaim(taskId, observe, now)) return { ok: false, reason: 'not-reclaimable', taskId }
    const res = this._cas(taskId, task.revision, (next) => {
      next.status = 'pending'
      next.attemptId = null
      next.claimedAt = null
    }, now)
    return res.ok ? { ok: true, revision: res.revision } : { ok: false, reason: res.reason, taskId }
  }

  /** runningResidualExit（§4.2）：running 残留不 reclaim（防双执行），走 stall→suspended。 */
  stallMark(taskId, observe, now = Date.now()) {
    const task = this.tasks.get(taskId)
    if (task === undefined) return { ok: false, reason: ERR.TASK_NOT_FOUND, taskId }
    if (task.status !== 'running') return { ok: false, reason: 'not-running', taskId }
    if (observe.observeIdle(task.assignee) !== true) return { ok: false, reason: 'observing-activity', taskId }
    const last = observe.lastSignalAtOf ? observe.lastSignalAtOf(task.assignee) : task.lastSignalAt
    if (last !== null && last !== undefined && now - last <= task.stallThresholdMs) return { ok: false, reason: 'recent-signal', taskId }
    const res = this._cas(taskId, task.revision, (next) => {
      next.stallMarked = true // 疑似停滞（供人工确认），status 仍为 running
    }, now)
    return res.ok ? { ok: true, revision: res.revision } : { ok: false, reason: res.reason, taskId }
  }

  // ── suspend（§4.3 S7B 路径 B / §5 F3 三出口）──────────────────

  /** 人工确认中断不可靠 → suspended（不回收，防双执行；§4.3 路径 B）。 */
  suspend(taskId, input, now = Date.now()) {
    const task = this.tasks.get(taskId)
    if (task === undefined) return { ok: false, reason: ERR.TASK_NOT_FOUND, taskId }
    if (task.revision !== input.revision) {
      return { ok: false, reason: ERR.STALE_REVISION, currentRevision: task.revision, taskId }
    }
    if (!transitionAllowed(task.status, 'suspended')) {
      return { ok: false, reason: ERR.ILLEGAL_TRANSITION, from: task.status, to: 'suspended', taskId }
    }
    const res = this._cas(taskId, input.revision, (next) => {
      next.status = 'suspended'
      next.suspended = true
    }, now)
    return res.ok ? { ok: true, revision: res.revision, task: res.task } : { ok: false, reason: res.reason, taskId }
  }

  /** 出口① 恢复（§5：带 revision stale 校验，原 attemptId 继续）→ 回 running。 */
  resume(taskId, input, now = Date.now()) {
    const task = this.tasks.get(taskId)
    if (task === undefined) return { ok: false, reason: ERR.TASK_NOT_FOUND, taskId }
    if (task.revision !== input.revision) {
      return { ok: false, reason: ERR.STALE_REVISION, currentRevision: task.revision, taskId }
    }
    if (task.status !== 'suspended') {
      return { ok: false, reason: ERR.ILLEGAL_TRANSITION, from: task.status, to: 'running', taskId }
    }
    const res = this._cas(taskId, input.revision, (next) => {
      next.status = 'running'
      next.suspended = false
      next.stallMarked = false
      next.lastSignalAt = now
    }, now)
    return res.ok
      ? { ok: true, revision: res.revision, attemptId: res.task.attemptId }
      : { ok: false, reason: res.reason, taskId }
  }

  /** 出口② reassign（§5：带 revision，任务重派）→ claimed（新 assignee + 新 attemptId）。 */
  reassign(taskId, input, now = Date.now()) {
    const task = this.tasks.get(taskId)
    if (task === undefined) return { ok: false, reason: ERR.TASK_NOT_FOUND, taskId }
    if (task.revision !== input.revision) {
      return { ok: false, reason: ERR.STALE_REVISION, currentRevision: task.revision, taskId }
    }
    if (!['claimed', 'running', 'suspended'].includes(task.status)) {
      return { ok: false, reason: ERR.ILLEGAL_TRANSITION, from: task.status, to: 'claimed', taskId }
    }
    const res = this._cas(taskId, input.revision, (next) => {
      next.status = 'claimed'
      next.assignee = String(input.to || '')
      next.attempt += 1
      next.attemptId = randomUUID()
      next.claimedAt = now
      next.suspended = false
      next.stallMarked = false
    }, now)
    return res.ok
      ? { ok: true, revision: res.revision, attemptId: res.task.attemptId }
      : { ok: false, reason: res.reason, taskId }
  }

  /** 出口③ supersede（§5/S6/§6：visited + 深度上限；写 supersededBy → 下游解锁+戳）。 */
  supersede(taskId, input, now = Date.now()) {
    const task = this.tasks.get(taskId)
    if (task === undefined) return { ok: false, reason: ERR.TASK_NOT_FOUND, taskId }
    // §7/S5：stale revision 优先（作废 vs 完成竞态：后写者收到 stale-revision，重读后再决策）。
    if (task.revision !== input.revision) {
      return { ok: false, reason: ERR.STALE_REVISION, currentRevision: task.revision, expectedRevision: input.revision, taskId }
    }
    if (TERMINAL.includes(task.status)) {
      return { ok: false, reason: ERR.ILLEGAL_TRANSITION, from: task.status, to: 'superseded', taskId }
    }
    const chainCheck = this._validateSupersedeChain(taskId, input.supersededBy)
    if (!chainCheck.ok) return chainCheck
    const res = this._cas(taskId, input.revision, (next) => {
      next.status = 'superseded'
      next.supersededBy = input.supersededBy === undefined || input.supersededBy === null ? null : String(input.supersededBy)
      next.suspended = false
      next.stallMarked = false
    }, now)
    if (!res.ok) return { ok: false, reason: res.reason, taskId }
    this._propagateDepState(taskId, 'dependencySupersededAt', now)
    return { ok: true, revision: res.revision, task: res.task }
  }

  /** S6：supersededBy 链 visited + 深度上限；链上出现自身 → 拒绝（防 A→B→A）。 */
  _validateSupersedeChain(taskId, supersededBy) {
    if (supersededBy === undefined || supersededBy === null || supersededBy === '') return { ok: true }
    const target = String(supersededBy)
    if (target === taskId) {
      return { ok: false, reason: ERR.SUPERSEDE_CYCLE, message: '作废目标不能是自身', taskId }
    }
    const seen = new Set()
    let cursor = target
    let depth = 0
    while (cursor !== undefined && cursor !== null && cursor !== '') {
      if (seen.has(cursor)) {
        return { ok: false, reason: ERR.SUPERSEDE_CYCLE, message: 'supersededBy 链成环：' + [...seen, cursor].join(' → '), taskId }
      }
      seen.add(cursor)
      if (cursor === taskId) {
        return { ok: false, reason: ERR.SUPERSEDE_CYCLE, message: 'supersededBy 链已含待作废任务', taskId }
      }
      depth += 1
      if (depth > this.maxSupersedeDepth) {
        return { ok: false, reason: ERR.SUPERSEDE_DEPTH, message: 'supersededBy 链超深（>' + this.maxSupersedeDepth + '）', taskId }
      }
      const nextTask = this.tasks.get(cursor)
      cursor = nextTask === undefined ? undefined : nextTask.supersededBy
    }
    return { ok: true }
  }

  /**
   * 依赖失效传播（§3）：某依赖变为 terminal 时，下游 pending 任务写戳
   * （superseded → dependencySupersededAt；failed → dependencyFailedAt）。
   * 戳 = 该依赖 terminal 的时刻（宿主写）。下游不阻塞（带戳继续）。
   */
  _propagateDepState(depId, stampField, now) {
    for (const task of this.tasks.values()) {
      if (task.status !== 'pending') continue
      if (!(task.dependencies || []).includes(depId)) continue
      if (task[stampField] !== null && task[stampField] !== undefined) continue
      this._cas(task.id, task.revision, (next) => {
        next[stampField] = now
      }, now)
    }
  }

  // ── 依赖判定（§3）─────────────────────────────────────────────

  isTerminal(taskId) {
    const task = this.tasks.get(taskId)
    return task !== undefined && TERMINAL.includes(task.status)
  }

  /**
   * dependencyBlocked(t) = 任一依赖非 terminal（§3）。悬空依赖（id 不在图中）
   * 取 undefined → 视为阻塞——这是 t75-F3 统一后的唯一悬空就绪语义：环检测
   * （findCycle）只管图内环，就绪判定把悬空当阻塞，入口（createTask/
   * editDependencies）对悬空发 warnings 告警——拼错的 id 不再静默永不就绪。
   */
  dependencyBlocked(taskId) {
    const task = this.tasks.get(taskId)
    if (task === undefined) return true
    return (task.dependencies || []).some((dep) => {
      const depTask = this.tasks.get(dep)
      return depTask === undefined || !TERMINAL.includes(depTask.status)
    })
  }

  /** taskOpen(t) = pending && !dependencyBlocked(t)（§3）。 */
  taskOpen(taskId) {
    const task = this.tasks.get(taskId)
    return task !== undefined && task.status === 'pending' && !this.dependencyBlocked(taskId)
  }

  // ── 无人裁决出口（§5 F3 / D8）────────────────────────────────

  /**
   * suspended 无人裁决超时自动升级（SUSPENDED_UNATTENDED_MS 可注入）：
   *   suspended 且 now - updatedAt > 阈值 → 自动转 superseded（supersededBy=null，
   *   复用 §6 supersede CAS 语义），依赖下游自动解锁。
   * 「永远挂着」在状态机上不可达（§5 证伪）。
   * @returns 被自动作废的任务 id 列表。
   */
  checkUnattended(now = Date.now()) {
    const auto = []
    for (const task of this.tasks.values()) {
      if (task.status !== 'suspended') continue
      if (now - task.updatedAt <= this.suspendedUnattendedMs) continue
      const res = this.supersede(task.id, { revision: task.revision, supersededBy: null }, now)
      if (res.ok) auto.push(task.id)
    }
    return auto
  }

  // ── 巡检例程（§4.2 / §4.3 / §5 F3 的组合；宿主定时器调用，测试可直接驱动）──

  /**
   * 一次完整巡检：
   *   claimed 残留 → canReclaim 谓词通过则 reclaim 回 pending（§4.2）；
   *   running 残留 → stallMark 疑似标记（不回收，防双执行——§4.3）；
   *   最后 checkUnattended（§5 F3：suspended 无人裁决超时自动 superseded）。
   * 纯组合（每个动作都走既有 CAS 校验），无新语义——宿主只需调这一个入口。
   * @param observe - { observeIdle(id)=>boolean, lastSignalAtOf(id)=>number|null }
   * @returns { reclaimed, stalled, autoSuperseded } 各自的任务 id 列表。
   */
  runRoutine(observe, now = Date.now()) {
    const reclaimed = []
    const stalled = []
    for (const task of this.tasks.values()) {
      if (task.status === 'claimed') {
        const r = this.reclaim(task.id, observe, now)
        if (r.ok) reclaimed.push(task.id)
      } else if (task.status === 'running') {
        const s = this.stallMark(task.id, observe, now)
        if (s.ok) stalled.push(task.id)
      }
    }
    const autoSuperseded = this.checkUnattended(now)
    return { reclaimed, stalled, autoSuperseded }
  }

  // ── 快照 / 持久化（§6 投影 / §7）──────────────────────────────

  /** /state 投影行（§6）：id/status/assignee/deps/revision/停滞标记/suspended。 */
  snapshotRow(taskId) {
    const task = this.tasks.get(taskId)
    if (task === undefined) return undefined
    return {
      id: task.id,
      status: task.status,
      assignee: task.assignee,
      dependencies: task.dependencies.slice(),
      revision: task.revision,
      stalled: task.stallMarked,
      suspended: task.suspended,
      attemptId: task.attemptId,
      supersededBy: task.supersededBy,
      dependencySupersededAt: task.dependencySupersededAt,
      dependencyFailedAt: task.dependencyFailedAt,
      openedAt: task.openedAt,
      claimedAt: task.claimedAt,
      updatedAt: task.updatedAt,
      // t106 · schema v2 扩展列投影（下游可读契约字段）
      constraints: (task.constraints || []).slice(),
      knownRisks: (task.knownRisks || []).slice(),
    }
  }

  snapshot() {
    return {
      nextSeq: this.nextSeq,
      tasks: [...this.tasks.values()].map((task) => this.snapshotRow(task.id)),
    }
  }

  /**
   * 原子持久化（§7）：临时文件 + rename 原子替换。
   * @param filePath - 目标 JSON 路径
   * @param writer   - 可选注入（测试内存 fs）：{ write(tmp, payload), rename(tmp, path) }
   */
  save(filePath, writer) {
    const payload = JSON.stringify(this.serialize(), null, 2)
    if (writer) {
      writer.write(filePath + '.tmp', payload)
      writer.rename(filePath + '.tmp', filePath)
      return { ok: true, path: filePath }
    }
    const dir = filePath.slice(0, Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')))
    if (dir !== '' && dir !== filePath) {
      try { mkdirSync(dir, { recursive: true }) } catch { /* 已存在等 */ }
    }
    const tmp = filePath + '.tmp-' + randomUUID().slice(0, 8)
    writeFileSync(tmp, payload, 'utf8')
    renameSync(tmp, filePath)
    return { ok: true, path: filePath }
  }

  /** 序列化（§7 崩溃恢复源，磁盘为准）。t106：schemaVersion=2（+constraints/knownRisks）。 */
  serialize() {
    return {
      schemaVersion: SCHEMA_VERSION,
      nextSeq: this.nextSeq,
      options: {
        claimLeaseMs: this.claimLeaseMs,
        stallThresholdMs: this.stallThresholdMs,
        maxSupersedeDepth: this.maxSupersedeDepth,
        suspendedUnattendedMs: this.suspendedUnattendedMs,
      },
      tasks: Object.fromEntries([...this.tasks.entries()]),
    }
  }
}

/**
 * 静态工厂：从持久化 JSON 重建（§7 崩溃恢复，磁盘为准）。
 * t106 · schema v2：v1 文件（无 schemaVersion、记录缺 constraints/knownRisks）
 * 零迁移兼容——缺列补空数组，其余原样入 Map（设计稿 §3.1「loadTaskStore 对未知
 * 字段已宽容」的延续）；store.schemaVersion 记录磁盘版本供审计。
 * @param filePath - JSON 路径
 * @param reader   - 可选注入（测试内存 fs）：(path) => string
 */
export function loadTaskStore(filePath, reader) {
  const raw = reader !== undefined
    ? JSON.parse(reader(filePath))
    : JSON.parse(readFileSync(filePath, 'utf8'))
  const store = new TaskStore(raw.options || {})
  store.schemaVersion = Number(raw.schemaVersion) || 1
  store.nextSeq = Number(raw.nextSeq) || 1
  for (const [id, record] of Object.entries(raw.tasks || {})) {
    // v1 兼容：缺列补缺省（仅当字段为 undefined 时，不覆盖磁盘已有值）
    if (record.constraints === undefined) record.constraints = []
    if (record.knownRisks === undefined) record.knownRisks = []
    store.tasks.set(id, record)
  }
  return store
}