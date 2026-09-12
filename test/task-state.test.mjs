/**
 * P1 状态层核心测试（v4.3 设计稿 + v4.4 §2/§6 回填）—— test/task-state.test.mjs
 *
 * 覆盖：§1 schema / §2 状态机（S1/S2 环与自依赖、非法迁移拒绝）/ §7 CAS（S5）/
 * §6 S13 claim 原子性 / §3 依赖失效（S3 带戳继续）/ §2.1 S6 supersede 链 /
 * §4 reclaim 谓词（F4-b 保守）/ §5 suspend 三出口 + 超时自动升级（F3）/
 * §7 持久化（revision 连续）/ t75 修复判别（F1 update 域、F2 claim 依赖前置、
 * F3 悬空告警、F4 claim 身份）。
 *
 * 本文件是干净用例；「能变红」对照由 %TEMP% 变异脚本注入缺陷后跑同一批测试
 * （去 CAS / 去深度上限 / 允许第二个 attemptId → 对应用例精确变红；t75 新增
 * 去 update 域检查 / 去 claim 依赖前置 / 去悬空告警 三组变异，见 %TEMP%
 * t75-mutate.mjs）。
 *
 * F5 测试口径（t75）：本套件为纯核心测试，零环境性依赖、零 skip——任何环境下
 * 跑本文件的数字都应等价。引用全量 `npm test` 数字时必须绑定环境口径：
 * 裸检出下宿主用例（host-smoke 16 + host-events 23）因 peer 依赖 schemastery
 * 不可解析而**环境性 skip**（数字须单独列出并标注，skip ≠ pass）；junction
 * 临时树（见 docs/optimization/host-evidence-repro.md 步骤 A）下全量应 0 skip。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TaskStore, loadTaskStore, findCycle, ERR, UPDATE_STATUS } from '../lib/state/task-store.js'

const T0 = 1726000000000

/** 短阈值便于时间推进：lease 1000ms、stall 1000ms、unattended 5000ms。 */
function makeStore(now = T0) {
  return new TaskStore({ claimLeaseMs: 1000, stallThresholdMs: 1000, suspendedUnattendedMs: 5000, maxSupersedeDepth: 16 })
}

/** 常用旧值观察者：settled => idle；running/waiting => activity；unknown 第三态覆盖。 */
function observerOf(activityByAssignee = {}) {
  return {
    observeIdle: (id) => {
      const v = activityByAssignee[id]
      if (v === 'settled') return true
      if (v === 'running' || v === 'waiting') return false
      // 未知第三态：保守不回收（§4.1：NOT-idle）
      return false
    },
    lastSignalAtOf: (id) => {
      const v = activityByAssignee[id + ':signal']
      return v === undefined ? null : v
    },
  }
}

// ---------------------------------------------------------------- §1 / §2 状态机

test('S1: createTask/editDependencies 拒绝依赖环，错误信息指明环路径', () => {
  const store = makeStore()
  const t1 = store.createTask({ subject: 'a', dependencies: [], assignee: 'r1' }, T0).task
  store.createTask({ subject: 'b', dependencies: [t1.id], assignee: 'r2' }, T0 + 1)
  // t1 改为依赖 t2 → t1←t2 成环（S11：editPlan 入口同样校验）
  const res = store.editDependencies(t1.id, { revision: store.tasks.get(t1.id).revision, dependencies: ['t2'] }, T0 + 2)
  assert.equal(res.ok, false)
  assert.equal(res.reason, ERR.CYCLE)
  assert.ok(String(res.message).includes('环'), '环路径必须在错误信息中：' + res.message)
  assert.ok(res.cycle.length >= 3, '环路径应完整：' + JSON.stringify(res.cycle))
  // 拒绝后依赖未被写入（不静默改写）
  assert.deepEqual(store.tasks.get(t1.id).dependencies, [], '拒绝后依赖保持不变')
})

test('S2: 自依赖被拒绝（错误信息区分）', () => {
  const store = makeStore()
  const t = store.createTask({ subject: 'x', dependencies: [], assignee: 'r1' }, T0).task
  const res = store.editDependencies(t.id, { revision: store.tasks.get(t.id).revision, dependencies: [t.id] }, T0 + 1)
  assert.equal(res.ok, false)
  assert.equal(res.reason, ERR.SELF_DEPENDENCY, '自依赖单独成码')
  // findCycle 对自依赖形态也判环（长度为 1 的环）
  const graph = new Map([['t1', { id: 't1', dependencies: ['t1'] }]])
  assert.ok(findCycle(graph) !== null, '自依赖 = 长度为 1 的环，Kahn 拒绝')
})

