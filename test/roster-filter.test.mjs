import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rosterFrom } from '../lib/shared.js'

// 0.8.0 花名册卫生（用户反馈：历史轮换冷态会话不应显示为成员）。
// 判别矩阵：agent-teams: 存量 / retired 标注 / dsh-team-chat: 活跃 三类输入。

const legacy = (id, label) => ({ kind: 'child', id, label, activity: 'idle' })

test('rosterFrom hides agent-teams: legacy sessions (orchestrator retired, P4)', () => {
  const children = [
    legacy('1', 'agent-teams:multi-role-team:researcher2'),
    legacy('2', 'agent-teams:multi-role-team:engineer2'),
    legacy('3', 'agent-teams:multi-role-team:reviewer2'),
    legacy('4', 'agent-teams:multi-role-team:engineer3'),
  ]
  const roster = rosterFrom(children)
  assert.equal(roster.length, 0, 'legacy agent-teams: sessions must not appear as members')
})

test('rosterFrom hides drain-annotated cold records (retired: true)', () => {
  const children = [
    { kind: 'child', id: 'p1', label: 'dsh-team-chat:p2e2e:probe1', retired: true, activity: 'idle' },
    { kind: 'child', id: 'p2', label: 'dsh-team-chat:p2e2e-r4:probe-r4', retired: true, activity: 'idle' },
  ]
  const roster = rosterFrom(children)
  assert.equal(roster.length, 0, 'retired-annotated cold records must not appear as members')
})

test('rosterFrom keeps active dsh-team-chat: members', () => {
  const children = [
    { kind: 'child', id: 'a1', label: 'dsh-team-chat:acme:worker-a', activity: 'running' },
    { kind: 'child', id: 'a2', label: 'dsh-team-chat:acme:worker-b', activity: 'idle' },
  ]
  const roster = rosterFrom(children)
  assert.equal(roster.length, 2)
  assert.equal(roster[0].name, 'worker-a')
  assert.equal(roster[0].activity, 'running')
  assert.equal(roster[1].name, 'worker-b')
})

test('rosterFrom mixed roster: legacy + retired filtered, active kept', () => {
  const children = [
    legacy('1', 'agent-teams:old-team:researcher2'),
    { kind: 'child', id: '2', label: 'dsh-team-chat:p4e2e:worker-a', retired: true, activity: 'idle' },
    { kind: 'child', id: '3', label: 'dsh-team-chat:new:engineer-i1', activity: 'running' },
  ]
  const roster = rosterFrom(children)
  assert.equal(roster.length, 1)
  assert.equal(roster[0].name, 'engineer-i1')
})

test('rosterFrom skips non-child kinds and unparseable labels', () => {
  const children = [
    { kind: 'captain', id: 'c0', label: 'dsh-team-chat:x:lead', activity: 'running' },
    { kind: 'child', id: 'c1', label: 42 },
    { kind: 'child', id: 'c2', label: 'dsh-team-chat:acme:real', activity: 'idle' },
  ]
  const roster = rosterFrom(children)
  assert.equal(roster.length, 1)
  assert.equal(roster[0].name, 'real')
})
