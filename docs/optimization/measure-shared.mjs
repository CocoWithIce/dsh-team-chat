// dsh-team-chat — measurement: routingText size (H3)
// Run: node measure-shared.mjs   (cwd may be anywhere; path is absolute)
import { normalizeTeams, routingText } from 'file:///E:/DSH_Desktop/DSH%20Desktop/dsh-team-chat/lib/shared.js'

const cfg = {
  enabled: true, autoCreateTeam: true, autoApproveTeam: true,
  imProgress: true, imPush: false, defaultTeamId: 'trio', teams: [],
}
const normalized = normalizeTeams({ ...cfg })
const team = normalized.teams[0]
console.log('team:', team.id, team.name, 'members:', team.members.length)
const text = routingText(cfg, team)
console.log('chars:', [...text].length)
console.log('utf8 bytes:', Buffer.byteLength(text, 'utf8'))
console.log('lines:', text.split('\n').length)
console.log('--- first 400 chars ---')
console.log(text.slice(0, 400))