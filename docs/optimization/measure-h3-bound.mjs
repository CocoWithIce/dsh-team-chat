// dsh-team-chat — measurement: routingText worst-case bound (H3)
// Each member's guidance is capped at MEMBER_PROMPT_LIMIT=1200 chars (shared.js:37, memberPrompt)
import { routingText, memberPrompt } from 'file:///E:/DSH_Desktop/DSH%20Desktop/dsh-team-chat/lib/shared.js'

const longPrompt = 'x'.repeat(2000) // longer than the 1200 cap — memberPrompt must clamp it
const member = { name: 'researcher', role: '研究员', provider: 'opencode-go', model: 'deepseek-v4-flash', reasoningEffort: 'high', soul: '先取证再结论；区分「已验证」与「推测」；产出必须附来源。', skills: ['understand', 'web-search'], mcp: ['postgres'], plugins: ['dsh-better-sidebar'], memory: 'bank:team-x', executionPrompt: longPrompt }
const clamped = memberPrompt(member)
console.log('memberPrompt clamp check: input 2000 chars → output', clamped.length, 'chars (cap=1200)')

const roster = ['researcher', 'engineer', 'reviewer'].map((name, i) => ({
  name, role: ['研究员', '工程师', '审查员'][i],
  provider: 'opencode-go', model: 'deepseek-v4-flash', reasoningEffort: 'high',
  soul: '先取证再结论；区分「已验证」与「推测」；产出必须附来源。',
  skills: ['understand'], mcp: [], plugins: [], memory: 'bank:team-x',
  executionPrompt: longPrompt, // every member at the cap → worst case
}))
const cfg = { enabled: true, autoCreateTeam: true, autoApproveTeam: true, imProgress: true, imPush: false, defaultTeamId: 'worst', teams: [{ id: 'worst', name: 'worst', description: 'x', members: roster }] }
const text = routingText(cfg, cfg.teams[0])
console.log('worst-case routingText chars:', [...text].length)
console.log('worst-case routingText utf8 bytes:', Buffer.byteLength(text, 'utf8'))
console.log()
console.log('summary: routingText size range measured:')
console.log('  default trio (soul only)         : 931 chars / 2,105 B')
console.log('  current team.json prompts        : 1,530 chars / 3,577 B')
console.log('  worst case (all @1200 cap)       :', [...text].length, 'chars /', Buffer.byteLength(text, 'utf8'), 'B')