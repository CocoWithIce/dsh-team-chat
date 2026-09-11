/**
 * E15 复核指纹守卫测试 —— test/p2-review-guard.test.mjs
 *
 * t96 · P2 Slice 2（设计 §10 E15 机制化）。覆盖：
 *   - fingerprintFile：sha256 + bytes；
 *   - snapshotFor：review 任务 inScope 快照；无 inScope → no-in-scope-files；
 *     不可读文件 → errors 记录不炸；
 *   - compareFor：未改动 match；被修订 → changed（modified）；删除/不可读 → unreadable；
 *     无快照 → e15-no-snapshot；比对一次性消费（再比 → no-snapshot）；
 *   - release：非完成出口清快照。
 *
 * 判别（能变红）见 %TEMP%/dsh-t96-mutate/：mut-e15-skip（compareFor 恒报 match）→ 红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { TaskStore } from '../lib/state/task-store.js'
import { executeMemberTool } from '../lib/p2/claim-channel.js'
import { createReviewGuard, fingerprintFile } from '../lib/p2/review-guard.js'

/** 可变内存文件系统：Map<string, string>。 */
function memfs(initial = {}) {
  const files = new Map(Object.entries(initial))
  return {
    files,
    readFile: (file) => {
      if (!files.has(file)) throw new Error('ENOENT: ' + file)
      return Buffer.from(files.get(file), 'utf8')
    },
  }
}

function taskOf(id, inScope) {
  return { id, kind: 'review', inScope }
}

test('fingerprintFile：file→sha256+bytes（与 node:crypto 直算一致）', () => {
  const { readFile } = memfs({ 'a.md': 'hello e15' })
  const fp = fingerprintFile('a.md', readFile)
  assert.equal(fp.file, 'a.md')
  assert.equal(fp.sha256, createHash('sha256').update('hello e15').digest('hex'))
  assert.equal(fp.bytes, 9)
})

test('snapshotFor：inScope 快照；无 inScope → no-in-scope-files；不可读 → errors 不炸', () => {
  const fs = memfs({ 'a.md': 'A', 'b.md': 'B' })
  const guard = createReviewGuard({ readFile: fs.readFile })
  const t = taskOf('t1', ['a.md', 'b.md'])
  const snap = guard.snapshotFor(t)
  assert.equal(snap.ok, true)
  assert.equal(snap.count, 2)
  assert.equal(guard.has('t1'), true)

  const empty = guard.snapshotFor(taskOf('t2', []))
  assert.equal(empty.ok, false)
  assert.equal(empty.reason, 'no-in-scope-files')

  const partial = guard.snapshotFor(taskOf('t3', ['a.md', 'ghost.md']))
  assert.equal(partial.count, 1)
  assert.equal(partial.errors.length, 1)
  assert.equal(partial.errors[0].file, 'ghost.md')
  // 每任务独立键控：t1 快照不受影响
  assert.equal(guard.snapshotOf('t1').files.length, 2)
})

test('compareFor：未改动 match=true；修订 → modified；比对一次性消费', () => {
  const fs = memfs({ 'a.md': 'v1' })
  const guard = createReviewGuard({ readFile: fs.readFile })
  const t = taskOf('t1', ['a.md'])
  guard.snapshotFor(t)
  const clean = guard.compareFor(t)
  assert.equal(clean.match, true)
  assert.equal(clean.compared, 1)

  // 消费后重比 → no-snapshot（重开复核需重新 claim 快照）
  const again = guard.compareFor(t)
  assert.equal(again.reason, 'e15-no-snapshot')

  const fs2 = memfs({ 'a.md': 'v1' })
  const guard2 = createReviewGuard({ readFile: fs2.readFile })
  guard2.snapshotFor(taskOf('t2', ['a.md']))
  fs2.files.set('a.md', 'v2-REVISED-IN-WINDOW')
  const dirty = guard2.compareFor(taskOf('t2', ['a.md']))
  assert.equal(dirty.match, false)
  assert.equal(dirty.changed[0].kind, 'modified')
  assert.notEqual(dirty.changed[0].after, dirty.changed[0].before)
})

test('compareFor：文件被删除/不可读 → unreadable 记入 changed；release 清快照', () => {
  const fs = memfs({ 'a.md': 'v1' })
  const guard = createReviewGuard({ readFile: fs.readFile })
  const t = taskOf('t1', ['a.md'])
  guard.snapshotFor(t)
  fs.files.delete('a.md')
  const r = guard.compareFor(t)
  assert.equal(r.match, false)
  assert.equal(r.changed[0].kind, 'unreadable')

  const guard2 = createReviewGuard({ readFile: fs.readFile })
  guard2.snapshotFor(taskOf('t2', ['a.md']))
  guard2.release('t2')
  assert.equal(guard2.has('t2'), false)
  assert.equal(guard2.compareFor(taskOf('t2', ['a.md'])).reason, 'e15-no-snapshot')
})

test('E15 端到端（B′ 通道接线）：review 任务 claim 自动快照 + report completed 自动警告', () => {
  // 用 executeMemberTool 全链验证两个触发点（设计原文触发点）
  const fs = memfs({ 'spec.md': 'v1' })
  const guard = createReviewGuard({ readFile: fs.readFile })
  const store = new TaskStore({ claimLeaseMs: 60000, stallThresholdMs: 60000, suspendedUnattendedMs: 300000, maxSupersedeDepth: 16 })
  const cache = new Map()
  const t = store.createTask({ subject: '复核x', dependencies: [], assignee: 'rv', kind: 'review', inScope: ['spec.md'] }, 0).task
  const identity = { memberId: 'child-rv', memberName: 'rv' }
  const claim = executeMemberTool({ store, attemptCache: cache, reviewGuard: guard }, 'team_claim_task', { taskId: t.id }, identity)
  assert.equal(claim.ok, true)
  assert.equal(claim.reviewSnapshot.count, 1, 'claim 时自动快照（设计触发点 1）')
  fs.files.set('spec.md', 'v2-REVISED')
  const report = executeMemberTool({ store, attemptCache: cache, reviewGuard: guard }, 'team_report_task', { taskId: t.id, status: 'completed' }, identity)
  assert.equal(report.ok, true)
  assert.equal(report.reviewGuard.match, false, '完成时自动比对（设计触发点 2）')
  assert.equal(report.reviewGuard.changed[0].kind, 'modified')
})
