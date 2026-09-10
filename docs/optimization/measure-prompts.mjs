// dsh-team-chat — measurement: routingText with REAL member prompts from team.json (H3, production case)
import fs from 'node:fs'
import { routingText } from 'file:///E:/DSH_Desktop/DSH%20Desktop/dsh-team-chat/lib/shared.js'

const teamJson = JSON.parse(fs.readFileSync('E:/DSH_Desktop/DSH Desktop/.agent-teams/multi-role-team/team.json', 'utf8'))
const members = teamJson.members.map((m) => ({
  name: m.name,
  role: m.role,
  provider: m.provider || '',
  model: m.model || '',
  reasoningEffort: m.reasoningEffort || '',
  soul: '',
  skills: [],
  plugins: [],
  mcp: [],
  memory: '',
  executionPrompt: m.executionPrompt || '',
}))
const cfg = { enabled: true, autoCreateTeam: true, autoApproveTeam: true, imProgress: true, imPush: false, defaultTeamId: teamJson.id, teams: [{
  id: teamJson.id, name: teamJson.name, description: teamJson.description, members,
}] }
const text = routingText(cfg, cfg.teams[0])
console.log('real-team routingText chars:', [...text].length)
console.log('real-team routingText utf8 bytes:', Buffer.byteLength(text, 'utf8'))
console.log('real-team routingText lines:', text.split('\n').length)
// per-member prompt sizes
for (const m of members) {
  console.log(`  member ${m.name}: executionPrompt ${m.executionPrompt.length} chars`)
}
// What does a per-request model payload look like? The section text is one part of systemPrompt.
// Approximate cost per root-agent session per model request = routingText bytes (plus framing).
console.log()
console.log('per-agent scoped section (index.js:499-535) renders routingText into each ROOT agent.')
console.log('global section (index.js:567-580) also mounts routingText when no scoped instance exists.')