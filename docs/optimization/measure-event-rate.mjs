// t15 Q2: event-rate measurement from a real session log
// Decodes multi-frame zstd, then computes per-second event rates:
//   - overall counts per type
//   - busy-window rate (max events in any sliding 1s and 3s window)
//   - per-type share of the feed (chunk noise vs meaningful events)
// Run: node measure-event-rate.mjs <session.jsonl.zstd>
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decodeAll(buffer) {
  const offsets = []
  for (let at = buffer.indexOf(MAGIC); at !== -1; at = buffer.indexOf(MAGIC, at + 1)) offsets.push(at)
  const parts = []
  let decoded = 0
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i]
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start)).toString('utf8'))
      decoded += 1
      continue
    } catch { /* magic inside payload */ }
    for (let j = i + 1; j < offsets.length; j += 1) {
      try {
        parts.push(zstdDecompressSync(buffer.subarray(start, offsets[j])).toString('utf8'))
        decoded += 1
        break
      } catch { /* widen */ }
    }
  }
  return { text: parts.join(''), frames: offsets.length, decoded }
}

const file = process.argv[2]
const data = readFileSync(file)
const { text, decoded } = decodeAll(data)

const events = [] // { time, type }
const counts = {}
let firstTime = Infinity
let lastTime = -Infinity

for (const line of text.split('\n')) {
  if (!line.trim()) continue
  let e
  try { e = JSON.parse(line) } catch { continue }
  const t = Number(e.time)
  if (!Number.isFinite(t)) continue
  counts[e.type] = (counts[e.type] || 0) + 1
  events.push({ time: t, type: e.type })
  if (t < firstTime) firstTime = t
  if (t > lastTime) lastTime = t
}

events.sort((a, b) => a.time - b.time)
const spanMs = lastTime - firstTime
const spanS = spanMs / 1000

// busy windows: max count in any sliding window
function maxInWindow(ms) {
  let max = 0
  let head = 0
  for (let tail = 0; tail < events.length; tail += 1) {
    while (events[tail].time - events[head].time > ms) head += 1
    const n = tail - head + 1
    if (n > max) max = n
  }
  return max
}
const max1s = maxInWindow(1000)
const max3s = maxInWindow(3000)
const max60s = maxInWindow(60000)

// chunk-type share (streaming noise)
const CHUNK_TYPES = new Set(['assistant/chunk', 'text-chunks', 'reasoning-chunks', 'tool-call-chunks'])
const chunkCount = events.filter((e) => CHUNK_TYPES.has(e.type)).length
// meaningful event types for a team-chat step line: turn/step/tool/assistant-message/user-message
const MEANINGFUL = new Set(['turn/start', 'turn/end', 'step/start', 'step/end', 'tool/call', 'tool/result', 'assistant/message', 'user/message'])
const meaningfulCount = events.filter((e) => MEANINGFUL.has(e.type)).length

console.log('FILE: ' + file)
console.log('decoded frames: ' + decoded + '  total events: ' + events.length)
console.log('time span: ' + spanMs.toFixed(0) + ' ms (' + (spanS).toFixed(1) + ' s)  first=' + new Date(firstTime).toLocaleTimeString('sv') + '  last=' + new Date(lastTime).toLocaleTimeString('sv'))
console.log('')
console.log('--- per-type counts ---')
for (const [type, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(String(count).padStart(7) + '  ' + type)
}
console.log('')
console.log('--- rate (subscribe-all events/sec) ---')
console.log('overall avg: ' + (events.length / spanS).toFixed(2) + ' ev/s over full span')
console.log('peak: ' + max1s + ' ev in any 1s window  |  ' + max3s + ' ev in any 3s  |  ' + max60s + ' ev in any 60s')
console.log('')
console.log('--- stream noise vs meaningful ---')
console.log('chunk-type events (assistant/chunk + *-chunks): ' + chunkCount + '  share=' + (chunkCount / events.length * 100).toFixed(1) + '%')
console.log('meaningful events (turn/step/tool/assistant-message/user): ' + meaningfulCount + '  share=' + (meaningfulCount / events.length * 100).toFixed(1) + '%')
console.log('peak meaningful in any 3s: ' + (function () {
  let max = 0
  let head = 0
  for (let tail = 0; tail < events.length; tail += 1) {
    while (events[tail].time - events[head].time > 3000) head += 1
    const n = events.slice(head, tail + 1).filter((e) => MEANINGFUL.has(e.type)).length
    if (n > max) max = n
  }
  return max
}()) + ' ev/3s (what a filtered subscription would actually process)')