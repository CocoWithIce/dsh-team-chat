/**
 * 调度核心地基 —— lib/p2/scheduler-core.js
 *
 * t92 · P2 Slice 1a（v0.7 设计 §2.3 单实例唤醒 + §4.4 per-instance 熔断 + 重排风暴反制）。
 *
 * 三块：
 *   1. MemberRegistry   —— 成员可用性注册表（online / breaker-open / quota-exhausted /
 *                          offline 四态，per-instance 键控）；连续失败阈值熔断（F7.3）、
 *                          配额耗尽标记、响应时间戳、在途集合。恢复边设计：离线→在线由
 *                          宿主显式恢复（唯一自动恢复边不含熔断重置——熔断 open 后必须
 *                          显式 resetBreaker 或等 resetMs 窗，杜绝静默自愈掩盖根因）。
 *   2. pickMemberToWake —— 单实例唤醒选择（E9 升格必需）：每拍至多唤醒 1 个实例。
 *                          定向（task.assignee 具名）→ 只在该名下实例中选最闲；
 *                          池任务（assignee 空）→ 全体可用实例中选最闲。
 *                          最闲 = 无在途优先 → 连续失败少 → lastResponseAt 早（最久未响应）。
 *   3. resolveStale     —— stale 任务取代的工作台：**无自动重排路径**（重排风暴反制，
 *                          §4.2 硬约束）。非 terminal 任务的一切处置必须显式声明
 *                          （supersede / reassign），缺省一律拒绝（no-auto-requeue）。
 *                          杜绝「复核中途自动重排」类事故（账本 t30/t49/t52 谱系）。
 *
 * 纯逻辑、依赖注入，可在裸 node 下单元测试；不触任何平台服务（隔离验证纪律）。
 */

export const AVAILABILITY = {
  ONLINE: 'online',
  BREAKER_OPEN: 'breaker-open',
  QUOTA_EXHAUSTED: 'quota-exhausted',
  OFFLINE: 'offline',
}

/** 默认连续失败熔断阈值（per-instance，F7.3；§10 E2 建议初值 3，需实测）。 */
export const DEFAULT_BREAKER_THRESHOLD = 3
/** 默认熔断自动复位置（ms）；null = 仅显式 resetBreaker（默认保守：显式）。 */
export const DEFAULT_BREAKER_RESET_MS = null

/** 不解锁派活的可用态（唤醒选择只考虑 ONLINE）。不可用态仅供宿主反馈/审计。 */
export const WAKE_ELIGIBLE = [AVAILABILITY.ONLINE]

function emptyRecord() {
  return {
    availability: AVAILABILITY.ONLINE,
    consecutiveFailures: 0,
    lastError: null,
    lastResponseAt: null,
    breakerOpenedAt: null,
    inFlight: new Set(),
  }
}

/**
 * 成员可用性注册表（per-instance 键控；同角色多开 = 每实例一条记录，§3.1/§4.5）。
 * t96 · Slice 2（reviewer4 规格）：新增退役注销语义——markRetired 将成员标记为
 * offline 并记入 retired 集合（显式注销标记，供发现面标注与幂等 retire 判定）；
 * 注册表为内存态，roster 状态落盘属宿主装配层（经 retiredMembers() 导出）。
 */
export class MemberRegistry {
  /**
   * @param {object} [options]
   * @param {number} [options.breakerThreshold] - 连续失败阈值（默认 3）。
   * @param {number|null} [options.breakerResetMs] - 熔断自动复位置（默认 null=显式）。
   * @param {number} [options.now] - 可注入时钟（测试）；缺省 Date.now() 惰性。
   */
  constructor(options = {}) {
    this.breakerThreshold = options.breakerThreshold ?? DEFAULT_BREAKER_THRESHOLD
    this.breakerResetMs = options.breakerResetMs === undefined ? DEFAULT_BREAKER_RESET_MS : options.breakerResetMs
    this.records = new Map()
    this.retired = new Set()
    this._now = options.now
  }

  nowAt() {
    return this._now !== undefined ? this._now() : Date.now()
  }

  _record(memberId) {
    let r = this.records.get(memberId)
    if (r === undefined) {
      r = emptyRecord()
      this.records.set(memberId, r)
    }
    return r
  }

