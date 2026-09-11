/**
 * B′ 认领通道测试（成员工具执行器）—— test/p2-claim-channel.test.mjs
 *
 * 覆盖：claim 成功/拒绝（非 pending、终态、依赖阻塞）；report running/completed/failed
 * 全链；归属校验（他人不得动）；revision 竞争（外部 supersede 后 report → 诚实失败）；
 * 非法 status 拒绝；身份缺失拒绝；终态后 cache 清理。
 *
 * 判别（能变红）见 %TEMP%/dsh-t92-mutate/（mut-p2-claim.ts：把归属校验注释掉 →
 * 「他人不得动」用例红；mut-p2-update.ts：把 update 直调改成空 → 端到端终态红）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TaskStore, ERR } from '../lib/state/task-store.js'
import { MEMBER_TOOLS, executeMemberTool, CLAIM_TOOL, REPORT_TOOL } from '../lib/p2/claim-channel.js'

const T0 = 1729000000000

function makeStore() {
  return new TaskStore({ claimLeaseMs: 60000, stallThresholdMs: 60000, suspendedUnattendedMs: 300000, maxSupersedeDepth: 16 })
}

const A = { memberId: 'child-a', memberName: 'alpha' }
const B = { memberId: 'child-b', memberName: 'beta' }

test('MEMBER_TOOLS：claim/report 定义形状完整（name/description/parameters）', () => {
  assert.deepEqual(Object.keys(MEMBER_TOOLS).sort(), [CLAIM_TOOL, REPORT_TOOL].sort())
  for (const name of [CLAIM_TOOL, REPORT_TOOL]) {
    assert.equal(MEMBER_TOOLS[name].name, name)
    assert.ok(MEMBER_TOOLS[name].description.length > 0)
    assert.ok(MEMBER_TOOLS[name].parameters.properties.taskId)
  }
  assert.deepEqual(MEMBER_TOOLS[REPORT_TOOL].parameters.properties.status.enum, ['running', 'completed', 'failed'])
  // t96 · Slice 2（t95 low①）：note 描述与 store 能力对齐——不再声称写 lastNote
  const noteDesc = MEMBER_TOOLS[REPORT_TOOL].parameters.properties.note.description
  assert.ok(!noteDesc.includes('lastNote'), '不得再声称记录在任务 lastNote（store 无该字段）')
  assert.ok(noteDesc.includes('不入库'), '描述须如实声明 note 不入库（仅会话事件日志留痕）')
})

test('claim：pending → claimed，身份写入（claimedById/assignee）', () => {
  const store = makeStore()
  const cache = new Map()
  const t = store.createTask({ subject: 'x', dependencies: [], assignee: 'alpha' }, T0).task
  const r = executeMemberTool({ store, attemptCache: cache, now: T0 + 1 }, CLAIM_TOOL, { taskId: t.id }, A)
  assert.equal(r.ok, true)
  assert.equal(r.status, 'claimed')
  const task = store.tasks.get(t.id)
  assert.equal(task.status, 'claimed')
  assert.equal(task.claimedById, 'child-a')
  assert.equal(task.assignee, 'alpha')
  assert.equal(cache.get(t.id).memberId, 'child-a')
})

test('claim：非 pending 拒绝（claimed/running 不可重复认领）', () => {
  const store = makeStore()
  const cache = new Map()
  const t = store.createTask({ subject: 'x', dependencies: [], assignee: '' }, T0).task
  executeMemberTool({ store, attemptCache: cache, now: T0 + 1 }, CLAIM_TOOL, { taskId: t.id }, A)
  const again = executeMemberTool({ store, attemptCache: cache, now: T0 + 2 }, CLAIM_TOOL, { taskId: t.id }, A)
  assert.equal(again.ok, false)
  assert.equal(again.reason, ERR.TASK_NOT_CLAIMABLE)
})

test('claim：终态任务拒绝 + 依赖未就绪拒绝', () => {
  const store = makeStore()
  const cache = new Map()
  const t = store.createTask({ subject: 'x', dependencies: [], assignee: '' }, T0).task
  store.claim(t.id, { assignee: 'alpha', claimedById: 'child-a' }, T0 + 1)
  store.update(t.id, { attemptId: store.tasks.get(t.id).attemptId, revision: store.tasks.get(t.id).revision, status: 'completed' }, T0 + 2)
  const onTerminal = executeMemberTool({ store, attemptCache: cache, now: T0 + 3 }, CLAIM_TOOL, { taskId: t.id }, B)
  assert.equal(onTerminal.reason, ERR.TASK_TERMINAL)

  const t2 = store.createTask({ subject: 'y', dependencies: ['ghost'], assignee: '' }, T0).task
  const blocked = executeMemberTool({ store, attemptCache: cache, now: T0 + 4 }, CLAIM_TOOL, { taskId: t2.id }, B)
  assert.equal(blocked.reason, ERR.DEPENDENCY_BLOCKED)
})

test('report：running → completed 全链合法迁移', () => {
  const store = makeStore()
  const cache = new Map()
  const t = store.createTask({ subject: 'x', dependencies: [], assignee: 'alpha' }, T0).task
  executeMemberTool({ store, attemptCache: cache, now: T0 + 1 }, CLAIM_TOOL, { taskId: t.id }, A)
  const run = executeMemberTool({ store, attemptCache: cache, now: T0 + 2 }, REPORT_TOOL, { taskId: t.id, status: 'running' }, A)
  assert.equal(run.ok, true)
  assert.equal(store.tasks.get(t.id).status, 'running')
  assert.equal(store.tasks.get(t.id).startedAt, T0 + 2)
  const done = executeMemberTool({ store, attemptCache: cache, now: T0 + 3 }, REPORT_TOOL, { taskId: t.id, status: 'completed' }, A)
  assert.equal(done.ok, true)
  assert.equal(store.tasks.get(t.id).status, 'completed')
  assert.equal(store.isTerminal(t.id), true)
  assert.equal(cache.has(t.id), false, '终态后清理 attemptCache（防陈旧归属）')
})

test('report：非拥有者拒绝（归属校验）', () => {
  const store = makeStore()
  const cache = new Map()
  const t = store.createTask({ subject: 'x', dependencies: [], assignee: 'alpha' }, T0).task
  executeMemberTool({ store, attemptCache: cache, now: T0 + 1 }, CLAIM_TOOL, { taskId: t.id }, A)
  const steal = executeMemberTool({ store, attemptCache: cache, now: T0 + 2 }, REPORT_TOOL, { taskId: t.id, status: 'completed' }, B)
  assert.equal(steal.ok, false)
  assert.equal(steal.reason, 'task-not-owned')
  assert.equal(store.tasks.get(t.id).status, 'claimed', '他人不得改写')
})

test('report：外部已 supersede → CAS/迁移失败诚实返回（并发窗口）', () => {
  const store = makeStore()
  const cache = new Map()
  const t = store.createTask({ subject: 'x', dependencies: [], assignee: 'alpha' }, T0).task
  executeMemberTool({ store, attemptCache: cache, now: T0 + 1 }, CLAIM_TOOL, { taskId: t.id }, A)
  // 外部（如 checkUnattended 30min 安全网）在成员 report 前作了 supersede
  const sup = store.supersede(t.id, { revision: store.tasks.get(t.id).revision, supersededBy: 't2' }, T0 + 2)
  assert.equal(sup.ok, true)
  const report = executeMemberTool({ store, attemptCache: cache, now: T0 + 3 }, REPORT_TOOL, { taskId: t.id, status: 'completed' }, A)
  assert.equal(report.ok, false)
  assert.ok(['stale-revision', 'illegal-transition', 'attempt-mismatch'].includes(report.reason), '诚实失败：' + report.reason)
  assert.equal(store.tasks.get(t.id).status, 'superseded')
})

test('report：非法 status（UPDATE_STATUS 域外）拒绝', () => {
  const store = makeStore()
  const cache = new Map()
  const t = store.createTask({ subject: 'x', dependencies: [], assignee: 'alpha' }, T0).task
  executeMemberTool({ store, attemptCache: cache, now: T0 + 1 }, CLAIM_TOOL, { taskId: t.id }, A)
  const bad = executeMemberTool({ store, attemptCache: cache, now: T0 + 2 }, REPORT_TOOL, { taskId: t.id, status: 'suspended' }, A)
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'invalid-report-status')
})

test('边界：未知工具 / 身份缺失 / taskId 缺失 均拒绝', () => {
  const store = makeStore()
  const unknown = executeMemberTool({ store }, 'team_hack', {}, A)
  assert.equal(unknown.reason, 'unknown-member-tool')
  const noIdentity = executeMemberTool({ store }, CLAIM_TOOL, { taskId: 't1' }, undefined)
  assert.equal(noIdentity.reason, 'identity-required')
  const noIdentity2 = executeMemberTool({ store }, CLAIM_TOOL, { taskId: 't1' }, { memberId: 'x' })
  assert.equal(noIdentity2.reason, 'identity-required')
  const noTask = executeMemberTool({ store }, CLAIM_TOOL, {}, A)
  assert.equal(noTask.reason, 'taskId-required')
})