test('§2: 状态机拒绝非法迁移并给明确错误，不静默改写', () => {
  const store = makeStore(T0)
  const created = store.createTask({ subject: 'x', dependencies: [], assignee: 'r1' }, T0).task
  // pending → completed 非法（须先 claim/update running）
  const bad = store.update(created.id, { attemptId: 'nope', revision: created.revision, status: 'completed' }, T0)
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, ERR.ILLEGAL_TRANSITION)
  // 终态不可再迁移
  const c = store.claim(created.id, T0)
  store.update(created.id, { attemptId: c.attemptId, revision: c.revision, status: 'running' }, T0 + 1)
  store.update(created.id, { attemptId: c.attemptId, revision: store.tasks.get(created.id).revision, status: 'completed' }, T0 + 2)
  const again = store.update(created.id, { attemptId: c.attemptId, revision: store.tasks.get(created.id).revision, status: 'running' }, T0 + 3)
  assert.equal(again.ok, false)
  assert.equal(again.reason, ERR.ILLEGAL_TRANSITION)
  assert.equal(store.tasks.get(created.id).status, 'completed', '拒绝后状态未被静默改写')
})

// ---------------------------------------------------------------- §7 CAS（S5）

test('S5: stale revision 被拒绝（CAS 防后写覆盖）', () => {
  const store = makeStore(T0)
  const created = store.createTask({ subject: 'x', dependencies: [], assignee: 'r1' }, T0).task
  const c = store.claim(created.id, T0)
  store.update(created.id, { attemptId: c.attemptId, revision: c.revision, status: 'running' }, T0 + 1)
  // running@r3：A 提交 completed（期望 r3）成功 → r4；B 提交 superseded（仍期望 r3）→ stale-revision，
  // 不可能后写覆盖先写（设计稿 §2.1 S5 示例：后到者收到 stale-revision 需重读）。
  const r3 = store.tasks.get(created.id).revision
  const a = store.update(created.id, { attemptId: c.attemptId, revision: r3, status: 'completed' }, T0 + 2)
  assert.equal(a.ok, true)
  const b = store.supersede(created.id, { revision: r3, supersededBy: null }, T0 + 3)
  assert.equal(b.ok, false)
  assert.equal(b.reason, ERR.STALE_REVISION, '后写者必须收到 stale-revision')
  assert.equal(store.tasks.get(created.id).status, 'completed', '先写者胜出，不被覆盖')
  // 终态 + 正确 revision 作废 → 明确非法（终态不可逆，§6 表）
  const term = store.supersede(created.id, { revision: store.tasks.get(created.id).revision, supersededBy: null }, T0 + 4)
  assert.equal(term.ok, false)
  assert.equal(term.reason, ERR.ILLEGAL_TRANSITION, '终态不可逆，报明确错误而非静默')
})

test('§7: 每次状态写 revision 单调递增，读-改-写经 compareAndSet', () => {
  const store = makeStore(T0)
  const t = store.createTask({ subject: 'x', dependencies: [], assignee: 'r1' }, T0).task
  assert.equal(t.revision, 1)
  const c = store.claim(t.id, T0)
  assert.equal(c.revision, 2)
  const up = store.update(t.id, { attemptId: c.attemptId, revision: c.revision, status: 'running' }, T0 + 1)
  assert.equal(up.revision, 3)
  assert.equal(store.tasks.get(t.id).revision, 3)
})

// ---------------------------------------------------------------- §6 S13 claim 原子性

test('S13: 并发双 claim 只有一个成功，第二个无新 attemptId', async () => {
  const store = makeStore(T0)
  const t = store.createTask({ subject: 'x', dependencies: [], assignee: '' }, T0).task
  // 模拟并发：Promise.all 两个 claim（宿主侧单线程 CAS 串行化，语义与顺序并发等价）。
  const [a, b] = await Promise.all([store.claim(t.id, T0 + 1), store.claim(t.id, T0 + 2)])
  const wins = [a, b].filter((r) => r.ok === true)
  const loses = [a, b].filter((r) => r.ok === false)
  assert.equal(wins.length, 1, '双 claim 必须恰好一个成功')
  assert.equal(loses.length, 1)
  assert.equal(loses[0].reason, ERR.TASK_NOT_CLAIMABLE)
  assert.equal(loses[0].currentStatus, 'claimed')
  assert.ok(loses[0].attemptId === undefined, '失败的 claim 不得生成第二个 attemptId')
  assert.ok(wins[0].attemptId && typeof wins[0].attemptId === 'string', '胜者有 attemptId')
  assert.equal(store.tasks.get(t.id).attemptId, wins[0].attemptId, 'store 里只有一个 attemptId')
})

