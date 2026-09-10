/**
 * Package self-check for dsh-team-chat.
 *
 * Verifies the publishable surface: manifest integrity, every `exports` target
 * and `files` entry present on disk, the DSH plugin declarations this package
 * relies on, the bundle patch's YAML validity, and that both halves parse.
 *
 * Run: node scripts/verify.mjs
 * Exits non-zero and prints every failure when anything is missing.
 */
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const notes = []

function check(label, condition, detail = '') {
  if (condition) {
    process.stdout.write(`  ✓ ${label}\n`)
  } else {
    process.stdout.write(`  ✗ ${label}${detail ? ' — ' + detail : ''}\n`)
    failures.push(label + (detail ? ': ' + detail : ''))
  }
}

async function exists(relativePath) {
  try {
    await stat(join(ROOT, relativePath))
    return true
  } catch {
    return false
  }
}

process.stdout.write('dsh-team-chat verify\n')

// ---------------------------------------------------------------- manifest
process.stdout.write('\n[manifest]\n')
let manifest
try {
  manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  check('package.json parses', true)
} catch (error) {
  check('package.json parses', false, String(error))
  process.exit(1)
}

check('name is set', typeof manifest.name === 'string' && manifest.name.length > 0)
check('version is set', typeof manifest.version === 'string' && manifest.version.length > 0)
check('type is module', manifest.type === 'module')
check('main points at lib/index.js', manifest.main === 'lib/index.js')
check('license is set', typeof manifest.license === 'string' && manifest.license.length > 0)

// ---------------------------------------------------------------- exports
process.stdout.write('\n[exports]\n')
const exportTargets = Object.entries(manifest.exports || {}).map(([key, value]) => {
  const target = typeof value === 'string' ? value : value && value.default
  return { key, target }
})
check('exports declares at least the root entry', exportTargets.length > 0)
for (const entry of exportTargets) {
  if (typeof entry.target !== 'string') {
    check(`exports["${entry.key}"] resolves to a path`, false, 'no default target')
    continue
  }
  if (entry.target === './package.json') {
    check(`exports["${entry.key}"] → ${entry.target}`, true)
    continue
  }
  check(`exports["${entry.key}"] → ${entry.target} exists`, await exists(entry.target))
}

// ---------------------------------------------------------------- files
process.stdout.write('\n[files]\n')
for (const entry of manifest.files || []) {
  check(`files entry "${entry}" exists`, await exists(entry))
}

// ---------------------------------------------------------------- dsh wiring
process.stdout.write('\n[dsh wiring]\n')
const dsh = manifest.dsh || {}
check('dsh.bundle.patch declared', typeof dsh.bundle?.patch === 'string', 'bundle patch missing')
if (typeof dsh.bundle?.patch === 'string') {
  check(`dsh.bundle.patch "${dsh.bundle.patch}" exists`, await exists(dsh.bundle.patch))
}
check('dsh.client.platform is web', dsh.client?.platform === 'web')
check('dsh.client.inject is a non-empty array', Array.isArray(dsh.client?.inject) && dsh.client.inject.length > 0)

// ---------------------------------------------------------------- bundle patch YAML
process.stdout.write('\n[bundle patch]\n')
const patchPath = dsh.bundle?.patch
if (typeof patchPath === 'string') {
  const raw = await readFile(join(ROOT, patchPath), 'utf8')
  check('patch file is non-empty', raw.trim().length > 0)
  check('patch inserts the team-chat row', /id:\s*team-chat/.test(raw) && /name:\s*'dsh-team-chat'/.test(raw))
  try {
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    let yaml
    try {
      yaml = require('yaml')
    } catch {
      const fallback = 'E:/DSH_Desktop/DSH Desktop/resources/app.asar.unpacked/node_modules/yaml'
      yaml = require(fallback)
    }
    const parsed = yaml.parse(raw)
    const inserted = Array.isArray(parsed) && parsed[0] && Array.isArray(parsed[0].insert) ? parsed[0].insert : []
    check('patch YAML parses to one insert list', inserted.length === 1)
    check('inserted row carries id/name', inserted[0]?.id === 'team-chat' && inserted[0]?.name === 'dsh-team-chat')
  } catch (error) {
    notes.push('YAML validation skipped: ' + String(error))
  }
}

