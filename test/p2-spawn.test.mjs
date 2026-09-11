/**
 * P2 自建成员通道测试（E4 落地 + B′ 受控端到端）—— test/p2-spawn.test.mjs
 *
 * 覆盖：
 *   - buildMemberLabel：`dsh-team-chat:<teamId>:<memberName>` 前缀隔离；
 *   - buildContinuableStartSpec：逐字段对齐平台契约（ContinuableStartSpec +
 *     SubagentStartRequest，t91 E4 取证），persona/agentOptions/toolFilter/prompt 全映射；
 *   - spawnMember：provider 能力检查（缺 provider / 无 continuable / 无 persona /
 *     无 toolFilter / parent 未解析 → 各自明确失败，不静默）；成功路径返回 childId/label；
 *   - 受控端到端（B′ 联合）：create pending → spawnMember(受控桩) → executeMemberTool
 *     claim → report running → report completed → store 终态（隔离验证纪律：
 *     桩只替代平台 startContinuable 执行器，store/工具执行器/渲染全部真实代码）。
 *
 * 判别（能变红）见 %TEMP%/dsh-t92-mutate/（mut-p2-spawn-claim.js：把 claim 直调改成
 * 空操作 → 端到端用例的 claim 断言精确变红；mut-p2-toolfilter.js：去掉 allow 白名单
 * → 白名单断言变红）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TaskStore } from '../lib/state/task-store.js'
import {
  MEMBER_LABEL_PREFIX,
  buildMemberLabel,
  buildContinuableStartSpec,
  spawnMember,
} from '../lib/p2/spawn.js'
import { executeMemberTool, CLAIM_TOOL, REPORT_TOOL } from '../lib/p2/claim-channel.js'
import { renderMemberPersona, renderMemberWelcome, MEMBER_TOOL_NAMES } from '../lib/p2/persona.js'

const T0 = 1729000000000

function makeStore() {
  return new TaskStore({ claimLeaseMs: 60000, stallThresholdMs: 60000, suspendedUnattendedMs: 300000, maxSupersedeDepth: 16 })
}

/** 受控 subagents 桩：记录收到的 spec，返回固定 childId/messageId。 */
function stubSubagents(overrides = {}) {
  const calls = []
  return {
    calls,
    deps: {
      getProvider(name) {
        if (overrides.provider === undefined) {
          return {
            name,
            prepareContinuable: async () => ({ seed: [] }),
            capabilities: { persona: true, toolFilter: true },
          }
        }
        return overrides.provider
      },
      startContinuable: async (spec) => {
        calls.push(spec)
        return { childId: overrides.childId ?? 'child-1', messageId: overrides.messageId ?? 'msg-1' }
      },
    },
  }
}

const team = { id: 't92demo', name: 't92 测试队', description: '隔离验证目的，不入池', profile: { protocol: '仅测试' } }
const member = { name: 'probe1', role: 'engineer', provider: 'probe-provider', model: 'probe-model', executionPrompt: '只做最小回执' }

test('label：dsh-team-chat 前缀 + teamId:memberName（与 agent-teams: 前缀隔离）', () => {
  const label = buildMemberLabel('t92demo', 'probe1')
  assert.equal(label, `${MEMBER_LABEL_PREFIX}t92demo:probe1`)
  assert.ok(label.startsWith('dsh-team-chat:'), '前缀必须是 dsh-team-chat:')
  assert.ok(!label.startsWith('agent-teams:'), '不得与 AgentTeams 前缀混淆（防双调度，§9.1.1）')
})

test('buildContinuableStartSpec：契约字段逐项映射（E4 映射表）', () => {
  const spec = buildContinuableStartSpec({
    provider: 'p1',
    label: `${MEMBER_LABEL_PREFIX}t92demo:probe1`,
    teamId: 't92demo',
    teamName: 't92 测试队',
    memberName: 'probe1',
    parent: { id: 'captain-1' },
    persona: 'PERSONA_TEXT',
    toolFilter: { allow: MEMBER_TOOL_NAMES.slice() },
    agentOptions: { provider: 'p1', model: 'm1', reasoningEffort: 'medium' },
    maxDepth: 3,
    signal: undefined,
  })
  // ContinuableStartSpec 顶层
  assert.equal(spec.provider, 'p1')
  assert.equal(spec.label, `${MEMBER_LABEL_PREFIX}t92demo:probe1`)
  // t94 实测（真实 startContinuable 读 signal.throwIfAborted）：signal 契约必填，缺省不可取消信号
  assert.ok(spec.signal !== undefined, 'spec.signal 缺省必须存在（平台直调崩溃缺口，t94 发现）')
  assert.equal(spec.signal.aborted, false)
  // request 是 Omit<SubagentStartRequest,'label'|'signal'|'outputSchema'>：不得含这三键
  assert.equal('label' in spec.request, false)
  assert.equal('signal' in spec.request, false)
  assert.equal('outputSchema' in spec.request, false)
  // prompt 是 ContentBlock[]（type:'text' 形态）
  assert.ok(Array.isArray(spec.request.prompt))
  assert.equal(spec.request.prompt[0].type, 'text')
  assert.ok(spec.request.prompt[0].text.includes('probe1'))
  // parent/persona/toolFilter/agentOptions/maxDepth
  assert.equal(spec.request.parent.id, 'captain-1')
  assert.equal(spec.request.persona, 'PERSONA_TEXT')
  assert.deepEqual(spec.request.toolFilter.allow, MEMBER_TOOL_NAMES.slice())
  assert.deepEqual(spec.request.agentOptions, { provider: 'p1', model: 'm1', reasoningEffort: 'medium' })
  assert.equal(spec.request.maxDepth, 3)
})

