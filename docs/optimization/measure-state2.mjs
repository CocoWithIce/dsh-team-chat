// dsh-team-chat — supplemental measurement: reply-heavy /state shape + groupThreads cost
import { groupThreads } from 'file:///E:/DSH_Desktop/DSH%20Desktop/dsh-team-chat/lib/shared.js'

function msg(id, kind, from, text, rootId) {
  return { id, kind, from, text, time: Date.now(), rootId: rootId ?? null, replyTo: null, quote: null }
}
const LONG = '已复现 DSH 卡顿根因：3 秒轮询对每个成员调用 readSurface，在子 agent 活跃写入会话日志时造成高频磁盘 I/O 与大对象解析/序列化，客户端每次切会话全量拉取 /state，全局提示词 section 把 routingText 注入到每一个会话。'

// Reply-heavy: 40 roots with 4 replies each = 200 messages, matching WINDOW_MESSAGES cap
{
  const messages = []
  for (let r = 0; r < 40; r += 1) {
    const rootId = 'root' + r
    messages.push(msg(rootId, 'chat', 'researcher', LONG, null))
    for (let k = 1; k <= 4; k += 1) messages.push(msg('m' + r + '-' + k, 'chat', k % 2 ? 'engineer' : 'reviewer', LONG, rootId))
  }
  const snap = { threads: groupThreads(messages.slice(-200)) }
  const json = JSON.stringify(snap)
  console.log(`reply-heavy 200 msgs (40 roots × 5): body ${Buffer.byteLength(json, 'utf8')} bytes, threads=${snap.threads.length}`)
  const t0 = process.hrtime.bigint(); JSON.stringify(snap); const t1 = process.hrtime.bigint()
  console.log(`  stringify ${(Number(t1 - t0) / 1e6).toFixed(3)} ms`)
}

// groupThreads at different message volumes (no cap) — the WINDOW cap still slices before grouping
for (const n of [400, 800, 2000]) {
  const messages = []
  for (let i = 0; i < n; i += 1) messages.push(msg('m' + i, 'chat', 'researcher', LONG, i % 5 === 0 ? null : 'm' + (i - 1)))
  const t0 = process.hrtime.bigint()
  const threads = groupThreads(messages.slice(-200))
  const t1 = process.hrtime.bigint()
  console.log(`groupThreads on ${n}-msg window slice(-200): ${(Number(t1 - t0) / 1e6).toFixed(3)} ms, threads=${threads.length}`)
}

// FRESH_LIMIT=24 tail scan per member per tick (index.js:329-335): worst case stops after 24 events
{
  const events = []
  for (let i = 0; i < 5000; i += 1) events.push({ seq: i, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'x' }] } } })
  const cursor = 4900
  const fresh = []
  const t0 = process.hrtime.bigint()
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (!(Number(event.seq) > cursor)) break
    fresh.push(event)
    if (fresh.length >= 24) break
  }
  fresh.reverse()
  const t1 = process.hrtime.bigint()
  console.log(`FRESH_LIMIT tail scan (cursor 4900/5000): scanned ${fresh.length} events in ${(Number(t1 - t0) / 1e6).toFixed(3)} ms — bounded by FRESH_LIMIT=24`)
}