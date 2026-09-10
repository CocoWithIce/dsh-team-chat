// dsh-team-chat — measurement: /state payload size + processing cost (H1, H2, H4)
// Run: node measure-state.mjs
import { groupThreads } from 'file:///E:/DSH_Desktop/DSH%20Desktop/dsh-team-chat/lib/shared.js'

// ---- /state snapshot shape from lib/index.js:460-489 (snapshotOf) ----
function makeMessage(id, kind, from, text) {
  return { id, kind, from, text, time: Date.now(), rootId: null, replyTo: null, quote: null }
}
function makeSnapshot(messageCount) {
  const messages = []
  const sample = {
    chat: '复现 DSH 卡顿的根因：3 秒轮询对每个成员调用 readSurface，在子 agent 活跃写入会话日志时造成高频磁盘 I/O 和大对象解析。',
    system: '🔨 researcher 开始工作',
    incoming: '📨 researcher 收到：分析 /state 响应体',
  }
  const kinds = ['chat', 'system', 'chat', 'incoming', 'chat']
  for (let i = 0; i < messageCount; i += 1) {
    const kind = kinds[i % kinds.length]
    messages.push(makeMessage('m' + i, kind, kind === 'system' ? '' : (['researcher', 'engineer', 'reviewer', 'me'])[i % 4], sample[kind]))
  }
  const threads = groupThreads(messages.slice(-200))
  return {
    ok: true, im: null, imPush: false, sessionId: 'session-abc123', team: 'multi-role-team',
    activeTeam: { id: 'multi-role-team', name: 'multi-role-team', description: '', members: ['researcher', 'engineer', 'reviewer'] },
    teams: [{ id: 'multi-role-team', name: 'multi-role-team', memberCount: 3 }],
    defaultTeamId: 'multi-role-team',
    members: [
      { id: 'member-1', name: 'researcher', activity: 'running', role: '研究员', model: '', skillCount: 0, configured: true },
      { id: 'member-2', name: 'engineer', activity: 'idle', role: '工程师', model: '', skillCount: 0, configured: true },
      { id: 'member-3', name: 'reviewer', activity: 'idle', role: '审查员', model: '', skillCount: 0, configured: true },
    ],
    threads,
    hasTeam: true, error: null,
  }
}

for (const n of [50, 200, 400]) {
  const snap = makeSnapshot(n)
  const json = JSON.stringify(snap)
  const t0 = process.hrtime.bigint()
  const json2 = JSON.stringify(snap)
  const t1 = process.hrtime.bigint()
  const parsed = JSON.parse(json2)
  const t2 = process.hrtime.bigint()
  const threadCount = parsed.threads.length
  const replyCount = parsed.threads.reduce((a, t) => a + t.replies.length, 0)
  console.log(`messages=${n} → /state body ${Buffer.byteLength(json, 'utf8')} bytes | stringify ${Number(t1 - t0) / 1e6} ms | parse ${Number(t2 - t1) / 1e6} ms | threads=${threadCount} replies=${replyCount}`)
}

// ---- refresh() synchronous cost: scan a member surface's events (index.js:309-357) ----
// readSurface returns surface.events: array of { seq, type, data }. First sight scans ALL
// events to find max seq (index.js:322-327); later ticks scan from the tail until seq <= cursor.
function scanFirstSight(eventCount) {
  const events = []
  for (let i = 0; i < eventCount; i += 1) {
    events.push({ seq: i, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '成员产出文本 ' + i }] } } })
  }
  const t0 = process.hrtime.bigint()
  let tail = -1
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const seq = Number(events[i].seq)
    if (seq > tail) tail = seq
  }
  const t1 = process.hrtime.bigint()
  return { tail, ms: Number(t1 - t0) / 1e6 }
}
for (const n of [1000, 5000, 20000]) {
  const r = scanFirstSight(n)
  console.log(`first-sight scan of ${n} events: ${r.ms.toFixed(3)} ms (host-side iteration only; excludes readSurface service call)`)
}

// ---- tick cadence math (index.js:58, :360-370) ----
// One tick = for each captain: 1× listChildren + per member 1× readSurface + synchronous processing.
// With 1 captain × 3 members: 1 listChildren + 3 readSurface per 3s tick.
console.log()
console.log('tick cadence (verified from code):')
console.log('  POLL_MS=3000 (index.js:58); setInterval (index.js:370) WITHOUT overlap guard')
console.log('  discoverCaptains → ctx.agents.list() + listChildren per agent (index.js:242-256)')
console.log('  refresh → readSurface per member (index.js:312); also readSurface for IM origin (index.js:444)')
console.log('  /state handler calls targetState → refresh synchronously (index.js:420, :690-695)')
console.log('  → with one open tab polling at 3s AND the 3s tick, readSurface can fire 2× more often than POLL_MS alone')