test('spawnMember：provider 缺 / 能力缺 / parent 缺 → 各自明确失败', async () => {
  const ok = await spawnMember({ getProvider: () => undefined, startContinuable: async () => ({}) }, { member, team })
  assert.equal(ok.ok, false)
  assert.equal(ok.reason, 'provider-not-registered')

  const noCont = await spawnMember(
    { getProvider: () => ({ capabilities: { persona: true, toolFilter: true } }), startContinuable: async () => ({}) },
    { member, team },
  )
  assert.equal(noCont.reason, 'provider-no-continuable')

  const noPersona = await spawnMember(
    { getProvider: () => ({ prepareContinuable: async () => ({}), capabilities: { persona: false, toolFilter: true } }), startContinuable: async () => ({}) },
    { member, team },
  )
  assert.equal(noPersona.reason, 'provider-no-persona')

  const noToolFilter = await spawnMember(
    { getProvider: () => ({ prepareContinuable: async () => ({}), capabilities: { persona: true, toolFilter: false } }), startContinuable: async () => ({}) },
    { member, team },
  )
  assert.equal(noToolFilter.reason, 'provider-no-toolfilter')

  const noParent = await spawnMember(stubSubagents().deps, { member, team, parent: undefined })
  assert.equal(noParent.reason, 'parent-agent-unresolved')
})

test('spawnMember：成功路径返回 childId/label；spec 含 persona 渲染 + allow 白名单', async () => {
  const stub = stubSubagents({ childId: 'child-t92', messageId: 'msg-t92' })
  const res = await spawnMember(stub.deps, { member, team, parent: { id: 'captain-1' } })
  assert.equal(res.ok, true)
  assert.equal(res.childId, 'child-t92')
  assert.equal(res.messageId, 'msg-t92')
  assert.equal(res.label, `${MEMBER_LABEL_PREFIX}t92demo:probe1`)
  assert.equal(stub.calls.length, 1)
  const spec = stub.calls[0]
  // persona = 渲染后的执行指引注入（E4：executionPrompt→persona）
  assert.ok(spec.request.persona.includes('probe1'), 'persona 必须声明成员身份')
  assert.ok(spec.request.persona.includes('只做最小回执'), 'persona 必须含 executionPrompt')
  assert.ok(spec.request.persona.includes(CLAIM_TOOL), 'persona 必须指引 claim 工具')
  assert.ok(spec.request.persona.includes(REPORT_TOOL), 'persona 必须指引 report 工具')
  // agentOptions 配额感知字段
  assert.deepEqual(spec.request.agentOptions, { provider: 'probe-provider', model: 'probe-model' })
  // B′ 白名单（allow 形态）
  assert.deepEqual(spec.request.toolFilter.allow, MEMBER_TOOL_NAMES.slice())
})

test('受控端到端（B′ 联合）：pending → spawn → claim → running → completed → 终态', async () => {
  const store = makeStore()
  const attemptCache = new Map()
  const identityA = { memberId: 'child-t92', memberName: 'probe1' }
  const identityB = { memberId: 'child-other', memberName: 'other1' }

  // 1) P1 store：创建 pending 任务（指派给 probe1）
  const created = store.createTask({ subject: 't92 隔离任务', dependencies: [], assignee: 'probe1' }, T0).task

  // 2) E4 落地：spawnMember（受控桩）——真实代码路径
  const stub = stubSubagents({ childId: 'child-t92' })
  const sp = await spawnMember(stub.deps, { member, team, parent: { id: 'captain-1' } })
  assert.equal(sp.ok, true)

  // 3) B′ 认领：成员回合模拟调 team_claim_task → store.claim 直调
  const claim = executeMemberTool({ store, attemptCache, now: T0 + 1 }, CLAIM_TOOL, { taskId: created.id }, identityA)
  assert.equal(claim.ok, true)
  assert.equal(claim.status, 'claimed')
  assert.equal(store.tasks.get(created.id).status, 'claimed')
  assert.equal(store.tasks.get(created.id).claimedById, 'child-t92')
  assert.equal(store.tasks.get(created.id).assignee, 'probe1')

  // 4) B′ 回报 running → store.update 直调
  const run = executeMemberTool({ store, attemptCache, now: T0 + 2 }, REPORT_TOOL, { taskId: created.id, status: 'running' }, identityA)
  assert.equal(run.ok, true)
  assert.equal(store.tasks.get(created.id).status, 'running')

  // 5) B′ 回报 completed → 终态
  const done = executeMemberTool({ store, attemptCache, now: T0 + 3 }, REPORT_TOOL, { taskId: created.id, status: 'completed' }, identityA)
  assert.equal(done.ok, true)
  assert.equal(store.tasks.get(created.id).status, 'completed')
  assert.equal(store.isTerminal(created.id), true)

  // 6) 归属校验：别的成员不能动 probe1 的任务
  const steal = executeMemberTool({ store, attemptCache, now: T0 + 4 }, REPORT_TOOL, { taskId: created.id, status: 'failed' }, identityB)
  assert.equal(steal.ok, false)
  assert.equal(steal.reason, 'task-not-owned')
  assert.equal(store.tasks.get(created.id).status, 'completed', '他人报告不得改写')
})