test('S13: claimed/running/suspended → task-not-claimable；终态 → task-terminal', () => {
  const store = makeStore(T0)
  const t = store.createTask({ subject: 'x', dependencies: [], assignee: '' }, T0).task
  const c = store.claim(t.id, T0)
  assert.equal(store.tasks.get(t.id).status, 'claimed')
  assert.equal(store.claim(t.id, T0 + 1).reason, ERR.TASK_NOT_CLAIMABLE)
  store.update(t.id, { attemptId: c.attemptId, revision: c.revision, status: 'running' }, T0 + 2)
  assert.equal(store.tasks.get(t.id).status, 'running')
  assert.equal(store.claim(t.id, T0 + 3).reason, ERR.TASK_NOT_CLAIMABLE)
  store.suspend(t.id, { revision: store.tasks.get(t.id).revision }, T0 + 4)
  assert.equal(store.tasks.get(t.id).status, 'suspended')
  assert.equal(store.claim(t.id, T0 + 5).reason, ERR.TASK_NOT_CLAIMABLE)
  // 终态
  const t2 = store.createTask({ subject: 'y', dependencies: [], assignee: '' }, T0 + 6).task
  const c2 = store.claim(t2.id, T0 + 7)
  store.update(t2.id, { attemptId: c2.attemptId, revision: c2.revision, status: 'completed' }, T0 + 8)
  const term = store.claim(t2.id, T0 + 9)
  assert.equal(term.reason, ERR.TASK_TERMINAL)
  assert.equal(term.currentStatus, 'completed')
})

// ---------------------------------------------------------------- §3 依赖失效（S3）

test('S3: 依赖作废 → 下游写 dependencySupersededAt 并解锁（带戳继续）', () => {
  const store = makeStore(T0)
  const dep = store.createTask({ subject: 'dep', dependencies: [], assignee: 'r1' }, T0).task
  const child = store.createTask({ subject: 'child', dependencies: [dep.id], assignee: 'r2' }, T0 + 1).task
  assert.equal(store.dependencyBlocked(child.id), true, '依赖未完成时下游 blocked')
  assert.equal(store.taskOpen(child.id), false)
  const c = store.claim(dep.id, T0 + 2)
  store.update(dep.id, { attemptId: c.attemptId, revision: c.revision, status: 'running' }, T0 + 3)
  const s = store.supersede(dep.id, { revision: store.tasks.get(dep.id).revision, supersededBy: null }, T0 + 4)
  assert.equal(s.ok, true)
  assert.equal(store.tasks.get(child.id).dependencySupersededAt, T0 + 4, '下游必须获得作废戳')
  assert.equal(store.dependencyBlocked(child.id), false, 'superseded 属 terminal → 下游解锁')
  assert.equal(store.taskOpen(child.id), true, 'pending 且依赖全 terminal → taskOpen')
})

test('§3: 依赖 failed 也解锁下游并写 dependencyFailedAt（t6 死锁消除）', () => {
  const store = makeStore(T0)
  const dep = store.createTask({ subject: 'dep', dependencies: [], assignee: 'r1' }, T0).task
  const child = store.createTask({ subject: 'child', dependencies: [dep.id], assignee: 'r2' }, T0 + 1).task
  const c = store.claim(dep.id, T0 + 2)
  store.update(dep.id, { attemptId: c.attemptId, revision: c.revision, status: 'running' }, T0 + 3)
  store.update(dep.id, { attemptId: c.attemptId, revision: store.tasks.get(dep.id).revision, status: 'failed' }, T0 + 4)
  assert.equal(store.tasks.get(child.id).dependencyFailedAt, T0 + 4)
  assert.equal(store.dependencyBlocked(child.id), false, 'failed 也是 terminal，不再堵死下游')
})

// ---------------------------------------------------------------- §2.1 S6 supersede 链

test('S6: supersededBy 链遍历 visited + 深度上限，超深报错而非死循环', () => {
  const store = makeStore(T0)
  // 构造目标链 t1→t2→…→t18（17 层 > maxDepth 16）：t_i 被作废、supersededBy=t_{i+1}。
  for (let i = 1; i <= 18; i += 1) {
    store.createTask({ subject: 'chain' + i, dependencies: [], assignee: 'r' + i }, T0 + i)
  }
  for (let i = 1; i <= 17; i += 1) {
    const prev = 't' + i
    const res = store.supersede(prev, { revision: store.tasks.get(prev).revision, supersededBy: 't' + (i + 1) }, T0 + 100 + i)
    assert.equal(res.ok, true, '链构造第 ' + i + ' 步应成功')
  }
  // 最后建 t19（不在链上），对它作废指向 t1：目标链 t1→…→t18 为 17 层 > 16 → 超深拒绝，不死循环
  store.createTask({ subject: 't19', dependencies: [], assignee: 'r19' }, T0 + 200)
  const res = store.supersede('t19', { revision: store.tasks.get('t19').revision, supersededBy: 't1' }, T0 + 300)
  assert.equal(res.ok, false)
  assert.equal(res.reason, ERR.SUPERSEDE_DEPTH)
})

