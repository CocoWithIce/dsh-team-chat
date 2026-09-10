// t15 Q2 supplemental: count ALL raw rows incl. chunk-row types (time0/seq0 shaped),
// giving the true upper bound of what a full session/event subscription would see.
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decodeAll(buffer) {
  const offsets = []
  for (let at = buffer.indexOf(MAGIC); at !== -1; at = buffer.indexOf(MAGIC, at + 1)) offsets.push(at)
  const parts = []
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i]
    try { parts.push(zstdDecompressSync(buffer.subarray(start)).toString('utf8')); continue } catch { }
    for (let j = i + 1; j < offsets.length; j += 1) {
      try { parts.push(zstdDecompressSync(buffer.subarray(start, offsets[j])).toString('utf8')); break } catch { }
    }
  }
  return parts.join('')
}

const file = process.argv[2]
const text = decodeAll(readFileSync(file))

const counts = new Map()
const timed = []
for (const line of text.split('\n')) {
  if (!line.trim()) continue
  let e
  try { e = JSON.parse(line) } catch { continue }
  counts.set(e.type, (counts.get(e.type) || 0) + 1)
  const t = Number(e.time ?? e.time0)
  if (Number.isFinite(t)) timed.push([t, e.type])
}
const total = [...counts.values()].reduce((a, b) => a + b, 0)
console.log('FILE: ' + file)
console.log('raw rows total: ' + total)
console.log('--- ALL raw types (incl chunk rows) ---')
for (const [type, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(String(count).padStart(7) + '  ' + type)
}
// timed rate
if (timed.length > 0) {
  timed.sort((a, b) => a[0] - b[0])
  const spanMs = timed[timed.length - 1][0] - timed[0][0]
  let peak1 = 0; let head = 0
  for (let tail = 0; tail < timed.length; tail += 1) {
    while (timed[tail][0] - timed[head][0] > 1000) head += 1
    peak1 = Math.max(peak1, tail - head + 1)
  }
  console.log('timed rows: ' + timed.length + '  span ' + (spanMs / 1000).toFixed(0) + 's  peak-in-1s: ' + peak1)
}