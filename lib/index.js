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
/** Legacy 3s poll cadence — kept as the fallback heartbeat reference; the
 *  rolling readSurface poll is gone (t17 replaces it with events). */
const POLL_MS = 3000
/** Roster discovery cadence (t17): `listChildren` every 45s — inside the
 *  30–60s band the review prescribed. Deliberately NOT the 3s utterance poll:
 *  member utterances arrive via `session/event`; roster changes are slow. */
const ROSTER_POLL_MS = 45000
/** Event-buffer flush cadence: drains one member's queued events into chat
 *  state at most every 500ms, so the hot `session/event` callback is O(1)
 *  (filter + cursor + enqueue) and all parsing/rendering happens here. */
const FLUSH_MS = 500
/** Heartbeat cadence (t15 §5.3): if a member is running but no session/event
 *  arrived for {@link STALL_MS}, log a warning and trigger a filterEvents
 *  self-check instead of silently going silent. */
const HEARTBEAT_MS = 30000
/** Stall threshold for the heartbeat: no member event for 60s while someone
 *  is running → suspected feed stall. */
const STALL_MS = 60000
/** Per-member event ring-buffer cap (t15 §5.2): before the throttle consumer
 *  drains, at most this many events are held; overflow marks lag and triggers
 *  a snapshot resync rather than unbounded growth. */
const FEED_CAP = 2000
/** Surface-eligible event types the feed buffers retain for the detail view
 *  (t24): the full utterance stream is reconstructed from these, so the
 *  client never needs a second data channel. */
const SURFACE_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])
/**
 * Step-projection event types (t19): the events a member's run is composed of.
 * The step list is one row per `tool/call`, grouped by step, with the step's
 * start/end and the turn's end-reason harvested from this set. These events are
 * retained incrementally from the SAME `session/event` feed that drives the
 * chat (no second read path); `tool/call` carries the artifact arguments
 * (file paths / commands) the projector shows.
 */
const STEP_EVENT_TYPES = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'tool/call',
  'tool/result',
  'assistant/message',
])
/** The `session/event` types the feed retains: the chat surface types PLUS the
 *  step-projection types (t19). chunk is filtered first — it is 53–67% of the
 *  raw feed and carries no step meaning (t15). */
const FEED_WATCH_TYPES = (() => {
  const set = new Set([
    'user/message',
    'assistant/message',
    'tool/result',
    'step/end',
    'turn/end',
  ])
  for (const type of STEP_EVENT_TYPES) set.add(type)
  return set
})()
const FRESH_LIMIT = 24
const TEXT_LIMIT = 1200
const MAX_MESSAGES = 400
const WINDOW_MESSAGES = 200
const THREAD_TTL_MS = 10 * 60 * 1000
/**
 * Upper bound for one `sessionQuery.readSurface` call. The background tick and
 * any joining request must never wait on a hung surface forever: the poller
 * would otherwise fill the single-flight slot and silently stop refreshing.
 * Kept below POLL_MS so a timeout always releases the lock before the next
 * tick is due.
 */
