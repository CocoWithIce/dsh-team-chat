/**
 * Unit tests for the shared pure helpers.
 *
 * Run: node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_ROLES,
  DEFAULT_TRIO,
  groupThreads,
  imTargetFromText,
  isTeamLabel,
  LABEL_PREFIX,
  LABEL_PREFIX_P2,
  LABEL_PREFIXES,
  memberPrompt,
  normalizeTeams,
  quoteSnippet,
  roleFromLabel,
  roleMeta,
  routingText,
  teamFor,
  teamFromLabel,
} from '../lib/shared.js'

// ----------------------------------------------------------------- labels

test('roleFromLabel extracts the member name（双前缀 · t98）', () => {
  assert.equal(roleFromLabel('agent-teams:multi-role-team:researcher'), 'researcher')
  assert.equal(roleFromLabel('agent-teams:t:engineer'), 'engineer')
  assert.equal(roleFromLabel('dsh-team-chat:trio:researcher'), 'researcher', 'P2 自建前缀同构解析')
  assert.equal(roleFromLabel('dsh-team-chat:p2e2e:probe1'), 'probe1')
})

test('roleFromLabel degrades gracefully', () => {
  assert.equal(roleFromLabel('plain-label'), 'plain-label')
  assert.equal(roleFromLabel(''), 'member')
  assert.equal(roleFromLabel(undefined), 'member')
})

test('teamFromLabel extracts the team name（双前缀 · t98）', () => {
  assert.equal(teamFromLabel('agent-teams:multi-role-team:reviewer'), 'multi-role-team')
  assert.equal(teamFromLabel('dsh-team-chat:trio:engineer'), 'trio')
  assert.equal(teamFromLabel('nope'), '')
})

test('isTeamLabel accepts both roster prefixes（存量兼容 + P2 自建 · t98）', () => {
  assert.equal(LABEL_PREFIX, 'agent-teams:')
  assert.equal(LABEL_PREFIX_P2, 'dsh-team-chat:')
  assert.deepEqual(LABEL_PREFIXES, ['dsh-team-chat:', 'agent-teams:'])
  assert.equal(isTeamLabel('agent-teams:x:y'), true, '存量前缀兼容')
  assert.equal(isTeamLabel('dsh-team-chat:x:y'), true, 'P2 自建前缀')
  assert.equal(isTeamLabel('agent-team:x:y'), false)
  assert.equal(isTeamLabel('dsh-team-chat-clone:x:y'), false, '前缀必须整段匹配（含冒号）')
  assert.equal(isTeamLabel(undefined), false)
  assert.equal(isTeamLabel(''), false)
})

test('mixed roster: both prefixes pass the same roster gate（混合场景 · t98）', () => {
  const children = [
    { label: 'agent-teams:multi-role-team:researcher' },
    { label: 'dsh-team-chat:trio:engineer' },
    { label: 'other-plugin:x:y' },
  ]
  const roster = children.filter((child) => isTeamLabel(child.label))
  assert.deepEqual(roster.map((row) => roleFromLabel(row.label)), ['researcher', 'engineer'])
  assert.deepEqual(roster.map((row) => teamFromLabel(row.label)), ['multi-role-team', 'trio'])
})

test('roleMeta knows the trio and falls back for strangers', () => {
  assert.equal(roleMeta('researcher').label, '研究员')
  assert.equal(roleMeta('engineer').color, '#34c77b')
  assert.equal(roleMeta('outsider').icon, '👤')
  assert.equal(roleMeta('outsider').label, 'outsider')
})

// ----------------------------------------------------------------- quotes

test('quoteSnippet flattens whitespace', () => {
  assert.equal(quoteSnippet('a\n\n  b   c'), 'a b c')
})

test('quoteSnippet elides past the limit', () => {
  const snippet = quoteSnippet('x'.repeat(200))
  assert.equal(snippet.length, 121)
  assert.ok(snippet.endsWith('…'))
})

test('quoteSnippet keeps short text untouched', () => {
  assert.equal(quoteSnippet('short'), 'short')
})

// ----------------------------------------------------------------- threads

function message(id, overrides = {}) {
  return {
    id,
    kind: 'chat',
    from: 'researcher',
    text: id,
    time: 1,
    rootId: null,
    replyTo: null,
    quote: null,
    ...overrides,
  }
}

test('groupThreads keeps flat messages as roots in order', () => {
  const threads = groupThreads([message('m1'), message('m2')])
  assert.equal(threads.length, 2)
  assert.equal(threads[0].root.id, 'm1')
  assert.equal(threads[0].replies.length, 0)
  assert.equal(threads[1].root.id, 'm2')
})

test('groupThreads nests a reply under its root', () => {
  const threads = groupThreads([
    message('m1'),
    message('m2'),
    message('m3', { rootId: 'm1', replyTo: 'm1' }),
  ])
  assert.equal(threads.length, 2)
  assert.equal(threads[0].root.id, 'm1')
  assert.deepEqual(threads[0].replies.map((reply) => reply.id), ['m3'])
})

test('groupThreads collapses a reply-to-a-reply onto the same root', () => {
  const threads = groupThreads([
    message('m1'),
    message('m2', { rootId: 'm1' }),
    message('m3', { rootId: 'm2', replyTo: 'm2' }),
  ])
  assert.equal(threads.length, 1)
  assert.deepEqual(threads[0].replies.map((reply) => reply.id), ['m2', 'm3'])
})

test('groupThreads promotes an orphaned reply to a root', () => {
  const threads = groupThreads([message('m9', { rootId: 'm1', replyTo: 'm1' })])
  assert.equal(threads.length, 1)
  assert.equal(threads[0].root.id, 'm9')
  assert.equal(threads[0].replies.length, 0)
})

test('groupThreads survives self-referential and cyclic roots', () => {
  const selfRef = groupThreads([message('m1', { rootId: 'm1' })])
  assert.equal(selfRef.length, 1)
  assert.equal(selfRef[0].root.id, 'm1')

  const a = message('a', { rootId: 'b' })
  const b = message('b', { rootId: 'a' })
  const cyclic = groupThreads([a, b])
  // Every message stays accounted for exactly once, even in a cycle.
  const total = cyclic.length + cyclic.reduce((count, thread) => count + thread.replies.length, 0)
  assert.equal(total, 2)
  assert.deepEqual(cyclic.map((thread) => thread.root.id).sort(), ['a', 'b'])
})

test('groupThreads never duplicates or drops a message', () => {
  const list = [
    message('m1'),
    message('m2'),
    message('m3', { rootId: 'm1' }),
    message('m4', { rootId: 'm3' }),
    message('m5', { rootId: 'gone' }),
    message('m6', { rootId: 'm6' }),
  ]
  const threads = groupThreads(list)
  const seen = []
  for (const thread of threads) {
    seen.push(thread.root.id)
    for (const reply of thread.replies) seen.push(reply.id)
  }
  assert.deepEqual(seen.slice().sort(), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'])
})

test('groupThreads tolerates an empty or malformed list', () => {
  assert.deepEqual(groupThreads([]), [])
  assert.deepEqual(groupThreads(undefined), [])
})

// ----------------------------------------------------------------- routing

test('routingText is empty while the feature is disabled', () => {
  assert.equal(routingText({ enabled: false }), '')
})

test('routingText routes to the team by default', () => {
  const text = routingText({})
  assert.match(text, /团队模式/)
  assert.match(text, /researcher/)
  assert.match(text, /engineer/)
  assert.match(text, /reviewer/)
  assert.match(text, /priority|优先/)
})

test('routingText retires legacy AgentTeams tool guidance（t98 · 判别锚点）', () => {
  const text = routingText({})
  // 指引类具体工具名零残留（禁令句使用 agent_teams_* 通配表述，不点名具体工具）
  for (const legacy of ['agent_teams_create', 'agent_teams_add_member', 'agent_teams_send_message', 'agent_teams_status']) {
    assert.ok(!text.includes(legacy), `不得再指引使用 ${legacy}`)
  }
  // 新语义写入（§9.1.1 三条硬约束进指令文本）
  assert.match(text, /\/team-tasks/, '新任务一律走 /team-tasks')
  assert.match(text, /agent_teams_\*/, '保留通配禁令句（不得用 AgentTeams 建队/建成员/派活）')
  assert.match(text, /dsh-team-chat:/, '自建前缀进文本')
  assert.match(text, /\/state/, '观察走 P1 /state 投影')
  assert.match(text, /只读/, '名册保持只读（AgentTeams 只读共存）')
})