test('spawn 桩收到 start-failed → 显式失败（不吞）', async () => {
  const deps = {
    getProvider: () => ({ prepareContinuable: async () => ({}), capabilities: { persona: true, toolFilter: true } }),
    startContinuable: async () => { throw new Error('boom') },
  }
  const res = await spawnMember(deps, { member, team, parent: { id: 'captain-1' } })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'start-failed')
  assert.ok(String(res.error).includes('boom'))
})

// 渲染健全性：persona/welcome 形状
test('renderMemberPersona / renderMemberWelcome 直接可用', () => {
  const p = renderMemberPersona({ teamName: 'T', teamId: 't1', memberName: 'm1', role: 'engineer', goal: 'G', executionPrompt: 'E' })
  assert.ok(p.includes('self-built team'), '身份声明自建调度')
  assert.ok(p.includes('team_claim_task'), '含 claim 工具指引')
  assert.ok(p.includes('team_report_task'), '含 report 工具指引')
  assert.ok(!p.includes('Keep the returned attemptId'), 't93 low-①：persona 不得再让成员持有/跟踪 attemptId（宿主侧缓存为权威）')
  const w = renderMemberWelcome({ teamName: 'T', memberName: 'm1', pendingCount: 2 })
  assert.ok(w.includes('2 pending'))
})

// t94 · Slice 1b：route（LLM 路由）与 spec.provider（spawn 驱动）是两个注册表
test('spawnMember：route 显式提供时 agentOptions 用 route（LLM 路由 ≠ spawn 驱动名）', async () => {
  const stub = stubSubagents()
  const res = await spawnMember(stub.deps, {
    member: { ...member, provider: 'subagent-spawn', route: { provider: 'llm-route-x', model: 'llm-model-x', reasoningEffort: 'low' } },
    team,
    parent: { id: 'captain-1' },
  })
  assert.equal(res.ok, true)
  assert.equal(stub.calls[0].provider, 'subagent-spawn', 'spec.provider = spawn 驱动 provider')
  assert.deepEqual(stub.calls[0].request.agentOptions, { provider: 'llm-route-x', model: 'llm-model-x', reasoningEffort: 'low' }, 'agentOptions = LLM 路由')
})

// t96 · Slice 2（t95 low②）：welcomeText 透传不再丢弃；缺省仍 renderMemberWelcome
test('spawnMember：welcomeText 透传进 spec.request.prompt；缺省渲染不变', async () => {
  const stubCustom = stubSubagents()
  const custom = await spawnMember(stubCustom.deps, {
    member, team,
    parent: { id: 'captain-1' },
    welcomeText: 'CUSTOM WELCOME for probe1',
  })
  assert.equal(custom.ok, true)
  assert.equal(stubCustom.calls[0].request.prompt[0].text, 'CUSTOM WELCOME for probe1', 'welcomeText 必须透传（1a 曾丢弃）')

  const stubDefault = stubSubagents()
  const fallback = await spawnMember(stubDefault.deps, { member, team, parent: { id: 'captain-1' } })
  assert.equal(fallback.ok, true)
  assert.ok(stubDefault.calls[0].request.prompt[0].text.includes('You have joined'), '缺省仍为 renderMemberWelcome 渲染')
})

// t94 · Slice 1b（t93 low-②）：工具名单一常量源——三处（persona/claim-channel DTO/spawn 白名单）同源
test('工具名单一常量源：spawn 白名单、claim-channel DTO 键、tool-names 源三者完全一致', async () => {
  const { MEMBER_TOOLS } = await import('../lib/p2/claim-channel.js')
  const { MEMBER_TOOL_NAMES: SOURCE } = await import('../lib/p2/tool-names.js')
  const stub = stubSubagents()
  const res = await spawnMember(stub.deps, { member, team, parent: { id: 'captain-1' } })
  assert.equal(res.ok, true)
  const allow = stub.calls[0].request.toolFilter.allow
  assert.deepEqual([...allow].sort(), [...SOURCE].sort(), 'spawn 默认白名单必须来自 tool-names 单一常量源')
  assert.deepEqual(Object.keys(MEMBER_TOOLS).sort(), [...SOURCE].sort(), 'MEMBER_TOOLS 键必须同源')
  assert.deepEqual([...MEMBER_TOOL_NAMES].sort(), [...SOURCE].sort(), 'persona re-export 必须同源')
})