// t34 probe 2: does lib/index.js's result-extraction branch ever fire on REAL tool/result events?
// Mirrors the exact code path at lib/index.js:729-741 (result assignment + error detail append).
// Aggregates ONLY — no user content is printed.
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

const stat = {
  failedEvents: 0,                 // data.error != null
  errorDetailAppended: 0,          // branch at :736 actually fired (typeof data.error.message === 'string')
  errorDetailMissed: 0,            // failed but no .message -> detail silently lost
  truncatedEvents: 0,              // meta.truncated === true
  okEvents: 0,
  errorKeysSeen: new Set(),        // key names observed on data.error
  metaKeysSeen: new Set(),         // key names observed on data.meta (bounded sample)
}

for (const file of process.argv.slice(2)) {
  for (const line of decodeAll(readFileSync(file)).split('\n')) {
    if (!line.trim()) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e.type !== 'tool/result') continue
    const d = e.data || {}
    const failed = d.error !== undefined && d.error !== null
    if (failed) {
      stat.failedEvents += 1
      if (d.error && typeof d.error === 'object') { for (const k of Object.keys(d.error)) stat.errorKeysSeen.add(k) }
      if (failed && d.error && typeof d.error.message === 'string') stat.errorDetailAppended += 1
      else stat.errorDetailMissed += 1
    } else {
      stat.okEvents += 1
      if (d.meta && d.meta.truncated === true) stat.truncatedEvents += 1
    }
    if (d.meta && typeof d.meta === 'object' && stat.metaKeysSeen.size < 20) {
      for (const k of Object.keys(d.meta)) stat.metaKeysSeen.add(k)
    }
  }
}
console.log('failedEvents(data.error非空):', stat.failedEvents)
console.log('  └ errorDetailAppended (代码 :736 真的触发):', stat.errorDetailAppended)
console.log('  └ errorDetailMissed   (失败但明细被静默丢弃):', stat.errorDetailMissed)
console.log('okEvents:', stat.okEvents, '| truncated(meta.truncated===true):', stat.truncatedEvents)
console.log('data.error 观察到的键:', [...stat.errorKeysSeen].join(',') || '(none)')
console.log('data.meta  观察到的键(样本):', [...stat.metaKeysSeen].join(',') || '(none)')