test('S6: supersededBy 链成环（A→B→A）被拒绝', () => {
  const store = makeStore(T0)
  const a = store.createTask({ subject: 'a', dependencies: [], assignee: 'r1' }, T0).task
  const b = store.createTask({ subject: 'b', dependencies: [], assignee: 'r2' }, T0 + 1).task
  // a superseded by b
  assert.equal(store.supersede(a.id, { revision: store.tasks.get(a.id).revision, supersededBy: b.id }, T0 + 2).ok, true)
  // b superseded by a → a 的链已含 b（b.supersededBy=a），目标=a 的链含 b → b supersede 目标 a 时链为 a.supersededBy=b... 环
  const res = store.supersede(b.id, { revision: store.tasks.get(b.id).revision, supersededBy: a.id }, T0 + 3)
  assert.equal(res.ok, false)
  assert.equal(res.reason, ERR.SUPERSEDE_CYCLE)
})

// ---------------------------------------------------------------- §4 reclaim 谓词（F4-b）

test('§4: reclaim 只回收 claimed + 超 lease + 宿主观测 settled（startedAt 不参与）', () => {
  const store = makeStore(T0)
  const t = store.createTask({ subject: 'x', dependencies: [], assignee: 'r1' }, T0).task
  const c = store.claim(t.id, T0)
  // 未超 lease → 不可回收
  assert.equal(store.canReclaim(t.id, observerOf({ r1: 'settled' }), T0 + 500), false)
  // 超 lease + settled → 可回收（成员从未真正干活；startedAt 若被写了也不影响判定）
  assert.equal(store.canReclaim(t.id, observerOf({ r1: 'settled' }), T0 + 1500), true)
  // 观测到 running → 永不回收
  assert.equal(store.canReclaim(t.id, observerOf({ r1: 'running' }), T0 + 1500), false)
  // 未知第三态 → 保守不回收
  assert.equal(store.canReclaim(t.id, observerOf({ r1: 'paused-mystery' }), T0 + 1500), false)
  // 近信号 → 不回收
  assert.equal(store.canReclaim(t.id, observerOf({ r1: 'settled', 'r1:signal': T0 + 1400 }), T0 + 1500), false)
  // startedAt 已写（claimed→running 场景被排除在外——running 不 reclaim；这里验证 startedAt 不参与 claimed 判定）
})

test('§4.3: running 残留不 reclaim，走 stall→suspended（防双执行）', () => {
  const store = makeStore(T0)
  const t = store.createTask({ subject: 'x', dependencies: [], assignee: 'r1' }, T0).task
  const c = store.claim(t.id, T0)
  store.update(t.id, { attemptId: c.attemptId, revision: c.revision, status: 'running' }, T0 + 1)
  // running 不可 reclaim（即使观察 idle）
  const reclaim = store.reclaim(t.id, observerOf({ r1: 'settled' }), T0 + 1500)
  assert.equal(reclaim.ok, false)
  assert.equal(reclaim.reason, 'not-reclaimable')
  // 停滞 → stallMarked（疑似，人工确认）
  const stall = store.stallMark(t.id, observerOf({ r1: 'settled' }), T0 + 2000)
  assert.equal(stall.ok, true)
  assert.equal(store.tasks.get(t.id).stallMarked, true)
  assert.equal(store.tasks.get(t.id).status, 'running', 'stall 是标记不是状态')
  // 人工确认 → suspended（不回收）
  const susp = store.suspend(t.id, { revision: store.tasks.get(t.id).revision }, T0 + 2001)
  assert.equal(susp.ok, true)
  assert.equal(store.tasks.get(t.id).status, 'suspended')
})

// ---------------------------------------------------------------- §5 suspend 三出口 + F3

test('§5: suspended 出口① resume 带 stale 校验，返回原 attemptId', () => {
  const store = makeStore(T0)
  const t = store.createTask({ subject: 'x', dependencies: [], assignee: 'r1' }, T0).task
  const c = store.claim(t.id, T0)
  store.update(t.id, { attemptId: c.attemptId, revision: c.revision, status: 'running' }, T0 + 1)
  store.suspend(t.id, { revision: store.tasks.get(t.id).revision }, T0 + 2)
  // stale revision 拒绝
  const stale = store.resume(t.id, { revision: 999 }, T0 + 3)
  assert.equal(stale.ok, false)
  assert.equal(stale.reason, ERR.STALE_REVISION)
  // 正确 revision → 恢复 running，attemptId 不变
  const ok = store.resume(t.id, { revision: store.tasks.get(t.id).revision }, T0 + 3)
  assert.equal(ok.ok, true)
  assert.equal(ok.attemptId, c.attemptId, '恢复沿用原 attemptId')
  assert.equal(store.tasks.get(t.id).status, 'running')
})

