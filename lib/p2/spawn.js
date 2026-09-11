/**
 * P2 自建成员通道（E4 落地）—— lib/p2/spawn.js
 *
 * t92 · P2 Slice 1a。`spawnMember` 经 `subagents.startContinuable` 直调，字段映射
 * 逐项对齐 t91 取证（E4）：platform contract = @deepseek-ai/dsh-subagent
 *   ContinuableStartSpec { provider, label, childId?, request, signal }（typert.host.js:375-376）
 *   SubagentStartRequest  { label?, prompt: ContentBlock[], parent: Agent, signal,
 *                           agentOptions?, outputSchema?, maxDepth?, toolFilter?, persona? }
 *                         （typert.host.js:696）
 * 生产同链参照 = @nanmicoder/dsh-agent-teams/lib/members.js:485-522（t91 已取证）。
 *
 * 依赖注入：`deps` 只依赖 { getProvider(name), startContinuable(spec) }（ctx.subagents
 * 适配子集），可在裸 node 下用受控桩测试（t92 隔离验证纪律：不接用户现有团队、
 * 不触发真实 spawn 由红线约束，真实端到端可行性由 t91 + AgentTeams 生产链背书）。
 */

import {
  renderMemberPersona,
  renderMemberWelcome,
  memberWelcomeBlocks,
} from './persona.js'
import { MEMBER_TOOL_NAMES } from './tool-names.js'
import { memberPrompt } from '../shared.js'

export const MEMBER_LABEL_PREFIX = 'dsh-team-chat:'

/**
 * Roster label：`dsh-team-chat:<teamId>:<memberName>`。
 * 与 AgentTeams 的 `agent-teams:<team>:<member>`（members.js:503）同构、前缀隔离
 * ——AgentTeams 按自身前缀过滤发现（members.js:278/284），两套 roster 互不干扰
 *（v0.7 设计 §9.1.1 防双调度边界）。
 * @returns {string}
 */
export function buildMemberLabel(teamId, memberName) {
  return `${MEMBER_LABEL_PREFIX}${teamId}:${memberName}`
}

/**
 * 纯函数：按平台契约构造 ContinuableStartSpec。
 * 逐字段映射（t91 核对结论）：
 *   provider   —— 顶层必填（route：由宿主解析，配额感知入口 agentOptions 同源）；
 *   label      —— 顶层必填（成员名经 label 承载，契约无 name 字段）；
 *   childId    —— 可选；缺省由平台生成（brandString(randomUUID)，continuation.js:244）；
 *   request    —— Omit<SubagentStartRequest,'label'|'signal'|'outputSchema'>：
 *                  prompt       ContentBlock[]（memberWelcomeBlocks）；
 *                  parent       live Agent（宿主经 ctx.agents.get(captainId) 解析，
 *                               AgentTeams 同款 tools.js:1664；dsh-agent index.js:689-690）；
 *                  persona      executionPrompt 注入载体（memberPersona 合入）；
 *                  toolFilter   B′ 白名单：{ allow: [...MEMBER_TOOL_NAMES] } 或传入的
 *                               allow/deny（ToolRestriction 支持两形态，typert.host.js:780）；
 *                  agentOptions { provider, model, reasoningEffort? }（配额感知，members.js:512-518）；
 *                  maxDepth     （可选，平台 desolveChildDepth 用）。
 *   signal     —— 调用方取消信号（测试可传 AbortSignal.timeout 或恒定信号）。
 * @param {object} input
 * @returns {object} ContinuableStartSpec 形状（不含 signal 时由调用方补）。
 */
export function buildContinuableStartSpec(input) {
  const label = input.label ?? buildMemberLabel(input.teamId, input.memberName)
  const request = {
    prompt: memberWelcomeBlocks(
      input.welcomeText ?? renderMemberWelcome({
        teamName: input.teamName,
        memberName: input.memberName,
        pendingCount: input.pendingCount,
      }),
    ),
    parent: input.parent,
  }
  if (input.persona !== undefined) request.persona = input.persona
  if (input.toolFilter !== undefined) request.toolFilter = input.toolFilter
  if (input.agentOptions !== undefined) request.agentOptions = input.agentOptions
  if (input.maxDepth !== undefined) request.maxDepth = input.maxDepth
  const spec = {
    provider: input.provider,
    label,
    request,
    // t94 · Slice 1b 真实端到端实测发现（1a 契约缺口）：平台 startContinuable 会读
    // signal.throwIfAborted（ContinuableStartSpec.signal 契约必填），缺省 undefined
    // 直接 TypeError。缺省 = 不可取消信号（无取消语义时 spec 仍形状完整）。
    signal: input.signal ?? new AbortController().signal,
  }
  if (input.childId !== undefined) spec.childId = input.childId
  return spec
}