test('routingText keeps auto-creation off-switch semantics when disabled', () => {
  const text = routingText({ autoCreateTeam: false })
  assert.doesNotMatch(text, /agent_teams_create/)
  assert.match(text, /不自动建队/)
})

test('routingText renders the team it is given', () => {
  const team = {
    id: 'duo',
    name: '双人组',
    description: '快速迭代小队',
    members: [
      {
        name: 'analyst',
        role: '分析师',
        provider: '',
        model: 'gpt-5.6',
        reasoningEffort: '',
        soul: '先看数据再下结论',
        skills: ['understand'],
        plugins: [],
        mcp: ['postgres'],
        memory: 'team:duo',
        executionPrompt: '',
      },
      { name: 'fixer', role: '修复者', provider: 'openai', model: 'x', reasoningEffort: 'high', soul: '', skills: [], plugins: [], mcp: [], memory: '', executionPrompt: '' },
    ],
  }
  const text = routingText({}, team)
  assert.match(text, /团队模板「双人组」/)
  assert.match(text, /快速迭代小队/)
  assert.match(text, /1\. analyst（分析师） · model: gpt-5\.6/)
  assert.match(text, /【角色人格】先看数据再下结论/)
  assert.match(text, /【优先技能】understand/)
  assert.match(text, /【可用 MCP】postgres/)
  assert.match(text, /【记忆】team:duo/)
  assert.match(text, /2\. fixer（修复者） · model: openai\/x · effort: high/)
  assert.doesNotMatch(text, /engineer/)
})