test('§5: suspended 出口② reassign 重派新 assignee + 新 attemptId', () => {
  const store = makeStore(T0)
  const t = store.createTask({ subject: 'x', dependencies: [], assignee: 'r1' }, T0).task
  const c = store.claim(t.id, T0)
  store.update(t.id, { attemptId: c.attemptId, revision: c.revision, status: 'running' }, T0 + 1)
  store.suspend(t.id, { revision: store.tasks.get(t.id).revision }, T0 + 2)
  const ok = store.reassign(t.id, { revision: store.tasks.get(t.id).revision, to: 'r2' }, T0 + 3)
  assert.equal(ok.ok, true)
  const now = store.tasks.get(t.id)
  assert.equal(now.status, 'claimed')
  assert.equal(now.assignee, 'r2')
  assert.notEqual(now.attemptId, c.attemptId, '重派生成新 attemptId')
})

test('§5: suspended 出口③ supersede 作废并解锁下游', () => {
  const store = makeStore(T0)
  const dep = store.createTask({ subject: 'dep', dependencies: [], assignee: 'r1' }, T0).task
  const child = store.createTask({ subject: 'child', dependencies: [dep.id], assignee: 'r2' }, T0 + 1).task
  const c = store.claim(dep.id, T0 + 2)
  store.update(dep.id, { attemptId: c.attemptId, revision: c.revision, status: 'running' }, T0 + 3)
  store.suspend(dep.id, { revision: store.tasks.get(dep.id).revision }, T0 + 4)
  const ok = store.supersede(dep.id, { revision: store.tasks.get(dep.id).revision, supersededBy: null }, T0 + 5)
  assert.equal(ok.ok, true)
  assert.equal(store.tasks.get(child.id).dependencySupersededAt, T0 + 5)
  assert.equal(store.taskOpen(child.id), true, '作废后下游解锁')
})

test('§5 F3: SUSPENDED_UNATTENDED_MS 超时自动 superseded，无人处理不可永远挂着', () => {
  const store = makeStore(T0)
  const dep = store.createTask({ subject: 'dep', dependencies: [], assignee: 'r1' }, T0).task
  const child = store.createTask({ subject: 'child', dependencies: [dep.id], assignee: 'r2' }, T0 + 1).task
  const c = store.claim(dep.id, T0 + 2)
  store.update(dep.id, { attemptId: c.attemptId, revision: c.revision, status: 'running' }, T0 + 3)
  store.suspend(dep.id, { revision: store.tasks.get(dep.id).revision }, T0 + 4)
  // 未到阈值不自动处理；到阈值自动转 superseded（掉档后再也到不了「永久挂着」）
  assert.deepEqual(store.checkUnattended(T0 + 4000), [], '未到 5000ms 阈值不处理')
  const auto = store.checkUnattended(T0 + 10000)
  assert.deepEqual(auto, [dep.id], '超时自动作废该 suspended 任务')
  assert.equal(store.tasks.get(dep.id).status, 'superseded')
  assert.equal(store.tasks.get(child.id).dependencySupersededAt !== null, true, '自动作废同样解锁下游')
})

test('§4.5 修法⑦: suspended 观测到新活动自动回 running（续租防误判）', () => {
  const store = makeStore(T0)
  const t = store.createTask({ subject: 'x', dependencies: [], assignee: 'r1' }, T0).task
  const c = store.claim(t.id, T0)
  store.update(t.id, { attemptId: c.attemptId, revision: c.revision, status: 'running' }, T0 + 1)
  store.suspend(t.id, { revision: store.tasks.get(t.id).revision }, T0 + 2)
  const act = store.observeActivity(t.id, T0 + 3)
  assert.equal(act.ok, true)
  assert.equal(act.status, 'running', 'suspended 续租到新活动自动回 running')
  assert.equal(store.tasks.get(t.id).suspended, false)
  assert.equal(store.tasks.get(t.id).attemptId, c.attemptId, '不清空 attemptId')
})

// ---------------------------------------------------------------- §7 持久化

test('§7: save 用临时文件 + 原子写（writer 记录 tmp → rename）', () => {
  const store = makeStore(T0)
  store.createTask({ subject: 'persist', dependencies: [], assignee: 'r1' }, T0)
  const calls = []
  const files = new Map()
  const writer = {
    write(tmp, payload) { calls.push(['write', tmp]); files.set(tmp, payload) },
    rename(tmp, path) { calls.push(['rename', tmp, path]); files.set(path, files.get(tmp)); files.delete(tmp) },
  }
  const res = store.save('/t/team.json', writer)
  assert.equal(res.ok, true)
  assert.ok(calls.some((c) => c[0] === 'write'), '先写临时文件')
  assert.ok(calls.some((c) => c[0] === 'rename'), 'rename 原子替换')
  assert.ok(files.has('/t/team.json'), '最终文件存在')
  assert.ok(![...files.keys()].some((k) => k.endsWith('.tmp')), '无临时文件残留')
})

