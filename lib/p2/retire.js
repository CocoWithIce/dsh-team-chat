/**
 * 成员退役通道（retire）—— lib/p2/retire.js
 *
 * t96 · P2 Slice 2（设计稿 §4.2 移除前置 + §4.3 轮换对偶：spawn 的反向操作）。
 *
 * 纪律映射（§7 反面清单）：
 *   · **不自动处置任务** —— 成员有未终态任务时 planRetire 拒绝（no-auto-requeue 同源
 *     纪律），须队长显式给 disposition（supersede/reassign 经 resolveStale 通道）；
 *   · **无孤儿** —— applyRetire 终校验：目标成员在途集合必须为空、无 claimed/running
 *     残留，否则 ok:false（不产生「注册表没了但任务悬空」的孤儿态）；
 *   · 退役 = **调度面摘除**（registry offline + 移出 memberIds）+ **子会话处置**
 *     （dispose 边界：生产 = 平台 interruptByParent / 宿主等价物；测试 = 受控桩；
 *     物理删除属平台生命周期，退役语义为「永不再被本调度器唤醒」）。
 *
 * 分相设计：dispose 边界夹在 plan 与 apply 之间（真实宿主里 dispose 需要活体服务，
 * 纯逻辑进程无法持有）——planRetire → (调用方执行 dispose) → applyRetire；
 * 组合入口 retireMember(deps, input) 供测试与简单宿主一次调用。
 */

import { resolveStale, STALE_ACTIONS } from './scheduler-core.js'

/**
 * drain 边界适配器（reviewer4 规格 · 验收 b/d）：把平台原语
 * `subagents.drainContinuableChildren(parent, [childId])`（dsh-subagent/lib/index.js:2810，
 * 按 childId 精确释放 resident 子代理；越权 UNAUTHORIZED / 不存在 accepted no-op）
 * 包装成 retireMember 的 dispose 边界。宿主装配：parent = 队长活体 Agent，
 * drainChildren = ctx.subagents.drainContinuableChildren。
 * @param {object} wire - { parent, drainChildren }
 * @returns {(childId: string) => Promise<{drained: string}>}
 */
export function makeDrainDispose(wire) {
  return async function drainDispose(childId) {
    await wire.drainChildren(wire.parent, [childId])
    return { drained: childId }
  }
}

/**
 * 发现面标注（reviewer4 规格 · 验收 b）：平台 `listChildren`（:2832）会枚举含冷态
 * durable 记录——退役后冷态记录按平台语义保留（DUPLICATE_CHILD 持久检查依赖，
 * :1044-1049），P2 侧不伪装「已删除」，而是**明确标注** retired。
 * @param {object[]} children - listChildren 行（或任意 {id,...} 投影行）。
 * @param {object} registry - MemberRegistry（isRetired 判定来源）。
 * @returns {object[]} 每行附 retired 布尔标注的新数组（不改输入）。
 */
export function annotateChildren(children, registry) {
  return (children ?? []).map((row) => ({ ...row, retired: registry.isRetired(row.id) }))
}

/**
 * 相位一：退役前置检查 + 计划（不改注册表）。
 * @param {object} deps - { store, registry, memberIds, now? }
 * @param {object} input - { memberId, disposition?: { explicit: 'supersede'|'reassign', input?: {...} } }
 * @returns {object} { ok, memberId, plan?, openTasks?, reason? }
 *   plan = { dispose: memberId, registry: 'offline+remove', openTaskDispositions: [...] }
 */
