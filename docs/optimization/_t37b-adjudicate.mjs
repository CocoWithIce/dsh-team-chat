// t37b: adjudicate the CAUSE of 114 (t34) vs 164/165 (t35/t36) vs 165 (t37).
// H1 (captain): the two commands scanned DIFFERENT corpora (27 vs 44 files).
// H2 (mine):    the same corpus grew because session logs append live.
// Decisive test: on the SAME 44-file set, does the count differ from the 27-file subset
// by roughly the growth, and does a 27-file rescope now exceed t34's 114?
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
function countFailed(files) {
  let failed = 0
  for (const f of files) {
    let t = ''
    try { t = decodeAll(readFileSync(f)) } catch { continue }
    for (const line of t.split('\n')) {
      if (!line.trim()) continue
      let e; try { e = JSON.parse(line) } catch { continue }
      if (e.type !== 'tool/result') continue
      const d = e.data || {}
      if (d.error !== undefined && d.error !== null) failed += 1
    }
  }
  return failed
}

const all = process.argv.slice(2)
const groupE = all.filter(f => f.includes('DSH~0020Desktop'))
const groupD = all.filter(f => f.includes('--D-deepseek-harness--'))
const groupF = all.filter(f => f.includes('dsh-work'))
console.log('corpus sizes: total=' + all.length, '| E(27)=' + groupE.length, '| D=' + groupD.length, '| F=' + groupF.length)
const cE = countFailed(groupE), cD = countFailed(groupD), cF = countFailed(groupF), cAll = countFailed(all)
console.log('failed(error非空):')
console.log('  E only (27 files, t34 target sample) :', cE)
console.log('  D only                               :', cD)
console.log('  F only                               :', cF)
console.log('  E+D+F (44 files)                     :', cAll, '(sum check:', cE + cD + cF + ')')
console.log('')
console.log('H1 (different corpora, both snapshots at ~same time):')
console.log('  E(27) =', cE, '-> but t34 recorded 114 for its own 27-file sample.')
console.log('  If H1 were the whole story, E(27) now should be ~= 114 (plus small live growth).')
console.log('  Delta vs t34 114:', cE - 114)
console.log('')
console.log('H2 (live growth of the SAME files): t34 did NOT report a file count, only "27 sessions".')
console.log('  F(8 files) =', cF, '-> if t36 really scanned 44, it should be about', cE, '+', cF, '+', cD, '=', cE + cF + cD)
