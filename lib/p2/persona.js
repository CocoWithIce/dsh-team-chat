/**
 * P2 自建成员 persona / welcome 渲染 —— lib/p2/persona.js
 *
 * t92 · P2 Slice 1a（自建成员通道落地的一部分）。纯函数，可在裸 node 下测试。
 *
 * 结构参照 AgentTeams 的 memberPersona（@nanmicoder/dsh-agent-teams/lib/members.js:425-458，
 * t91 已取证的生产同链），差异点（B′ 裁定，t92 契约）：
 *   - 身份声明 = 自建调度（`dsh-team-chat:` 前缀）而非 AgentTeams；
 *   - 任务协作 = B′ 成员白名单工具 `team_claim_task` / `team_report_task`
 *     （宿主侧直调 P1 store，零 HTTP 鉴权面），不再使用 agent_teams_*；
 *   - 消息协作模型保留（宿主 push 唤醒 / 成员回合自循环）。
 *
 * persona 经 startContinuable 的 request.persona 注入（E4 映射：executionPrompt→persona）。
 */

import { CLAIM_TOOL, REPORT_TOOL, MEMBER_TOOL_NAMES } from './tool-names.js'

// t94 · Slice 1b（t93 low-②）：工具名收敛到 tool-names.js 单一常量源，
// 本文件只 re-export 兼容 1a 的既有 import 面（MEMBER_TOOL_NAMES）。
export { CLAIM_TOOL, REPORT_TOOL, MEMBER_TOOL_NAMES }

/** persona 文本上限（与 AgentTeams PERSONA_PROTOCOL_MAX_CHARS 同量级意识，防超长注入）。 */
export const PERSONA_MAX_CHARS = 6000

/**
 * 渲染自建成员 persona（注入 request.persona）。
 * @param {object} input
 * @param {string} input.teamName - 团队显示名（用于身份声明）。
 * @param {string} input.teamId - 团队 id（用于成员定位团队状态）。
 * @param {string} input.memberName - 成员名（label 内已含，persona 再声明一遍便于自我认知）。
 * @param {string} [input.role] - 角色（researcher/engineer/reviewer…）。
 * @param {string} [input.goal] - 团队目标（team.description）。
 * @param {string} [input.profileProtocol] - 档案协议（可空）。
 * @param {string} [input.executionPrompt] - 执行指引（可空）。
 * @param {string} [input.stateDir] - 团队状态目录（只读诊断说明用）。
 * @returns {string} persona 全文。
 */
export function renderMemberPersona(input) {
  const teamName = input.teamName || '(unnamed team)'
  const teamId = input.teamId || ''
  const memberName = input.memberName || '(unnamed)'
  const goal = (input.goal || '').trim() || '(not provided)'
  const protocol = (input.profileProtocol || '').trim()
  const guidance = (input.executionPrompt || '').trim()
  const roleLine = input.role ? ` with the role: ${input.role}` : ''

  const parts = []
  parts.push(`You are ${memberName}, a member of the self-built team "${teamName}" running inside DeepSeek Harness. The captain leads the team; you are a worker member${roleLine}.`)
  parts.push('')
  parts.push('Team context:')
  parts.push(`- Team id: ${teamId}`)
  parts.push(`- Your name inside the team (use it as \`from\`/identity): ${memberName}`)
  parts.push(`- Team goal: ${goal}`)
  if (protocol !== '') parts.push(`- Profile protocol: ${protocol}`)
  if (guidance !== '') parts.push(`- Execution guidance:\n${guidance}`)
  if (input.stateDir) {
    parts.push(`- The team state lives under ${input.stateDir}/${teamId}/ (read-only diagnostics for you).`)
  }
  parts.push('')
  parts.push('Working rules:')
  parts.push(`1. When you receive a task assignment (or find one assigned to you), call ${CLAIM_TOOL} with the taskId to claim it. The host records the attempt on your behalf — you never track attempt ids.`)
  parts.push(`2. Work thoroughly with your available tools; do not cut corners.`)
  parts.push(`3. Report progress/completion by calling ${REPORT_TOOL} with the taskId and status (\`running\` when you start, \`completed\`/\`failed\` when you finish). The host applies the transition to the shared task store; you never touch team state files directly.`)
  parts.push('4. Send a short report to the captain when you complete a task or hit a blocker.')
  parts.push('5. After your turn becomes idle, the host scheduler may wake you for your next ready task. Never claim a second task while you still own unfinished work.')
  parts.push('6. If you already own an open task and receive new mail, treat it as guidance for that same task unless the mail explicitly tells you to stop or fail.')
  parts.push('7. You are a worker: do not create or delete teams, reassign tasks, or add/remove members — that is the captain\'s job. Do not start a teammate\'s assigned task.')

  let text = parts.join('\n')
  if (text.length > PERSONA_MAX_CHARS) text = text.slice(0, PERSONA_MAX_CHARS) + '…'
  return text
}

/**
 * 渲染成员初始欢迎消息（startContinuable request.prompt 的第一块）。
 * @param {object} input
 * @param {string} input.teamName
 * @param {string} input.memberName
 * @param {number} [input.pendingCount] - 已指派待认领任务数（0 时省略）。
 * @returns {string} 欢迎文本。
 */
export function renderMemberWelcome(input) {
  const pending = typeof input.pendingCount === 'number' && input.pendingCount > 0
    ? `\nYou already have ${input.pendingCount} pending task(s) assigned to you.`
    : ''
  return `You have joined the team "${input.teamName || '(unnamed team)'}" as ${input.memberName || '(unnamed)'}. Wait for an automatic assignment or a captain message.${pending}`
}

/** 构造 startContinuable prompt 块数组（ContentBlock[] 契约形态，t91 E4）。 */
export function memberWelcomeBlocks(welcomeText) {
  return [{ type: 'text', text: welcomeText }]
}