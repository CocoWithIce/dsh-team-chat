/**
 * dsh-team-chat — Host half.
 *
 * Serves the live team group-chat state to the browser half and accepts
 * `speak` / `task` actions from it.
 *
 * ## Why the roster is reconstructed instead of read from AgentTeams
 *
 * The AgentTeams plugin publishes its `agentTeams` service inside the captain
 * Agent's own scope, so a sibling plugin cannot resolve it (`ctx.get('agentTeams')`
 * is `undefined`). The team members, however, are durable continuable children of
 * the captain session and every one of them carries an
 * `agent-teams:<team>:<member>` subagent label. That makes
 *
 *   - `ctx.subagents.listChildren(captainSessionId)` → the roster + live activity
 *   - `ctx.sessionQuery.readSurface(memberSessionId)`  → the members' real utterances
 *   - `ctx.subagents.sendMessage(captainAgent, …)`     → waking a member / the team
 *
 * a complete and permission-safe reconstruction that needs no AgentTeams access.
 *
 * ## Routing new sessions to the team
 *
 * The host half cannot create a team by itself for the same reason it cannot read
 * the service — so routing is done at the prompt layer: while the `team-chat`
 * namespace has `enabled: true`, a prompt section tells the captain agent (which
 * *does* own the `agent_teams_*` tools) to stand the trio up and delegate. See
 * {@link ./shared.js routingText}.
 *
 * ## State model
 *
 * Every session owns its own team, so the chat state is keyed by captain session
 * id. `/state` accepts `?sessionId=` and returns the grouped thread tree for that
 * session; the client only renders.
 *
 * @module dsh-team-chat
 */
import z from 'schemastery'
import {
  DEFAULT_ROLES,
  DEFAULT_TRIO,
  groupThreads,
  imTargetFromText,
  isTeamLabel,
  memberPrompt,
  normalizeTeams,
  quoteSnippet,
  roleFromLabel,
  routingText,
  teamFor,
  teamFromLabel,
} from './shared.js'

const WEB_SERVER_KEYS = ['webServer', 'httpServer']
const ROUTE_PREFIX = '/plugins/dsh-team-chat'
const SETTINGS_NS = 'team-chat'
const SECTION_NAME = 'team-chat:routing'
const SECTION_ORDER = 118
const POLL_MS = 3000
const FRESH_LIMIT = 24
const TEXT_LIMIT = 1200
const MAX_MESSAGES = 400
const WINDOW_MESSAGES = 200
const THREAD_TTL_MS = 10 * 60 * 1000

/** Settings namespace schema — the user-facing switches and team templates. */
export const Config = z.object({
  enabled: z.boolean().default(true),
  autoCreateTeam: z.boolean().default(true),
  autoApproveTeam: z.boolean().default(true),
  /** Relay team progress through the captain's replies for IM-driven sessions. */
  imProgress: z.boolean().default(true),
  /** Push team progress into the IM conversation (browser-relayed delivery). */
  imPush: z.boolean().default(false),
  /** Deprecated (kept so pre-0.3 stored sections still validate): the trio names. */
  roles: z.array(z.string()).default(DEFAULT_ROLES),
  defaultTeamId: z.string().default(DEFAULT_TRIO.id),
  teams: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().default(''),
    members: z.array(z.object({
      name: z.string(),
      role: z.string().default(''),
      provider: z.string().default(''),
      model: z.string().default(''),
      reasoningEffort: z.string().default(''),
      soul: z.string().default(''),
      skills: z.array(z.string()).default([]),
      plugins: z.array(z.string()).default([]),
      mcp: z.array(z.string()).default([]),
      memory: z.string().default(''),
      executionPrompt: z.string().default(''),
    })),
  })).default([]),
})

/** Resolution defaults, kept plain so a read never depends on schema behaviour. */
const DEFAULT_SETTINGS = {
  enabled: true,
  autoCreateTeam: true,
  autoApproveTeam: true,
  imProgress: true,
  imPush: false,
  roles: DEFAULT_ROLES,
  defaultTeamId: DEFAULT_TRIO.id,
  teams: [],
}

