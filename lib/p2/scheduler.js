/**
 * 调度器接线 —— lib/p2/scheduler.js
 *
 * t94 · P2 Slice 1b（v0.7 设计 §2.3 唤醒 + §4.4 熔断 + §4.2 重排风暴反制的「实际驱动」层）。
 * Slice 1a 的 scheduler-core.js 是纯原语；本模块把它们接成真正跑得动的批次派发：
 *
 *   1. readyTasksOf        —— 从 P1 store 取「可派」任务（pending 且依赖已就绪）。
 *   2. dispatchBatch       —— 逐任务 pickMemberToWake 选实例 → 调 wake 边界派发。
 *                              · E9 单实例纪律：每拍至多 maxWakes 次唤醒（默认 1）；
 *                              · 唤醒成功 → markActive + markInFlight（真实信号通路①）；
 *                              · 唤醒失败 → recordFailure（真实信号通路②，F7.3 熔断的
 *                              数据源是 wake 边界的真实结果，不是直接戳 registry）；
 *                              · 无可唤醒 → skipped（**绝不自动重排**，store 零改动）。
 *   3. reconcileInFlight   —— 对账：任务已终态 → 清成员在途集合（防在途泄漏假占坑）。
 *   4. collectStaleCandidates —— 租约过期/停滞候选（claimed/running 且租约超时）。
 *   5. disposeStale        —— stale 的**显式**处置（resolveStale 通道）：缺省/none 一律
 *                              no-auto-requeue 拒绝；supersede/reassign 必须宿主显式给。
 *
 * wake 边界 = 平台送达（生产：ctx.subagents.sendMessage；测试：受控驱动）。
 * 依赖注入 { store, registry, memberIds, wake }，纯逻辑可在裸 node 下测试。
 */

import { pickMemberToWake, resolveStale, STALE_ACTIONS } from './scheduler-core.js'

/** 默认每拍唤醒上限（E9 单实例纪律：防唤醒风暴，§10 E9 实测可调）。 */
export const DEFAULT_MAX_WAKES_PER_TICK = 1

/**
 * 可派任务：pending 且依赖全部终态（taskOpen 的调度半边；认领半边由 store.claim 把守）。
 * @param {object} store - TaskStore。
 * @returns {object[]} 任务记录数组（store 内部行，只读使用）。
 */
export function readyTasksOf(store) {
  const out = []
  for (const task of store.tasks.values()) {
    if (task.status !== 'pending') continue
    if (store.dependencyBlocked(task.id)) continue
    out.push(task)
  }
  // 定向任务优先（assignee 具名在前），同组按 openedAt 稳定排序（可复现）。
  out.sort((a, b) => {
    const aDirected = a.assignee !== undefined && a.assignee !== '' ? 0 : 1
    const bDirected = b.assignee !== undefined && b.assignee !== '' ? 0 : 1
    if (aDirected !== bDirected) return aDirected - bDirected
    return (a.openedAt ?? 0) - (b.openedAt ?? 0)
  })
  return out
}

/**
 * 批次派发（一拍）。对每条 ready 任务：选实例 → 唤醒；唤醒结果的成败**就是**
 * 熔断信号源（wake 边界真实返回/抛错 → registry 记账）。
 * @param {object} deps
 * @param {object} deps.store - TaskStore。
 * @param {object} deps.registry - MemberRegistry（scheduler-core.js）。
 * @param {string[]} deps.memberIds - 候选成员名集合（注册表视角）。
 * @param {(memberId: string, task: object) => Promise<void>|void} deps.wake
 *        平台送达边界；失败 = throw / resolve false（两者都记失败）。
 * @param {number} [deps.maxWakes] - 每拍唤醒上限（默认 1，E9）。
 * @param {number} [deps.now] - 可注入时间（测试）。
 * @param {object[]} [tasks] - 显式任务集（缺省 readyTasksOf(store)）。
 * @returns {Promise<object>} { woken, failed, skipped }（各项含 taskId/member/reason）。
 */