test('§7: 重载后 revision 连续，崩溃重启以磁盘为准', () => {
  const store = makeStore(T0)
  const t = store.createTask({ subject: 'persist', dependencies: [], assignee: 'r1' }, T0).task
  const c = store.claim(t.id, T0)
  store.update(t.id, { attemptId: c.attemptId, revision: c.revision, status: 'running' }, T0 + 1)
  const files = new Map()
  const writer = {
    write(tmp, payload) { files.set(tmp, payload) },
    rename(tmp, path) { files.set(path, files.get(tmp)); files.delete(tmp) },
  }
  store.save('/t/team.json', writer)
  // 崩溃重启：从磁盘重建
  const reloaded = loadTaskStore('/t/team.json', (p) => files.get(p))
  const tAfter = reloaded.tasks.get(t.id)
  assert.equal(tAfter.status, 'running', '重启后状态以磁盘为准')
  assert.equal(tAfter.revision, 3, 'revision 从磁盘原样恢复（连续）')
  assert.equal(tAfter.attemptId, c.attemptId)
  // 同一任务再 claim → not-claimable（磁盘态 claimed/running 生效，不复活第二个 attemptId）
  const second = reloaded.claim(t.id, T0 + 100)
  assert.equal(second.ok, false)
  assert.equal(second.reason, ERR.TASK_NOT_CLAIMABLE)
  // 新建任务 seq 连续（磁盘 nextSeq 恢复）
  const fresh = reloaded.createTask({ subject: 'fresh', dependencies: [], assignee: 'r2' }, T0 + 101)
  assert.equal(fresh.ok, true)
  assert.equal(fresh.task.id, 't2', 'nextSeq 从磁盘继续，id 单调连续')
})

// ---------------------------------------------------------------- §3 依赖判定

test('§3: taskOpen = pending && 依赖全 terminal', () => {
  const store = makeStore(T0)
  const dep = store.createTask({ subject: 'dep', dependencies: [], assignee: 'r1' }, T0).task
  const child = store.createTask({ subject: 'child', dependencies: [dep.id], assignee: 'r2' }, T0 + 1).task
  assert.equal(store.taskOpen(child.id), false)
  const c = store.claim(dep.id, T0 + 2)
  store.update(dep.id, { attemptId: c.attemptId, revision: c.revision, status: 'completed' }, T0 + 3)
  assert.equal(store.taskOpen(child.id), true)
})

// ---------------------------------------------------------------- t75 修复判别（F1-F4）

test('t75-F1: update 拒绝域外 status（superseded/suspended 只能走专用端点），S3 传播不被绕过', () => {
  const store = makeStore(T0)
  const dep = store.createTask({ subject: 'dep', dependencies: [], assignee: 'r1' }, T0).task
  const child = store.createTask({ subject: 'child', dependencies: [dep.id], assignee: 'r2' }, T0 + 1).task
  const c = store.claim(dep.id, T0 + 2)
  store.update(dep.id, { attemptId: c.attemptId, revision: c.revision, status: 'running' }, T0 + 3)
  // 域外：update 提交 superseded → 拒绝（§6:250 形状 = UPDATE_STATUS）
  const viaUpdate = store.update(dep.id, { attemptId: c.attemptId, revision: store.tasks.get(dep.id).revision, status: 'superseded' }, T0 + 4)
  assert.equal(viaUpdate.ok, false, 'update 不得提交 superseded（t74-F1 缺口关闭）')
  assert.equal(viaUpdate.reason, ERR.ILLEGAL_TRANSITION)
  assert.deepEqual(viaUpdate.allowedStatus, UPDATE_STATUS, '拒绝指明合法域')
  assert.equal(store.tasks.get(dep.id).status, 'running', '拒绝后状态未被改写')
  // 域外：update 提交 suspended → 同样拒绝（suspend 需人工确认通道）
  const viaUpdate2 = store.update(dep.id, { attemptId: c.attemptId, revision: store.tasks.get(dep.id).revision, status: 'suspended' }, T0 + 5)
  assert.equal(viaUpdate2.ok, false)
  assert.equal(viaUpdate2.reason, ERR.ILLEGAL_TRANSITION)
  // 绕过路径消失：update 被拒 → 无作废发生 → 下游不写戳、保持阻塞（不再「解锁却无戳」）
  assert.equal(store.tasks.get(child.id).dependencySupersededAt, null, 'update 被拒 → 不产生作废戳')
  assert.equal(store.taskOpen(child.id), false, '依赖未走正道作废 → 下游保持阻塞（S3 语义自洽）')
  // 对照：走 supersede 端点（正道）→ 戳传播保持有效（本修复不伤 S3 正道）
  const viaEndpoint = store.supersede(dep.id, { revision: store.tasks.get(dep.id).revision, supersededBy: null }, T0 + 6)
  assert.equal(viaEndpoint.ok, true)
  assert.equal(store.tasks.get(child.id).dependencySupersededAt, T0 + 6, '正道 supersede 的传播保持有效')
})