test('routingText renders the default team from settings when none is passed', () => {
  const text = routingText({ teams: [{ id: 'solo', name: '独行侠', members: [{ name: 'solo' }] }], defaultTeamId: 'solo' })
  assert.match(text, /团队模板「独行侠」/)
  assert.match(text, /1\. solo/)
})

test('routingText asks the captain to broadcast progress to IM sessions', () => {
  const text = routingText({})
  assert.match(text, /dsh_im_source/)
  assert.match(text, /飞书/)
  assert.match(text, /1–3 行/)
})

test('routingText drops the IM broadcast clause when disabled', () => {
  const text = routingText({ imProgress: false })
  assert.doesNotMatch(text, /dsh_im_source/)
  assert.match(text, /团队模式/, 'the rest of the routing section survives')
  assert.match(text, /子代理/)
})

test('routingText always self-excludes subagents', () => {
  assert.match(routingText({}), /子代理/)
  assert.match(routingText({ teams: [] }), /子代理/)
})

test('shared.js source has zero specific agent_teams_* tool names（grep 验收 · t98 判别锚点）', () => {
  const source = readFileSync(new URL('../lib/shared.js', import.meta.url), 'utf8')
  for (const legacy of ['agent_teams_create', 'agent_teams_add_member', 'agent_teams_send_message', 'agent_teams_status']) {
    assert.ok(!source.includes(legacy), `lib/shared.js 不得残留 ${legacy}（指令退场，禁令句只用通配 agent_teams_*）`)
  }
  assert.ok(source.includes('agent_teams_*'), '通配禁令句必须在（不得用 AgentTeams 建队/建成员/派活的显式禁令）')
  assert.ok(source.includes('/team-tasks'), '新语义必须在（任务一律走 /team-tasks）')
})

// ----------------------------------------------------------------- IM origin

test('imTargetFromText reads a group-thread origin', () => {
  const text = '<dsh_im_source>{"channel":"feishu","conversationType":"group","chatId":"oc_a","threadId":"omt_b","botId":"bot_c"}</dsh_im_source>\n你好'
  const im = imTargetFromText(text)
  assert.equal(im.botId, 'bot_c')
  assert.equal(im.chatId, 'oc_a')
  assert.equal(im.threadId, 'omt_b')
  assert.equal(im.channel, 'feishu')
  assert.equal(im.targetId, 'group:oc_a:thread:omt_b')
})

test('imTargetFromText handles a direct chat without a thread', () => {
  const im = imTargetFromText('<dsh_im_source>{"conversationType":"direct","chatId":"oc_a","botId":"bot_c"}</dsh_im_source>')
  assert.equal(im.targetId, 'direct:oc_a')
})

test('imTargetFromText ignores non-IM and malformed sources', () => {
  assert.equal(imTargetFromText('plain user message'), null)
  assert.equal(imTargetFromText(undefined), null)
  assert.equal(imTargetFromText('<dsh_im_source>not json</dsh_im_source>'), null)
  assert.equal(imTargetFromText('<dsh_im_source>{"chatId":"oc_a"}</dsh_im_source>'), null, 'botId is required')
  assert.equal(imTargetFromText('<dsh_im_source>{"botId":"bot_c"}</dsh_im_source>'), null, 'chatId is required')
})

test('DEFAULT_ROLES is the trio', () => {
  assert.deepEqual(DEFAULT_ROLES, ['researcher', 'engineer', 'reviewer'])
})

// ----------------------------------------------------------------- member prompt

test('memberPrompt omits empty sections entirely', () => {
  assert.equal(memberPrompt({}), '')
  assert.equal(memberPrompt({ soul: '   ', skills: [], mcp: [], plugins: [], memory: '' }), '')
  assert.equal(memberPrompt(undefined), '')
})