/**
 * 编排：检查 provider 能力 → 构造 spec → startContinuable → 返回 childId/label。
 * 能力前置检查参照 AgentTeams members.js:489-502（缺失即 loud failure，不静默）。
 * @param {object} deps - { getProvider(name), startContinuable(spec) }
 * @param {object} input
 * @param {object} input.member - { name, role, provider, model, reasoningEffort?,
 *                                  route?: { provider, model, reasoningEffort? },
 *                                  executionPrompt? }（角色配置，memberPrompt 渲染；
 *                                  route = 子代理 LLM 路由，缺省回退 provider/model）。
 * @param {object} input.team - { id, name, description?, profile? }（团队上下文）。
 * @param {string} [input.stateDir] - 团队状态目录（persona 只读诊断说明）。
 * @param {object} input.parent - live Agent（may be undefined → 显式失败）。
 * @param {string[]} [input.allowTools] - B′ 白名单工具（默认 MEMBER_TOOL_NAMES）。
 * @param {string} [input.welcomeText] - 可选：覆盖默认欢迎文本（t95 low②：1a 曾丢弃；
 *                                       taskId 下发按 §2.3 走唤醒消息，welcome 不承载）。
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<object>} { ok, childId?, messageId?, label?, spec?, reason? }
 */
export async function spawnMember(deps, input) {
  const member = input.member || {}
  const team = input.team || {}
  const provider = deps.getProvider(member.provider)
  if (provider === undefined) {
    return { ok: false, reason: 'provider-not-registered', provider: member.provider }
  }
  if (provider.prepareContinuable === undefined) {
    return { ok: false, reason: 'provider-no-continuable', provider: member.provider }
  }
  if (provider.capabilities?.persona !== true) {
    return { ok: false, reason: 'provider-no-persona', provider: member.provider }
  }
  if (provider.capabilities?.toolFilter !== true) {
    return { ok: false, reason: 'provider-no-toolfilter', provider: member.provider }
  }
  if (input.parent === undefined || input.parent === null) {
    return { ok: false, reason: 'parent-agent-unresolved' }
  }
  const label = buildMemberLabel(team.id, member.name)
  // t94 · Slice 1b：agentOptions 是「子代理的 LLM 路由」（配额感知，AgentTeams
  // members.js:512-518 用 llmSelection），与 spec.provider 的「spawn 驱动 provider」
  // 是两个不同注册表——1a 用 member.provider 同时填两处属契约混淆，真实 spawn 会把
  // LLM 路由错填成驱动名。修复：route（LLM 路由）显式优先，缺省回退旧形态（兼容）。
  const route = member.route ?? { provider: member.provider, model: member.model }
  const agentOptions = {
    provider: route.provider,
    model: route.model,
  }
  if (route.reasoningEffort !== undefined && route.reasoningEffort !== '') {
    agentOptions.reasoningEffort = route.reasoningEffort
  }
  const guidance = memberPrompt({
    role: member.role,
    executionPrompt: member.executionPrompt,
  })
  const persona = renderMemberPersona({
    teamName: team.name,
    teamId: team.id,
    memberName: member.name,
    role: member.role,
    goal: team.description,
    profileProtocol: team.profile?.protocol,
    executionPrompt: guidance,
    stateDir: input.stateDir,
  })
  const spec = buildContinuableStartSpec({
    provider: member.provider,
    label,
    teamId: team.id,
    teamName: team.name,
    memberName: member.name,
    parent: input.parent,
    persona,
    // t96 · Slice 2（t95 low② 对齐）：welcomeText 透传不再丢弃——缺省仍为
    // renderMemberWelcome；携带 taskId 的定向下发按设计 §2.3 走 send_message
    // 唤醒元数据（captain-tools.sendCaptainMessage kind:wake），welcome 只做欢迎。
    ...(input.welcomeText !== undefined ? { welcomeText: input.welcomeText } : {}),
    toolFilter: { allow: input.allowTools ?? [...MEMBER_TOOL_NAMES] },
    agentOptions,
    signal: input.signal,
  })
  try {
    const start = await deps.startContinuable(spec)
    return {
      ok: true,
      childId: start.childId,
      messageId: start.messageId,
      label,
      spec,
    }
  } catch (error) {
    return { ok: false, reason: 'start-failed', error: String(error), label }
  }
}