/**
 * dsh-team-chat — shared pure helpers.
 *
 * Everything here is side-effect free and framework-free so it can be unit
 * tested directly with `node --test` and reused by the host half. The client
 * half receives already-grouped threads from `/state`, so it never re-implements
 * this logic.
 *
 * @module dsh-team-chat/shared
 */

/** Subagent label prefix AgentTeams mints for its members (`<prefix><team>:<member>`). Legacy-compatible. */
export const LABEL_PREFIX = 'agent-teams:'
/** Label prefix this plugin's self-built scheduler mints for its members (t98 · P2 Slice 3). */
export const LABEL_PREFIX_P2 = 'dsh-team-chat:'
/** Both recognized roster prefixes: P2 self-built first, AgentTeams legacy-compatible second. */
export const LABEL_PREFIXES = [LABEL_PREFIX_P2, LABEL_PREFIX]

/** Default roster when no explicit roles are configured. */
export const DEFAULT_ROLES = ['researcher', 'engineer', 'reviewer']

/** Longest quoted excerpt carried in a reply's quote block. */
export const QUOTE_LIMIT = 120

/** Display metadata per role: glyph, localized label, frame color. */
export const ROLE_META = {
  researcher: { icon: '🔬', label: '研究员', color: '#4f8cff' },
  engineer: { icon: '🛠', label: '工程师', color: '#34c77b' },
  reviewer: { icon: '🧐', label: '审查员', color: '#ff9f43' },
  me: { icon: '🙋', label: '我', color: '#a78bfa' },
}

/** Team id / member name charset: safe inside the subagent label and the state dir. */
export const TEAM_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,40}$/
export const MEMBER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,40}$/

/** AgentTeams defaults `maxMembers` to 8; templates follow the same ceiling. */
export const MAX_MEMBERS = 8

/** Longest rendered per-member execution guidance. */
export const MEMBER_PROMPT_LIMIT = 1200

/**
 * The shipped default team. Every member field the editor exposes is present so
 * the settings UI never has to special-case a missing property.
 */
export const DEFAULT_TRIO = {
  id: 'trio',
  name: '铁三角',
  description: '调研 → 实施 → 把关的常驻三角色团队',
  members: [
    {
      name: 'researcher',
      role: '研究员',
      provider: '',
      model: '',
      reasoningEffort: '',
      soul: '先取证再结论；区分「已验证」与「推测」；产出必须附来源。',
      skills: [],
      plugins: [],
      mcp: [],
      memory: '',
      executionPrompt: '',
    },
    {
      name: 'engineer',
      role: '工程师',
      provider: '',
      model: '',
      reasoningEffort: '',
      soul: '动手前先确认目标与验收标准；交付可复核证据（命令、输出、退出码）。',
      skills: [],
      plugins: [],
      mcp: [],
      memory: '',
      executionPrompt: '',
    },
    {
      name: 'reviewer',
      role: '审查员',
      provider: '',
      model: '',
      reasoningEffort: '',
      soul: '独立核验、不引用被审方结论；批评对事不对人，修复要求具体可执行。',
      skills: [],
      plugins: [],
      mcp: [],
      memory: '',
      executionPrompt: '',
    },
  ],
}

/**
 * Extract the member name from a roster subagent label. Both prefixes parse the
 * same way: `agent-teams:multi-role-team:researcher` and
 * `dsh-team-chat:trio:researcher` → `researcher`.
 * @param label - the raw subagent label.
 * @returns the member name (falls back to the last segment, then `member`).
 */
export function roleFromLabel(label) {
  const parts = String(label ?? '').split(':')
  return parts.length >= 3 ? parts[2] : parts[parts.length - 1] || 'member'
}

/**
 * Extract the team name from a roster subagent label. Both prefixes parse the
 * same way: `agent-teams:multi-role-team:researcher` and
 * `dsh-team-chat:trio:researcher` → `multi-role-team` / `trio`.
 * @param label - the raw subagent label.
 * @returns the team name, or an empty string when the label is malformed.
 */
export function teamFromLabel(label) {
  const parts = String(label ?? '').split(':')
  return parts.length >= 2 ? parts[1] : ''
}

/**
 * Whether a subagent label belongs to this plugin's roster. t98 · P2 Slice 3:
 * both prefixes are recognized — `dsh-team-chat:`（P2 自建）and
 * `agent-teams:`（存量兼容）— so mixed rosters render as one team.
 * @param label - the candidate label.
 */
export function isTeamLabel(label) {
  return typeof label === 'string' && LABEL_PREFIXES.some((prefix) => label.startsWith(prefix))
}