test('t75-F2: claim 拒绝依赖未 terminal 的任务（dependency-blocked），解锁后可认领', () => {
  const store = makeStore(T0)
  const dep = store.createTask({ subject: 'dep', dependencies: [], assignee: 'r1' }, T0).task
  const child = store.createTask({ subject: 'child', dependencies: [dep.id], assignee: 'r2' }, T0 + 1).task
  const early = store.claim(child.id, T0 + 2)
  assert.equal(early.ok, false, '依赖未 terminal 不可被 claim（t74-F2 缺口关闭）')
  assert.equal(early.reason, ERR.DEPENDENCY_BLOCKED)
  assert.deepEqual(early.blockedBy, [dep.id], '拒绝指明阻塞来源')
  assert.equal(store.tasks.get(child.id).attemptId, null, '被拒不生成 attemptId')
  assert.equal(store.tasks.get(child.id).status, 'pending', '被拒后状态不变')
  // 依赖 terminal（completed）→ 解锁可认领（taskOpen 的依赖半边在 claim 入口生效）
  const c = store.claim(dep.id, T0 + 3)
  store.update(dep.id, { attemptId: c.attemptId, revision: c.revision, status: 'completed' }, T0 + 4)
  assert.equal(store.taskOpen(child.id), true)
  const late = store.claim(child.id, T0 + 5)
  assert.equal(late.ok, true, '依赖 terminal 后可认领')
  // failed 也是 terminal → 同样解锁（§3 t6 死锁消除在 claim 入口同样成立）
  const dep2 = store.createTask({ subject: 'dep2', dependencies: [], assignee: 'r1' }, T0 + 6).task
  const child2 = store.createTask({ subject: 'child2', dependencies: [dep2.id], assignee: 'r2' }, T0 + 7).task
  const c2 = store.claim(dep2.id, T0 + 8)
  store.update(dep2.id, { attemptId: c2.attemptId, revision: c2.revision, status: 'failed' }, T0 + 9)
  assert.equal(store.claim(child2.id, T0 + 10).ok, true, 'failed 属 terminal → claim 解锁')
})

test('t75-F3: 悬空依赖入口告警 + 语义统一（§3 阻塞不变，不再静默）', () => {
  const store = makeStore(T0)
  const res = store.createTask({ subject: 'typo', dependencies: ['t99'], assignee: 'r' }, T0)
  assert.equal(res.ok, true, '悬空依赖仍被接受（前向引用合法：id 单调分配，未来任务可满足）')
  assert.ok(Array.isArray(res.warnings) && res.warnings.length === 1, '必须带可观测告警：' + JSON.stringify(res.warnings))
  assert.ok(String(res.warnings[0]).includes('t99'), '告警指明悬空 id')
  // §3 语义保持：悬空 = 阻塞 → 不静默就绪（与入口告警共同消除「静默永不就绪」）
  assert.equal(store.dependencyBlocked('t1'), true)
  assert.equal(store.taskOpen('t1'), false)
  // editDependencies 入口同样告警（S11：全部任务入口同一语义）
  store.createTask({ subject: 'ok', dependencies: [], assignee: 'r' }, T0 + 1)
  const edit = store.editDependencies('t2', { revision: store.tasks.get('t2').revision, dependencies: ['t77'] }, T0 + 2)
  assert.equal(edit.ok, true)
  assert.ok(Array.isArray(edit.warnings) && edit.warnings.some((w) => String(w).includes('t77')), 'edit 入口同样告警：' + JSON.stringify(edit.warnings))
  // 引用已存在任务不发告警（不产生噪音）
  const clean = store.createTask({ subject: 'clean', dependencies: ['t1'], assignee: 'r' }, T0 + 3)
  assert.equal(clean.ok, true)
  assert.deepEqual(clean.warnings, [], '引用已存在任务不发告警')
})

