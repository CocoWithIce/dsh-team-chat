# 孤儿态可检测性判定：插件能否检测「成员 idle 但任务 claimed」（stall-detection-feasibility）

> **任务**：t22 — 能力论证（attempt 1）
> **结论**：公开面不足以精确判定「成员 idle 但任务 claimed」的孤儿态；弱替代可行且即 P4「停滞可见 + 一键恢复」的可落地形态。
> **证据出处**：AgentTeams 已安装包源码（`profiles\desktop\node_modules\@nanmicoder\dsh-agent-teams\lib\`）+ host Inspect 契约（Service.listService agentTeams）。
> **已验证 / 推测分界**：quoted 状态只存磁盘（已验证，state.js）；兄弟插件 `ctx.get('agentTeams')===undefined`（源码作者自证 + 方法签名推断，高置信非运行时探针，见下）。

---

## 1. 结论（三行）

1. **另一个插件读不到任务 claimed 状态 —— 直读不可行**：`claimed` 只存在于 AgentTeams 磁盘持久化，读取通道仅两个（agent 专用工具 `agent_teams_status` 与 Connection 鉴权的 web `/state`），兄弟插件的 `ctx.get('agentTeams')` 为 `undefined`。
2. **弱替代可行**：成员 activity `idle`（`ctx.agents.get(id).status`）+ 最近「消息级」session/event 超阈值（如 10min）→ 标注「疑似停滞」+ 恢复按钮。
3. **恢复路径**：插件无法直接触发 reassign；按钮 → 队长消息 → 队长执行 `agent_teams_reassign_task`（唯一权威通道）。

## 2. 证据链（为什么直读不可行）

### 2.1 `claimed` 状态只存在于 AgentTeams 磁盘持久化 — 已验证

- 任务状态机：`state.js` `TASK_TRANSITIONS = { pending: ['claimed','cancelled'], claimed: ['in_progress','failed','cancelled'], in_progress: ['completed','failed','cancelled'], completed: [], failed: [], cancelled: [] }`（state.js:100-107）。
- `claimed` = 认领后、开工前的中间态：`activateTaskAttempt` 置 `task.status='claimed'; task.attemptId=randomUUID()`（state.js:123-133）。
- 读取这个状态的两个通道：
  1. **agent 专用工具** `agent_teams_status`：`requireCaptain(exec)`（tools.js:1709-1717），输出含 `members[].activity` 与 `tasks[].status/assignee/attempt/attempt_id`（tools.js:1719-1745）——**只有 agent 能调用**。
  2. **AgentTeams web `/state`**：Connection 鉴权围墙（web-routes.js:62-82），快照含 `members[].activity`（working/idle）与 `tasks[].status`（snapshot.js:59-113）——**只有带浏览器鉴权的客户端可达**。

### 2.2 兄弟插件 `ctx.get('agentTeams')===undefined` — 高置信推断（源码自证）

- dsh-team-chat 自身源码注释（作者自证）：`lib/index.js:9-11` —— "The AgentTeams plugin publishes its `agentTeams` service inside the captain Agent's own scope, so a sibling plugin cannot resolve it (`ctx.get('agentTeams')` is `undefined`)."
- host Inspect 契约（Service.listService agentTeams）佐证：**全部方法的参数都要求 `caller`/`agent` 为「exact live Agent」**（Team 成员身份作为 authority credential），例如 `membership(agent: Agent)`、`listTasks(caller: Agent)`、`updateTask(caller: Agent, …)`、`tryMembership(agent: Agent)`（契约 referencedTypes 确认：`TeamMemberView`、`TeamTaskView`、`TeamTaskStatus='pending'|'in_progress'|'completed'|'deleted'`）。
- 诚实声明：`ctx.get('agentTeams')===undefined` 为源码自证 + 方法签名推断（高置信），**未做兄弟 scope 的运行时探针**（成员会话无法开兄弟 scope 实测）。若队长能在自身 scope 探 `ctx.get('agentTeams')` 一次，可升级为铁证。

### 2.3 禁止依赖 `.agent-teams` 状态文件（硬约束，非可行性方案）

- t22 硬性约束：禁止读取或依赖 `.agent-teams` 状态文件（内部实现，依赖它等于自埋地雷）。

## 3. 弱替代形态（P4 可落地）

```
判定信号 = member activity === 'idle'          （ctx.agents.get(id).status，成员.js:597-606 同款）
         + 最近「消息级」session/event 时间超阈值（如 10min）
         消息级 = turn/start | turn/end | step/start | step/end | tool/call | tool/result | assistant/message | user/message
         排除 assistant/chunk（流式噪声，非产出信号）
→ 标注「疑似停滞」+ 恢复按钮
```

- 事件来源：`session/event`（契约：post-commit append feed，含 data；`assistant/chunk` 除外）与 `agent/status`（payload `{agent,status}`），详见 `event-driven-options.md`。
- 恢复按钮动作：生成一条发往队长的消息（dsh-team-chat 现有 `/speak`→`deliver` 到 captain），由队长执行 `agent_teams_reassign_task`；或提示用户手动操作。

## 4. 误报源（局限，必须明示）

1. **深度长时间推理且未产出消息的成员**：reasoning 只产生 `assistant/chunk`（若订阅端过滤了 chunk，则只剩 step/task 级信号）——「无消息级事件」≠「停滞」。
2. **刚 claim 正在首回合的成员**：claim→in_progress 之间存在无消息 window，可能被误标。

缓解：阈值可调 + 按钮由人工确认后才执行恢复；UI 明示「疑似」而非「已」停滞。

## 5. 恢复路径（等价能力）

- **插件无法直接触发 reassign**：`agentTeams` service 不可达；即便可达，`updateTask(caller, …)` 也要求 Team 成员 Agent 身份。
- **可行替代**：群聊按钮 → 生成「请队长执行 agent_teams_reassign_task tX」的消息 → 队长执行（唯一权威通道）；或提示用户手动操作。依据：`TeamTaskAction` 含 `'reassign'|'release'`（契约已验证）。

## 6. 可检测信号清单（逐条）

| 信号 | 来源 | 可靠性 | 误报风险 |
|---|---|---|---|
| `ctx.agents.get(id).status`（running/idle） | agents service | 高（实时） | 低——只表示 driver 活跃，不算停滞 |
| `agent/status` 事件 `{agent,status}` | host Event | 高（实时推送） | 低（AgentTeams scheduler.js:428 同款） |
| 最近消息级 `session/event` seq/time | host Event（session/event） | 高 | 中——深度推理无产出会被误判（见 §4） |
| `agent/inbox/spliced` | AgentTeams 专用 session 事件 | 高 | 低（inbox 入队提示） |
| web `/state` 快照（members.activity + tasks.status） | AgentTeams web route | 高（内容）但仅浏览器可达 | 插件自身不可达（Connection 鉴权） |

---

> 落盘：t26（2026-09-10）。诚实声明保留：`ctx.get('agentTeams')===undefined` 为推断非运行时探针；「sessions 已安装可 resolve」类运行时断言一律标推断。