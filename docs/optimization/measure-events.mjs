// t13 empirical evidence: event-landing counts + tool/call product clues from a real session log
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
    } catch { /* magic in payload */ }
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
const { text, frames, decoded } = decodeAll(readFileSync(file))

const counts = {}
const toolArgsClues = {}
const fileToolCalls = []
const productClueCalls = []

for (const line of text.split('\n')) {
  if (!line.trim()) continue
  let e
  try { e = JSON.parse(line) } catch { continue }
  counts[e.type] = (counts[e.type] || 0) + 1
  if (e.type === 'tool/call' && e.data && typeof e.data.name === 'string') {
    const args = String(e.data.arguments || '')
    const hasClue = /file_path|"path"|"command"|"dir"|"cwd"/i.test(args)
    if (hasClue) toolArgsClues[e.data.name] = (toolArgsClues[e.data.name] || 0) + 1
    if (hasClue && args.length < 300) productClueCalls.push(e.data.name + ' :: ' + args.replace(/\s+/g, ' ').slice(0, 200))
  }
}

console.log('FILE: ' + file)
console.log('compressed: ' + readFileSync(file).length + '  frames: ' + frames + '  decoded: ' + decoded + '  chars: ' + text.length)
console.log('\n--- EVENT COUNTS (all types, sorted desc) ---')
for (const [type, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(String(count).padStart(6) + '  ' + type)
}
console.log('\n--- TOOL CALLS whose arguments carry path/command/cwd clues ---')
for (const [name, count] of Object.entries(toolArgsClues).sort((a, b) => b[1] - a[1])) {
  console.log(String(count).padStart(5) + '  ' + name)
}
console.log('\n--- SAMPLE product-clue tool calls (first 8) ---')
for (const call of productClueCalls.slice(0, 8)) console.log('  ' + call)