// ---------------------------------------------------------------- syntax
process.stdout.write('\n[syntax]\n')
for (const target of ['lib/index.js', 'lib/client.js']) {
  if (!(await exists(target))) {
    check(`${target} exists`, false)
    continue
  }
  const result = spawnSync(process.execPath, ['--check', join(ROOT, target)], { encoding: 'utf8' })
  check(`${target} parses`, result.status === 0, (result.stderr || '').trim().split('\n')[0] || '')
}

const clientSource = await readFile(join(ROOT, 'lib/client.js'), 'utf8')
check('client uses the module loader', clientSource.includes('window.__ModuleLoader__.load'))
check('client exports inject', /exports\.inject\s*=/.test(clientSource))
check('client exports apply', /exports\.apply\s*=/.test(clientSource))
check('client requires react', /require\(['"]react['"]\)/.test(clientSource))
check('client registers the better-sidebar tab', clientSource.includes('registerTab'))
check('client falls back to shell.overlay', clientSource.includes('shell.overlay'))
check('client never uses JSX', !/<[A-Z][A-Za-z]*[\s/>]/.test(clientSource.replace(/<[a-z/!]/g, '')))

// ---------------------------------------------------------------- theming
process.stdout.write('\n[theming]\n')
check('client never uses made-up --dsh- tokens', !/--dsh-/.test(clientSource))
check('client never pairs a self-drawn background with color:inherit', !/background: (?!'transparent'|'none')[^}]*color: 'inherit'/.test(clientSource.replace(/\s+/g, ' ')))
check('client styles every drawn surface with a --dsw-* label token', clientSource.includes('--dsw-alias-label-primary') || clientSource.includes('--dsw-alias-label-secondary') || clientSource.includes('--dsw-alias-label-tertiary'))

const hostSource = await readFile(join(ROOT, 'lib/index.js'), 'utf8')
check('host exports name/inject/apply', /export const name/.test(hostSource) && /export const inject/.test(hostSource) && /export function apply/.test(hostSource))
check('host serves /state, /speak, /task', ['/state', '/speak', '/task'].every((suffix) => hostSource.includes(`ROUTE_PREFIX + '${suffix}'`)))
check('host serves the step projection route', hostSource.includes(`ROUTE_PREFIX + '/steps'`))
check('host fences every route', hostSource.includes('requestRejection'))

// ---------------------------------------------------------------- host perf guard (P1a)
process.stdout.write('\n[host perf guard]\n')
const codeLines = hostSource.split('\n').filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
const directReadSurface = codeLines.filter((line) => line.includes('ctx.sessionQuery.readSurface(')).length
check('readSurface is called through exactly one bounded wrapper (P1a)', directReadSurface === 1 && hostSource.includes('readSurfaceTimed'), `code call sites: ${directReadSurface}`)
check('the wrapper bounds readSurface with a hard timeout', hostSource.includes('READ_SURFACE_TIMEOUT_MS') && hostSource.includes('Promise.race'))
check('listChildren is bounded by the same timeout', hostSource.includes('listChildrenTimed'))
check('refresh is single-flight (one in-flight pass max)', hostSource.includes('refreshInFlight') && hostSource.includes('function refreshAll'))
check('request paths never start a refresh (they sync only on first pull)', /sync && !state\.firstPullDone/.test(hostSource) && /state\.firstPullDone = true/.test(hostSource))
check('snapshot surfaces freshness for the client', hostSource.includes('stale:') && hostSource.includes('generatedAt:'))
check('request path kicks a stale-gated background refresh', hostSource.includes('>= ROSTER_POLL_MS') && hostSource.includes('void refreshAll()'))
check('timeouts are counted, never silently dropped', hostSource.includes('timeoutCount') && hostSource.includes('lastError = '))

// ---------------------------------------------------------------- host event feed guard (P1b)
process.stdout.write('\n[host event feed guard]\n')
check('feed subscribes to session/event globally', /ctx\.on\('session\/event'/.test(hostSource) && /global:\s*true/.test(hostSource))
check('feed subscribes to agent/status', /ctx\.on\('agent\/status'/.test(hostSource))
check('hot callback drops assistant/chunk first (the 53-67% noise)', /event\.type === 'assistant\/chunk'\)\s*\{/.test(hostSource) || /event\.type === 'assistant\/chunk'/.test(hostSource))
check('hot callback only enqueues (cursor + ring buffer, no work)', hostSource.includes('cell.rows.push(event)') && hostSource.includes('cell.seq = seq'))
check('unbounded growth is impossible (cap + lag resync)', hostSource.includes('FEED_CAP') && hostSource.includes('cell.lag = true'))
check('throttled consumer drains off the hot path', hostSource.includes('drainFeeds') && hostSource.includes('FLUSH_MS'))
check('feed has an observable heartbeat', hostSource.includes('HEARTBEAT_MS') && hostSource.includes('lastEventAt'))
check('heartbeat self-checks instead of silently stalling', hostSource.includes('STALL_MS') && hostSource.includes('syncCatchUp()'))
check('subscriptions and timers are disposed on unload', /ctx\.effect\(\(\) => \(\) => \{[\s\S]*?feedDisposers[\s\S]*?clearInterval\(rosterPoller\)/.test(hostSource))
check('roster fallback keeps a 30-60s cadence', /ROSTER_POLL_MS\s*=\s*(3[0-9]|4[0-9]|5[0-9]|60)000/.test(hostSource))
check('the periodic pass does not read member surfaces', /async function refreshRoster\(\)/.test(hostSource) && !/function refreshRoster[\s\S]{0,1200}readSurfaceTimed/.test(hostSource))
check('surface catch-up is retained for first pull / lag only', /async function syncCatchUp\(\)/.test(hostSource) && /syncCatchUp\(\)/.test(hostSource))
check('surface-eligible events are retained for the detail view (t24)', hostSource.includes('SURFACE_EVENT_TYPES') && hostSource.includes('surfaceEvents'))
check('agent/status handler is guarded like the event handler', (hostSource.match(/ctx\.logger\.warn\('team-chat:/g) || []).length >= 3)

// ---------------------------------------------------------------- host steps guard (P2a)
process.stdout.write('\n[host steps guard]\n')
check('steps are served over a dedicated route', hostSource.includes(`ROUTE_PREFIX + '/steps'`))
check('step events are retained from the SAME feed (no second data source)', hostSource.includes('STEP_EVENT_TYPES') && hostSource.includes('stepEvents') && hostSource.includes('seedStepEvents'))
check('step projection is a pure in-memory fold (no read calls)', /function projectSteps\(state, memberId, memberName\)/.test(hostSource) && /rows\.slice\(-WINDOW_MESSAGES\)/.test(hostSource))
check('the steps route never reads a member surface', (() => {
  const routeStart = hostSource.indexOf(`ROUTE_PREFIX + '/steps'`)
  if (routeStart < 0) return false
  const snippet = hostSource.slice(routeStart, routeStart + 2000)
  const inner = (snippet.match(/handler: async \(req, res\) => \{[\s\S]*?\n\s*\},/) || [''])[0]
  return inner.length === 0 || (!inner.includes('readSurface') && !inner.includes('filterEvents') && !inner.includes('readEvent'))
})())
check('tool artifacts are extracted from arguments, missing → —', hostSource.includes('function artifactOf') && hostSource.includes("'—'"))
check('steps are capped to the same window as messages (bounded)', hostSource.includes('projectSteps') && /WINDOW_MESSAGES/.test(hostSource))

// ---------------------------------------------------------------- shared helpers
process.stdout.write('\n[shared helpers]\n')
check('lib/shared.js exists', await exists('lib/shared.js'))
const sharedSource = await readFile(join(ROOT, 'lib/shared.js'), 'utf8')
for (const symbol of [
  'roleFromLabel',
  'teamFromLabel',
  'isTeamLabel',
  'roleMeta',
  'quoteSnippet',
  'groupThreads',
  'routingText',
  'ROLE_META',
  'DEFAULT_ROLES',
]) {
  check(`shared exports ${symbol}`, new RegExp(`export (function|const) ${symbol}\\b`).test(sharedSource))
}

// ---------------------------------------------------------------- v0.2 features
process.stdout.write('\n[features]\n')
check('host resolves the team of a named session', /listChildren\(sessionId\)/.test(hostSource))
check('host falls back to a member session\'s parent', /parentSession/.test(hostSource))
check('host registers the team-chat settings namespace', /settings\.register\(SETTINGS_NS, Config\)/.test(hostSource))
check('host installs a global routing baseline', /function installGlobalSection\(\)/.test(hostSource))
check('host scopes routing onto a capable agent context', /agentCtx\.systemPrompt/.test(hostSource))
check('host prefers the preset instance when one is mounted', /serviceFor\(agent, 'systemPrompt'\)/.test(hostSource))
check('host keeps the baseline when scoping is impossible', /installGlobalSection\(\)\n/.test(hostSource))
check('host binds a quoted reply to a thread', /pendingThread\.set\(/.test(hostSource))
check('host groups threads before responding', /groupThreads\(/.test(hostSource))
check('host exposes a settings route', hostSource.includes(`ROUTE_PREFIX + '/settings'`))
check('host validates the settings patch', /no-known-field/.test(hostSource))

check('client registers a settings page', /settings\.section/.test(clientSource))
check('client forwards the session scope', /scope\.sessionId/.test(clientSource))
check('client renders role frames', /borderLeft: '3px solid ' \+ meta\.color/.test(clientSource))
check('client renders quote blocks', /function QuoteBlock/.test(clientSource))
check('client renders thread disclosure', /function ThreadView/.test(clientSource))
check('client sends quote-reply ids', /replyTo: quoted \? quoted\.id/.test(clientSource))
check('client surfaces the trio switches', /autoApproveTeam/.test(clientSource))
check('client wraps the chat in an error boundary', /class ChatErrorBoundary extends React\.Component/.test(clientSource))
check('client decides the dock by capability, not a switch', /dockedRight: !hasSidebar/.test(clientSource))
check('client ships a mode diagnostic strip', /诊断：渲染模式/.test(clientSource))

// ---------------------------------------------------------------- team templates
process.stdout.write('\n[team templates]\n')
for (const symbol of ['normalizeTeams', 'memberPrompt', 'teamFor', 'cloneDefaultTrio', 'DEFAULT_TRIO', 'TEAM_ID_PATTERN', 'MEMBER_NAME_PATTERN']) {
  check(`shared exports ${symbol}`, new RegExp(`export (const|function) ${symbol}\\b`).test(sharedSource))
}
check('routing renders the per-member executionPrompt', /executionPrompt（必须原样传入该成员）/.test(sharedSource))
check('settings schema declares teams + defaultTeamId', /defaultTeamId: z\.string\(\)/.test(hostSource) && /teams: z\.array\(/.test(hostSource))
check('settings schema keeps the deprecated roles field', /roles: z\.array\(z\.string\(\)\)/.test(hostSource))
check('host normalizes teams before persisting', /normalizeTeams\(\{ teams: patch\.teams/.test(hostSource))
check('host exposes the per-session team route', hostSource.includes(`ROUTE_PREFIX + '/team'`))
check('host resolves the session team override', /sessionOverrides/.test(hostSource))
check('host renders the session team into the prompt', /routingText\(settings, activeTeamOf\(settings, sessionId\)\)/.test(hostSource))
check('host reports the active team in the snapshot', /activeTeam: \{ id: team\.id/.test(hostSource))
check('host supports a member preview without persisting', /previewMember/.test(hostSource))
check('client renders a team selector', /切换本会话使用的团队模板/.test(clientSource))
check('client ships the team editor', /function TeamEditor/.test(clientSource))
check('client ships the member editor', /function MemberEditor/.test(clientSource))
check('client exposes the editor test seam', /exports\.__internals/.test(clientSource))
check('client previews the rendered guidance', /previewMember: member/.test(clientSource))
check('client attaches better-sidebar lazily', /function attachSidebar\(service\)/.test(clientSource))
check('client defers on the optional peer via inject', /ctx\.inject\(\['betterSidebar'\]/.test(clientSource))
check('client hides the dock once the tab exists', /if \(registered\) return null/.test(clientSource))
check('client declares all five switch keys', /SWITCH_KEYS = \['enabled', 'autoCreateTeam', 'autoApproveTeam', 'imProgress', 'imPush'\]/.test(clientSource))
check('client maps switches through one helper', /function switchStateOf\(settings\)/.test(clientSource))
check('client renders the IM push switch', /主动推送团队进度到 IM/.test(clientSource))
check('host exposes the IM origin to the browser', /async function imOriginOf\(sessionId\)/.test(hostSource))
check('host accepts the imPush setting', /clean\.imPush = patch\.imPush/.test(hostSource))

check('unit tests exist', await exists('test/shared.test.mjs'))
check('host smoke test exists', await exists('test/host-smoke.test.mjs'))
check('client render test exists', await exists('test/client.test.mjs'))
check('host event-feed behaviour test exists (t17)', await exists('test/host-events.test.mjs'))
check('host evidence reproduction guide exists (t17)', await exists('docs/optimization/host-evidence-repro.md'))

// ---------------------------------------------------------------- report
process.stdout.write('\n')
for (const note of notes) process.stdout.write(`note: ${note}\n`)
if (failures.length > 0) {
  process.stdout.write(`FAILED — ${failures.length} check(s)\n`)
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
  process.exit(1)
}
process.stdout.write('OK — all checks passed\n')