/**
 * Resolve display metadata for one speaker.
 * @param name - a member name such as `researcher`, or `me`.
 * @returns `{ icon, label, color }`, falling back to a generic frame.
 */
export function roleMeta(name) {
  const known = ROLE_META[name]
  if (known !== undefined) return known
  return { icon: '👤', label: String(name ?? 'member'), color: '#8a8f98' }
}

/**
 * Build the excerpt shown in a reply's quote block.
 * @param text - the quoted message body.
 * @param limit - maximum characters before elision.
 * @returns a single-line excerpt, elided with `…` when it was longer.
 */
export function quoteSnippet(text, limit = QUOTE_LIMIT) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > limit ? flat.slice(0, limit) + '…' : flat
}

/**
 * Walk a message up to its thread root.
 *
 * A message whose `rootId` is missing, empty, self-referential, or pointing at a
 * message that was pruned out of the window is its own root — which is what
 * promotes orphaned replies back to the top level instead of dropping them.
 *
 * A cycle (`a→b→a`) resolves every participant to itself rather than to another
 * member of the cycle: picking a winner inside the cycle would make that winner
 * both a root and a reply, duplicating it in the window.
 * @param message - the message to resolve.
 * @param byId - every message in the window, keyed by id.
 * @returns the root message.
 */
function rootOf(message, byId) {
  let current = message
  const seen = new Set([current.id])
  for (;;) {
    const parentId = current.rootId
    if (typeof parentId !== 'string' || parentId === '' || parentId === current.id) return current
    const parent = byId.get(parentId)
    if (parent === undefined) return current
    if (seen.has(parent.id)) return message
    seen.add(parent.id)
    current = parent
  }
}

/**
 * Group a flat, time-ordered message list into thread trees.
 *
 * Roots keep their original order; replies keep theirs inside their root. A
 * reply whose root is absent from the window is promoted to a root so no
 * message is ever lost by pruning.
 * @param messages - flat messages, oldest first.
 * @returns `[{ root, replies }]`, oldest-first.
 */
export function groupThreads(messages) {
  const list = Array.isArray(messages) ? messages : []
  const byId = new Map()
  for (const message of list) byId.set(message.id, message)

  const order = []
  const threads = new Map()
  for (const message of list) {
    const root = rootOf(message, byId)
    let thread = threads.get(root.id)
    if (thread === undefined) {
      thread = { root, replies: [] }
      threads.set(root.id, thread)
      order.push(root.id)
    }
    if (root.id !== message.id) thread.replies.push(message)
  }
  return order.map((id) => threads.get(id))
}

/**
 * Extract the IM conversation a session was started from.
 *
 * IM-driven sessions open with a `<dsh_im_source>{…}</dsh_im_source>` block, and
 * the delivery endpoint addresses the conversation as
 * `<kind>:<chatId>[:thread:<threadId>]` — the same key the IM plugin stores in its
 * own conversation map.
 * @param text - one user message body.
 * @returns `{ botId, targetId, chatId, threadId, channel }`, or null when the
 *   message did not come from IM.
 */
export function imTargetFromText(text) {
  const match = /<dsh_im_source>([\s\S]*?)<\/dsh_im_source>/.exec(String(text ?? ''))
  if (match === null) return null
  let source
  try {
    source = JSON.parse(match[1])
  } catch {
    return null
  }
  if (source === null || typeof source !== 'object') return null
  const botId = typeof source.botId === 'string' ? source.botId.trim() : ''
  const chatId = typeof source.chatId === 'string' ? source.chatId.trim() : ''
  const threadId = typeof source.threadId === 'string' ? source.threadId.trim() : ''
  if (botId === '' || chatId === '') return null
  const kind = source.conversationType === 'direct' ? 'direct' : 'group'
  return {
    botId,
    chatId,
    threadId,
    channel: typeof source.channel === 'string' ? source.channel : '',
    targetId: threadId === '' ? `${kind}:${chatId}` : `${kind}:${chatId}:thread:${threadId}`,
  }
}

/**
 * Build the routing prompt section.
 *
 * t98 · P2 Slice 3（routingText 解耦）：AgentTeams 指令在本节全面退场——队长不再被
 * 指引使用任何 `agent_teams_*` 工具；新任务一律走 `/team-tasks`（P1 状态层），
 * 成员由自建调度器（`dsh-team-chat:` 前缀）管理，观察走 P1 `/state` 投影与群聊
 * 步骤视图（§9.1.1 三条硬约束进指令文本）。
 *
 * The per-member blocks are the ONLY channel for member-level configuration:
 * the member's `executionPrompt` is injected verbatim into their persona, so
 * everything the editor collects must be rendered into that one string（t80 C 类
 * 渲染通道——本切片保留，注入者由后续 Slice 替换）.
 * @param config - the resolved `team-chat` settings namespace.
 * @param team - the effective team template for this session.
 * @returns the prompt section text, or an empty string when disabled.
 */