export function planRetire(deps, input) {
  const memberId = input?.memberId
  if (typeof memberId !== 'string' || memberId === '') return { ok: false, reason: 'member-required' }
  // t96 追加（reviewer4 规格 · 验收 c）：幂等 + 不静默——已退役成员重复 retire =
  // 显式 no-op；非本队/不存在成员 = 显式失败（unknown-member）。
  if (deps.registry.isRetired?.(memberId) === true) {
    return { ok: true, memberId, noop: 'already-retired' }
  }
  if (!deps.memberIds.includes(memberId)) return { ok: false, reason: 'unknown-member', memberId }
  const now = deps.now ?? Date.now()

  // 未终态任务盘点（claimed/running/pending 都算 open——孤儿定义不含 pending，
  // 但 pending 的 assignee 指向该成员时同样会在唤醒选序中撞上，一并显式化）。
  const openTasks = []
  for (const task of deps.store.tasks.values()) {
    const assignedHere = task.assignee === memberId
    if (task.status === 'claimed' || task.status === 'running') {
      if (assignedHere) openTasks.push({ taskId: task.id, status: task.status, attemptId: task.attemptId, revision: task.revision })
    } else if (task.status === 'pending' && assignedHere) {
      openTasks.push({ taskId: task.id, status: task.status, revision: task.revision })
    }
  }
  if (openTasks.length > 0 && input?.disposition === undefined) {
    // §7：不自动处置 —— 拒绝并列出，队长显式给 disposition 后重试。
    return { ok: false, reason: 'member-has-open-tasks', memberId, openTasks }
  }
  const dispositions = []
  if (openTasks.length > 0) {
    for (const open of openTasks) {
      if (open.status === 'pending') {
        // pending 无 attempt 可处置，退役后由队长改派/作废；此处仅显式声明留痕。
        dispositions.push({ taskId: open.taskId, action: 'leave-pending-detached', ok: true })
        continue
      }
      const res = resolveStale(deps.store.tasks.get(open.taskId), {
        explicit: input.disposition.explicit,
        store: deps.store,
        input: input.disposition.input,
        now,
      })
      dispositions.push({ taskId: open.taskId, action: input.disposition.explicit, ok: res.ok, reason: res.reason })
      if (!res.ok) return { ok: false, reason: 'disposition-failed', memberId, dispositions }
    }
  }
  return {
    ok: true,
    memberId,
    plan: {
      dispose: memberId,
      registry: 'offline+remove',
      openTaskDispositions: dispositions,
      inFlightAtPlan: [...deps.registry.inFlightOf(memberId)],
    },
  }
}

/**
 * 相位二：执行退役（dispose 由调用方在两相之间完成，回执传入）。
 * 顺序（§4.2 反向）：dispose（不再有新回合）→ registry offline（不再派活）→
 * 移出 memberIds（选序不可见）→ 无孤儿终校验。
 * @param {object} deps - { store, registry, memberIds, now? }
 * @param {string} memberId
 * @param {object} [opts] - { disposeReceipt?: unknown }（dispose 边界回执，留痕）。
 * @returns {object} { ok, memberId, receipt?, orphans?, reason? }
 */
export function applyRetire(deps, memberId, opts = {}) {
  // 幂等（验收 c）：已退役 → 显式 no-op（不重复 dispose/摘除，也不报错）。
  if (deps.registry.isRetired?.(memberId) === true) {
    return { ok: true, memberId, noop: 'already-retired' }
  }
  if (!deps.memberIds.includes(memberId)) return { ok: false, reason: 'unknown-member', memberId }
  const now = deps.now ?? Date.now()
  // dispose 应已发生；本相先摘调度面（retired 标记 = offline + 注销集合）。
  deps.registry.markRetired(memberId)
  const idx = deps.memberIds.indexOf(memberId)
  if (idx >= 0) deps.memberIds.splice(idx, 1)
  // 无孤儿终校验：在途集合必空 + 无该成员的 claimed/running 残留。
  const inFlight = [...deps.registry.inFlightOf(memberId)]
  const residual = []
  for (const task of deps.store.tasks.values()) {
    if (task.assignee === memberId && (task.status === 'claimed' || task.status === 'running')) {
      residual.push({ taskId: task.id, status: task.status })
    }
  }
  if (inFlight.length > 0 || residual.length > 0) {
    // 已摘除但发现孤儿 → 如实上报（不回滚摘除——离线成员更不可能结算孤儿）。
    return { ok: false, reason: 'orphan-detected', memberId, orphans: { inFlight, residual } }
  }
  return { ok: true, memberId, receipt: opts.disposeReceipt ?? null, retiredAt: now, orphans: [] }
}

/**
 * 组合入口：plan → dispose（注入边界）→ apply，一次调用（测试与简单宿主用）。
 * @param {object} deps - plan/apply 的 deps + { dispose: async (memberId) => receipt }
 * @param {object} input - { memberId, disposition? }
 */
export async function retireMember(deps, input) {
  const plan = planRetire(deps, input)
  if (!plan.ok) return plan
  // 幂等（验收 c）：已退役 → no-op，不再触发 dispose（重复 drain 无意义）。
  if (plan.noop !== undefined) return plan
  if (typeof deps.dispose !== 'function') return { ok: false, reason: 'dispose-boundary-required', memberId: plan.memberId }
  const receipt = await deps.dispose(plan.memberId)
  return applyRetire(deps, plan.memberId, { disposeReceipt: receipt })
}