test('t75-F4: claim 写入 claimedById/assignee（§1 防误认领），旧签名向后兼容', () => {
  const store = makeStore(T0)
  const t1 = store.createTask({ subject: 'a', dependencies: [], assignee: '' }, T0).task
  const c1 = store.claim(t1.id, { claimedById: 'session-abc' }, T0 + 1)
  assert.equal(c1.ok, true)
  assert.equal(store.tasks.get(t1.id).claimedById, 'session-abc', 'claimedById 落库（§1 防误认领）')
  assert.equal(store.tasks.get(t1.id).assignee, 'session-abc', 'assignee 缺省由 claimedById 补空')
  // 显式 assignee 优先于 claimedById 推导
  const t2 = store.createTask({ subject: 'b', dependencies: [], assignee: '' }, T0 + 2).task
  store.claim(t2.id, { claimedById: 'session-def', assignee: 'eng1' }, T0 + 3)
  assert.equal(store.tasks.get(t2.id).claimedById, 'session-def')
  assert.equal(store.tasks.get(t2.id).assignee, 'eng1', '显式 assignee 优先')
  // 旧签名（number = now）不写身份——既有调用方行为逐字节不变
  const t3 = store.createTask({ subject: 'c', dependencies: [], assignee: 'r9' }, T0 + 4).task
  const c3 = store.claim(t3.id, T0 + 5)
  assert.equal(c3.ok, true)
  assert.equal(store.tasks.get(t3.id).claimedById, null, '旧签名不写 claimedById（向后兼容）')
  assert.equal(store.tasks.get(t3.id).assignee, 'r9', '旧签名不改 assignee')
})

// ---------------------------------------------------------------- t106 · schema v2（P3 契约四件套收编）

test('t106-v2: createTask 收编 constraints/knownRisks 扩展列（缺省空数组，旧调用零感知）', () => {
  const store = makeStore(T0)
  const t = store.createTask({
    subject: '带契约的任务',
    dependencies: [],
    assignee: 'eng',
    constraints: ['node>=22', '不引入新依赖'],
    knownRisks: ['LLM 配额耗尽', '外部 API 不可用'],
  }, T0).task
  assert.deepEqual(t.constraints, ['node>=22', '不引入新依赖'], 'constraints 列收编')
  assert.deepEqual(t.knownRisks, ['LLM 配额耗尽', '外部 API 不可用'], 'knownRisks 列收编')
  // 旧形态调用（无这两字段）→ 缺省空数组，零感知
  const legacy = store.createTask({ subject: '旧形态', dependencies: [], assignee: '' }, T0 + 1).task
  assert.deepEqual(legacy.constraints, [])
  assert.deepEqual(legacy.knownRisks, [])
  // 非字符串项被过滤（列表规整）
  const dirty = store.createTask({ subject: 'd', dependencies: [], constraints: ['ok', 42, null], assignee: '' }, T0 + 2).task
  assert.deepEqual(dirty.constraints, ['ok'])
})

test('t106-v2: serialize 携带 schemaVersion=2；snapshotRow 投影含两列', () => {
  const store = makeStore(T0)
  const t = store.createTask({ subject: 'x', dependencies: [], constraints: ['c1'], knownRisks: ['r1'], assignee: '' }, T0).task
  const serialized = store.serialize()
  assert.equal(serialized.schemaVersion, 2, '版本化声明（P1 契约增量清单见 p3-impl-baseline.md）')
  const row = store.snapshotRow(t.id)
  assert.deepEqual(row.constraints, ['c1'])
  assert.deepEqual(row.knownRisks, ['r1'])
})

test('t106-v2: v1 旧文件零迁移兼容（缺列补空数组，schemaVersion 记录磁盘版本）', () => {
  const store = makeStore(T0)
  const t = store.createTask({ subject: 'persist-v2', dependencies: [], constraints: ['keep-me'], assignee: 'r1' }, T0).task
  const files = new Map()
  store.save('/t/team.json', {
    write(tmp, payload) { files.set(tmp, payload) },
    rename(tmp, path) { files.set(path, files.get(tmp)); files.delete(tmp) },
  })
  // 模拟 v1 文件：剥掉 schemaVersion 与 v2 列
  const raw = JSON.parse(files.get('/t/team.json'))
  const v1 = { nextSeq: raw.nextSeq, options: raw.options, tasks: {} }
  for (const [id, record] of Object.entries(raw.tasks)) {
    const { constraints, knownRisks, ...rest } = record
    void constraints
    void knownRisks
    v1.tasks[id] = rest
  }
  files.set('/t/team-v1.json', JSON.stringify(v1))
  const reloaded = loadTaskStore('/t/team-v1.json', (p) => files.get(p))
  assert.equal(reloaded.schemaVersion, 1, '磁盘版本如实记录')
  assert.deepEqual(reloaded.tasks.get(t.id).constraints, [], 'v1 缺列补空数组（零迁移兼容）')
  assert.equal(reloaded.tasks.get(t.id).status, 'pending', '其余字段原样恢复')
  // v2 文件往返：v2 列从磁盘原样恢复
  const reloadedV2 = loadTaskStore('/t/team.json', (p) => files.get(p))
  assert.equal(reloadedV2.schemaVersion, 2)
  assert.deepEqual(reloadedV2.tasks.get(t.id).constraints, ['keep-me'], 'v2 列从磁盘原样恢复')
})