export function routingText(config = {}, team) {
  if (config.enabled === false) return ''
  const active = team && Array.isArray(team.members) && team.members.length > 0
    ? team
    : normalizeTeams(config).teams[0]
  const engageLine = config.autoCreateTeam === false
    ? '1. 本会话不自动建队：只有当用户明确要求使用团队时才启用团队模式。'
    : '1. 本会话已按上方名册进入团队模式：任务一律进 /team-tasks 任务池，由自建调度器分派，无需手工建队。'

  const roster = active.members.map((member, index) => {
    const route = [member.provider, member.model].filter((part) => part !== '').join('/')
    const head = `${index + 1}. ${member.name}${member.role === '' ? '' : '（' + member.role + '）'}`
      + (route === '' ? '' : ' · model: ' + route)
      + (member.reasoningEffort === '' ? '' : ' · effort: ' + member.reasoningEffort)
    const guidance = memberPrompt(member)
    if (guidance === '') return head
    const indented = guidance.split('\n').map((line) => '   ' + line).join('\n')
    return `${head}\n   executionPrompt（必须原样传入该成员）:\n${indented}`
  }).join('\n')

  // IM-driven sessions: the chat relay forwards the CAPTAIN's replies, not the
  // members' own turns, so progress only reaches the user if the captain says it.
  const imClause = config.imProgress === false
    ? ''
    : '8. 若本会话来自 IM（用户消息带 `<dsh_im_source>`，例如飞书 / 企业微信），你的每条回复都会被转发到那个聊天：请把团队成员的关键进度用 1–3 行简短中文汇报（谁认领了什么、谁完成了什么、有什么阻塞或失败）。成员经任务回报通道推进时会唤醒你，那正是播报的时机。'

  return [
    '## 团队模式（已启用）',
    `本会话使用团队模板「${active.name}」${active.description === '' ? '' : '：' + active.description}`,
    '用户的任务优先交给这个团队处理，而不是由你直接实现。名册与每名成员的配置如下：',
    roster,
    '',
    '执行规则（P2 自建调度 · AgentTeams 指令退场）：',
    engageLine,
    '2. 新任务一律走 /team-tasks（P1 状态层）：创建、推进、结算全部经任务池完成，任务账本唯一。',
    '3. 不得用 AgentTeams 的建队/建成员/派活指令（agent_teams_* 已退场）：名册保持只读，成员由自建调度器管理（dsh-team-chat: 前缀），与旧前缀结构性隔离（§9.1.1）。',
    '4. 观察进展走 P1：/state 投影与群聊步骤视图；你（队长）负责拆解、分派、裁定与汇报，不亲自承担成员职责内的实现或验证。',
    '5. 指导与协调经群聊侧栏发言送达成员；成员空闲时由调度器接管，不要重复他们的工作。',
    '6. 群聊侧栏的发言与任务广播会直接送达成员，成员的真实回复会流入侧栏。',
    '7. 若你是被作为团队成员启动的子代理（subagent），请完全忽略本节。',
    ...(imClause === '' ? [] : [imClause]),
  ].join('\n')
}

/** Trim to a non-empty string, optionally capped. */
function toText(value, limit = 0) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  return limit > 0 && text.length > limit ? text.slice(0, limit) + '…' : text
}

/** Trim, de-duplicate and cap a list of user-entered strings. */
function toStringList(value, limit = 12) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text !== '' && !out.includes(text)) out.push(text)
    if (out.length >= limit) break
  }
  return out
}

/**
 * Render one member's configuration into the single string AgentTeams injects
 * into that member's persona. Empty sections are omitted rather than emitted
 * blank, so a member with nothing configured contributes no noise.
 * @param member - a template member.
 * @returns the execution guidance text (possibly empty).
 */
export function memberPrompt(member) {
  const source = member || {}
  const parts = []
  const soul = toText(source.soul)
  if (soul !== '') parts.push('【角色人格】' + soul)
  const skills = toStringList(source.skills)
  if (skills.length > 0) parts.push('【优先技能】' + skills.join('、') + '（动手前先用 skill 工具加载）')
  const mcp = toStringList(source.mcp)
  if (mcp.length > 0) parts.push('【可用 MCP】' + mcp.join('、'))
  const plugins = toStringList(source.plugins)
  if (plugins.length > 0) parts.push('【依赖插件】' + plugins.join('、'))
  const memory = toText(source.memory)
  if (memory !== '') parts.push('【记忆】' + memory)
  const extra = toText(source.executionPrompt)
  if (extra !== '') parts.push(extra)
  const text = parts.join('\n')
  return text.length > MEMBER_PROMPT_LIMIT ? text.slice(0, MEMBER_PROMPT_LIMIT) + '…' : text
}