const READ_SURFACE_TIMEOUT_MS = 2500

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
  /** Member session id currently watched by the event feed (roster-derived). */
  const watchedMembers = new Set()
  /** Member session id → { seq, rows, lag } ring buffer fed by `session/event`
   *  and drained by the throttled consumer (t17). */
  const feedBuffers = new Map()
  /** Wall-clock of the last member event accepted into any feed buffer. */
  let lastEventAt = 0
  /** Total member events accepted into the feed (observability). */
  let eventCount = 0
  /** Total member events dropped before buffering (chunk / un-watched / stale). */
  let droppedEvents = 0
  /** Whether a member is currently running (from the last roster/status read). */
  let anyRunning = false
  let lastError = ''
  let routes = []
  let webRegistered = false
  let routingDisposer = null
  /** Count of bounded-read timeouts, surfaced in the snapshot so a degraded
   *  deployment is observable rather than silently degraded. */
  let timeoutCount = 0
  /** Count of `tool/call.arguments` JSON.parse failures, surfaced so a
   *  malformed-string payload is visible instead of silently dropping to '—'
   *  (t31: real traffic carries string arguments; parse failures must be
   *  observable). */
  let artifactParseFailures = 0
  /** Count of failed tool results whose error detail could not be surfaced
   *  (t35): the production contract carries `error: { name, code }` — no
   *  `message` — so a detail that yields neither field still needs to be
   *  observable rather than silently dropped. */
  let errorDetailMisses = 0
  /** Single-flight refresh: at most one roster refresh in flight at a time.
   *  The background tick occupies it; request paths join it (never start a
   *  second one), so readSurface traffic is bounded to the tick cadence. */
  let refreshInFlight = null

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
        generatedAt: 0,
        firstPullDone: false,
        surfaceEvents: new Map(),
        stepEvents: new Map(),
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

  /**
   * `sessionQuery.readSurface` bounded by {@link READ_SURFACE_TIMEOUT_MS}.
   * A hung surface must not wedge the single-flight refresh lock or stall a
   * browser request; on timeout it resolves to an empty surface so callers
   * degrade to "no new events this round" instead of freezing the tick. The
   * timeout is counted and surfaced in the snapshot — never silently dropped.
   */
  async function readSurfaceTimed(sessionId) {
    let timer
    try {
      return await Promise.race([
        ctx.sessionQuery.readSurface(sessionId),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            timeoutCount += 1
            lastError = 'readSurface timeout: ' + sessionId
            resolve({ events: [] })
          }, READ_SURFACE_TIMEOUT_MS)
          if (typeof timer.unref === 'function') timer.unref()
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * `ctx.subagents.listChildren` bounded by the same {@link READ_SURFACE_TIMEOUT_MS}.
   * A hung roster enumeration must not stall `discoverCaptains` / `resolveTeam`
   * (and through them a request or the tick); on timeout it degrades to an
   * empty child list and records the event. Callers that treat an empty list
   * as "no team" must be prepared for that reading.
   */
  async function listChildrenTimed(sessionId) {
    let timer
    try {
      return await Promise.race([
        ctx.subagents.listChildren(sessionId),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            timeoutCount += 1
            lastError = 'listChildren timeout: ' + sessionId
            resolve([])
          }, READ_SURFACE_TIMEOUT_MS)
          if (typeof timer.unref === 'function') timer.unref()
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
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
        children = await listChildrenTimed(agent.id)
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
      const roster = rosterFrom(await listChildrenTimed(sessionId))
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
        const roster = rosterFrom(await listChildrenTimed(parent))
        if (roster.length > 0) return { captainId: String(parent), roster }
      } catch {
        // no team below the parent either
      }
    }
    return undefined
  }

  // ------------------------------------------------------------ event feed

  /**
   * Apply the feed's incremental utterance logic for one event: assistant/message
   * → chat row (honouring the one-shot pendingThread binding), user/message →
   * incoming row. Shared by the throttled consumer and the catch-up reconciler,
   * so both produce byte-identical rows. Returns the event's seq (for cursor).
   */
  function applyFeedEvent(state, memberName, event) {
    const seq = Number(event.seq)
    if (event.type === 'assistant/message' && event.data && event.data.message) {
      const text = textOf(event.data.message.content)
      if (text !== '') {
        const binding = pendingThread.get(event.sessionId ?? event.memberId)
        if (binding !== undefined) pendingThread.delete(event.sessionId ?? event.memberId)
        const live = binding !== undefined && binding.expiresAt > Date.now() ? binding : undefined
        push(state, 'chat', memberName, text, live === undefined
          ? undefined
          : { rootId: live.rootId, replyTo: live.replyTo })
      }
    } else if (event.type === 'user/message' && event.data && event.data.content) {
      const text = textOf(event.data.content)
      if (text !== '') push(state, 'incoming', memberName, text)
    }
    return seq
  }

  /**
   * Fast roster discovery pass (t17): `listChildren` for each live captain,
   * updates members/activity system lines, and re-syncs the watched-member set.
   * Deliberately does NOT call readSurface — utterances arrive via events.
   * @returns whether any member is running (feeds the heartbeat signal).
   */
  async function refreshRoster() {
    let running = false
    const allMemberIds = new Set()
    for (const { captainId, roster } of await discoverCaptains()) {
      const state = stateFor(captainId)
      if (roster.length > 0 && state.teamName === '') {
        state.teamName = teamFromLabel(roster[0].label)
      }
      const members = roster.map((member) => ({
        id: member.id,
        name: member.name,
        activity: member.activity,
        // t61: this captain IS the member's real parent session. The client
        // needs it to load the parent catalog before a first-time jump
        // (refreshSubagents(parentSessionId)); the tab's scope.sessionId is the
        // session the USER is viewing, which is NOT guaranteed to be the parent
        // of every member.
        parentSessionId: captainId,
      }))
      for (const member of roster) {
        const previous = state.actSeen.get(member.id)
        if (previous !== undefined && previous !== member.activity) {
          push(state, 'system', '', member.activity === 'running'
            ? '🔨 ' + member.name + ' 开始工作'
            : '◽ ' + member.name + ' 空闲')
        }
        state.actSeen.set(member.id, member.activity)
        if (member.activity === 'running') running = true
        allMemberIds.add(member.id)
        watchedMembers.add(member.id)
        if (!feedBuffers.has(member.id)) {
          feedBuffers.set(member.id, { seq: -1, rows: [], lag: false })
        }
      }
      state.members = members
      state.generatedAt = Date.now()
    }
    // Prune feed buffers / watched set for members that no longer exist.
    pruneWatched(allMemberIds)
    return running
  }

  /** Prune watched/buffered member ids that disappeared from every roster. */
  function pruneWatched(allMemberIds) {
    for (const memberId of [...watchedMembers]) {
      if (!allMemberIds.has(memberId)) {
        watchedMembers.delete(memberId)
        feedBuffers.delete(memberId)
      }
    }
  }

  /**
   * One-time surface catch-up (t17): readSurface is ONLY used here — when a
   * member first appears (cursor unknown) or the feed lagged (buffer overflow,
   * missed events). It seeds `seqSeen` at the tail and folds any events after
   * the stored cursor, exactly like the old poll did, but on demand.
   * Returns true if a member is running (roster signal for the heartbeat).
   */
  async function refreshSurface(state, roster) {
    let running = false
    for (const member of roster) {
      if (member.activity === 'running') running = true
      let surface
      try {
        surface = await readSurfaceTimed(member.id)
      } catch {
        continue
      }
      const events = surface.events || []
      const cursor = state.seqSeen.get(member.id)
      if (cursor === undefined) {
        let tail = -1
        for (let i = events.length - 1; i >= 0; i -= 1) {
          const seq = Number(events[i].seq)
          if (seq > tail) tail = seq
        }
        state.seqSeen.set(member.id, tail)
        // Prime the feed buffer at the tail so events after it stream in.
        const cell = feedBuffers.get(member.id)
        if (cell !== undefined) cell.seq = tail
        seedSurfaceEvents(state, member.id, events)
        seedStepEvents(state, member.id, events)
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
        next = applyFeedEvent(state, memberNameOf(roster, member.id), Object.assign({}, event, { memberId: member.id }))
      }
      state.seqSeen.set(member.id, next)
      seedSurfaceEvents(state, member.id, fresh)
      seedStepEvents(state, member.id, fresh)
    }
    state.generatedAt = Date.now()
    return running
  }

  function memberNameOf(roster, memberId) {
    for (const member of roster) {
      if (member.id === memberId) return member.name
    }
    return memberId
  }

  /**
   * t24: retain surface-eligible events (with their surfaceOp) in the state so
   * the client's detail view can render the full utterance stream from this
   * buffer alone — no second data channel needed.
   */
  function seedSurfaceEvents(state, memberId, events) {
    let list = state.surfaceEvents.get(memberId)
    if (list === undefined) {
      list = []
      state.surfaceEvents.set(memberId, list)
    }
    for (const event of events) {
      if (event && SURFACE_EVENT_TYPES.has(event.type)) list.push(event)
      if (list.length > FEED_CAP) list.splice(0, list.length - FEED_CAP)
    }
  }

  /**
   * t19: retain step-eligible events in a per-member buffer, fed from the SAME
   * incremental feed as the surface buffer — the step projection is a pure
   * in-memory fold over it, so exposing steps adds ZERO new read calls.
   */
  function seedStepEvents(state, memberId, events) {
    let list = state.stepEvents.get(memberId)
    if (list === undefined) {
      list = []
      state.stepEvents.set(memberId, list)
    }
    for (const event of events) {
      if (event && STEP_EVENT_TYPES.has(event.type)) list.push(event)
      if (list.length > FEED_CAP) list.splice(0, list.length - FEED_CAP)
    }
  }

  /**
   * Extract the ONE artifact line a tool call produced: the file path for
   * file tools, the command for pwsh. Missing data renders as '—' (never a
   * fabricated value).
   *
   * `arguments` arrives in TWO shapes in real traffic (t31): the production
   * session log emits `tool/call` with `arguments` as a **JSON string** (the
   * append snapshot is emitted as recorded — no parse happens on the wire),
   * while synthetic/harness payloads may carry the **object** form. Both must
   * work. String form is parsed first (failure is counted, never silent, and
   * degrades to '—'); object form is used directly. Unknown tools surface the
   * first string-valued argument of the PARSED object — never a raw substring
   * of the unparsed string (which previously yielded `'{'`).
   */
  function artifactOf(toolName, args, onParseFailure) {
    let arg
    const raw = args
    if (typeof raw === 'string') {
      if (raw.trim() === '') return '—'
      try {
        arg = JSON.parse(raw)
      } catch (error) {
        // Observable, not silent: bump the counter and record the cause.
        artifactParseFailures += 1
        lastError = 'tool/call arguments JSON.parse failed for ' + toolName + ': ' + String((error && error.message) || error)
        if (typeof onParseFailure === 'function') onParseFailure()
        return '—'
      }
    } else if (raw !== null && typeof raw === 'object') {
      arg = raw
    } else {
      // undefined / number / boolean — nothing to extract.
      return '—'
    }
    let value
    if (toolName === 'pwsh' || toolName === 'bash' || toolName === 'sh') value = arg.command
    else if (toolName === 'read' || toolName === 'write' || toolName === 'edit') value = arg.file_path ?? arg.path
    else if (toolName === 'grep') value = arg.path ?? arg.pattern
    else if (toolName === 'glob') value = arg.pattern ?? arg.path
    else {
      // Unknown tool: surface the first string argument of the PARSED object.
      for (const key of Object.keys(arg)) {
        if (typeof arg[key] === 'string' && arg[key] !== '') { value = arg[key]; break }
      }
    }
    return typeof value === 'string' && value !== '' ? value : '—'
  }

  /**
   * Assemble a human-readable tool/result error detail from the production
   * contract shape — `error: { name: string; code: string }` (t34 verified:
   * real logs carry ONLY `name` / `code`, no `message`). A `message` field is
   * still honoured when present (future contract growth), so the detail works
   * for every observed shape. Returns '' when nothing usable exists; the
   * caller counts that as an observability miss (t35) rather than silently
   * dropping.
   */
  function errorDetailOf(error) {
    if (error === null || error === undefined || typeof error !== 'object') return ''
    const name = typeof error.name === 'string' && error.name !== '' ? error.name : ''
    const code = typeof error.code === 'string' && error.code !== '' ? error.code : ''
    const message = typeof error.message === 'string' && error.message !== '' ? error.message : ''
    if (name === '' && code === '' && message === '') return ''
    if (name === '' && code === '') return message.slice(0, 80)
    const head = name !== '' && code !== ''
      ? name + ' (' + code + ')'
      : (name !== '' ? name : code)
    return message === '' ? head : head + ': ' + message.slice(0, 80)
  }

  /**
   * Project the per-member step list (P2a): one row per `tool/call`, grouped by
   * step, with turn/step numbering, the step's status and the turn's end reason
   * folded from surrounding events. Pure in-memory fold over `state.stepEvents`.
   *
   * Event → step field mapping (the contract's required table):
   *   role            ← roster name for the member
   *   turn + step     ← turn/start..turn/end and step/start..step/end counters
   *   action          ← tool/call.name
   *   artifact        ← tool/call.arguments (via {@link artifactOf})
   *   result          ← tool/result: 'ok' | 'error' (error.data.message) | '—'
   *   decision        ← the step's last assistant/message text, else '—'
   * @param state - the captain's chat state.
   * @param memberId - the member session whose steps are requested.
   * @param memberName - display name for the role column.
   */
  function projectSteps(state, memberId, memberName) {
    const events = state.stepEvents.get(memberId) || []
    const rows = []
    const decisionByStep = new Map()
    let turn = 0
    let step = 0
    let stepOpen = false
    let stepTools = 0
    let decision = ''
    let lastResult = '—'
    let stepAction = ''

    for (const event of events) {
      const type = event.type
      const data = event.data || {}
      if (type === 'turn/start') {
        turn += 1
        step = 0
        stepOpen = false
        stepTools = 0
        decision = ''
      } else if (type === 'turn/end') {
        stepOpen = false
      } else if (type === 'step/start') {
        step += 1
        stepOpen = true
        stepTools = 0
        decision = ''
        lastResult = '—'
        stepAction = ''
      } else if (type === 'step/end') {
        stepOpen = false
        // A step with no tool call still surfaces as one informational row.
        if (stepTools === 0) {
          rows.push({
            role: memberName,
            turn,
            step,
            action: stepAction || '（思考）',
            artifact: '—',
            result: '—',
            decision: decision || '—',
          })
        } else {
          decisionByStep.set(turn + ':' + step, decision)
        }
      } else if (type === 'tool/call') {
        stepTools += 1
        const toolName = typeof data.name === 'string' ? data.name : '—'
        stepAction = toolName
        rows.push({
          role: memberName,
          turn,
          step,
          action: toolName,
          artifact: artifactOf(toolName, data.arguments),
          result: '—',
          decision: '',
        })
      } else if (type === 'tool/result') {
        const failed = data.error !== undefined && data.error !== null
        const meta = data.meta || {}
        lastResult = failed ? 'error' : (meta.truncated === true ? 'truncated' : 'ok')
        // Attach the result to the most recent tool row of this step.
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (rows[i].turn === turn && rows[i].step === step && rows[i].result === '—') {
            rows[i].result = lastResult
            if (failed) {
              const detail = errorDetailOf(data.error)
              if (detail !== '') rows[i].result = rows[i].result + ': ' + detail
              else errorDetailMisses += 1
            }
            break
          }
        }
      } else if (type === 'assistant/message' && data.message && stepOpen) {
        const text = textOf(data.message.content)
        if (text !== '') decision = text
      }
    }
    // Attach each step's decision (which arrives BEFORE the step's tool rows in
    // the log) to every tool row of that step.
    for (const row of rows) {
      const key = row.turn + ':' + row.step
      const decided = decisionByStep.get(key)
      if (decided !== undefined && decided !== '') row.decision = decided
    }
    return {
      memberId,
      member: memberName,
      steps: rows.slice(-WINDOW_MESSAGES),
    }
  }

  /** Drain every member's event ring buffer into chat state (throttled). */
  function drainFeeds(state, roster) {
    const nameById = new Map(roster.map((member) => [member.id, member.name]))
    for (const [memberId, cell] of feedBuffers) {
      if (cell.lag) {
        // Overflow happened: mark so the next mature tick reconciles via surface.
        cell.lag = false
        state.seqSeen.delete(memberId)
        continue
      }
      if (cell.rows.length === 0) continue
      const name = nameById.get(memberId) ?? memberNameOf(roster, memberId)
      let next = cell.seq
      for (const event of cell.rows) {
        next = applyFeedEvent(state, name, Object.assign({}, event, { memberId }))
        seedSurfaceEvents(state, memberId, [event])
        seedStepEvents(state, memberId, [event])
      }
      cell.rows = []
      cell.seq = next
      state.seqSeen.set(memberId, next)
    }
  }

  /**
   * Recompute whether any watched member is currently running, from the live
   * chat states — the authoritative activity every beat (t39/A). The heartbeat
   * calls this instead of reading a cross-beat flag: a sticky `||=` value would
   * keep the stall self-check firing on an idle deployment long after the last
   * member ran.
   * @returns true when at least one member's activity is 'running'.
   */
  function anyMemberRunning() {
    for (const [, state] of sessions) {
      for (const member of state.members) {
        if (member && member.activity === 'running') return true
      }
    }
    return false
  }

  /**
   * Single-flight roster refresh (t17): the slow tick and `/state`'s first pull
   * share one lock; readSurface is NOT part of the periodic pass.
   */
  async function refreshAll() {
    if (refreshInFlight !== null) return refreshInFlight
    refreshInFlight = (async () => {
      try {
        const running = await refreshRoster()
        anyRunning = running
      } catch (error) {
        lastError = 'roster: ' + String(error)
        anyRunning = false
      } finally {
        refreshInFlight = null
      }
    })()
    return refreshInFlight
  }

  /**
   * First-pull / catch-up path: synchronously reconcile the state with each
   * live roster via a single surface read pass (bounded), then prime buffers.
   */
  async function syncCatchUp() {
    if (refreshInFlight !== null) await refreshInFlight
    let running = false
    for (const { captainId, roster } of await discoverCaptains()) {
      running = (await refreshSurface(stateFor(captainId), roster)) || running
      for (const member of roster) watchedMembers.add(member.id)
    }
    anyRunning = running
    return running
  }

  async function tick() {
    await refreshAll()
  }

  // ---- event subscribers (the hot path is O(1): filter + cursor + enqueue)

  const feedDisposers = []
  feedDisposers.push(ctx.on('session/event', (session, event) => {
    try {
      const sessionId = session && String(session.id)
      if (!watchedMembers.has(sessionId)) { droppedEvents += 1; return }
      // First cut: drop the streaming noise (53–67% of the raw feed, t15).
      if (event === null || event === undefined || event.type === 'assistant/chunk') { droppedEvents += 1; return }
      if (!FEED_WATCH_TYPES.has(event.type)) { droppedEvents += 1; return }
      const cell = feedBuffers.get(sessionId)
      if (cell === undefined) { droppedEvents += 1; return }
      const seq = Number(event.seq)
      if (cell.lag || seq <= cell.seq) { droppedEvents += 1; return }
      cell.seq = seq
      cell.rows.push(event)
      if (cell.rows.length > FEED_CAP) {
        // Backpressure: never grow unbounded — flag lag so the consumer
        // reconciles from a snapshot instead of a corrupted sequence.
        cell.lag = true
        cell.rows = []
      }
      lastEventAt = Date.now()
      eventCount += 1
    } catch (error) {
      if (ctx.logger && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn('team-chat: session/event handler: ' + String(error))
      }
    }
  }, { global: true }))

  feedDisposers.push(ctx.on('agent/status', ({ agent, status }) => {
    try {
      const agentId = agent && String(agent.id)
      if (!watchedMembers.has(agentId)) return
      const runningNow = status === 'running'
      // NOTE (t39/A): do NOT accumulate a sticky "someone ever ran" flag here.
      // The heartbeat recomputes the running set from the live rosters each
      // beat; a sticky flag would keep the stall self-check spinning forever
      // after the first run (idle deployments included).
      // Find the owning state via any roster containing this member.
      for (const [captainId, state] of sessions) {
        for (const member of state.members) {
          if (member.id === agentId && state.actSeen.get(agentId) !== (runningNow ? 'running' : 'idle')) {
            state.actSeen.set(agentId, runningNow ? 'running' : 'idle')
            member.activity = runningNow ? 'running' : 'idle'
            push(state, 'system', '', runningNow
              ? '🔨 ' + member.name + ' 开始工作'
              : '◽ ' + member.name + ' 空闲')
            void captainId
          }
        }
      }
    } catch (error) {
      if (ctx.logger && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn('team-chat: agent/status handler: ' + String(error))
      }
    }
  }))

  // ---- throttled consumer + heartbeat + slow roster tick

  const flushTimer = setInterval(() => {
    for (const [captainId, state] of sessions) {
      drainFeeds(state, state.members)
      void captainId
    }
  }, FLUSH_MS)
  if (typeof flushTimer.unref === 'function') flushTimer.unref()

  const heartbeatTimer = setInterval(() => {
    try {
      // t39/A: recompute from the live rosters every beat — never read an
      // accumulated flag. `||=` accumulation made "someone has run at some
      // point" stick forever, so the stall self-check kept firing on fully
      // idle deployments. A stale-roster guard (generatedAt) keeps this from
      // trusting a snapshot older than the stall window.
      const runningNow = anyMemberRunning()
      anyRunning = runningNow
      if (!runningNow) return
      const idleMs = Date.now() - lastEventAt
      if (idleMs > STALL_MS) {
        if (ctx.logger && typeof ctx.logger.warn === 'function') {
          ctx.logger.warn('team-chat: feed stalled ' + Math.round(idleMs / 1000) + 's with members running — self-checking')
        }
        // Self-check: reconcile one surface pass (bounded) instead of trusting
        // a possibly-silent feed (better-sidebar lesson, t15 §5.3).
        void syncCatchUp()
      }
    } catch (error) {
      if (ctx.logger && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn('team-chat: heartbeat: ' + String(error))
      }
    }
  }, HEARTBEAT_MS)
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref()

  const rosterPoller = setInterval(() => { void tick() }, ROSTER_POLL_MS)
  if (typeof rosterPoller.unref === 'function') rosterPoller.unref()
  void tick()

  ctx.effect(() => () => {
    for (const dispose of feedDisposers) {
      if (typeof dispose === 'function') dispose()
    }
    clearInterval(flushTimer)
    clearInterval(heartbeatTimer)
    clearInterval(rosterPoller)
  }, 'team-chat: event feed')

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
   *
   * De-synchronised by design (t16) and event-fed (t17). Steady state reads no
   * member surface at all: utterances arrive through `session/event` and are
   * drained by the throttled consumer. A request never blocks except on the
   * browser's FIRST pull for a state, which runs one bounded catch-up so the
   * first screen is correct. /speak and /task act on the latest snapshot.
   */
  async function targetState(sessionId, options) {
    const sync = options !== undefined && options.sync === true
    if (typeof sessionId === 'string' && sessionId !== '') {
      const resolved = await resolveTeam(sessionId)
      const state = stateFor(resolved === undefined ? sessionId : resolved.captainId)
      if (sync && !state.firstPullDone && resolved !== undefined) {
        state.firstPullDone = true
        await syncCatchUp()
      }
      return { state, captainId: resolved === undefined ? '' : resolved.captainId, found: resolved !== undefined }
    }
    const captains = await discoverCaptains()
    if (captains.length === 0) return { state: stateFor(''), captainId: '', found: false }
    const first = captains[0]
    const state = stateFor(first.captainId)
    if (sync && !state.firstPullDone) {
      state.firstPullDone = true
      await syncCatchUp()
    }
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
      const surface = await readSurfaceTimed(sessionId)
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
      /**
       * Snapshot freshness, for the client to hint the user when data is not
       * current: false when this response is the first pull (refreshed in
       * request), true when it was served from the tick's latest snapshot.
       */
      stale: Date.now() - (state.generatedAt || 0) > POLL_MS,
      /**
       * Wall-clock ms of the last completed roster refresh for this snapshot
       * (0 before any refresh has finished).
       */
      generatedAt: state.generatedAt,
      activeTeam: { id: team.id, name: team.name, description: team.description, members: team.members.map((member) => member.name) },
      teams: settings.teams.map((candidate) => ({ id: candidate.id, name: candidate.name, memberCount: candidate.members.length })),
      defaultTeamId: settings.defaultTeamId,
      members: state.members.map((member) => {
        const template = configByName.get(member.name)
        return {
          id: member.id,
          name: member.name,
          activity: member.activity,
          parentSessionId: member.parentSessionId,
          role: template === undefined ? '' : template.role,
          model: template === undefined ? '' : template.model,
          skillCount: template === undefined ? 0 : template.skills.length,
          configured: template !== undefined,
        }
      }),
      threads: groupThreads(state.messages.slice(-WINDOW_MESSAGES)),
      hasTeam: found && state.members.length > 0,
      error: lastError === '' ? null : lastError,
      timeouts: timeoutCount,
      artifactParseFailures,
      errorDetailMisses,
      /**
       * Feed observability (t17, "可观测的调度心跳"): the client can prove the
       * event feed is alive rather than silently stalled — `lastEventAt` is
       * when a member event was last accepted, `eventCount` how many were
       * accepted, `watched` how many member sessions the feed follows, and
       * `lagged` how many buffers hit the cap and will resync.
       */
      feed: {
        lastEventAt,
        eventCount,
        watched: watchedMembers.size,
        dropped: droppedEvents,
        lagged: [...feedBuffers.values()].filter((cell) => cell.lag).length,
      },
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
          const target = await targetState(sessionId, { sync: true })
          sendJson(res, 200, snapshotOf(
            target.state,
            target.found,
            await imOriginOf(target.captainId === '' ? target.state.sessionId : target.captainId),
          ))
          // Serve the snapshot first, then top up the roster in the background
          // so the next poll is fresher — but only when the roster data is
          // actually stale. This is a `listChildren` pass (no readSurface):
          // member utterances arrive through the event feed instead.
          if (Date.now() - (target.state.generatedAt || 0) >= ROSTER_POLL_MS) {
            void refreshAll()
          }
        },
      }),

      webServer.register({
        kind: 'exact',
        path: ROUTE_PREFIX + '/steps',
        handler: async (req, res) => {
          if (!fenced(req, res)) return
          let sessionId
          try {
            sessionId = new URL(req.url ?? '/', 'http://x').searchParams.get('sessionId') ?? undefined
          } catch {
            sessionId = undefined
          }
          const target = await targetState(sessionId)
          if (!target.found) {
            // No team yet: still serve an empty projection so the client can
            // render without guessing.
            sendJson(res, 200, { ok: true, members: [] })
            return
          }
          const state = target.state
          const rows = state.members.map((member) => projectSteps(state, member.id, member.name))
          // Projection is a pure in-memory fold over the feed buffer: it never
          // re-reads a member surface, so it cannot add a read hotspot, and it
          // inherits the fenced route + bounded targetState seams.
          sendJson(res, 200, { ok: true, members: rows })
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
        path: ROUTE_PREFIX + '/capabilities',
        handler: async (req, res) => {
          if (!fenced(req, res)) return
          if (req.method !== 'GET') {
            res.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' })
            res.end()
            return
          }
          // t44: expose the REAL skill catalog for the member-page pickers.
          // Contract (t43 §1): ctx.skills.list({ scope, cwd }) → [{ name, ... }].
          // The service is OPTIONAL — when absent the client renders an honest
          // 'unavailable' state; on throw it renders 'failed'. Never an empty
          // list that could be mistaken for "no skills exist."
          const skillsService = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
          const skills = { state: 'unavailable', reason: 'no-service', items: [] }
          if (skillsService && typeof skillsService.list === 'function') {
            try {
              const items = await skillsService.list({ scope: 'global' })
              const names = Array.isArray(items)
                ? items.map((item) => String((item && item.name) || '')).filter((name) => name !== '')
                : []
              skills.state = names.length === 0 ? 'empty' : 'ok'
              // t61/t45-low: an ok/empty answer carries NO failure reason — the
              // initial 'no-service' must not leak into a successful response.
              skills.reason = ''
              skills.items = names
            } catch (error) {
              skills.state = 'failed'
              skills.reason = String((error && error.message) || error)
            }
          }
          sendJson(res, 200, { ok: true, capabilities: { skills } })
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
