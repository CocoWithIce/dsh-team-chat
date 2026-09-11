/**
 * dsh-team-chat — Client half.
 *
 * Registers the team group chat as a `dsh-better-sidebar` tab when that plugin
 * is installed, with its display options exposed as declarative settings on the
 * sidebar's own row. Without better-sidebar the same view degrades to a docked
 * right-edge column inside `shell.overlay`, so the feature never depends on an
 * optional peer.
 *
 * Rendering contract: the host half already grouped the messages into thread
 * trees (`/{state}.threads`), so this half only draws role frames, quote blocks
 * and thread disclosure — it never re-derives conversation structure.
 *
 * This file is a hand-written module-loader bundle (no bundler required):
 * `window.__ModuleLoader__.load({ id, factory })` with `require()` for the
 * shared browser-side packages.
 */
window.__ModuleLoader__.load({
  id: 'dsh-team-chat',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    /** The better-sidebar tab id; also the sidebar settings-blob key. */
    var TAB_ID = 'team-chat'
    var BASE = '/plugins/dsh-team-chat'
    var STATE_URL = BASE + '/state'
    var SPEAK_URL = BASE + '/speak'
    var TASK_URL = BASE + '/task'
    var SETTINGS_URL = BASE + '/settings'
    var DOCK_WIDTH = 380

    var ROLE_META = {
      researcher: { icon: '🔬', label: '研究员', color: '#4f8cff' },
      engineer: { icon: '🛠', label: '工程师', color: '#34c77b' },
      reviewer: { icon: '🧐', label: '审查员', color: '#ff9f43' },
      me: { icon: '🙋', label: '我', color: '#a78bfa' },
    }

    function roleMeta(name) {
      return ROLE_META[name] || { icon: '👤', label: String(name || 'member'), color: 'var(--dsw-alias-label-tertiary)' }
    }

    /**
     * Turns a render failure into a visible message. Without it a throwing view
     * renders as an empty panel, which is indistinguishable from "no data yet".
     */
    class ChatErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error: error }
      }

      componentDidCatch(error, info) {
        try {
          console.error('dsh-team-chat: group chat render failed', error, info)
        } catch (ignored) {
          // logging must never cascade
        }
      }

      render() {
        if (this.state.error !== null && this.state.error !== undefined) {
          var message = String((this.state.error && this.state.error.message) || this.state.error)
          var stack = String((this.state.error && this.state.error.stack) || '')
          return React.createElement('div', {
            style: {
              margin: '10px', padding: '10px', borderRadius: '8px',
              background: 'var(--dsw-alias-state-error-primary)',
              border: '1px solid var(--dsw-alias-state-error-primary)',
              color: 'var(--dsw-alias-label-primary)',
              fontSize: '12px', lineHeight: 1.6, wordBreak: 'break-word',
            },
          },
            React.createElement('div', { style: { fontWeight: 700, marginBottom: '4px' } }, '群聊面板渲染出错'),
            React.createElement('div', null, message),
            stack ? React.createElement('pre', {
              style: { margin: '8px 0 0', fontSize: '10px', whiteSpace: 'pre-wrap', color: 'var(--dsw-alias-label-secondary)' },
            }, stack.split('\n').slice(0, 4).join('\n')) : null,
          )
        }
        return this.props.children
      }
    }

    function clockOf(time) {
      try {
        var date = new Date(time)
        return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
      } catch (error) {
        return ''
      }
    }

    var DISPLAY_DEFAULTS = {
      showIncoming: true,
      compact: false,
      pollSeconds: 3,
      autoOpen: true,
    }

    /**
     * Merge the sidebar's persisted plugin settings for this tab over defaults.
     *
     * The docked column is NOT a stored preference — it is decided by capability
     * (only when better-sidebar is unavailable). Exposing it as a switch let the
     * sidebar initialize it to `true` and render the dock *and* the tab at once.
     */
    function readDisplayConfig(betterSidebar, hasSidebar) {
      var config = Object.assign({}, DISPLAY_DEFAULTS, { dockedRight: !hasSidebar })
      try {
        if (betterSidebar && typeof betterSidebar.getSnapshot === 'function') {
          var snapshot = betterSidebar.getSnapshot()
          var all = snapshot && snapshot.prefs && snapshot.prefs.pluginSettings
          var mine = all ? all[TAB_ID] : undefined
          if (mine && typeof mine === 'object') {
            if (typeof mine.showIncoming === 'boolean') config.showIncoming = mine.showIncoming
            if (typeof mine.compact === 'boolean') config.compact = mine.compact
            if (typeof mine.autoOpen === 'boolean') config.autoOpen = mine.autoOpen
            if (typeof mine.pollSeconds === 'number' && mine.pollSeconds >= 1 && mine.pollSeconds <= 30) {
              config.pollSeconds = mine.pollSeconds
            }
          }
        }
      } catch (error) {
        // A broken prefs read must never take the tab down.
      }
      return config
    }

    function postJson(url, payload) {
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      }).then(function (response) { return response.json() })
    }

    /**
     * Copy a string to the clipboard. Resolves to the REAL outcome (t39/B):
     * `true` only when the platform confirmed the write, `false` when the API
     * is unavailable or the write rejected. The previous version returned `true`
     * unconditionally while ignoring its own `settled` flag, so the caller
     * claimed success even when nothing reached the clipboard.
     * @param value - the text to copy.
     * @returns Promise<boolean> — never rejects.
     */
    function copyText(value) {
      try {
        if (typeof navigator === 'undefined' || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
          return Promise.resolve(false)
        }
        var written = navigator.clipboard.writeText(String(value || ''))
        if (written === undefined || written === null || typeof written.then !== 'function') {
          // Older implementations return void; a synchronous call with no
          // throw is the only signal available — treat it as success.
          return Promise.resolve(true)
        }
        return written.then(function () { return true }, function () { return false })
      } catch (error) {
        return Promise.resolve(false)
      }
    }

    /**
     * The empty view. Every field the view reads is present so a payload that
     * has not arrived yet (or a session switch in flight) can never render as a
     * blank panel or throw on a missing array.
     */
    var EMPTY_STATE = {
      threads: [],
      members: [],
      teams: [],
      activeTeam: null,
      defaultTeamId: '',
      hasTeam: false,
      team: '',
      error: null,
      loading: true,
    }

    /**
     * Distance from the bottom (px) still counted as "at the bottom". A user
     * scrolled within this band keeps auto-follow; anything further up is
     * treated as reading and is never yanked back. 48px is roughly one line of
     * the compact card plus its gap.
     */
    var NEAR_BOTTOM_PX = 48

    /**
     * Build the change fingerprint the poller compares on every reply.
     *
     * Computed CLIENT-side on purpose: the reviewed F4 draft proposed comparing
     * `state.seq`, but `snapshotOf` never exposes it (`/state` carries
     * sessionId/team/activeTeam/teams/defaultTeamId/members/threads/hasTeam/
     * error/im/imPush only), so that field is simply absent. Everything below
     * comes from the payload we actually receive:
     *
     * - `threads` length and the LAST message id — catches appended utterances
     *   and the system rows that activity flips produce;
     * - a leading/trailing reply-count signature — catches a reply landing in
     *   an existing thread without moving the global tail;
     * - each member's `activity` — catches status changes even if a future
     *   server stops emitting system rows for them;
     * - `feed.eventCount` — the monotone counter added by the host event feed
     *   (t17), which advances whenever an accepted member event arrives. It
     *   makes the fingerprint strictly more sensitive than message shape alone.
     * - `error` — a changed error banner must repaint.
     * @param data - one `/state` payload.
     * @returns a stable string; equal strings mean "nothing the view shows changed".
     */
    function stateFingerprint(data) {
      if (!data || typeof data !== 'object') return ''
      var threads = data.threads || []
      var tailIds = []
      var replyShape = []
      for (var i = 0; i < threads.length; i += 1) {
        var thread = threads[i] || {}
        var root = thread.root || {}
        tailIds.push(String(root.id || ''))
        var replies = thread.replies || []
        if (replies.length > 0) {
          var lastReply = replies[replies.length - 1] || {}
          tailIds.push(String(lastReply.id || ''))
        }
        replyShape.push(replies.length)
      }
      var activities = []
      var members = data.members || []
      for (var j = 0; j < members.length; j += 1) {
        var member = members[j] || {}
        activities.push(String(member.name || '') + ':' + String(member.activity || ''))
      }
      var feed = data.feed || {}
      return [
        threads.length,
        tailIds.join(','),
        replyShape.join(','),
        activities.join(','),
        typeof feed.eventCount === 'number' ? feed.eventCount : '',
        String(data.error || ''),
        data.sessionId ? String(data.sessionId) : '',
      ].join('|')
    }

    /**
     * Jump the DSH UI into one member's (subagent) session — the P2b "click a
     * step → see that member's process" action.
     *
     * Uses the platform's public client sessions service, exactly like
     * better-sidebar does:
     *
     *   const sessions = ctx.get('sessions')          // runtime root service
     *   const address = sessions.subagentAddress(id)   // { parentSessionId, childSessionId, mode }
     *   sessions.openSubagent(address)                 // switch the main view
     *
     * Four degradation levels — NONE of them may throw:
     *   1. client context missing (`ctx` falsy / no get) → { reason:'no-ctx' } —
     *      OUR defect (e.g. the tab wrapper dropped props.ctx), never reported
     *      as a platform problem.
     *   2. `sessions` service unavailable → { ok:false, reason:'no-service' } —
     *      the platform service truly is not mounted.
     *   3. `subagentAddress` yields no address          → the member may not be a
     *      healthy catalog child; return its sessionId so the UI can offer a
     *      copy fallback.
     *   4. `openSubagent` throws (non-healthy child)    → catch and degrade.
     * A `console.warn` sample is emitted on each call so the deployment can tell
     * whether the sessions service actually mounted (client runtime probes hang,
     * so this is the only observable).
     * @param ctx - the client context (from TabComponentProps or the dock closure).
     * @param childSessionId - the member session to focus.
     * @returns `{ ok, reason?, sessionId? }` — never throws.
     */
    function jumpToSubagent(ctx, childSessionId) {
      var result = { ok: false, sessionId: childSessionId }
      try {
        // t44/P0: distinguish "we never received the client context" from "the
        // sessions service really is not mounted". The old code collapsed both
        // into 'no-service', blaming the platform for our own dropped ctx (the
        // tab wrapper discarded TabComponentProps.ctx). Each cause must surface
        // with its own reason so the UI can state what is actually true.
        if (!ctx || typeof ctx.get !== 'function') {
          try {
            console.warn('team-chat: client context unavailable; cannot jump into ' + childSessionId)
          } catch (ignored) { /* logging must never cascade */ }
          result.reason = 'no-ctx'
          return result
        }
        var sessions = ctx.get('sessions')
        // Degradation 1: service not mounted (or the inject was declared but the
        // host never provided it). Do not crash the panel.
        if (sessions === undefined || sessions === null) {
          try {
            console.warn('team-chat: sessions service unavailable; cannot jump into ' + childSessionId)
          } catch (ignored) { /* logging must never cascade */ }
          result.reason = 'no-service'
          return result
        }
        var address
        try {
          address = typeof sessions.subagentAddress === 'function'
            ? sessions.subagentAddress(childSessionId)
            : undefined
        } catch (error) {
          try {
            console.warn('team-chat: subagentAddress failed for ' + childSessionId + ': ' + String((error && error.message) || error))
          } catch (ignored) { /* cascade guard */ }
          address = undefined
        }
        // Degradation 2: no durable address — the member is not a healthy
        // catalog child. Keep sessionId so the UI can copy it.
        if (address === undefined || address === null || typeof address !== 'object') {
          result.reason = 'no-address'
          return result
        }
        if (typeof sessions.openSubagent === 'function') {
          try {
            sessions.openSubagent(address)
            result.ok = true
          } catch (error) {
            // Degradation 3: openSubagent rejected the address (e.g. the child
            // left the catalog since the address was resolved).
            try {
              console.warn('team-chat: openSubagent failed for ' + childSessionId + ': ' + String((error && error.message) || error))
            } catch (ignored) { /* cascade guard */ }
            result.reason = 'open-failed'
          }
        } else {
          // Service mounted but this build lacks openSubagent (old DSH).
          result.reason = 'no-openSubagent'
        }
      } catch (error) {
        try {
          console.warn('team-chat: jumpToSubagent unexpected: ' + String((error && error.message) || error))
        } catch (ignored) { /* cascade guard */ }
        result.reason = 'unexpected'
      }
      return result
    }

    /**
     * Poll the /steps projection for the current session on the same cadence as
     * /state. Returns `[stepsData, reload]`. The payload has `{ ok, members:
     * [{ memberId, member, steps: [{ role, turn, step, action, artifact, result,
     * decision }] }] }`. Loaded lazily: a quiet poll reuses the last snapshot.
     */
    function useSteps(sessionId, pollSeconds, active) {
      var pair = React.useState(null)
      var stepsData = pair[0]
      var setSteps = pair[1]
      var lastRef = React.useRef(0)
      var url = sessionId ? BASE + '/steps?sessionId=' + encodeURIComponent(sessionId) : BASE + '/steps'
      var urlRef = React.useRef(url)
      urlRef.current = url

      function load() {
        return fetch(urlRef.current, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
          .then(function (response) { return response.json() })
          .then(function (next) {
            if (next && next.ok) setSteps(next)
            return next
          })
          .catch(function () { /* keep the last snapshot on a failed poll */ })
      }

      React.useEffect(function () {
        if (!active) return undefined
        var cancelled = false
        load().then(function (next) {
          if (!cancelled && next === undefined) setSteps(null)
        })
        var handle = setInterval(function () {
          var now = Date.now()
          if (now - lastRef.current < pollSeconds * 1000) return
          lastRef.current = now
          load()
        }, 1000)
        return function () {
          cancelled = true
          clearInterval(handle)
        }
      }, [url, pollSeconds, active])

      return [stepsData, load]
    }

    /**
     * Poll the host state route for one session on the configured cadence.
     *
     * Three behaviours the reviewed plan requires (F4 + F5):
     *
     * - **Fingerprint gate**: every reply is compared against the last applied
     *   fingerprint, and an unchanged payload does NOT call `setData` — no new
     *   object ⇒ no re-render of the whole thread tree on a quiet poll.
     * - **Switch keeps the old view**: changing sessions no longer resets to
     *   `EMPTY_STATE`. The previous messages stay on screen under a "switching"
     *   overlay until the new payload lands (no blank flash), and while that
     *   overlay is up the view is marked non-interactive so a click on a stale
     *   thread cannot send a reply whose `replyTo` the new session's state
     *   cannot resolve (the reviewed F5 trap that silently nulls the binding).
     * - The first-ever load still shows the loading state, because there is no
     *   previous session whose content could be meaningfully kept.
     *
     * @returns `[data, setData, reload, switching]` — `reload` forces an
     *   immediate fetch (how a team switch shows up without waiting a tick);
     *   `switching` is true while a session change is awaiting its payload.
     */
    function useTeamState(sessionId, pollSeconds, active) {
      var pair = React.useState(EMPTY_STATE)
      var data = pair[0]
      var setData = pair[1]
      var switchPair = React.useState(false)
      var switching = switchPair[0]
      var setSwitching = switchPair[1]
      var lastRef = React.useRef(0)
      var printRef = React.useRef('')
      var url = sessionId ? STATE_URL + '?sessionId=' + encodeURIComponent(sessionId) : STATE_URL
      var urlRef = React.useRef(url)
      urlRef.current = url

      /**
       * Apply one payload only when it actually differs. Returns whether the
       * state was replaced, which the scroll effect uses to decide follow.
       */
      function apply(next) {
        if (!next || !next.ok) return false
        var print = stateFingerprint(next)
        if (print === printRef.current) return false
        printRef.current = print
        setData(next)
        return true
      }

      function fetchNow() {
        return fetch(urlRef.current, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
          .then(function (response) { return response.json() })
          .then(function (next) {
            apply(next)
            return next
          })
          .catch(function (error) {
            setData(function (previous) {
              return Object.assign({}, previous, { loading: false, error: String((error && error.message) || error) })
            })
            return null
          })
      }

      React.useEffect(function () {
        if (!active) return undefined
        var cancelled = false
        // Session change: KEEP the previous view (F5) and mark it switching,
        // instead of blanking it. The overlay blocks interaction until the new
        // payload arrives, so stale threads can never emit a reply binding the
        // new session cannot resolve.
        var isFirstLoad = printRef.current === ''
        if (isFirstLoad) setData(EMPTY_STATE)
        else setSwitching(true)
        lastRef.current = Date.now()
        fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
          .then(function (response) { return response.json() })
          .then(function (next) {
            if (cancelled) return
            var changed = apply(next)
            setSwitching(false)
            if (!changed && !next.ok) {
              setData(function (previous) {
                return Object.assign({}, previous, { loading: false })
              })
            }
          })
          .catch(function (error) {
            if (cancelled) return
            setSwitching(false)
            setData(function (previous) {
              return Object.assign({}, previous, {
                loading: false,
                // Keep the old view visible AND say why it may not be current.
                error: String((error && error.message) || error),
                switchedButFailed: !isFirstLoad,
              })
            })
          })
        var handle = setInterval(function () {
          var now = Date.now()
          if (now - lastRef.current < pollSeconds * 1000) return
          lastRef.current = now
          fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
            .then(function (response) { return response.json() })
            .then(function (next) {
              if (cancelled) return
              apply(next)
            })
            .catch(function (error) {
              if (cancelled) return
              setData(function (previous) {
                return Object.assign({}, previous, { loading: false, error: String((error && error.message) || error) })
              })
            })
        }, 1000)
        return function () {
          cancelled = true
          clearInterval(handle)
        }
      }, [url, pollSeconds, active])

      return [data, setData, fetchNow, switching]
    }

    function MemberChip(props) {
      var member = props.member
      var meta = roleMeta(member.name)
      var running = member.activity === 'running'
      var role = member.role || (member.configured === false ? '（不在当前团队）' : '')
      var detail = []
      if (member.model) detail.push(member.model)
      if (member.skillCount > 0) detail.push(member.skillCount + ' 技能')
      var title = '角色：' + (member.role || '未配置') + (detail.length > 0 ? '\n' + detail.join(' · ') : '')
      return React.createElement('div', {
        title: title,
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '5px',
          padding: props.compact ? '1px 6px' : '3px 8px',
          borderRadius: '999px',
          background: running ? 'rgba(245,179,1,0.14)' : 'rgba(140,148,160,0.12)',
          border: '1px solid ' + (running ? 'rgba(245,179,1,0.5)' : 'transparent'),
          opacity: member.configured === false ? 0.65 : 1,
        },
      },
        React.createElement('span', {
          style: { width: '7px', height: '7px', borderRadius: '50%', background: running ? '#f5b301' : 'var(--dsw-alias-label-tertiary)' },
        }),
        React.createElement('span', {
          style: { fontWeight: 600, color: meta.color, fontSize: props.compact ? '11px' : '12px' },
        }, member.name),
        props.compact ? null : React.createElement('span', {
          style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px' },
        }, [role, running ? '工作中' : '空闲'].filter(Boolean).join(' · ')),
      )
    }

    /** A quoted excerpt rendered above a reply's body. */
    function QuoteBlock(props) {
      var quote = props.quote
      if (!quote) return null
      var meta = roleMeta(quote.from)
      return React.createElement('div', {
        onClick: props.onJump,
        title: '跳转到原消息',
        style: {
          display: 'flex',
          gap: '6px',
          margin: '4px 0 6px',
          padding: '5px 8px',
          borderLeft: '3px solid ' + meta.color,
          borderRadius: '4px',
          background: 'var(--dsw-alias-bg-layer-2)',
          color: 'var(--dsw-alias-label-secondary)',
          fontSize: '11px',
          cursor: 'pointer',
          lineHeight: 1.45,
        },
      },
        React.createElement('span', { style: { flexShrink: 0, fontWeight: 600 } }, quote.from === 'me' ? '我' : quote.from),
        React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, quote.text),
      )
    }

    /**
     * One message. Role frames apply to chat turns; system / task / incoming
     * entries stay as lightweight rows so the conversation reads as a stream.
     */
    function MessageCard(props) {
      var message = props.msg
      var compact = props.compact
      var meta = roleMeta(message.from)
      var mine = message.from === 'me'

      if (message.kind === 'system') {
        return React.createElement('div', {
          style: { textAlign: 'center', margin: '4px 0', color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px' },
        }, message.text)
      }
      if (message.kind === 'task') {
        return React.createElement('div', {
          style: {
            textAlign: 'center', margin: '8px 0', padding: '6px 8px', borderRadius: '8px',
            background: 'var(--dsw-alias-state-business-tertiary)',
            color: 'var(--dsw-alias-state-business-primary)', fontSize: '12px', fontWeight: 600,
          },
        }, message.text)
      }
      if (message.kind === 'incoming') {
        return React.createElement('div', {
          style: { margin: '3px 0 3px 6px', color: 'var(--dsw-alias-label-secondary)', fontSize: '11px' },
        }, '📨 ' + message.from + ' 收到：' + message.text)
      }

      return React.createElement('div', Object.assign({
        ref: props.cardRef,
        style: {
          borderLeft: '3px solid ' + meta.color,
          borderRadius: '10px',
          padding: compact ? '7px 9px' : '9px 11px',
          margin: compact ? '6px 0' : '9px 0',
          background: mine ? 'var(--dsw-specific-bubble-highlight)' : 'var(--dsw-specific-bubble)',
          color: 'var(--dsw-alias-label-primary)',
          outline: props.highlighted ? '2px solid ' + meta.color : 'none',
          transition: 'outline-color 200ms ease',
        },
      }),
        React.createElement('div', {
          style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '5px' },
        },
          React.createElement('span', { style: { fontSize: '13px' } }, meta.icon),
          React.createElement('span', {
            style: { fontWeight: 700, color: meta.color, fontSize: '12px' },
          }, mine ? '我' : message.from),
          React.createElement('span', {
            style: {
              padding: '0 5px', borderRadius: '4px', fontSize: '10px',
              background: 'var(--dsw-alias-bg-layer-3)', color: meta.color, fontWeight: 600,
            },
          }, meta.label),
          React.createElement('span', {
            style: { marginLeft: 'auto', color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px' },
          }, clockOf(message.time)),
        ),
        React.createElement(QuoteBlock, { quote: message.quote, onJump: props.onJumpQuote }),
        React.createElement('div', {
          style: {
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.55,
            color: 'var(--dsw-alias-label-primary)',
            fontSize: compact ? '12px' : '13px',
          },
        }, message.text),
        React.createElement('div', {
          style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '6px' },
        },
          props.replyCount > 0 ? React.createElement('button', {
            onClick: props.onToggleThread,
            style: {
              border: 'none', background: 'transparent', cursor: 'pointer', color: meta.color,
              fontSize: '11px', fontWeight: props.unread ? 700 : 500, padding: '2px 4px',
            },
          }, (props.expanded ? '▾ ' : '▸ ') + props.replyCount + ' 条回复') : null,
          React.createElement('button', {
            onClick: props.onReply,
            style: {
              border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
              color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', fontSize: '11px', padding: '2px 8px', borderRadius: '6px',
            },
          }, '回复'),
        ),
      )
    }

    /**
     * Memoized card: a long list re-renders only the cards whose props changed,
     * not the whole tree on every poll. With the message window capped at
     * WINDOW_MESSAGES (200, server-side `slice(-200)` in snapshotOf) the list is
     * bounded anyway; memo removes the per-poll churn within that bound. A full
     * virtual list is not worth it at this size: 200 rows re-render in single
     * digit ms on any modern host, while virtualization buys nothing until the
     * window itself grows. The props carried here are all primitives or stable
     * callbacks, so shallow comparison is effective.
     */
    var MemoMessageCard = React.memo(MessageCard)

    function ThreadView(props) {
      var thread = props.thread
      var expanded = props.isExpanded(thread.root.id)
      return React.createElement('div', null,
        React.createElement(MemoMessageCard, {
          msg: thread.root,
          compact: props.compact,
          replyCount: thread.replies.length,
          expanded: expanded,
          unread: props.isUnread(thread),
          highlighted: props.highlightId === thread.root.id,
          onToggleThread: function () { props.onToggle(thread.root.id) },
          onReply: function () { props.onReply(thread.root) },
          onJumpQuote: props.onJumpQuote,
          cardRef: props.registerRef(thread.root.id),
        }),
        thread.replies.length > 0 && expanded
          ? React.createElement('div', {
              style: {
                marginLeft: props.compact ? '10px' : '16px',
                paddingLeft: props.compact ? '8px' : '10px',
                borderLeft: '2px solid var(--dsw-alias-border-l1)',
              },
            },
            thread.replies.map(function (reply) {
              return React.createElement(MemoMessageCard, {
                key: reply.id,
                msg: reply,
                compact: props.compact,
                highlighted: props.highlightId === reply.id,
                onReply: function () { props.onReply(reply) },
                onJumpQuote: props.onJumpQuote,
                cardRef: props.registerRef(reply.id),
              })
            }),
          )
          : null,
      )
    }

    /**
     * Memoized thread: like the card, only rows whose thread actually changed
     * re-render when the poll applies a new payload.
     */
    var MemoThreadView = React.memo(ThreadView)

    /**
     * Visible exit for the "not silent" observability counters (t35 R2):
     * `artifactParseFailures`, `timeouts`, `errorDetailMisses` are surfaced by
     * the host snapshot but were never rendered — a stub. This builds the
     * inline `· ⚠N` fragment for the diagnostics line when any counter is
     * non-zero, and the full breakdown for the hover title.
     */
    function countersOf(data) {
      var out = ''
      var n = 0
      if (typeof data === 'object' && data !== null) {
        if (typeof data.artifactParseFailures === 'number' && data.artifactParseFailures > 0) { out += ' · 产物解析失败 ' + data.artifactParseFailures; n += 1 }
        if (typeof data.errorDetailMisses === 'number' && data.errorDetailMisses > 0) { out += ' · 错误明细丢失 ' + data.errorDetailMisses; n += 1 }
        if (typeof data.timeouts === 'number' && data.timeouts > 0) { out += ' · 超时 ' + data.timeouts; n += 1 }
      }
      return n === 0 ? '' : ' · ⚠ ' + n + ' 项'
    }

    /** Full counter breakdown for the diagnostics hover title. */
    function diagnosticsOf(data) {
      var parts = []
      if (typeof data === 'object' && data !== null) {
        if (typeof data.artifactParseFailures === 'number' && data.artifactParseFailures > 0) parts.push('产物解析失败 ' + data.artifactParseFailures)
        if (typeof data.errorDetailMisses === 'number' && data.errorDetailMisses > 0) parts.push('错误明细丢失 ' + data.errorDetailMisses)
        if (typeof data.timeouts === 'number' && data.timeouts > 0) parts.push('超时 ' + data.timeouts)
      }
      return parts.length > 0 ? '\n' + parts.join('\n') : ''
    }

    /**
     * t44/P0 probe: fold the jump-path availability into the diagnostics line so
     * a deployment can tell WHO is at fault without opening the console:
     *   `ctx:无` — ChatBody never received a client context (the tab wrapper
     *             dropped props.ctx, or the host did not pass one).
     *   `svc:未挂载` — ctx exists but the `sessions` service is truly absent.
     *   `svc:可用`   — both ctx and `sessions` are present; jumps can work.
     * Empty when no probe is possible (defensive), so the line never fabricates.
     */
    function jumpProbeOf(props) {
      var sessionCtx = props && props.sessionCtx
      if (!sessionCtx || typeof sessionCtx.get !== 'function') return ' · ctx:无'
      var sessions = sessionCtx.get('sessions')
      if (sessions === undefined || sessions === null) return ' · svc:未挂载'
      return ' · svc:可用'
    }

    /**
     * The P2b step view: one row per tool call, grouped by step, with the
     * member's process visible as a compact list instead of raw message dumps.
     *
     * Row format (P2a projection): `[角色] step N · 动作(tool) · 产物(path/cmd) ·
     * 结果(ok/error)`; the step's decision sentence renders under a fold toggle.
     *
     * Interactions:
     * - Clicking a row jumps the DSH UI into that member's subagent session
     *   (jumpToSubagent's three degradation levels).
     * - 「评论」 binds a free-text reply to the step and sends it to that member
     *   via the /speak route (same channel as chat replies, so the member sees a
     *   normal @reply).
     * - 「插任务」 routes a task to that member via /task.
     *
     * States: loading → '正在加载步骤…'; empty → '暂无步骤 · 成员尚未工作';
     * error → the actual message; missing fields render '—' (never a fake value).
     */
    function StepsView(props) {
      var stepsData = props.stepsData
      var members = props.members || []
      var onJump = props.onJump
      var onComment = props.onComment
      var onTask = props.onTask
      var activeLane = props.activeLane || ''
      var compact = props.compact
      var folded = props.folded || {}
      var onToggleFold = props.onToggleFold

      // Flatten every member's steps into one ordered list.
      var allSteps = []
      for (var m = 0; m < members.length; m += 1) {
        var memberSteps = (stepsData && stepsData.members) || []
        for (var f = 0; f < memberSteps.length; f += 1) {
          var projected = memberSteps[f]
          if (projected.memberId !== members[m].id) continue
          for (var s = 0; s < (projected.steps || []).length; s += 1) {
            var step = projected.steps[s]
            allSteps.push({
              key: projected.memberId + ':' + step.turn + ':' + step.step + ':' + step.action + ':' + s,
              memberId: projected.memberId,
              memberName: projected.member || members[m].name || step.role || '—',
              step: step,
            })
          }
          break
        }
      }

      if (!stepsData) {
        return React.createElement('div', {
          style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', textAlign: 'center', marginTop: '16px', lineHeight: 1.7 },
        }, '正在加载步骤…')
      }
      if (allSteps.length === 0) {
        return React.createElement('div', {
          style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', textAlign: 'center', marginTop: '16px', lineHeight: 1.7 },
        }, '暂无步骤 · 成员尚未开始工作。')
      }

      // Group rows by (memberId, step) for collapsible sections.
      var groups = []
      var groupIndex = new Map()
      for (var i = 0; i < allSteps.length; i += 1) {
        var item = allSteps[i]
        var gkey = item.memberId + ':' + item.step.turn + ':' + item.step.step
        var existing = groupIndex.get(gkey)
        if (existing !== undefined) {
          existing.rows.push(item)
        } else {
          var group = { key: gkey, memberName: item.memberName, turn: item.step.turn, step: item.step.step, rows: [item] }
          groups.push(group)
          groupIndex.set(gkey, group)
        }
      }

      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        groups.map(function (group) {
          var isFolded = folded[group.key] === true
          return React.createElement('div', {
            key: group.key,
            style: {
              border: '1px solid var(--dsw-alias-border-l1)',
              borderRadius: '8px',
              background: 'var(--dsw-alias-bg-layer-2)',
              padding: '6px 9px',
            },
          },
            React.createElement('button', {
              type: 'button',
              title: isFolded ? '展开本步' : '折叠本步',
              onClick: function () { onToggleFold(group.key) },
              style: {
                display: 'flex', alignItems: 'center', gap: '6px', width: '100%',
                border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
                color: 'var(--dsw-alias-label-primary)',
              },
            },
              React.createElement('span', { style: { fontSize: '10px', color: 'var(--dsw-alias-label-tertiary)' } },
                isFolded ? '▸' : '▾'),
              React.createElement('span', {
                style: { fontWeight: 700, fontSize: '12px' },
              }, '[' + group.memberName + '] step ' + group.step + ' · ' + group.rows.length + ' 动作'),
            ),
            isFolded ? null : React.createElement('div', { style: { marginTop: '5px' } },
              group.rows.map(function (item) {
                var st = item.step
                return React.createElement('div', {
                  key: item.key,
                  style: {
                    display: 'flex', alignItems: 'flex-start', gap: '6px',
                    padding: '3px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)',
                    fontSize: '11px', lineHeight: 1.5,
                    color: 'var(--dsw-alias-label-primary)',
                  },
                },
                  React.createElement('span', { style: { flexShrink: 0, color: 'var(--dsw-alias-label-tertiary)' } },
                    'step ' + st.step + ' ·'),
                  React.createElement('span', { style: { flexShrink: 0, fontWeight: 600 } }, st.action || '—'),
                  React.createElement('span', {
                    style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-secondary)' },
                    title: String(st.artifact || '—'),
                  }, st.artifact || '—'),
                  React.createElement('span', {
                    style: {
                      flexShrink: 0, fontWeight: 600,
                      color: st.result === 'error' || String(st.result || '').startsWith('error')
                        ? 'var(--dsw-alias-state-error-primary)'
                        : 'var(--dsw-alias-state-success-primary)',
                    },
                  }, st.result || '—'),
                  // Per-row actions: jump into that member's session, comment on
                  // the step, or insert a task for that member.
                  React.createElement('span', { style: { display: 'flex', gap: '4px', flexShrink: 0 } },
                    React.createElement('button', {
                      type: 'button',
                      title: '进入 ' + item.memberName + ' 的会话',
                      onClick: function () { onJump(item.memberId, st) },
                      style: rowActionStyle(),
                    }, '进入'),
                    React.createElement('button', {
                      type: 'button',
                      title: '评论这一步',
                      onClick: function () { onComment(item.memberId, st) },
                      style: rowActionStyle(),
                    }, '评论'),
                    React.createElement('button', {
                      type: 'button',
                      title: '给 ' + item.memberName + ' 插入任务',
                      onClick: function () { onTask(item.memberId, st) },
                      style: rowActionStyle(),
                    }, '插任务'),
                  ),
                )
              }),
              !isFolded && group.rows.length > 0 && group.rows[0].step.decision
                ? React.createElement('div', {
                    style: {
                      marginTop: '5px', padding: '4px 6px', borderRadius: '5px', fontSize: '11px',
                      background: 'var(--dsw-alias-bg-layer-3)',
                      color: 'var(--dsw-alias-label-secondary)',
                    },
                  }, '💡 ' + group.rows[0].step.decision)
                : null,
            ),
          )
        }),
      )
    }

    function rowActionStyle() {
      return {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer', fontSize: '10px', padding: '1px 6px', borderRadius: '5px',
      }
    }

    function ChatBody(props) {
      var config = props.config
      var sessionId = props.sessionId
      var sessionCtx = props.sessionCtx
      var pair = useTeamState(sessionId, config.pollSeconds, props.active !== false)
      var data = pair[0]
      var reload = pair[2]
      var switching = pair[3]
      var stepsPair = useSteps(sessionId, config.pollSeconds, props.active !== false)
      var stepsData = stepsPair[0]
      var reloadSteps = stepsPair[1]
      // P2b: 步骤视图（默认） ⇄ 详细发言流（开启后切换）
      var detailPair = React.useState(false)
      var showDetail = detailPair[0]
      var setShowDetail = detailPair[1]
      // 步骤分组折叠态 key → boolean
      var foldPair = React.useState({})
      var folded = foldPair[0]
      var setFolded = foldPair[1]
      // 步骤评论：选中的 (memberId, step)，在下方输入框绑定
      var stepCommentPair = React.useState(null)
      var stepComment = stepCommentPair[0]
      var setStepComment = stepCommentPair[1]
      var textPair = React.useState('')
      var text = textPair[0]
      var setText = textPair[1]
      var targetPair = React.useState('all')
      var target = targetPair[0]
      var setTarget = targetPair[1]
      var noticePair = React.useState('')
      var notice = noticePair[0]
      var setNotice = noticePair[1]
      var quotingPair = React.useState(null)
      var quoting = quotingPair[0]
      var setQuoting = quotingPair[1]
      var expandedPair = React.useState({})
      var expanded = expandedPair[0]
      var setExpanded = expandedPair[1]
      var highlightPair = React.useState(null)
      var highlightId = highlightPair[0]
      var setHighlightId = highlightPair[1]
      var scrollRef = React.useRef(null)
      var itemRefs = React.useRef({})
      var seenRef = React.useRef({})
      /** Whether the viewport sat within NEAR_BOTTOM_PX at the last scroll. */
      var atBottomRef = React.useRef(true)
      /** The thread tail the last auto-follow ran for, so it fires once per append. */
      var followedRef = React.useRef('')

      /**
       * Track whether the reader is at the bottom. Read on scroll (cheap) and
       * also just before an auto-follow decision, so a programmatic scroll can
       * never desync the flag for long.
       */
      function readAtBottom() {
        var node = scrollRef.current
        if (!node) return true
        var distance = node.scrollHeight - node.scrollTop - node.clientHeight
        return distance <= NEAR_BOTTOM_PX
      }

      /**
       * Auto-follow only when BOTH hold: the message tail actually grew, and the
       * reader was already at the bottom. A user scrolled up is never yanked
       * back — that was the every-3s jump this replaces.
       */
      React.useEffect(function () {
        var node = scrollRef.current
        if (!node) return
        var threads = data.threads || []
        var tail = threads.length === 0
          ? ''
          : String((threads[threads.length - 1].root || {}).id || '') + ':' + threads.length
        if (tail === followedRef.current) return
        var grew = followedRef.current !== ''
        followedRef.current = tail
        // First paint for this view always lands at the bottom; afterwards the
        // reader's position decides.
        if (!grew || atBottomRef.current) {
          node.scrollTop = node.scrollHeight
          atBottomRef.current = true
        }
      }, [data.threads])

      function flash(message) {
        setNotice(message)
        setTimeout(function () { setNotice('') }, 3000)
      }

      function registerRef(id) {
        return function (node) {
          if (node) itemRefs.current[id] = node
          else delete itemRefs.current[id]
        }
      }

      function jumpTo(id) {
        var node = itemRefs.current[id]
        if (node && typeof node.scrollIntoView === 'function') {
          node.scrollIntoView({ block: 'center', behavior: 'smooth' })
        }
        setHighlightId(id)
        setTimeout(function () { setHighlightId(null) }, 1200)
      }

      function toggleThread(rootId) {
        setExpanded(function (previous) {
          var next = Object.assign({}, previous)
          if (next[rootId]) delete next[rootId]
          else next[rootId] = true
          return next
        })
      }

      function isExpanded(rootId) {
        return expanded[rootId] === true
      }

      function isUnread(thread) {
        if (isExpanded(thread.root.id)) return false
        return thread.replies.length > (seenRef.current[thread.root.id] || 0)
      }

      // Keep the "seen" watermark in step with what is actually on screen.
      React.useEffect(function () {
        data.threads.forEach(function (thread) {
          if (expanded[thread.root.id]) seenRef.current[thread.root.id] = thread.replies.length
        })
      }, [data.threads, expanded])

      /**
       * Relay progress into the IM conversation.
       *
       * The captain's replies only reach IM when they answer an incoming IM
       * message, and member-report wakeups answer nothing — so progress has to be
       * pushed. The IM plugin's proactive endpoint sits behind the deployment's
       * browser auth, which THIS half holds and the host half cannot reach.
       * Forwarding is opt-in (`imPush`) and only ever carries short status rows.
       */
      var relayRef = React.useRef({ primed: false, sent: {} })
      React.useEffect(function () {
        if (typeof fetch !== 'function') return
        if (data.imPush !== true || !data.im || !data.im.botId || !data.im.targetId) return
        var relay = relayRef.current
        var entries = []
        data.threads.forEach(function (thread) {
          ;[thread.root].concat(thread.replies).forEach(function (message) {
            if (relay.sent[message.id] === true) return
            relay.sent[message.id] = true
            // The first payload is the panel's whole backlog: mark it seen,
            // never replay it into a chat.
            if (relay.primed && (message.kind === 'system' || message.kind === 'task')) entries.push(message.text)
          })
        })
        relay.primed = true
        if (entries.length === 0) return
        var body = '【团队进度】\n' + entries.slice(0, 5).join('\n')
        fetch('/api/dsh-im/delivery/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ botId: data.im.botId, targetId: data.im.targetId, text: body }),
        })
          .then(function (response) {
            return response.text().then(function (raw) {
              try {
                return JSON.parse(raw)
              } catch {
                return { raw: raw.slice(0, 120), status: response.status }
              }
            })
          })
          .then(function (result) {
            if (result && result.error) flash('IM 投递失败：' + (result.error.code || 'unknown'))
            else if (result && result.raw) flash('IM 投递被拒：' + result.raw + ' (' + result.status + ')')
          })
          .catch(function (error) { flash('IM 投递异常：' + String((error && error.message) || error)) })
      }, [data])

      function toggleStepFold(groupKey) {
        setFolded(function (previous) {
          var next = Object.assign({}, previous)
          if (next[groupKey]) delete next[groupKey]
          else next[groupKey] = true
          return next
        })
      }

      /**
       * Jump the DSH main view into a member's subagent session (P2b).
       * Never throws: `jumpToSubagent` hides all three degradation paths.
       */
      function jumpToMemberSession(memberId, step) {
        var result = jumpToSubagent(sessionCtx, memberId)
        if (result.ok) {
          flash('已切入 ' + (step ? 'step ' + step.step + ' · ' + step.action : memberId.slice(0, 8)) + ' 的会话')
          // Wait for the switch then reload both feeds for the new session.
          setTimeout(function () {
            reload()
            reloadSteps()
          }, 600)
          return
        }
        if (result.reason === 'no-address') {
          // The member is not a healthy catalog child — offer a copy fallback.
          flash('未找到该成员的可跳转地址（可能已离开团队）')
          // t39/B: report the REAL copy outcome. The old code flashed success
          // unconditionally (it ignored the promise), so a failed copy told the
          // user the id was on the clipboard when it was not.
          copyText(memberId).then(function (copied) {
            flash(copied
              ? '已复制会话 ID：' + memberId.slice(0, 8) + '…'
              : '复制失败（剪贴板不可用）· 会话 ID：' + memberId)
          })
          return
        }
        // t44/P0: state the ACTUAL cause. 'no-ctx' is our defect (the tab
        // wrapper dropped props.ctx) — the message must point at us, not at the
        // platform. Only 'no-service' may say the service is missing.
        var causeText = result.reason === 'no-service'
          ? '（sessions 服务未挂载）'
          : result.reason === 'no-ctx'
            ? '（上下文未就绪）'
            : ''
        flash('无法切入该会话' + causeText + '，已展示步骤详情')
      }

      /** Bind a comment to a step, then focus the composer on that member. */
      function commentOnStep(memberId, step) {
        setStepComment({ memberId: memberId, step: step })
        setTarget(memberNameOfId(memberId) || 'all')
        flash('正在回复 ' + (memberNameOfId(memberId) || memberId.slice(0, 8)) + ' · step ' + step.step)
      }

      /** Route a fresh task to a specific member (P2b 「插任务」). */
      function taskForMember(memberId, step) {
        postJson(TASK_URL, { subject: '（跟进 step ' + step.step + ' ' + (step.action || '') + '）请在步骤视图内协查进展', sessionId: sessionId, target: memberNameOfId(memberId) })
          .then(function (result) {
            flash(result && result.ok ? '已派任务，送达 ' + result.delivered + ' 名成员' : '派任务失败：' + ((result && result.error) || 'unknown'))
          })
          .catch(function (error) { flash('派任务异常：' + String((error && error.message) || error)) })
      }

      /** Resolve a member's display name from its id (roster order). */
      function memberNameOfId(memberId) {
        for (var i = 0; i < data.members.length; i += 1) {
          if (data.members[i].id === memberId) return data.members[i].name
        }
        return undefined
      }

      function send(mode) {
        // F5 guard: while a session switch is awaiting its payload the visible
        // threads belong to the PREVIOUS session. Sending a reply now would
        // carry a `replyTo` the new session cannot resolve, silently degrading
        // a reply into a plain message. Block until the payload lands.
        if (switching) {
          flash('正在切换会话…请稍候再发言')
          return
        }
        var message = text.trim()
        if (message === '') return
        var quoted = quoting
        setText('')
        setQuoting(null)
        var request
        if (mode === 'task') {
          request = postJson(TASK_URL, { subject: message, sessionId: sessionId }).then(function (result) {
            flash(result && result.ok ? '已广播任务，送达 ' + result.delivered + ' 名成员' : '广播失败：' + ((result && result.error) || 'unknown'))
          })
        } else {
          request = postJson(SPEAK_URL, {
            text: message,
            target: target,
            sessionId: sessionId,
            replyTo: quoted ? quoted.id : undefined,
            rootId: quoted ? (quoted.rootId || quoted.id) : undefined,
          }).then(function (result) {
            flash(result && result.ok ? '已送达 ' + result.delivered + ' 名成员' : '发送失败：' + ((result && result.error) || 'unknown'))
          })
        }
        request.catch(function (error) { flash('调用失败：' + String((error && error.message) || error)) })
      }

      var threads = data.threads.filter(function (thread) {
        if (config.showIncoming) return true
        return thread.root.kind !== 'incoming' && thread.replies.every(function (reply) { return reply.kind !== 'incoming' })
      })
      var names = data.members.map(function (member) { return member.name })
      var teams = Array.isArray(data.teams) ? data.teams : []
      var activeTeamId = data.activeTeam ? data.activeTeam.id : ''

      function switchTeam(teamId) {
        postJson(BASE + '/team', { sessionId: sessionId, teamId: teamId })
          .then(function (result) {
            if (result && result.ok) {
              flash('已切换到「' + result.activeTeam.name + '」（本会话）')
              return reload()
            }
            flash('切换失败：' + ((result && result.error) || 'unknown'))
            return null
          })
          .catch(function (error) { flash('切换失败：' + String((error && error.message) || error)) })
      }

      return React.createElement('div', {
        style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: '200px', height: '100%' },
      },
        teams.length > 0 ? React.createElement('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px',
            borderBottom: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-specific-sidebar-fill)',
          },
        },
          React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px', flexShrink: 0 } }, '团队'),
          React.createElement('select', {
            value: activeTeamId,
            onChange: function (event) { switchTeam(event.target.value) },
            title: '切换本会话使用的团队模板',
            style: {
              flex: 1, padding: '3px 6px', borderRadius: '6px', fontSize: '12px',
              border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-specific-selector)',
              color: 'var(--dsw-alias-label-primary)',
            },
          }, teams.map(function (team) {
            return React.createElement('option', { key: team.id, value: team.id },
              team.name + (team.id === data.defaultTeamId ? '（默认）' : '') + ' · ' + team.memberCount + ' 人')
          })),
        ) : null,
        React.createElement('div', {
          style: {
            display: 'flex', flexWrap: 'wrap', gap: '5px', padding: '8px 12px',
            borderBottom: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-specific-sidebar-fill)',
          },
        },
          data.members.map(function (member) {
            return React.createElement(MemberChip, { key: member.id, member: member, compact: config.compact })
          }),
          !data.hasTeam ? React.createElement('span', {
            style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' },
          }, '未发现团队成员') : null,
          React.createElement('span', {
            title: '诊断：渲染模式 / 会话 / 成员数' + diagnosticsOf(data),
            style: { marginLeft: 'auto', color: 'var(--dsw-alias-label-tertiary)', fontSize: '10px', whiteSpace: 'nowrap' },
          }, (props.mode || 'tab') + ' · ' + (sessionId ? String(sessionId).slice(0, 8) : 'no-session')
            + ' · ' + data.members.length + ' 成员'
            + jumpProbeOf(props)
            + (data.error ? ' · 有错误' : '')
            + countersOf(data)
            + (data.switchedButFailed ? ' · 切换失败' : '')),
        ),
        React.createElement('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 12px',
            borderBottom: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-specific-sidebar-fill)',
          },
        },
          React.createElement('span', {
            style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', fontWeight: 600 },
          }, '视图'),
          React.createElement('button', {
            type: 'button',
            title: '步骤视图：每个成员跑过的工具调用，一行一步',
            onClick: function () { setShowDetail(false) },
            style: {
              border: '1px solid ' + (showDetail ? 'var(--dsw-alias-border-l1)' : 'var(--dsw-alias-border-l2)'),
              borderRadius: '999px', padding: '2px 10px', fontSize: '11px', cursor: 'pointer',
              background: showDetail ? 'transparent' : 'var(--dsw-alias-bg-layer-2)',
              color: showDetail ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-primary)',
              fontWeight: showDetail ? 400 : 700,
            },
          }, '步骤'),
          React.createElement('button', {
            type: 'button',
            title: '详细视图：完整发言流（来自事件缓冲，不轮询）',
            onClick: function () { setShowDetail(true) },
            style: {
              border: '1px solid ' + (showDetail ? 'var(--dsw-alias-border-l2)' : 'var(--dsw-alias-border-l1)'),
              borderRadius: '999px', padding: '2px 10px', fontSize: '11px', cursor: 'pointer',
              background: showDetail ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
              color: showDetail ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
              fontWeight: showDetail ? 700 : 400,
            },
          }, '详细'),
        ),
        React.createElement('div', {
          ref: scrollRef,
          onScroll: function () { atBottomRef.current = readAtBottom() },
          style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 12px', position: 'relative' },
        },
          showDetail // 详细 = 完整发言流（threads）；默认 = 步骤视图
            ? React.createElement(React.Fragment, null,
                threads.length === 0 ? React.createElement('div', {
                  style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', textAlign: 'center', marginTop: '16px', lineHeight: 1.7 },
                }, data.loading === true
                  ? '正在加载团队…'
                  : '群聊已连接 · 成员发言会实时流入。\n在下方发言或派任务即可唤醒他们。') : null,
                threads.map(function (thread) {
                  return React.createElement(MemoThreadView, {
                    key: thread.root.id,
                    thread: thread,
                    compact: config.compact,
                    expanded: expanded,
                    isExpanded: isExpanded,
                    isUnread: isUnread,
                    highlightId: highlightId,
                    onToggle: toggleThread,
                    onReply: function (message) {
                      // F5 guard (same reason as send): a quote minted from a stale
                      // thread would bind a replyTo the new session cannot resolve.
                      if (switching) { flash('正在切换会话…请稍候再回复'); return }
                      setQuoting(message)
                    },
                    onJumpQuote: jumpTo,
                    registerRef: registerRef,
                  })
                }),
              )
            : React.createElement(StepsView, {
                stepsData: stepsData,
                members: data.members,
                compact: config.compact,
                folded: folded,
                onToggleFold: toggleStepFold,
                onJump: jumpToMemberSession,
                onComment: commentOnStep,
                onTask: taskForMember,
              }),
          data.error && showDetail ? React.createElement('div', {
            style: { marginTop: '8px', color: 'var(--dsw-alias-state-error-primary)', fontSize: '11px', fontFamily: 'monospace', wordBreak: 'break-all' },
          }, data.error) : null,
          switching ? React.createElement('div', {
            title: '正在切换会话…',
            style: {
              position: 'sticky', bottom: '8px', margin: '0 auto', display: 'table',
              padding: '4px 12px', borderRadius: '999px', fontSize: '11px',
              background: 'var(--dsw-alias-bg-layer-2)',
              color: 'var(--dsw-alias-label-secondary)',
              border: '1px solid var(--dsw-alias-border-l1)',
              boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
              pointerEvents: 'none',
            },
          }, '⏳ 切换中…') : null,
        ),
        React.createElement('div', {
          style: { borderTop: '1px solid var(--dsw-alias-border-l1)', padding: '10px 12px' },
        },
          React.createElement('div', { style: { display: 'flex', gap: '8px', marginBottom: '8px' } },
            React.createElement('select', {
              value: target,
              onChange: function (event) { setTarget(event.target.value) },
              style: {
                flex: 1, padding: '6px 8px', borderRadius: '8px',
                border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-specific-selector)',
                color: 'var(--dsw-alias-label-primary)',
              },
            },
              React.createElement('option', { value: 'all' }, '💬 全员'),
              names.map(function (name) {
                return React.createElement('option', { key: name, value: name }, '@' + name)
              }),
            ),
            React.createElement('button', {
              onClick: function () { send('task') },
              style: {
                border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px',
                padding: '6px 10px', cursor: 'pointer', background: 'transparent',
                color: 'var(--dsw-alias-label-primary)',
              },
            }, '📋 派任务'),
          ),
          quoting ? React.createElement('div', {
            style: {
              display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px',
              padding: '5px 8px', borderRadius: '8px', background: 'var(--dsw-alias-bg-layer-3)',
              borderLeft: '3px solid ' + roleMeta(quoting.from).color, fontSize: '11px',
              color: 'var(--dsw-alias-label-secondary)',
            },
          },
            React.createElement('span', { style: { fontWeight: 600, flexShrink: 0 } },
              '↩ 回复 ' + (quoting.from === 'me' ? '我' : quoting.from) + '：'),
            React.createElement('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              quoting.text),
            React.createElement('button', {
              onClick: function () { setQuoting(null) },
              title: '取消引用',
              style: { border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', fontSize: '12px' },
            }, '✕'),
          ) : null,
          React.createElement('div', { style: { display: 'flex', gap: '8px' } },
            React.createElement('input', {
              value: text,
              onChange: function (event) { setText(event.target.value) },
              onKeyDown: function (event) { if (event.key === 'Enter') send('chat') },
              placeholder: stepComment
                ? '评论 ' + (memberNameOfId(stepComment.memberId) || stepComment.memberId.slice(0, 8)) + ' 的 step ' + stepComment.step.step + '… 回车发送'
                : quoting ? '回复该消息… 回车发送' : '在群里说点什么… 回车发送',
              style: {
                flex: 1, padding: '8px 10px', borderRadius: '8px',
                border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-specific-input-major)',
                color: 'var(--dsw-alias-label-primary)',
              },
            }),
            React.createElement('button', {
              onClick: function () { send('chat') },
              style: {
                border: 'none', borderRadius: '8px', padding: '8px 16px', cursor: 'pointer',
                background: 'var(--dsw-alias-button-primary-fill)',
                color: 'var(--dsw-alias-label-primary)', fontWeight: 600,
              },
            }, '发送'),
          ),
          stepComment ? React.createElement('div', {
            style: {
              display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px',
              padding: '4px 8px', borderRadius: '8px', fontSize: '11px',
              background: 'var(--dsw-alias-bg-layer-3)',
              color: 'var(--dsw-alias-label-secondary)',
            },
          },
            React.createElement('span', { style: { fontWeight: 600, flexShrink: 0 } },
              '💬 评论 ' + (memberNameOfId(stepComment.memberId) || stepComment.memberId.slice(0, 8)) + ' · step ' + stepComment.step.step + ' · ' + (stepComment.step.action || '—')),
            React.createElement('button', {
              onClick: function () { setStepComment(null) },
              title: '取消评论绑定',
              style: { border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', fontSize: '12px', marginLeft: 'auto' },
            }, '✕'),
          ) : null,
          notice ? React.createElement('div', {
            style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px', marginTop: '6px' },
          }, notice) : null,
        ),
      )
    }

    /** Shared styles for the settings page. */
    var ui = {
      label: { display: 'flex', flexDirection: 'column', gap: '3px', marginBottom: '8px' },
      labelText: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
      input: {
        padding: '5px 8px', borderRadius: '6px', fontSize: '12px',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
      },
      area: {
        padding: '5px 8px', borderRadius: '6px', fontSize: '12px', fontFamily: 'inherit', resize: 'vertical',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '10px',
        padding: '10px 12px', marginBottom: '10px',
      },
      btn: {
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-specific-selector)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '6px', padding: '3px 9px', cursor: 'pointer', fontSize: '11px',
      },
      btnPrimary: {
        border: 'none', background: 'var(--dsw-alias-button-primary-fill)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '6px', padding: '5px 12px', cursor: 'pointer', fontSize: '12px', fontWeight: 600,
      },
      badge: {
        padding: '0 6px', borderRadius: '4px', fontSize: '10px', fontWeight: 600,
        background: 'var(--dsw-alias-state-business-tertiary)', color: 'var(--dsw-alias-state-business-primary)',
      },
      mono: {
        margin: '8px 0 0', padding: '8px', borderRadius: '6px', fontSize: '11px', lineHeight: 1.6,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        background: 'var(--dsw-alias-markdown-code-block)', color: 'var(--dsw-alias-label-primary)',
      },
    }

    function TextField(props) {
      return React.createElement('label', { style: ui.label },
        React.createElement('span', { style: ui.labelText }, props.label),
        React.createElement('input', {
          value: props.value || '',
          placeholder: props.placeholder || '',
          onChange: function (event) { props.onChange(event.target.value) },
          style: ui.input,
        }),
      )
    }

    function AreaField(props) {
      return React.createElement('label', { style: ui.label },
        React.createElement('span', { style: ui.labelText }, props.label),
        React.createElement('textarea', {
          value: props.value || '',
          placeholder: props.placeholder || '',
          rows: props.rows || 3,
          onChange: function (event) { props.onChange(event.target.value) },
          style: ui.area,
        }),
      )
    }

    /** A comma-separated list field backed by a string array. */
    function ListField(props) {
      return React.createElement('label', { style: ui.label },
        React.createElement('span', { style: ui.labelText }, props.label + '（逗号分隔）'),
        React.createElement('input', {
          value: (props.values || []).join(', '),
          placeholder: props.placeholder || '',
          onChange: function (event) {
            props.onChange(event.target.value.split(/[,，]/).map(function (part) { return part.trim() }).filter(Boolean))
          },
          style: ui.input,
        }),
      )
    }

    /** One editable member inside a team template. */
    function MemberEditor(props) {
      var member = props.member
      var openPair = React.useState(false)
      var open = openPair[0]
      var setOpen = openPair[1]
      var previewPair = React.useState('')
      var preview = previewPair[0]
      var setPreview = previewPair[1]
      var patch = props.onPatch

      if (!open) {
        return React.createElement('div', {
          style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
        },
          React.createElement('span', { style: { fontWeight: 600, fontSize: '12px' } }, member.name || '(未命名)'),
          React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px' } }, member.role || ''),
          member.skills && member.skills.length > 0 ? React.createElement('span', { style: ui.badge }, member.skills.length + ' 技能') : null,
          React.createElement('button', { style: Object.assign({}, ui.btn, { marginLeft: 'auto' }), onClick: function () { setOpen(true) } }, '编辑'),
          React.createElement('button', { style: ui.btn, onClick: props.onRemove }, '删除'),
        )
      }

      return React.createElement('div', { style: ui.card },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' } },
          React.createElement('span', { style: { fontWeight: 700, fontSize: '12px' } }, member.name || '(未命名)'),
          React.createElement('button', { style: Object.assign({}, ui.btn, { marginLeft: 'auto' }), onClick: function () { setOpen(false) } }, '收起'),
        ),
        React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 10px' } },
          TextField({ label: '成员名（小写字母/数字/-_）', value: member.name, onChange: function (v) { patch({ name: v }) } }),
          TextField({ label: '角色', value: member.role, placeholder: '研究员', onChange: function (v) { patch({ role: v }) } }),
          TextField({ label: 'provider（可空）', value: member.provider, onChange: function (v) { patch({ provider: v }) } }),
          TextField({ label: 'model（可空）', value: member.model, onChange: function (v) { patch({ model: v }) } }),
          TextField({ label: '推理强度（可空）', value: member.reasoningEffort, placeholder: 'high', onChange: function (v) { patch({ reasoningEffort: v }) } }),
          TextField({ label: '记忆', value: member.memory, placeholder: 'bank:team-x / 开工前查、收工后写', onChange: function (v) { patch({ memory: v }) } }),
        ),
        ListField({ label: 'Skills', values: member.skills, placeholder: 'understand, code-review', onChange: function (v) { patch({ skills: v }) } }),
        ListField({ label: 'MCP', values: member.mcp, placeholder: 'postgres, openalex', onChange: function (v) { patch({ mcp: v }) } }),
        ListField({ label: '依赖插件', values: member.plugins, placeholder: 'dsh-better-sidebar', onChange: function (v) { patch({ plugins: v }) } }),
        AreaField({ label: 'Soul（角色人格 / 行事风格）', value: member.soul, rows: 2, onChange: function (v) { patch({ soul: v }) } }),
        AreaField({ label: '执行指引（原样追加）', value: member.executionPrompt, rows: 2, onChange: function (v) { patch({ executionPrompt: v }) } }),
        React.createElement('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '4px' } },
          React.createElement('button', {
            style: ui.btn,
            onClick: function () {
              postJson(SETTINGS_URL, { previewMember: member }).then(function (result) {
                setPreview((result && result.preview) || '（该成员没有任何配置内容）')
              }).catch(function (error) { setPreview('预览失败：' + String((error && error.message) || error)) })
            },
          }, '预览将写入 persona 的执行指引'),
          React.createElement('button', {
            style: Object.assign({}, ui.btn, { marginLeft: 'auto' }),
            onClick: props.onRemove,
          }, '删除成员'),
        ),
        preview ? React.createElement('pre', { style: ui.mono }, preview) : null,
      )
    }

    /** One editable team template. */
    function TeamEditor(props) {
      var team = props.team
      var patchTeam = props.onPatchTeam
      var patchMember = props.onPatchMember
      return React.createElement('div', { style: { marginTop: '8px' } },
        React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '0 10px' } },
          TextField({ label: '团队显示名', value: team.name, onChange: function (v) { patchTeam({ name: v }) } }),
          TextField({ label: '描述', value: team.description, onChange: function (v) { patchTeam({ description: v }) } }),
        ),
        React.createElement('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', margin: '2px 0 6px' } },
          '团队 id：' + team.id + '（成员名与 id 仅限小写字母、数字、- 和 _）'),
        team.members.map(function (member, index) {
          return React.createElement(MemberEditor, {
            key: index,
            member: member,
            onPatch: function (patch) { patchMember(index, patch) },
            onRemove: function () { props.onRemoveMember(index) },
          })
        }),
        React.createElement('button', {
          style: ui.btn,
          onClick: function () {
            patchTeam({ members: team.members.concat([{ name: 'member' + (team.members.length + 1), role: '', provider: '', model: '', reasoningEffort: '', soul: '', skills: [], plugins: [], mcp: [], memory: '', executionPrompt: '' }]) })
          },
        }, '＋ 添加成员'),
      )
    }

    /**
     * Every switch the settings page renders. Kept in one place because the
     * initial state and every reload must agree — a key missing here renders a
     * checkbox that silently never changes.
     */
    var SWITCH_KEYS = ['enabled', 'autoCreateTeam', 'autoApproveTeam', 'imProgress', 'imPush']

    /**
     * Map a settings payload onto checkbox state.
     * `imPush` is opt-in (it sends real messages); everything else defaults on.
     * @param settings - the resolved settings section (or any partial object).
     * @returns one boolean per key in {@link SWITCH_KEYS}.
     */
    function switchStateOf(settings) {
      var source = settings || {}
      var next = {}
      SWITCH_KEYS.forEach(function (key) {
        next[key] = key === 'imPush' ? source[key] === true : source[key] !== false
      })
      return next
    }

    /**
     * The `team-chat` settings page: the switches, the team-template library,
     * and the per-member editor. Edits live in a local draft until saved.
     */
    function SettingsPage() {
      var statusPair = React.useState({ loading: true, error: null, notice: '', saving: false, errors: [] })
      var status = statusPair[0]
      var setStatus = statusPair[1]
      var switchesPair = React.useState(switchStateOf({}))
      var switches = switchesPair[0]
      var setSwitches = switchesPair[1]
      var draftPair = React.useState(null)
      var draft = draftPair[0]
      var setDraft = draftPair[1]
      var openPair = React.useState('')
      var openTeamId = openPair[0]
      var setOpenTeamId = openPair[1]
      var nextIdRef = React.useRef(1)

      function adopt(settings) {
        setSwitches(switchStateOf(settings))
        setDraft({
          teams: JSON.parse(JSON.stringify(settings.teams || [])),
          defaultTeamId: settings.defaultTeamId || '',
        })
      }

      function load() {
        fetch(SETTINGS_URL, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
          .then(function (response) { return response.json() })
          .then(function (result) {
            if (result && result.ok) {
              adopt(result.settings)
              setStatus({ loading: false, error: null, notice: '', saving: false, errors: result.settings.errors || [] })
            } else {
              setStatus({ loading: false, error: (result && result.error) || 'load failed', notice: '', saving: false, errors: [] })
            }
          })
          .catch(function (error) {
            setStatus({ loading: false, error: String((error && error.message) || error), notice: '', saving: false, errors: [] })
          })
      }

      React.useEffect(function () { load() }, [])

      function applySwitch(key, value) {
        postJson(SETTINGS_URL, { [key]: value })
          .then(function (result) {
            if (result && result.ok) {
              adopt(result.settings)
              setStatus(function (previous) { return Object.assign({}, previous, { notice: '已保存', error: null }) })
            } else {
              setStatus(function (previous) { return Object.assign({}, previous, { notice: '', error: (result && result.error) || 'save failed' }) })
            }
          })
          .catch(function (error) {
            setStatus(function (previous) { return Object.assign({}, previous, { error: String((error && error.message) || error) }) })
          })
      }

      function save() {
        if (draft === null) return
        setStatus(function (previous) { return Object.assign({}, previous, { saving: true, notice: '', error: null }) })
        postJson(SETTINGS_URL, { teams: draft.teams, defaultTeamId: draft.defaultTeamId })
          .then(function (result) {
            if (result && result.ok) {
              adopt(result.settings)
              const errors = (result.settings && result.settings.errors) || []
              setStatus({ loading: false, error: null, notice: errors.length > 0 ? '已保存（部分条目被修正）' : '已保存', saving: false, errors })
            } else {
              setStatus(function (previous) { return Object.assign({}, previous, { saving: false, error: (result && result.error) || 'save failed' }) })
            }
          })
          .catch(function (error) {
            setStatus(function (previous) { return Object.assign({}, previous, { saving: false, error: String((error && error.message) || error) }) })
          })
      }

      function updateDraft(transform) {
        setDraft(function (previous) {
          if (previous === null) return previous
          return transform({ teams: previous.teams, defaultTeamId: previous.defaultTeamId })
        })
      }

      function patchTeam(index, patch) {
        updateDraft(function (previous) {
          const teams = previous.teams.slice()
          teams[index] = Object.assign({}, teams[index], patch)
          return { teams, defaultTeamId: previous.defaultTeamId }
        })
      }

      function switchRow(key, title, desc) {
        return React.createElement('label', {
          key: key,
          style: { display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '10px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)', cursor: 'pointer' },
        },
          React.createElement('input', {
            type: 'checkbox', checked: switches[key] === true,
            onChange: function (event) { applySwitch(key, event.target.checked) },
            style: { marginTop: '2px' },
          }),
          React.createElement('span', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
            React.createElement('span', { style: { fontWeight: 600 } }, title),
            React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: 1.5 } }, desc),
          ),
        )
      }

      var teams = draft === null ? [] : draft.teams

      return React.createElement('div', { style: { padding: '4px 2px', fontSize: '13px', color: 'var(--dsw-alias-label-primary)' } },
        React.createElement('h3', { style: { margin: '0 0 4px' } }, '团队群聊'),
        React.createElement('p', { style: { margin: '0 0 10px', color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: 1.6 } },
          '启用后新会话的任务优先交给所选团队处理。每个成员的配置会渲染成该成员的 executionPrompt —— 这是 AgentTeams 唯一注入成员 persona 的通道，因此属于「指引级」配置（模型须遵守），而非工具级硬隔离。'),

        status.loading ? React.createElement('div', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '加载中…') : null,
        status.error ? React.createElement('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' } }, status.error) : null,

        React.createElement('div', null,
          switchRow('enabled', '启用团队功能', '关闭后新会话不再自动路由到团队，群聊侧栏仍可查看已有团队。'),
          switchRow('autoCreateTeam', '新会话自动建立团队', '会话内还没有团队时，授权队长按所选团队的成员名册自动建队。'),
          switchRow('autoApproveTeam', '建队免审批', '自动建队时使用 approval="automatic"，不再弹出计划审批。'),
          switchRow('imProgress', 'IM 会话播报团队进度', '当会话来自 IM（飞书/企业微信等）时，要求队长把成员进度写进回复，由 IM 插件的会话同步转发到聊天。'),
          switchRow('imPush', '主动推送团队进度到 IM', '由浏览器侧把成员开工/空闲、任务创建与完成等简短进度直接投递到该 IM 会话（成员汇报唤醒的轮次不会被 IM 插件自动转发，因此需要主动推送）。'),
        ),

        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', margin: '16px 0 8px' } },
          React.createElement('h4', { style: { margin: 0 } }, '团队模板'),
          React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px' } }, '共 ' + teams.length + ' 个'),
          React.createElement('button', {
            style: Object.assign({}, ui.btn, { marginLeft: 'auto' }),
            onClick: function () {
              updateDraft(function (previous) {
                const id = 'team' + nextIdRef.current++
                return {
                  teams: previous.teams.concat([{
                    id: id,
                    name: '新团队 ' + id,
                    description: '',
                    members: [{ name: 'member1', role: '', provider: '', model: '', reasoningEffort: '', soul: '', skills: [], plugins: [], mcp: [], memory: '', executionPrompt: '' }],
                  }]),
                  defaultTeamId: previous.defaultTeamId,
                }
              })
            },
          }, '＋ 新建团队'),
        ),

        teams.map(function (team, index) {
          const isDefault = draft.defaultTeamId === team.id
          const open = openTeamId === team.id
          return React.createElement('div', { key: team.id + ':' + index, style: ui.card },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              React.createElement('span', { style: { fontWeight: 700 } }, team.name || team.id),
              isDefault ? React.createElement('span', { style: ui.badge }, '默认') : null,
              React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px' } }, team.members.length + ' 名成员'),
              React.createElement('button', {
                style: Object.assign({}, ui.btn, { marginLeft: 'auto' }),
                onClick: function () { setOpenTeamId(open ? '' : team.id) },
              }, open ? '收起' : '编辑'),
              isDefault ? null : React.createElement('button', {
                style: ui.btn,
                onClick: function () { updateDraft(function (previous) { return { teams: previous.teams, defaultTeamId: team.id } }) },
              }, '设为默认'),
              React.createElement('button', {
                style: ui.btn,
                onClick: function () {
                  updateDraft(function (previous) {
                    const copyId = team.id + '-copy' + nextIdRef.current++
                    const copy = JSON.parse(JSON.stringify(team))
                    copy.id = copyId.replace(/[^a-z0-9_-]/g, '')
                    copy.name = team.name + '（副本）'
                    return { teams: previous.teams.concat([copy]), defaultTeamId: previous.defaultTeamId }
                  })
                },
              }, '复制'),
              teams.length > 1 ? React.createElement('button', {
                style: ui.btn,
                onClick: function () {
                  updateDraft(function (previous) {
                    const remaining = previous.teams.filter(function (candidate) { return candidate.id !== team.id })
                    return {
                      teams: remaining,
                      defaultTeamId: previous.defaultTeamId === team.id ? remaining[0].id : previous.defaultTeamId,
                    }
                  })
                },
              }, '删除') : null,
            ),
            open ? React.createElement(TeamEditor, {
              team: team,
              onPatchTeam: function (patch) { patchTeam(index, patch) },
              onPatchMember: function (memberIndex, patch) {
                const members = team.members.slice()
                members[memberIndex] = Object.assign({}, members[memberIndex], patch)
                patchTeam(index, { members })
              },
              onRemoveMember: function (memberIndex) {
                patchTeam(index, { members: team.members.filter(function (_, i) { return i !== memberIndex }) })
              },
            }) : null,
          )
        }),

        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '14px' } },
          React.createElement('button', { style: ui.btnPrimary, disabled: status.saving, onClick: save }, status.saving ? '保存中…' : '保存团队设置'),
          React.createElement('button', { style: ui.btn, onClick: load }, '放弃修改'),
          status.notice ? React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' } }, status.notice) : null,
        ),
        status.errors && status.errors.length > 0 ? React.createElement('div', {
          style: { marginTop: '10px', padding: '8px', borderRadius: '8px', background: 'var(--dsw-alias-state-warn-primary)', border: '1px solid var(--dsw-alias-state-warn-primary)', color: 'var(--dsw-alias-label-primary)', fontSize: '11px', lineHeight: 1.6 },
        },
          React.createElement('div', { style: { fontWeight: 700, marginBottom: '3px' } }, '规范化提示'),
          status.errors.map(function (message, index) {
            return React.createElement('div', { key: index }, '· ' + message)
          }),
        ) : null,
      )
    }

    exports.inject = ['slots', 'sessions']

    /**
     * Test seam: the module-loader format has no other way to reach a component
     * for a render test, and "the settings page came up blank" is exactly the
     * failure this package must not ship again. Not a public API.
     */
    exports.__internals = {
      SettingsPage: SettingsPage,
      TeamEditor: TeamEditor,
      MemberEditor: MemberEditor,
      MemberChip: MemberChip,
      ChatBody: ChatBody,
      StepsView: StepsView,
      roleMeta: roleMeta,
      switchStateOf: switchStateOf,
      SWITCH_KEYS: SWITCH_KEYS,
      stateFingerprint: stateFingerprint,
      NEAR_BOTTOM_PX: NEAR_BOTTOM_PX,
      EMPTY_STATE: EMPTY_STATE,
      jumpToSubagent: jumpToSubagent,
      copyText: copyText,
      countersOf: countersOf,
      diagnosticsOf: diagnosticsOf,
    }

    exports.apply = function apply(ctx) {
      /**
       * better-sidebar may register its service AFTER this plugin applies (load
       * order is not ours to control), so the service is attached lazily and the
       * dock stays the fallback until a tab actually exists.
       */
      var sidebar = { service: null, registered: false }
      var sidebarListeners = new Set()

      function hasSidebar() {
        return sidebar.registered
      }

      function attachSidebar(service) {
        if (sidebar.registered) return
        if (!service || typeof service.registerTab !== 'function') return
        sidebar.service = service
        sidebar.registered = true
        ctx.effect(function () {
          return service.registerTab({
            id: TAB_ID,
            title: '团队群聊',
            icon: '🤝',
            order: 45,
            single: true,
            settings: {
              pluginToggles: [
                { key: 'showIncoming', title: '显示成员收到的指令', desc: '以「📨 收到」小字显示成员收到的上游指令', type: 'switch' },
                { key: 'compact', title: '紧凑模式', desc: '缩小角色框间距与字号，适合窄侧栏', type: 'switch' },
                { key: 'pollSeconds', title: '刷新间隔', desc: '拉取团队成员发言的间隔', type: 'number', min: 1, max: 30, unit: '秒' },
                { key: 'autoOpen', title: '启动时自动打开标签页', type: 'switch' },
              ],
            },
            component: function (props) {
              // t44/P0: TabComponentProps DOES carry ctx (better-sidebar's
              // TabContent.tsx passes it to every tab). The previous wrapper
              // forwarded only { visible, scope }, so TabView's sessionCtx was
              // always undefined and every step-jump degraded to "no-service" —
              // blaming the platform for our own dropped context. Forward ctx.
              return React.createElement(TabView, {
                visible: props && props.visible,
                scope: props && props.scope,
                ctx: props && props.ctx,
              })
            },
          })
        }, 'team-chat: better-sidebar tab')
        sidebarListeners.forEach(function (listener) { listener() })
        setTimeout(function () {
          if (readDisplayConfig(sidebar.service, true).autoOpen) openTab()
        }, 1500)
      }

      function TabView(props) {
        var config = readDisplayConfig(sidebar.service, hasSidebar())
        var sessionId = props && props.scope ? props.scope.sessionId : undefined
        return React.createElement('div', {
          style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: '160px', color: 'var(--dsw-alias-label-primary)' },
        }, React.createElement(ChatErrorBoundary, null, React.createElement(ChatBody, {
          config: config,
          sessionId: sessionId,
          mode: 'tab',
          active: !(props && props.visible === false),
          sessionCtx: (props && props.ctx) || ctx,
        })))
      }

      function openTab() {
        try {
          if (sidebar.service && typeof sidebar.service.openTab === 'function') {
            sidebar.service.openTab({ type: TAB_ID })
            return true
          }
        } catch (error) {
          // fall through to the docked column
        }
        return false
      }

      // Path 1: already registered (our bundle loaded second).
      try {
        attachSidebar(ctx.get('betterSidebar'))
      } catch (error) {
        // reported through the dock diagnostic instead of failing the plugin
      }
      // Path 2: registers later (our bundle loaded first) — a hard injection on
      // an OPTIONAL peer parks only this child fiber, so the dock still mounts.
      if (!sidebar.registered && typeof ctx.inject === 'function') {
        try {
          ctx.inject(['betterSidebar'], function (fctx) {
            attachSidebar(fctx.get('betterSidebar'))
          })
        } catch (error) {
          // no injection support: the dock remains the only surface
        }
      }

      /** Re-render the dock when the tab appears, so the two never coexist. */
      function useSidebarRegistered() {
        var pair = React.useState(sidebar.registered)
        React.useEffect(function () {
          var listener = function () { pair[1](true) }
          sidebarListeners.add(listener)
          if (sidebar.registered) pair[1](true)
          return function () { sidebarListeners.delete(listener) }
        }, [])
        return pair[0]
      }

      // The dock's open/closed state lives outside React (hooks cannot run at
      // apply time); a tiny subscriber set keeps every mount in sync.
      var dockOpen = true
      var dockListeners = new Set()
      function setDockOpen(value) {
        dockOpen = value
        dockListeners.forEach(function (listener) { listener(value) })
      }
      function useDockOpen() {
        var pair = React.useState(dockOpen)
        React.useEffect(function () {
          var listener = function () { pair[1](dockOpen) }
          dockListeners.add(listener)
          return function () { dockListeners.delete(listener) }
        }, [])
        return pair
      }

      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register(
          { name: 'shell.overlay', id: 'team-chat-dock', order: 150, label: '团队群聊侧栏' },
          function () {
            var config = readDisplayConfig(sidebar.service, hasSidebar())
            var pair = useDockOpen()
            var registered = useSidebarRegistered()
            // The tab is the preferred surface: as soon as it exists the dock
            // stands down so the same chat never renders twice.
            if (registered) return null
            if (!config.dockedRight) return null
            if (pair[0]) {
              return React.createElement('div', {
                style: {
                  position: 'fixed', top: '0', right: '0', bottom: '0', width: DOCK_WIDTH + 'px',
                  display: 'flex', flexDirection: 'column',
                  background: 'var(--dsw-specific-sidebar-fill)',
                  color: 'var(--dsw-alias-label-primary)',
                  borderLeft: '1px solid var(--dsw-alias-border-l1)',
                  boxShadow: '-10px 0 30px rgba(0,0,0,0.12)',
                  zIndex: 9000, pointerEvents: 'auto', fontFamily: 'inherit', fontSize: '13px',
                },
              },
                React.createElement('div', {
                  style: {
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px',
                    borderBottom: '1px solid var(--dsw-alias-border-l1)',
                    background: 'var(--dsw-specific-sidebar-fill)',
                    color: 'var(--dsw-alias-label-primary)',
                  },
                },
                  React.createElement('div', { style: { fontWeight: 700, fontSize: '14px' } }, '🤝 多角色协作群聊'),
                  React.createElement('button', {
                    onClick: function () { setDockOpen(false) },
                    title: '收起',
                    style: { border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', fontSize: '16px', padding: '2px 8px' },
                  }, '⟩'),
                ),
                React.createElement(ChatErrorBoundary, null,
                  React.createElement(ChatBody, { config: config, sessionId: undefined, mode: 'dock', sessionCtx: ctx }),
                ),
              )
            }
            return React.createElement('div', {
              onClick: function () { setDockOpen(true) },
              title: '展开团队群聊侧栏',
              style: {
                position: 'fixed', top: '50%', right: '0', transform: 'translateY(-50%)',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px',
                padding: '12px 6px', borderRadius: '10px 0 0 10px',
                background: 'var(--dsw-specific-sidebar-fill)', color: 'var(--dsw-alias-label-primary)',
                border: '1px solid var(--dsw-alias-border-l2)', borderRight: 'none',
                cursor: 'pointer', zIndex: 9000, pointerEvents: 'auto', fontSize: '12px',
                writingMode: 'vertical-rl', letterSpacing: '1px',
              },
            }, '🤝 团队')
          },
        )
      })

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          { name: 'settings.section', id: 'team-chat', order: 22, label: '团队群聊' },
          function () { return React.createElement(SettingsPage, {}) },
        )
      })

      ctx.slots.inject('sidebar.footer.action', function () {
        return ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'team-chat-open', order: 60, label: '团队群聊' },
          function () {
            return React.createElement('button', {
              onClick: function () { if (!openTab()) setDockOpen(true) },
              title: hasSidebar() ? '在 better-sidebar 中打开团队群聊' : '展开团队群聊侧栏',
              style: {
                border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer',
                fontSize: '13px', padding: '6px 10px', borderRadius: '8px',
              },
            }, '🤝 团队')
          },
        )
      })
    }

    return module.exports
  },
})