export const name = 'team-chat'
export const inject = ['agents', 'subagents', 'sessionQuery', 'settings']

/**
 * Install the team-chat host half: per-session roster/utterance pollers, the
 * routing prompt section, and the browser routes the sidebar tab talks to.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  /** Captain session id → chat state. */
  const sessions = new Map()
  /** Session id → team-id override chosen in the sidebar (in-memory, by design). */
  const sessionOverrides = new Map()
  /** Member session id → one-shot thread binding for the next utterance. */
  const pendingThread = new Map()
  /** Captain session id → its IM origin (or null), read once. */
  const imOrigins = new Map()
  /** Root session id → its scoped routing-section disposer. */
  const routedSessions = new Map()
  let lastError = ''
  let routes = []
  let webRegistered = false
  let routingDisposer = null

  function stateFor(sessionId) {
    let state = sessions.get(sessionId)
    if (state === undefined) {
      state = {
        sessionId,
        teamName: '',
        members: [],
        messages: [],
        seq: 0,
        seqSeen: new Map(),
        actSeen: new Map(),
      }
      sessions.set(sessionId, state)
    }
    return state
  }

  function push(state, kind, from, text, extra) {
    state.seq += 1
    const meta = extra || {}
    state.messages.push({
      id: 'm' + state.seq,
      kind,
      from,
      text,
      time: Date.now(),
      rootId: meta.rootId ?? null,
      replyTo: meta.replyTo ?? null,
      quote: meta.quote ?? null,
    })
    if (state.messages.length > MAX_MESSAGES) state.messages.splice(0, state.messages.length - MAX_MESSAGES)
    return state.messages[state.messages.length - 1]
  }

  function findMessage(state, id) {
    for (const message of state.messages) {
      if (message.id === id) return message
    }
    return undefined
  }

  /** The thread root a reply to `message` belongs to. */
  function rootIdOf(message) {
    if (message === undefined) return null
    return message.rootId === null || message.rootId === undefined ? message.id : message.rootId
  }

  function textOf(blocks) {
    const out = []
    for (const block of blocks || []) {
      if (block && block.type === 'text' && typeof block.text === 'string') out.push(block.text)
    }
    const text = out.join('\n').trim()
    return text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT) + ' …' : text
  }

  // ------------------------------------------------------------ settings

  /**
   * Read the resolved settings section and normalize its team templates.
   * `teams`/`errors` are always usable, so callers never branch on bad input.
   * @returns `{ enabled, autoCreateTeam, autoApproveTeam, defaultTeamId, teams, errors }`
   */
  function readSettings() {
    let raw
    try {
      raw = ctx.settings.get(SETTINGS_NS)
    } catch (error) {
      lastError = 'settings: ' + String(error)
      raw = undefined
    }
    const merged = raw === undefined || raw === null || typeof raw !== 'object'
      ? { ...DEFAULT_SETTINGS }
      : { ...DEFAULT_SETTINGS, ...raw }
    const normalized = normalizeTeams(merged)
    return {
      enabled: merged.enabled !== false,
      autoCreateTeam: merged.autoCreateTeam !== false,
      autoApproveTeam: merged.autoApproveTeam !== false,
      imProgress: merged.imProgress !== false,
      imPush: merged.imPush === true,
      defaultTeamId: normalized.defaultTeamId,
      teams: normalized.teams,
      errors: normalized.errors,
    }
  }

  // ------------------------------------------------------------ roster

  function rosterFrom(children) {
    const roster = []
    for (const child of children) {
      if (child.kind !== 'child') continue
      if (!isTeamLabel(child.label)) continue
      roster.push({
        id: String(child.id),
        name: roleFromLabel(child.label),
        activity: child.activity === 'running' ? 'running' : 'idle',
        label: child.label,
      })
    }
    return roster
  }

  /** Every live captain session, with its roster. */
  async function discoverCaptains() {
    const found = []
    let agents = []
    try {
      agents = ctx.agents.list()
    } catch (error) {
      lastError = 'agents.list: ' + String(error)
      return found
    }
    for (const agent of agents) {
      let children
      try {
        children = await ctx.subagents.listChildren(agent.id)
      } catch {
        continue
      }
      const roster = rosterFrom(children)
      if (roster.length > 0) found.push({ captainId: String(agent.id), roster })
    }
    return found
  }

  /**
   * Resolve the captain that owns `sessionId`: the session itself when it has a
   * team, otherwise its parent session (a tab opened on a member's session).
   * @param sessionId - the requesting session id, or undefined.
   * @returns `{ captainId, roster }` or undefined.
   */
  async function resolveTeam(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    try {
      const roster = rosterFrom(await ctx.subagents.listChildren(sessionId))
      if (roster.length > 0) return { captainId: sessionId, roster }
    } catch {
      // fall through to the parent probe
    }
    let parent
    try {
      parent = ctx.get('sessions')?.get(sessionId)?.header?.parentSession
    } catch {
      parent = undefined
    }
    if (typeof parent === 'string' && parent !== '') {
      try {
        const roster = rosterFrom(await ctx.subagents.listChildren(parent))
        if (roster.length > 0) return { captainId: String(parent), roster }
      } catch {
        // no team below the parent either
      }
    }
    return undefined
  }

  // ------------------------------------------------------------ polling

  async function refresh(state, captainId, roster) {
    if (roster.length > 0 && state.teamName === '') {
      state.teamName = teamFromLabel(roster[0].label)
    }
    state.members = roster.map((member) => ({ id: member.id, name: member.name, activity: member.activity }))

    for (const member of roster) {
      const previous = state.actSeen.get(member.id)
      if (previous !== undefined && previous !== member.activity) {
        push(state, 'system', '', member.activity === 'running'
          ? '🔨 ' + member.name + ' 开始工作'
          : '◽ ' + member.name + ' 空闲')
      }
      state.actSeen.set(member.id, member.activity)
    }

    for (const member of roster) {
      let surface
      try {
        surface = await ctx.sessionQuery.readSurface(member.id)
      } catch {
        continue
      }
      const events = surface.events || []
      const cursor = state.seqSeen.get(member.id)
      if (cursor === undefined) {
        // First sight of a member: start at the tail so the tab opens clean
        // instead of replaying the whole session history.
        let tail = -1
        for (let i = events.length - 1; i >= 0; i -= 1) {
          const seq = Number(events[i].seq)
          if (seq > tail) tail = seq
        }
        state.seqSeen.set(member.id, tail)
        continue
      }
      const fresh = []
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i]
        if (!(Number(event.seq) > cursor)) break
        fresh.push(event)
        if (fresh.length >= FRESH_LIMIT) break
      }
      fresh.reverse()
      let next = cursor
      for (const event of fresh) {
        if (event.type === 'assistant/message' && event.data && event.data.message) {
          const text = textOf(event.data.message.content)
          if (text !== '') {
            const binding = pendingThread.get(member.id)
            if (binding !== undefined) pendingThread.delete(member.id)
            const live = binding !== undefined && binding.expiresAt > Date.now() ? binding : undefined
            push(state, 'chat', member.name, text, live === undefined
              ? undefined
              : { rootId: live.rootId, replyTo: live.replyTo })
          }
        } else if (event.type === 'user/message' && event.data && event.data.content) {
          const text = textOf(event.data.content)
          if (text !== '') push(state, 'incoming', member.name, text)
        }
        const seq = Number(event.seq)
        if (seq > next) next = seq
      }
      state.seqSeen.set(member.id, next)
    }
  }

  async function tick() {
    try {
      for (const { captainId, roster } of await discoverCaptains()) {
        await refresh(stateFor(captainId), captainId, roster)
      }
    } catch (error) {
      lastError = 'tick: ' + String(error)
    }
  }

  const poller = setInterval(() => { void tick() }, POLL_MS)
  // Never let the poller hold the host process open during shutdown: the effect
  // below still disposes it deterministically on unload.
  if (typeof poller.unref === 'function') poller.unref()
  ctx.effect(() => () => clearInterval(poller), 'team-chat: roster poller')
  void tick()

  // ------------------------------------------------------------ delivery

  async function deliver(state, captainId, text, target) {
    let agent
    try {
      agent = ctx.agents.get(captainId)
    } catch (error) {
      return { ok: false, delivered: 0, error: 'agent-get-failed: ' + String(error) }
    }
    if (agent === undefined) return { ok: false, delivered: 0, error: 'captain-offline' }
    const targets = state.members.filter((member) => target === 'all' || member.name === target)
    if (targets.length === 0) return { ok: false, delivered: 0, error: 'no-target' }
    let delivered = 0
    let failure = ''
    for (const member of targets) {
      try {
        await ctx.subagents.sendMessage(
          agent,
          member.id,
          [{ type: 'text', text }],
          { signal: new AbortController().signal },
        )
        delivered += 1
      } catch (error) {
        failure = String(error)
        lastError = 'send ' + member.name + ': ' + failure
      }
    }
    return {
      ok: delivered > 0,
      delivered,
      ...delivered > 0 ? {} : { error: failure === '' ? 'send-failed' : failure },
    }
  }

  /**
   * Resolve the chat state a browser request targets: the requested session when
   * it names one, otherwise any live team (single-team back-compat).
   */
  async function targetState(sessionId) {
    if (typeof sessionId === 'string' && sessionId !== '') {
      const resolved = await resolveTeam(sessionId)
      const state = stateFor(resolved === undefined ? sessionId : resolved.captainId)
      if (resolved !== undefined) await refresh(state, resolved.captainId, resolved.roster)
      return { state, captainId: resolved === undefined ? '' : resolved.captainId, found: resolved !== undefined }
    }
    const captains = await discoverCaptains()
    if (captains.length === 0) return { state: stateFor(''), captainId: '', found: false }
    const first = captains[0]
    const state = stateFor(first.captainId)
    await refresh(state, first.captainId, first.roster)
    return { state, captainId: first.captainId, found: true }
  }

  /**
   * The IM conversation a session was started from, read once from its first
   * user message. The browser half needs it to relay progress through the IM
   * plugin's proactive-delivery endpoint (which only the authenticated browser
   * may call).
   * @param sessionId - the captain session.
   * @returns `{ botId, targetId, chatId, threadId, channel }` or null.
   */
  async function imOriginOf(sessionId) {
    if (sessionId === '') return null
    if (imOrigins.has(sessionId)) return imOrigins.get(sessionId)
    let found = null
    try {
      const surface = await ctx.sessionQuery.readSurface(sessionId)
      for (const event of surface.events || []) {
        if (event.type !== 'user/message' || !event.data || !event.data.content) continue
        const candidate = imTargetFromText(textOf(event.data.content))
        if (candidate !== null) {
          found = candidate
          break
        }
      }
    } catch {
      found = null
    }
    imOrigins.set(sessionId, found)
    return found
  }

  function snapshotOf(state, found, im) {
    const settings = readSettings()
    const team = activeTeamOf(settings, state.sessionId)
    const configByName = new Map(team.members.map((member) => [member.name, member]))
    return {
      ok: true,
      im: im === undefined ? null : im,
      imPush: settings.imPush === true,
      sessionId: state.sessionId,
      team: state.teamName,
      activeTeam: { id: team.id, name: team.name, description: team.description, members: team.members.map((member) => member.name) },
      teams: settings.teams.map((candidate) => ({ id: candidate.id, name: candidate.name, memberCount: candidate.members.length })),
      defaultTeamId: settings.defaultTeamId,
      members: state.members.map((member) => {
        const template = configByName.get(member.name)
        return {
          id: member.id,
          name: member.name,
          activity: member.activity,
          role: template === undefined ? '' : template.role,
          model: template === undefined ? '' : template.model,
          skillCount: template === undefined ? 0 : template.skills.length,
          configured: template !== undefined,
        }
      }),
      threads: groupThreads(state.messages.slice(-WINDOW_MESSAGES)),
      hasTeam: found && state.members.length > 0,
      error: lastError === '' ? null : lastError,
    }
  }

  // ------------------------------------------------------------ routing prompt

  /**
   * Register the routing section inside one agent's OWN scope, so teammates —
   * separate agent scopes — never receive captain instructions.
   * @param agent - a live Agent.
   * @returns whether a scoped registration is now in place.
   */
  function installScopedSection(agent) {
    const sessionId = String(agent.id)
    if (routedSessions.has(sessionId)) return true
    let systemPrompt
    // (a) The preset's OWN systemPrompt instance, when the composition mounts one.
    const agentPresets = ctx.get('agentPresets')
    if (agentPresets !== undefined && typeof agentPresets.serviceFor === 'function') {
      try {
        systemPrompt = agentPresets.serviceFor(agent, 'systemPrompt')
      } catch {
        systemPrompt = undefined
      }
    }
    // (b) The inherited service, read through the agent's own context so cordis
    // records the section in THAT scope. `serviceForAgent` returns undefined
    // whenever the preset does not mount its own instance (the default preset
    // does not), which is why this second path exists at all.
    if (systemPrompt === undefined) {
      try {
        const agentCtx = agent && agent.ctx
        const candidate = agentCtx === undefined ? undefined : agentCtx.systemPrompt
        if (candidate !== undefined && typeof candidate.section === 'function') systemPrompt = candidate
      } catch {
        systemPrompt = undefined
      }
    }
    if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') return false
    // A scoped section shadows the global one with the same name, so a session
    // that CAN be scoped gets its own team; everyone else gets the global text.
    routedSessions.set(sessionId, systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text: () => {
        const settings = readSettings()
        return routingText(settings, activeTeamOf(settings, sessionId))
      },
    }))
    return true
  }

  /**
   * The team one session should use: its explicit override, else the default.
   * @param settings - a resolved settings section (optional; read when omitted).
   * @param sessionId - the requesting session.
   * @returns the effective team template.
   */
  function activeTeamOf(settings, sessionId) {
    const resolved = settings || readSettings()
    return teamFor(resolved, sessionOverrides.get(sessionId))
  }

  /** Whether an agent is a root session (`agent/created` also fires for members). */
  function isRootAgent(agent) {
    try {
      const header = ctx.get('sessions')?.get(agent.id)?.header
      return header === undefined || header.parentSession === undefined
    } catch {
      return true
    }
  }

  /**
   * Baseline routing: ONE global section, registered in this plugin's own scope.
   * This is the mechanism the AgentTeams plugin itself uses, and it is the only
   * one that works on a deployment whose agent presets mount no systemPrompt of
   * their own. Its text self-excludes subagents (rule 6 of `routingText`), so a
   * teammate that also receives it is told to ignore it.
   */
  function installGlobalSection() {
    if (routingDisposer !== null) return true
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') return false
    routingDisposer = systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text: () => routingText(readSettings(), activeTeamOf(readSettings())),
    })
    return true
  }

  function ensureRouting() {
    installGlobalSection()
    let agents = []
    try {
      agents = ctx.agents.list()
    } catch {
      return
    }
    for (const agent of agents) {
      if (isRootAgent(agent)) installScopedSection(agent)
    }
  }

  ensureRouting()
  ctx.on('agent/created', (payload) => {
    const agent = payload && payload.agent
    if (agent === undefined || !isRootAgent(agent)) return
    installScopedSection(agent)
  })

  // ------------------------------------------------------------ HTTP routes

  function readJson(req, maxBytes = 1_000_000) {
    return new Promise((resolve, reject) => {
      let size = 0
      let settled = false
      const chunks = []
      const finish = (error) => {
        if (settled) return
        settled = true
        req.off('data', onData)
        req.off('end', onEnd)
        req.off('aborted', onAborted)
        req.off('error', onError)
        if (error) {
          chunks.length = 0
          req.once('error', () => {})
          req.resume()
          reject(error)
          return
        }
        resolve(Buffer.concat(chunks).toString('utf8'))
      }
      const onData = (chunk) => {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += part.length
        if (size > maxBytes) finish(new Error('request body is too large'))
        else chunks.push(part)
      }
      const onEnd = () => finish()
      const onAborted = () => finish(new Error('request body was aborted'))
      const onError = () => finish(new Error('invalid request body'))
      req.on('data', onData)
      req.once('end', onEnd)
      req.once('aborted', onAborted)
      req.once('error', onError)
    })
  }

  function sendJson(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
  }

  /**
   * Raw WebServer routes do not inherit the Connection authentication fence, so
   * every route re-checks it here. A missing fence is an assembly failure, never
   * an invitation to serve team state to an unauthenticated caller.
   */
  function fenced(req, res) {
    const connection = ctx.get('connection')
    const rejection = connection === undefined ? 503 : connection.requestRejection(req)
    if (rejection === undefined) return true
    sendJson(res, rejection, {
      error: rejection === 503 ? 'authentication unavailable' : rejection === 401 ? 'unauthorized' : 'forbidden',
    })
    return false
  }

  async function body(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' })
      res.end()
      return undefined
    }
    try {
      return JSON.parse((await readJson(req)).trim() || '{}')
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid JSON' })
      return undefined
    }
  }

  function registerRoutes() {
    if (webRegistered) return
    const webServer = ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1])
    if (webServer === undefined || typeof webServer.register !== 'function') return
    webRegistered = true

    routes = [
      webServer.register({
        kind: 'exact',
        path: ROUTE_PREFIX + '/state',
        handler: async (req, res) => {
          if (!fenced(req, res)) return
          let sessionId
          try {
            sessionId = new URL(req.url ?? '/', 'http://x').searchParams.get('sessionId') ?? undefined
          } catch {
            sessionId = undefined
          }
          const target = await targetState(sessionId)
          sendJson(res, 200, snapshotOf(
            target.state,
            target.found,
            await imOriginOf(target.captainId === '' ? target.state.sessionId : target.captainId),
          ))
        },
      }),

      webServer.register({
        kind: 'exact',
        path: ROUTE_PREFIX + '/speak',
        handler: async (req, res) => {
          if (!fenced(req, res)) return
          const payload = await body(req, res)
          if (payload === undefined) return
          const text = typeof payload.text === 'string' ? payload.text.trim() : ''
          if (text === '') {
            sendJson(res, 400, { ok: false, error: 'empty' })
            return
          }
          const target = await targetState(typeof payload.sessionId === 'string' ? payload.sessionId : undefined)
          if (!target.found) {
            sendJson(res, 200, { ok: false, delivered: 0, error: 'no-team' })
            return
          }
          const state = target.state
          const quoted = typeof payload.replyTo === 'string' ? findMessage(state, payload.replyTo) : undefined
          const replyTo = quoted === undefined ? null : quoted.id
          const rootId = quoted === undefined
            ? (typeof payload.rootId === 'string' && payload.rootId !== '' ? payload.rootId : null)
            : rootIdOf(quoted)
          const sent = push(state, 'chat', 'me', text, {
            rootId,
            replyTo,
            quote: quoted === undefined ? null : { from: quoted.from, text: quoteSnippet(quoted.text) },
          })
          const targetName = typeof payload.target === 'string' ? payload.target : 'all'
          if (rootId !== null) {
            for (const member of state.members) {
              if (targetName !== 'all' && member.name !== targetName) continue
              pendingThread.set(member.id, { rootId, replyTo: sent.id, expiresAt: Date.now() + THREAD_TTL_MS })
            }
          }
          sendJson(res, 200, await deliver(state, target.captainId, text, targetName))
        },
      }),

      webServer.register({
        kind: 'exact',
        path: ROUTE_PREFIX + '/task',
        handler: async (req, res) => {
          if (!fenced(req, res)) return
          const payload = await body(req, res)
          if (payload === undefined) return
          const subject = typeof payload.subject === 'string' ? payload.subject.trim() : ''
          if (subject === '') {
            sendJson(res, 400, { ok: false, error: 'empty' })
            return
          }
          const target = await targetState(typeof payload.sessionId === 'string' ? payload.sessionId : undefined)
          if (!target.found) {
            sendJson(res, 200, { ok: false, delivered: 0, error: 'no-team' })
            return
          }
          push(target.state, 'task', 'me', '📋 派发任务：' + subject)
          const body_ = '【新任务】' + subject + '\n请根据各自角色判断是否接手，并直接在群里回应分工。'
          sendJson(res, 200, await deliver(target.state, target.captainId, body_, 'all'))
        },
      }),

      webServer.register({
        kind: 'exact',
        path: ROUTE_PREFIX + '/settings',
        handler: async (req, res) => {
          if (!fenced(req, res)) return
          if (req.method !== 'POST') {
            sendJson(res, 200, { ok: true, settings: readSettings(), writable: ctx.settings.writable })
            return
          }
          const payload = await body(req, res)
          if (payload === undefined) return
          // Preview only: render a draft member exactly as it would reach the
          // member persona, without persisting anything. Keeps the renderer in
          // one place instead of duplicating it in the browser half.
          if (payload !== null && typeof payload.previewMember === 'object' && payload.previewMember !== null) {
            sendJson(res, 200, { ok: true, preview: memberPrompt(payload.previewMember) })
            return
          }
          const patch = payload && typeof payload.patch === 'object' && payload.patch !== null ? payload.patch : payload
          const clean = {}
          if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled
          if (typeof patch.autoCreateTeam === 'boolean') clean.autoCreateTeam = patch.autoCreateTeam
          if (typeof patch.autoApproveTeam === 'boolean') clean.autoApproveTeam = patch.autoApproveTeam
          if (typeof patch.imProgress === 'boolean') clean.imProgress = patch.imProgress
          if (typeof patch.imPush === 'boolean') clean.imPush = patch.imPush
          if (Array.isArray(patch.roles)) clean.roles = patch.roles.filter((role) => typeof role === 'string')
          if (typeof patch.defaultTeamId === 'string') clean.defaultTeamId = patch.defaultTeamId
          if (Array.isArray(patch.teams)) {
            // Normalize before persisting so invalid entries never reach the
            // schema, and report exactly what was dropped.
            const candidate = normalizeTeams({ teams: patch.teams, defaultTeamId: patch.defaultTeamId })
            clean.teams = candidate.teams
            clean.defaultTeamId = candidate.defaultTeamId
          }
          if (Object.keys(clean).length === 0) {
            sendJson(res, 400, { ok: false, error: 'no-known-field' })
            return
          }
          try {
            await ctx.settings.update(SETTINGS_NS, clean)
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) })
            return
          }
          sendJson(res, 200, { ok: true, settings: readSettings() })
        },
      }),

      webServer.register({
        kind: 'exact',
        path: ROUTE_PREFIX + '/team',
        handler: async (req, res) => {
          if (!fenced(req, res)) return
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' })
            res.end()
            return
          }
          const payload = await body(req, res)
          if (payload === undefined) return
          const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : ''
          if (sessionId === '') {
            sendJson(res, 400, { ok: false, error: 'sessionId-required' })
            return
          }
          const settings = readSettings()
          const teamId = typeof payload.teamId === 'string' ? payload.teamId.trim() : ''
          if (teamId === '') {
            sessionOverrides.delete(sessionId)
            sendJson(res, 200, { ok: true, activeTeam: { id: settings.defaultTeamId, name: activeTeamOf(settings).name } })
            return
          }
          const chosen = settings.teams.find((team) => team.id === teamId)
          if (chosen === undefined) {
            sendJson(res, 404, { ok: false, error: 'unknown-team' })
            return
          }
          sessionOverrides.set(sessionId, teamId)
          const state = sessions.get(sessionId)
          if (state !== undefined) push(state, 'system', '', '🔀 团队已切换为「' + chosen.name + '」')
          sendJson(res, 200, { ok: true, activeTeam: { id: chosen.id, name: chosen.name } })
        },
      }),
    ]
    ctx.effect(() => () => {
      for (const dispose of routes) {
        if (typeof dispose === 'function') dispose()
      }
      routes = []
      webRegistered = false
    }, 'team-chat: web routes')
  }

  try {
    ctx.settings.register(SETTINGS_NS, Config)
  } catch (error) {
    lastError = 'settings.register: ' + String(error)
  }

  registerRoutes()
  ctx.on('internal/service', (serviceName) => {
    if (WEB_SERVER_KEYS.includes(serviceName) || serviceName === 'connection') registerRoutes()
  })
}
