/**
 * B′ 认领通道（成员白名单 claim/report 工具 + 宿主侧直调 P1 store）—— lib/p2/claim-channel.js
 *
 * t92 · P2 Slice 1a。用户裁定 B′：成员白名单注入 claim/report 工具，宿主侧对接
 * P1 状态层，零新 HTTP 鉴权面，保留认领语义。
 *
 * E14 取证（t91）：成员直调 fenced 路由 = 结构性 401（无 secret 签名 cookie），
 * 故 B′ 不走 HTTP——成员在回合内声明工具意图，宿主在本进程内直接调 TaskStore。
 *
 * 本文件职责：
 *   1. MEMBER_TOOLS：给成员用的工具定义形状（name/description/parameters）——
 *      后续 Slice 接平台工具注册面（dsh-tools defineTool/register）的输入，
 *      本 Slice 以 DTO + 执行器形态交付并隔离验证；
 *   2. executeMemberTool：宿主侧执行器——纯逻辑、依赖注入 { store, attemptCache }，
 *      claim → store.claim(taskId, { assignee, claimedById })；
 *      report(running/completed/failed) → 归属校验 → store.update(attemptId/revision/status)。
 *
 * 归属模型（防误认领）：宿主在 claim 成功时把 { taskId → { attemptId, memberId } }
 * 记入 attemptCache；report 前校验 cache 归属 === 调用者。attempt 不为成员所知
 * （最小工具面），revision 每次 report 现取（CAS 期望），stale 即诚实失败。
 */

import { ERR } from '../state/task-store.js'
import { CLAIM_TOOL, REPORT_TOOL, MEMBER_TOOL_NAMES } from './tool-names.js'

// t94 · Slice 1b（t93 low-②）：工具名收敛到 tool-names.js 单一常量源，
// 本文件只 re-export 兼容 1a 的既有 import 面（MEMBER_TOOLS 键 / 执行器分支）。
export { CLAIM_TOOL, REPORT_TOOL, MEMBER_TOOL_NAMES }

/** 成员工具定义（平台工具注册面的输入形状，B′）。 */
export const MEMBER_TOOLS = {
  [CLAIM_TOOL]: {
    name: CLAIM_TOOL,
    description: '认领一个指派给你（或池中）的 pending 任务。调用后任务进入 claimed 状态，你即唯一执行者。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '目标任务 id（来自派单消息或 /state 投影）' },
      },
      required: ['taskId'],
    },
  },
  [REPORT_TOOL]: {
    name: REPORT_TOOL,
    description: '回报任务进展/结果：status=running 表示开始执行，completed/failed 表示结算。宿主直接更新共享任务存储。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '目标任务 id' },
        status: { type: 'string', enum: ['running', 'completed', 'failed'], description: '目标状态（UPDATE_STATUS 域）' },
        // t96 · Slice 2（t95 low① 对齐）：P1 store 无 note 字段（task-store 冻结、不在
        // 本任务 in-scope），note 只随工具结果落入宿主侧会话事件日志留痕，
        // 不再声称「记录在任务 lastNote」（旧描述与 store 能力不符）。
        note: { type: 'string', description: '可选：进度/结果说明（随工具结果留痕于宿主侧会话事件日志；P1 store 无 note 字段，不入库）' },
      },
      required: ['taskId', 'status'],
    },
  },
}

/** claim/report 的合法 status 域（对齐 task-store UPDATE_STATUS 的 report 半边）。 */
export const REPORT_STATUS = ['running', 'completed', 'failed']
export const CLAIM_OK = 'claimed'

/**
 * 宿主侧工具执行器（B′ 核心：直调 P1 store，不经 HTTP）。
 * @param {object} deps
 * @param {object} deps.store - TaskStore 实例（lib/state/task-store.js）。
 * @param {Map<string, {attemptId: string, memberId: string}>} [deps.attemptCache]
 *        宿主维护的 claimant 上下文（claim 成功时写入；缺省内部自建）。
 * @param {number} [deps.now] - 可注入时间（测试）。
 * @param {string} toolName
 * @param {object} args - 成员工具实参（taskId/status/note）。
 * @param {object} identity - { memberId, memberName }（宿主解析的调用者身份）。
 * @returns {object} { ok, reason?, status?, taskId?, attemptId? }
 */
export function executeMemberTool(deps, toolName, args, identity) {
  if (toolName !== CLAIM_TOOL && toolName !== REPORT_TOOL) {
    return { ok: false, reason: 'unknown-member-tool', tool: toolName }
  }
  if (identity === undefined || identity.memberId === undefined || identity.memberName === undefined) {
    return { ok: false, reason: 'identity-required' }
  }
  const store = deps.store
  const cache = deps.attemptCache ?? new Map()
  const now = deps.now ?? Date.now()
  const taskId = args.taskId
  if (typeof taskId !== 'string' || taskId === '') return { ok: false, reason: 'taskId-required' }

  if (toolName === CLAIM_TOOL) {
    const res = store.claim(taskId, { assignee: identity.memberName, claimedById: identity.memberId }, now)
    if (!res.ok) return { ok: false, reason: res.reason, taskId }
    cache.set(taskId, { attemptId: res.attemptId, memberId: identity.memberId })
    // t96 · Slice 2 E15（设计 §10）：review 任务 claim 时快照被审文件指纹集。
    const claimedTask = store.tasks.get(taskId)
    let reviewSnapshot
    if (deps.reviewGuard !== undefined && claimedTask?.kind === 'review') {
      reviewSnapshot = deps.reviewGuard.snapshotFor(claimedTask)
    }
    return {
      ok: true,
      status: CLAIM_OK,
      taskId,
      attemptId: res.attemptId,
      revision: res.revision,
      ...(reviewSnapshot !== undefined ? { reviewSnapshot } : {}),
      ...(typeof args.note === 'string' ? { note: args.note } : {}),
    }
  }

  // REPORT_TOOL
  if (!REPORT_STATUS.includes(args.status)) {
    return { ok: false, reason: 'invalid-report-status', taskId, allowedStatus: REPORT_STATUS.slice() }
  }
  const owned = cache.get(taskId)
  if (owned === undefined || owned.memberId !== identity.memberId) {
    return { ok: false, reason: 'task-not-owned', taskId }
  }
  const task = store.tasks.get(taskId)
  if (task === undefined) return { ok: false, reason: ERR.TASK_NOT_FOUND, taskId }
  const res = store.update(taskId, {
    attemptId: owned.attemptId,
    revision: task.revision,
    status: args.status,
  }, now)
  if (!res.ok) {
    // 归属仍有效但 CAS 失败（如外部超时自动 superseded）→ 诚实失败并清理缓存。
    if (res.reason === ERR.STALE_REVISION || res.reason === ERR.TASK_NOT_FOUND || res.reason === ERR.ILLEGAL_TRANSITION || res.reason === ERR.ATTEMPT_MISMATCH) {
      cache.delete(taskId)
    }
    return { ok: false, reason: res.reason, taskId, currentStatus: task.status }
  }
  if (args.status === 'completed' || args.status === 'failed') cache.delete(taskId)
  const result = { ok: true, status: args.status, taskId, revision: res.revision }
  // t96 · Slice 2 E15（设计 §10）：review 任务完成 → 自动比对，不匹配即警告（不阻断）。
  if (args.status === 'completed' && task.kind === 'review' && deps.reviewGuard !== undefined) {
    result.reviewGuard = deps.reviewGuard.compareFor(task)
  }
  if (typeof args.note === 'string') result.note = args.note
  return result
}