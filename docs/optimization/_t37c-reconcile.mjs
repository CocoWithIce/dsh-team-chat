// t37c: reconcile the captain's/reviewer's "44 files -> 165, errors ALL in main dir,
// harness(9)+work(8) ZERO" against my own measurement "E=115, F=50, D=0 -> 165".
// Also measure the dedupe caliber (107 claim) so every number in the table is checkable.
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
function decodeAll(buffer) {
  const parts = []
  const offsets = []
  for (let at = buffer.indexOf(MAGIC); at !== -1; at = buffer.indexOf(MAGIC, at + 1)) offsets.push(at)
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i]
    try { parts.push(zstdDecompressSync(buffer.subarray(start)).toString('utf8')); continue } catch { }
    for (let j = i + 1; j < offsets.length; j += 1) {
      try { parts.push(zstdDecompressSync(buffer.subarray(start, offsets[j])).toString('utf8')); break } catch { }
    }
  }
  return parts.join('')
}

const rows = []
for (const file of process.argv.slice(2)) {
  const p = file.split(/[\\/]/)
  const i = p.indexOf('sessions')
  const group = p[i + 1]
  const sid = p[i + 2] || ''
  let failed = 0, seqs = new Set(), noSeq = 0
  let text = ''
  try { text = decodeAll(readFileSync(file)) } catch { continue }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let e; try { e = JSON.parse(line) } catch { continue }
    if (e.type !== 'tool/result') continue
    const d = e.data || {}
    if (!(d.error !== undefined && d.error !== null)) continue
    failed += 1
    if (typeof e.seq === 'number') seqs.add(e.seq)
    else noSeq += 1
  }
  rows.push({ group, sid, failed, uniq: seqs.size, noSeq })
}

const byGroup = new Map()
for (const r of rows) {
  const g = byGroup.get(r.group) || { files: 0, failed: 0, uniq: 0, noSeq: 0, sessionsWithError: 0 }
  g.files += 1; g.failed += r.failed; g.uniq += r.uniq; g.noSeq += r.noSeq
  if (r.failed > 0) g.sessionsWithError += 1
  byGroup.set(r.group, g)
}
console.log('group                                    files  failed  uniqSeq  noSeq  sessionsWithError')
let F = 0, U = 0, N = 0, FF = 0
for (const [g, v] of [...byGroup].sort((a, b) => b[1].failed - a[1].failed)) {
  F += v.failed; U += v.uniq; N += v.noSeq; FF += v.files
  console.log(g.slice(0, 40).padEnd(40), String(v.files).padStart(5), String(v.failed).padStart(7), String(v.uniq).padStart(8), String(v.noSeq).padStart(6), String(v.sessionsWithError).padStart(17))
}
console.log('TOTAL'.padEnd(40), String(FF).padStart(5), String(F).padStart(7), String(U).padStart(8), String(N).padStart(6))
console.log('')
console.log('CAPTAIN claims: 27 main = 115 ; 44 total = 165 ; errors ALL in main ; dedupe = 107')
const main = byGroup.get('--E-DSH_Desktop-DSH~0020Desktop--')
console.log('  main-dir failed      :', main ? main.failed : 'n/a', '(captain says 115)')
console.log('  total failed         :', F, '(captain says 165)')
console.log('  non-main failed      :', F - (main ? main.failed : 0), '(captain says 0)')
console.log('  dedupe(total uniqSeq):', U, '(captain says 107)')
console.log('')
console.log('TOP sessions by error count:')
for (const r of rows.filter(x => x.failed > 0).sort((a, b) => b.failed - a.failed).slice(0, 8)) {
  console.log('  ', r.group.slice(2, 14).padEnd(14), r.sid.slice(0, 12).padEnd(14), 'failed=' + r.failed, 'uniq=' + r.uniq)
}
