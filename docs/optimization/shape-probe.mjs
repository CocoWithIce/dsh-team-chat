// t34 shape-assumption probe: verify platform payload shapes against REAL session logs.
// Decodes multi-frame zstd (magic 0x28B52FFD), aggregates ONLY — never dumps user content.
// Usage: node shape-probe.mjs <session.jsonl.zstd> [more...]
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
    try { parts.push(zstdDecompressSync(buffer.subarray(start)).toString('utf8')); decoded += 1; continue } catch { }
    for (let j = i + 1; j < offsets.length; j += 1) {
      try { parts.push(zstdDecompressSync(buffer.subarray(start, offsets[j])).toString('utf8')); decoded += 1; break } catch { }
    }
  }
  return { text: parts.join(''), frames: offsets.length, decoded }
}

const agg = {
  toolCall: 0, argsString: 0, argsObject: 0, argsOther: 0, argsParseFail: 0,
  knownToolArgsString: 0, knownToolArgsParseOk: 0,
  toolResult: 0, withError: 0, errorIsObject: 0, errorHasMessage: 0, errorHasName: 0, errorHasCode: 0,
  errorOtherShape: 0,
  withMeta: 0, metaIsObject: 0, metaTruncatedTrue: 0,
  asstMsg: 0, contentIsArray: 0, contentBlocksText: 0,
  resultMsgContentIsArray: 0, resultMsgBlockTypeToolResult: 0,
  resultMsgContentIsString: 0,
  userMsg: 0, userContentIsArray: 0,
}

const KNOWN = new Set(['pwsh', 'bash', 'sh', 'read', 'write', 'edit', 'grep', 'glob'])

for (const file of process.argv.slice(2)) {
  const { text, frames, decoded } = decodeAll(readFileSync(file))
  let events = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    events += 1
    const d = e.data || {}
    if (e.type === 'tool/call') {
      agg.toolCall += 1
      const a = d.arguments
      const t = typeof a
      if (t === 'string') {
        agg.argsString += 1
        if (KNOWN.has(d.name)) {
          agg.knownToolArgsString += 1
          try { JSON.parse(a); agg.knownToolArgsParseOk += 1 } catch { agg.argsParseFail += 1 }
        }
      } else if (a !== null && t === 'object') agg.argsObject += 1
      else agg.argsOther += 1
    } else if (e.type === 'tool/result') {
      agg.toolResult += 1
      const err = d.error
      if (err !== undefined && err !== null) {
        agg.withError += 1
        if (typeof err === 'object') {
          agg.errorIsObject += 1
          if (typeof err.message === 'string') agg.errorHasMessage += 1
          if (typeof err.name === 'string') agg.errorHasName += 1
          if (typeof err.code === 'string') agg.errorHasCode += 1
        } else agg.errorOtherShape += 1
      }
      const m = d.meta
      if (m !== undefined && m !== null) {
        agg.withMeta += 1
        if (typeof m === 'object') { agg.metaIsObject += 1; if (m.truncated === true) agg.metaTruncatedTrue += 1 }
      }
      // tool/result.message.content shape
      const mc = d.message && d.message.content
      if (Array.isArray(mc)) {
        agg.resultMsgContentIsArray += 1
        if (mc.some((b) => b && b.type === 'tool-result')) agg.resultMsgBlockTypeToolResult += 1
      } else if (typeof mc === 'string') agg.resultMsgContentIsString += 1
    } else if (e.type === 'assistant/message') {
      agg.asstMsg += 1
      const c = d.message && d.message.content
      if (Array.isArray(c)) {
        agg.contentIsArray += 1
        if (c.some((b) => b && b.type === 'text')) agg.contentBlocksText += 1
      }
    } else if (e.type === 'user/message') {
      agg.userMsg += 1
      if (Array.isArray(d.content)) agg.userContentIsArray += 1
    }
  }
  console.log(`file=${file.split('\\').pop()} frames=${frames} decoded=${decoded} events=${events}`)
}
console.log(JSON.stringify(agg, null, 1))