test('memberPrompt renders every configured section in order', () => {
  const text = memberPrompt({
    soul: '谨慎',
    skills: ['a', 'b'],
    mcp: ['postgres'],
    plugins: ['dsh-better-sidebar'],
    memory: 'bank:1',
    executionPrompt: '先写测试',
  })
  assert.equal(text, [
    '【角色人格】谨慎',
    '【优先技能】a、b（动手前先用 skill 工具加载）',
    '【可用 MCP】postgres',
    '【依赖插件】dsh-better-sidebar',
    '【记忆】bank:1',
    '先写测试',
  ].join('\n'))
})

test('memberPrompt de-duplicates and trims list entries', () => {
  const text = memberPrompt({ skills: [' a ', 'a', '', 'b'] })
  assert.match(text, /【优先技能】a、b（/)
})

test('memberPrompt caps very long guidance', () => {
  const text = memberPrompt({ executionPrompt: 'x'.repeat(5000) })
  assert.ok(text.length <= 1201, 'guidance was not capped: ' + text.length)
  assert.ok(text.endsWith('…'))
})

// ----------------------------------------------------------------- normalizeTeams

test('normalizeTeams falls back to the shipped trio', () => {
  const result = normalizeTeams(undefined)
  assert.equal(result.teams.length, 1)
  assert.equal(result.teams[0].id, 'trio')
  assert.equal(result.defaultTeamId, 'trio')
  assert.equal(result.teams[0].members.length, 3)
})

test('normalizeTeams drops illegal ids with a reason', () => {
  const result = normalizeTeams({ teams: [{ id: 'Bad:Id', members: [{ name: 'a' }] }, { id: 'ok', members: [{ name: 'a' }] }] })
  assert.deepEqual(result.teams.map((team) => team.id), ['ok'])
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0], /不合法/)
})

test('normalizeTeams drops duplicate member names', () => {
  const result = normalizeTeams({ teams: [{ id: 't', members: [{ name: 'a' }, { name: 'a' }, { name: 'b' }] }] })
  assert.deepEqual(result.teams[0].members.map((member) => member.name), ['a', 'b'])
  assert.match(result.errors.join(' '), /重复/)
})

test('normalizeTeams drops teams with no usable member', () => {
  const result = normalizeTeams({ teams: [{ id: 'empty', members: [] }, { id: 'ok', members: [{ name: 'a' }] }] })
  assert.deepEqual(result.teams.map((team) => team.id), ['ok'])
  assert.match(result.errors.join(' '), /没有任何可用成员/)
})

test('normalizeTeams falls back when the default id is unknown', () => {
  const result = normalizeTeams({ teams: [{ id: 'ok', members: [{ name: 'a' }] }], defaultTeamId: 'ghost' })
  assert.equal(result.defaultTeamId, 'ok')
  assert.match(result.errors.join(' '), /不存在/)
})

test('normalizeTeams keeps a valid default', () => {
  const result = normalizeTeams({
    teams: [{ id: 'one', members: [{ name: 'a' }] }, { id: 'two', members: [{ name: 'b' }] }],
    defaultTeamId: 'two',
  })
  assert.equal(result.defaultTeamId, 'two')
  assert.deepEqual(result.errors, [])
})

test('normalizeTeams never mutates the shipped default', () => {
  const result = normalizeTeams({ teams: [{ id: 'x', members: [{ name: 'a' }] }] })
  result.teams[0].members.push({ name: 'injected' })
  assert.equal(DEFAULT_TRIO.members.length, 3)
  assert.equal(normalizeTeams(undefined).teams[0].members.length, 3)
})

test('normalizeTeams coerces member fields to their declared shapes', () => {
  const result = normalizeTeams({
    teams: [{ id: 't', name: '', members: [{ name: 'a', skills: 'not-a-list', soul: 42, model: ' m ' }] }],
  })
  const member = result.teams[0].members[0]
  assert.deepEqual(member.skills, [])
  assert.equal(member.soul, '')
  assert.equal(member.model, 'm')
  assert.equal(result.teams[0].name, 't', 'a missing name falls back to the id')
})

test('teamFor prefers the override, then the default, then anything', () => {
  const normalized = normalizeTeams({
    teams: [{ id: 'one', members: [{ name: 'a' }] }, { id: 'two', members: [{ name: 'b' }] }],
    defaultTeamId: 'one',
  })
  assert.equal(teamFor(normalized, 'two').id, 'two')
  assert.equal(teamFor(normalized, 'ghost').id, 'one')
  assert.equal(teamFor(undefined, 'x').id, 'trio')
})