  availabilityOf(memberId) {
    const r = this.records.get(memberId)
    if (r === undefined) return AVAILABILITY.ONLINE // 未注册 = 视为在线（宿主尚未观察）；注册表以事实覆盖
    // 熔断时间窗自动复位（仅当配了 resetMs 且窗口已过）。
    if (r.availability === AVAILABILITY.BREAKER_OPEN && this.breakerResetMs !== null) {
      if (this.nowAt() - r.breakerOpenedAt >= this.breakerResetMs) {
        r.availability = AVAILABILITY.ONLINE
        r.consecutiveFailures = 0
      }
    }
    return r.availability
  }

  /** 宿主观测到成员回合/响应（唤醒送达、消息回报等）→ online + 刷新 lastResponseAt。 */
  markActive(memberId, now = this.nowAt()) {
    const r = this._record(memberId)
    // 退役注销单向：已退役成员不因任何观测复活（复活 = 重新 spawn 新代）。
    if (this.retired.has(memberId)) {
      r.availability = AVAILABILITY.OFFLINE
      return r
    }
    r.availability = AVAILABILITY.ONLINE
    r.lastResponseAt = now
    return r
  }

  /**
   * 连续失败 → per-instance 熔断（F7.3）。
   * 注意：consecutiveFailures 只在 ONLINE 连续累积；breaker-open / quota-exhausted 不重复计数。
   * @returns {{availability: string, consecutiveFailures: number, breached: boolean}}
   */
  recordFailure(memberId, error, now = this.nowAt()) {
    const r = this._record(memberId)
    if (r.availability === AVAILABILITY.BREAKER_OPEN || r.availability === AVAILABILITY.QUOTA_EXHAUSTED) {
      // 已熔断/已配额：记录最近错误但不重复累积（避免阈值漂移）。
      r.lastError = error === undefined ? r.lastError : String(error)
      return { availability: r.availability, consecutiveFailures: r.consecutiveFailures, breached: false }
    }
    r.consecutiveFailures += 1
    r.lastError = error === undefined ? null : String(error)
    const breached = r.consecutiveFailures >= this.breakerThreshold
    if (breached) {
      r.availability = AVAILABILITY.BREAKER_OPEN
      r.breakerOpenedAt = now
    }
    return { availability: r.availability, consecutiveFailures: r.consecutiveFailures, breached }
  }

  /** 配额耗尽标记（不改 consecutiveFailures；由宿主在 429/quota 错误时调用）。 */
  markQuotaExhausted(memberId, error, now = this.nowAt()) {
    const r = this._record(memberId)
    r.availability = AVAILABILITY.QUOTA_EXHAUSTED
    r.lastError = error === undefined ? null : String(error)
    r.breakerOpenedAt = now
    return r
  }

  /** 显式下线（轮换/移除前置，§4.3：标记后不再派活；宿主应同时处置其任务）。 */
  markOffline(memberId) {
    const r = this._record(memberId)
    r.availability = AVAILABILITY.OFFLINE
  }

  /**
   * 退役注销（t96 · Slice 2，reviewer4 规格）：offline（不派活）+ retired 集合标记
   * （显式注销语义：幂等 retire 判定 + 发现面标注依据）。退役成员不可被
   * markActive/markQuotaExhausted 复活——注销是单向的（复活 = 重新 spawn 新代）。
   */
  markRetired(memberId) {
    this.markOffline(memberId)
    this.retired.add(memberId)
  }

  /** 是否已退役注销。 */
  isRetired(memberId) {
    return this.retired.has(memberId)
  }

  /** 已退役名册快照（宿主落盘/发现面标注的数据源）。 */
  retiredMembers() {
    return [...this.retired]
  }

  /** 显式重置熔断（唯一恢复边之一；介质=人工/宿主策略校验后调用）。 */
  resetBreaker(memberId) {
    if (this.retired.has(memberId)) {
      // 退役成员无恢复边（注销单向）：reset 对其无效，显式拒绝以防误复活。
      const r = this.records.get(memberId)
      if (r !== undefined) r.availability = AVAILABILITY.OFFLINE
      return r
    }
    const r = this._record(memberId)
    r.availability = AVAILABILITY.ONLINE
    r.consecutiveFailures = 0
    r.breakerOpenedAt = null
    return r
  }

  consecutiveFailuresOf(memberId) {
    return this.records.get(memberId)?.consecutiveFailures ?? 0
  }

  lastResponseAtOf(memberId) {
    return this.records.get(memberId)?.lastResponseAt ?? null
  }

  inFlightOf(memberId) {
    return this.records.get(memberId)?.inFlight ?? new Set()
  }