/** Deep-copy the shipped default team so callers can never mutate the constant. */
export function cloneDefaultTrio() {
  return {
    id: DEFAULT_TRIO.id,
    name: DEFAULT_TRIO.name,
    description: DEFAULT_TRIO.description,
    members: DEFAULT_TRIO.members.map((member) => ({ ...member, skills: [], plugins: [], mcp: [] })),
  }
}

/** Normalize one member, reporting why it was dropped. */
function normalizeMember(raw, teamId, seenNames, errors) {
  if (raw === null || typeof raw !== 'object') {
    errors.push(`团队「${teamId}」：成员项不是对象，已忽略`)
    return undefined
  }
  const name = toText(raw.name)
  if (!MEMBER_NAME_PATTERN.test(name)) {
    errors.push(`团队「${teamId}」：成员名「${String(raw.name ?? '')}」不合法（仅小写字母、数字、- 和 _，且以字母或数字开头）`)
    return undefined
  }
  if (seenNames.has(name)) {
    errors.push(`团队「${teamId}」：成员名「${name}」重复，已忽略后一个`)
    return undefined
  }
  seenNames.add(name)
  return {
    name,
    role: toText(raw.role),
    provider: toText(raw.provider),
    model: toText(raw.model),
    reasoningEffort: toText(raw.reasoningEffort),
    soul: toText(raw.soul),
    skills: toStringList(raw.skills),
    plugins: toStringList(raw.plugins),
    mcp: toStringList(raw.mcp),
    memory: toText(raw.memory),
    executionPrompt: toText(raw.executionPrompt),
  }
}

/**
 * Validate and normalize the stored team templates.
 *
 * Bad input is dropped with a reason instead of failing the whole write: a typo
 * in one member must not cost the user every other team. An empty result falls
 * back to the shipped trio.
 * @param input - the resolved `team-chat` settings section (or anything).
 * @returns `{ teams, defaultTeamId, errors }` — always usable.
 */
export function normalizeTeams(input) {
  const errors = []
  const source = input && Array.isArray(input.teams) ? input.teams : []
  const teams = []
  const seenTeamIds = new Set()

  for (const raw of source) {
    if (raw === null || typeof raw !== 'object') {
      errors.push('团队项不是对象，已忽略')
      continue
    }
    const id = toText(raw.id)
    if (!TEAM_ID_PATTERN.test(id)) {
      errors.push(`团队 id「${String(raw.id ?? '')}」不合法（仅小写字母、数字、- 和 _，且以字母或数字开头）`)
      continue
    }
    if (seenTeamIds.has(id)) {
      errors.push(`团队 id「${id}」重复，已忽略后一个`)
      continue
    }
    const seenNames = new Set()
    const members = []
    for (const memberRaw of Array.isArray(raw.members) ? raw.members : []) {
      const member = normalizeMember(memberRaw, id, seenNames, errors)
      if (member !== undefined) members.push(member)
      if (members.length >= MAX_MEMBERS) break
    }
    if (members.length === 0) {
      errors.push(`团队「${id}」没有任何可用成员，已忽略该团队`)
      continue
    }
    seenTeamIds.add(id)
    teams.push({ id, name: toText(raw.name) || id, description: toText(raw.description), members })
  }

  if (teams.length === 0) teams.push(cloneDefaultTrio())

  const requested = toText(input && input.defaultTeamId)
  const defaultTeamId = teams.some((team) => team.id === requested) ? requested : teams[0].id
  if (requested !== '' && requested !== defaultTeamId) {
    errors.push(`默认团队「${requested}」不存在，已回落到「${defaultTeamId}」`)
  }

  return { teams, defaultTeamId, errors }
}

/**
 * Pick the team a session should use: its explicit override, else the default.
 * @param normalized - the output of {@link normalizeTeams}.
 * @param teamId - a per-session override id, when one is set.
 * @returns the effective team template.
 */
export function teamFor(normalized, teamId) {
  const teams = normalized && Array.isArray(normalized.teams) ? normalized.teams : []
  const wanted = typeof teamId === 'string' ? teamId : ''
  return teams.find((team) => team.id === wanted) || teams[0] || cloneDefaultTrio()
}