export async function dispatchBatch(deps, tasks) {
  const list = tasks ?? readyTasksOf(deps.store)
  const maxWakes = deps.maxWakes ?? DEFAULT_MAX_WAKES_PER_TICK
  const now = deps.now ?? Date.now()
  const result = { woken: [], failed: [], skipped: [] }
  let wakes = 0
  for (const task of list) {
    if (wakes >= maxWakes) {
      result.skipped.push({ taskId: task.id, reason: 'max-wakes-per-tick' })
      continue
    }
    const pick = pickMemberToWake(deps.registry, task, deps.memberIds)
    if (pick === null) {
      // 无可唤醒：跳过且**不动 store**（no-auto-requeue，重排风暴反制 §4.2）。
      result.skipped.push({ taskId: task.id, reason: 'no-eligible-member' })
      continue
    }
    if (deps.registry.inFlightOf(pick).has(task.id)) {
      // 同一任务在途（已唤醒未认领/未结算）不重复唤醒——防唤醒风暴（§2.3）。
      result.skipped.push({ taskId: task.id, member: pick, reason: 'already-in-flight' })
      continue
    }
    let ok = false
    let error = null
    try {
      ok = await deps.wake(pick, task) !== false
      if (!ok) error = 'wake-reported-failure'
    } catch (e) {
      ok = false
      error = String(e)
    }
    if (ok) {
      deps.registry.markActive(pick, now)
      deps.registry.markInFlight(pick, task.id)
      wakes += 1
      result.woken.push({ taskId: task.id, member: pick })
    } else {
      // 真实失败信号 → F7.3 连败熔断（open 后实例被后续 pick 排除）。
      const rec = deps.registry.recordFailure(pick, error, now)
      result.failed.push({ taskId: task.id, member: pick, error, breached: rec.breached, availability: rec.availability })
    }
  }
  return result
}

/**
 * 在途对账：任务已终态（或已不属于任何人可结算）→ 清成员在途集合，
 * 防止已结算任务永久占用「有在途」排序位（假占坑）。
 * @param {object} deps - { store, registry, memberIds }
 * @returns {string[]} 清理掉的 taskId 列表。
 */
export function reconcileInFlight(deps) {
  const cleared = []
  for (const memberId of deps.memberIds) {
    for (const taskId of [...deps.registry.inFlightOf(memberId)]) {
      const task = deps.store.tasks.get(taskId)
      if (task !== undefined && deps.store.isTerminal(taskId)) {
        deps.registry.clearInFlight(memberId, taskId)
        cleared.push(taskId)
      }
    }
  }
  return cleared
}

/**
 * stale 候选：claimed/running 且认领租约已过期（claimedAt + claimLeaseMs < now）。
 * 只收集、不处置——处置必须走 disposeStale 显式通道（§4.2 无自动重排）。
 * @param {object} deps - { store, now }
 * @returns {object[]} { taskId, status, assignee, attemptId, claimedAt, leaseExpiredAt }
 */
export function collectStaleCandidates(deps) {
  const now = deps.now ?? Date.now()
  const out = []
  for (const task of deps.store.tasks.values()) {
    if (task.status !== 'claimed' && task.status !== 'running') continue
    if (task.claimedAt === undefined || task.claimedAt === null) continue
    const leaseExpiresAt = task.claimedAt + task.claimLeaseMs
    if (now <= leaseExpiresAt) continue
    out.push({
      taskId: task.id,
      status: task.status,
      assignee: task.assignee,
      attemptId: task.attemptId,
      claimedAt: task.claimedAt,
      leaseExpiresAt,
    })
  }
  // 早过期在前（最久无人管的先浮出）。
  out.sort((a, b) => a.leaseExpiresAt - b.leaseExpiresAt)
  return out
}

/**
 * stale 的显式处置（唯一入口）。候选任务**没有自动路径**：
 *   · explicit 缺省/'none' → no-auto-requeue（store 零改动）；
 *   · 'supersede'          → store.supersede（作废，需 supersededBy 目标）；
 *   · 'reassign'           → store.reassign（重派，input.to = 新 assignee——P1 契约
 *                             字段为 `to`，见 task-store.js:530 `next.assignee = String(input.to || '')`）。
 * @param {object} deps - { store, now }
 * @param {object} candidate - collectStaleCandidates 的一项（或含 id/revision 的任务行）。
 * @param {object} opts - { explicit?: 'supersede'|'reassign'|'none', input?: { supersededBy?, to? } }
 * @returns {object} resolveStale 的结果 { ok, action?/reason? }。
 */
export function disposeStale(deps, candidate, opts = {}) {
  const task = deps.store.tasks.get(candidate.taskId ?? candidate.id)
  if (task === undefined) return { ok: false, reason: 'task-not-found' }
  return resolveStale(task, {
    explicit: opts.explicit,
    store: deps.store,
    input: opts.input,
    now: deps.now ?? Date.now(),
  })
}

/** re-export 语义动作名（接线层与 core 层共用同一来源）。 */
export { STALE_ACTIONS }