  /** 记录在途任务（唤醒/claim 后宿主调用；report 结算后应 remove）。 */
  markInFlight(memberId, taskId) {
    this._record(memberId).inFlight.add(taskId)
  }
  clearInFlight(memberId, taskId) {
    this.records.get(memberId)?.inFlight.delete(taskId)
  }
}

/**
 * 单实例唤醒选择（E9 默认策略：定向→assignee 匹配最闲；池→无在途→最少连续失败→
 * lastResponseAt 最早；每拍至多返回 1 个）。不可用态（熔断/配额/离线）一律排除。
 *
 * 选序（两组相同）：
 *   1. 无在途（inFlight.size === 0）优先；
 *   2. consecutiveFailures 小优先；
 *   3. lastResponseAt 早（null 视为最早/从未响应）优先 —— 保证轮转不过度集中。
 * 平局取名字典序（可复现，避免不稳定唤醒）。
 * @param {MemberRegistry} registry
 * @param {object} task - { id, assignee }（assignee 空串 = 池任务）。
 * @param {Iterable<string>} memberIds - 候选成员名集合（宿主注册表视角的成员列表）。
 * @returns {string|null} 被唤醒的成员名（单实例；无可用返回 null）。
 */
export function pickMemberToWake(registry, task, memberIds) {
  const pool = [...memberIds]
    .map((id) => ({ id, ...registry.records.get(id) ?? emptyRecord() }))
    .filter((m) => WAKE_ELIGIBLE.includes(registry.availabilityOf(m.id)))
  if (pool.length === 0) return null
  const want = task.assignee
  const candidates = want !== undefined && want !== ''
    ? pool.filter((m) => m.id === want)
    : pool
  if (candidates.length === 0) return null
  candidates.sort((a, b) => {
    const aIdle = a.inFlight.size === 0 ? 0 : 1
    const bIdle = b.inFlight.size === 0 ? 0 : 1
    if (aIdle !== bIdle) return aIdle - bIdle
    if (a.consecutiveFailures !== b.consecutiveFailures) return a.consecutiveFailures - b.consecutiveFailures
    const ar = a.lastResponseAt ?? Number.NEGATIVE_INFINITY
    const br = b.lastResponseAt ?? Number.NEGATIVE_INFINITY
    if (ar !== br) return ar - br
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  return candidates[0].id
}

/** stale 取代的显式处置动作（无自动路径：非 terminal 的任务处置必须显式）。 */
export const STALE_ACTIONS = {
  /**
   * 显式作废（supersede）：宿主调用 P1 store.supersede（重排风暴反制要求调用方
   * 持有 supersededBy 目标；此处只做前置校验，真正迁移归 store）。
   */
  SUPERSEDE: 'supersede',
  /** 显式转派（reassign）：宿主调用 store.reassign（新 attemptId 交接，§4.3 双通道）。 */
  REASSIGN: 'reassign',
}

/**
 * stale 任务取代工作台。
 * 语义（§4.2 + §7 负面清单「无自动重排」）：非 terminal 任务没有自动重排路径——
 * explicit 缺省或为 'none' 一律返回 no-auto-requeue（重排风暴反制）。
 * @param {object} task - store 任务记录（非 terminal 才需要本函数）。
 * @param {object} opts
 * @param {'supersede'|'reassign'|'none'|undefined} [opts.explicit] - 显式处置动作。
 * @param {object} [opts.store] - TaskStore（explicit 为 supersede/reassign 时的迁移载体）。
 * @param {object} [opts.input] - store.supersede/reassign 的输入（revision 等）。
 * @param {number} [opts.now]
 * @returns {object} { ok, action?, reason? } — ok:false 时 reason 给出拒因。
 */
export function resolveStale(task, opts = {}) {
  if (opts.explicit === undefined || opts.explicit === 'none') {
    return { ok: false, reason: 'no-auto-requeue' }
  }
  if (opts.explicit === STALE_ACTIONS.SUPERSEDE) {
    if (opts.store === undefined) return { ok: false, reason: 'store-required' }
    return opts.store.supersede(task.id, { revision: task.revision, supersededBy: opts.input?.supersededBy }, opts.now ?? Date.now())
  }
  if (opts.explicit === STALE_ACTIONS.REASSIGN) {
    if (opts.store === undefined) return { ok: false, reason: 'store-required' }
    // P1 store.reassign 的入参字段为 `to`（新 assignee），见 task-store.js:530。
    return opts.store.reassign(task.id, { revision: task.revision, to: opts.input?.to }, opts.now ?? Date.now())
  }
  return { ok: false, reason: 'unknown-action' }
}