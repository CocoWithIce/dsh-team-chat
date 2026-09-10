# 事件驱动改造前提：可替代 3 秒轮询的推送源（event-driven-options）

> 生成：researcher · 2026-09-10 · t8（attempt 3）→ 因 client 端查询挂起由队长作废，本报告续用于替代任务 **t13**（仅 host 端取证，已补充事件落盘实证 §5.5）
> 待答问题：Q1 宿主侧推送事件 / Q2 客户端侧订阅（由队长代查运行时，本报告给出源码证据） / Q3 Service 精确契约与 AgentTeams 现状 / Q4 readSurface 增量能力 / Q5 轮询能否删除 / Q5.5 事件落盘实证
> 取证方式：`cordis_inspect_*`（platform=host，本地执行不挂起）+ 已安装包源码研读（AgentTeams、dsh-client-connection、dsh-api-session-controller 等）+ **真实会话日志解码实证**（详见 §5.5）。
> **客户端 inspect（platform=client）已按队长指示整体放弃**——该查询会永久挂起页面等待；Q2 基于源码证据，已标注依据来源；运行时事实列入「需队长代查」。
> 每项结论标注「已验证」/「推测/未验证」；严禁凭印象编造名称。

---

## 0. 结论速览（工程师可直接据此决策）

| 问题 | 结论 |
|---|---|
| Q1 宿主侧是否有点「成员产出/状态变化」的推送事件 | **有**：`session/event`（成员会话日志追加，含产出事件）、`agent/status`（idle⇄running）、`agent/inbox/inserted`（成员收消息）、`subagent/start/end`。均已取精确契约。 |
| Q2 客户端侧能否订阅推送 | **能（平台级能力存在，但需走 Gateway 流）**：`session/follow` Remote 流（`@deepseek-ai/dsh-api-session-controller`，typert.host.js:822-843）+ `$events` Remote 事件流（dsh-api-gateway）。**但 dsh-team-chat 当前客户端只有裸 HTTP 路由，未接入这两个通道**——属「能力存在、需改造接线」，不是「现成可用」。 |
| Q3 Service 里是否有订阅/流式/增量能力 | **有**：`sessionQuery.filterEvents`（seq 区间过滤，增量拉取能力）、`observeSession`（带 cursor/revision 的观察租约）、`session/follow`（真正的流式跟随）。AgentTeams 自身拿成员进展的方式：宿主侧主要靠 `agent/status` 事件 + `ctx.agents.get(id).status`（members.js:597-606, scheduler.js:428）与自持久化 mailbox；**其客户端面板也是 1 秒轮询 `/plugins/dsh-agent-teams/state`**（activity-monitor.js:100-101），并未走推送。 |
| Q4 readSurface 是否有增量/尾部替代 | **readSurface 本身没有**（无 cursor/since/lastN/tail 参数，返回完整 surface + capturedThroughSeq）；但平台提供 `session/follow`（真增量流）与 `filterEvents` seq 区间（增量拉取）两个替代。 |
| Q5 3 秒轮询能不能删 | **能部分删**：产物/消息拉取（readSurface 轮询）**应替换为 session/follow 订阅 + agent/status 事件**；**必须保留**：成员 roster 的周期性发现（`agents.list`/`subagents.listChildren` 探测）与 `/state` 请求路径去同步化（F1）。判定为「**部分保留**」，见 §5。 |
| Q5.5 事件落盘实证 | **已验证（解码真实会话日志）**：step/start·step/end·tool/call·tool/result·turn/start·turn/end 在成员会话（step 224/tool 227/turn 19）与 captain 会话（step 625/tool 670/turn 46）均真实产生；tool/call 参数携带路径/命令线索（成员会话 153 条、captain 498 条）。详见 §5.5。 |

---

## 1. Q1 宿主侧事件（子代理产出/状态变化时触发）— 全部来自 cordis_inspect host Event

取证路径：`cordis_inspect_list`(host) → `Event.listEvents`（紧凑目录 60+ 事件）→ 对候选逐一取精确契约（platform=host, provider=Event, method=listEvents with event 名）。以下均为**精确契约原文**。

### 1.1 `session/event`（成员「有新产出」的唯一权威推送源）— 已验证

```
name:      session/event
mode:      emit
signature: 'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void
精度:      "Post-commit, fire-and-forget append feed. The listener snapshot resolves before
           the log push, but callbacks run after it; observer failures are logged and
           contained without making the committed append fail."
载荷:      session — 日志增长的会话；event — 追加的事件（恰好如落盘记录）
触发时机:  该会话日志每追加一条事件后（提交后）
```

- `SessionEvent` 结构（精确类型）：`{ type, seq, time, data }`；`SessionEventMap` 含 `user/message`、`assistant/message`（成员最终产出）、`assistant/chunk`（流式增量）、`tool/result`、`turn/start/end`、`step/start/end`、`request/header` 等。
- **注意**：`readSurface` 只暴露 `SurfaceEventType = 'user/message' | 'assistant/message' | 'tool/result'`（service 契约 referencedTypes），而 `session/event` 能拿到**全部**类型含 step/turn/tool-call——这正回答队长线索「成员会话中这些事件是否实际落盘」：**事件类型系统存在且就是 session 日志的 append feed 内容**（详见 §4「实际产生」证据）。
- **作用域语义（关键）**：契约注明 "Scope-filtered dispatch：agent-scoped listeners receive only events from sessions entered through that agent's context"。`history.js:145` 用 `{ global: true }` 注册来接收任意会话的事件——**插件级监听需显式 `{ global: true }` 才能收到非本代理作用域的成员会话事件**（已验证：dsh-api-session-controller/lib/types/history.js:145-150 正是这么做的）。
- host 消费示例（已验证源码）：`dsh-agent-loop/lib/index.js:50` `ctx.on("session/event", (subject, event) => …)`；`dsh-api-session-controller/lib/types/history.js:145` `this.ctx.on('session/event', (session, event) => …) `（global: true）。

### 1.2 `agent/status`（成员 idle⇄running）— 已验证

```
name:      agent/status
mode:      emit
signature: 'agent/status'(this: Scoped<Agent>, payload: { agent: Agent; status: AgentStatus }): void
触发时机:  驱动状态切换（idle ⇄ running）；waking delivery 同步进入 running；idle = 无 driver 调度或活跃。
载荷:      payload.status — 刚进入的状态；payload.agent — { id: SessionId }
```

- AgentTeams 自身就用它同步成员状态（已验证源码）：`scheduler.js:428` `ctx.on('agent/status', ({ agent, status }) => …)` → `syncMemberStatus`。
- 这正是 F3（按 activity 降频）的直接事件源：成员开始/结束运行时立刻可感知，无需轮询。

### 1.3 `agent/inbox/inserted`（成员收到新消息）— 已验证

```
name:      agent/inbox/inserted
mode:      emit
signature: 'agent/inbox/inserted'(this: Scoped<Agent>, payload: { agent: Agent; message: UserMessage }): void
触发时机:  一条消息进入该 agent 的 live inbox。
```

### 1.4 `subagent/start` / `subagent/end`（子代理启停）— 已验证

```
subagent/start: 'subagent/start'(this: Scoped<SubagentRuntime>, info: SubagentRunInfo): void
  info: { runId, provider, id: SessionId, local: boolean }
subagent/end:   'subagent/end'(this: Scoped<SubagentRuntime>, info: SubagentRunEndInfo): void
  info: { runId, provider, id: SessionId, local, stopReason, lastAssistantMessage?: ContentBlock[] }
```

- `subagent/end.info.lastAssistantMessage`（可选）——成员最终产出可直接拿到，无需再读 surface。
- 注意 `local` 标记：远程/本地 provider 语义不同。

### 1.5 次要可用事件（已验证存在，用途辅助）

- `agent/created` / `agent/disposed`（注册与离开，`: payload { agent }`）——roster 变化探测。
- `api-session/status(sessionId, running)`、`api-session/activity(sessionId, updatedAt)`——Session 列表层活动（emit）。
- `session/created` / `session/disposed`、`session/flush`（parallel：预置并行持久化检查点，可 await）——会话生命周期/持久化。
- `workflow/*` 系列（workflow/start|log|phase|agent-start|agent-end|end）——若群聊关心 workflow 运行。

---

## 2. Q2 客户端侧订阅（platform=client 未取到运行时目录 — 已按队长指示放弃；以下为源码证据）

**取证声明**：`cordis_inspect_query(platform=client, provider=Event, method=listEvents)` 三次尝试均被取消/挂起（等页面响应不返回），已按队长硬约束**不再依赖该通道**。客户端事件结论来自已安装包源码研读（路径见下），可信度 = 源码契约（高），但非运行时目录（弱于 inspect）。**若需运行时确认，需从浏览器打开 devtools 后重试 inspect，本回合不再尝试。**

### 2.1 平台为客户端提供了两条推送式通道（源码证据，已验证）

**通道 A — `session/follow` Remote 流（逐事件推送，最接近「簇拥」需求）**
- 定义：`@deepseek-ai/dsh-api-session-controller`，宿主契约 `typert.host.js:822-843`：
  - `@Remote({ mode: 'stream' }) follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame>`
- 帧契约（`typert.host.js:1651-1656`）：
  - `SessionFollowFrame = { type:'snapshot'; header; cursor; records: SessionHistoryRecord[]; hasMore; projections } | SessionEventEntry`
  - `SessionFollowRequest = { address: SessionAddress; maxMessages?: number }`
- 实现（`types/history.js:127-224`，已验证）：开局吐 snapshot（含 cursor），随后**订阅 `session/event`（global）+ `session/created`** 逐条推 gap-free 事件帧（seq 连续校验，`:203-209`）。这就是「事件的推送源」的官方实现。
- 地址语义（`history.js:286-323`，已验证）：`address.kind === 'session'` 对普通会话；**subagent 会话必须用 `parent` 地址（childSessionId + parentSessionId）**——`validateAddress` 对 subagent 直接禁 `kind:'session'`（:291-294：「subagent Sessions require their durable parent address」）。成员是 continuable 子代理，**正好用 parent 地址**。
- 客户端接入方式（自带客户端验证，`transport.js:74-93`）：`remote.session.follow({ address, maxMessages? }, signal)`，`frame.type === 'snapshot'` → opened，其余 → entry（appended event）。这是官方 UI 本身在用的实时路径（`types/client/sessions/session.js` 的 journal append 即来自它）。

**通道 B — `$events` Remote 事件流（任意 Remote 事件）**
- `dsh-api-gateway`：`REMOTE_EVENT_STREAM_ENDPOINT = "$events"`（stream-protocol.js:5），`registerRemoteEvents(source, host)`（gateway index.js:485）；客户端 `ClientRemoteEvents`（types/client/remote-events.js:19-63）打开 `$events` 流接收 `{type:"emit", event, args}` 帧。emit 示例（fixture client.js:2608-2613）：`emitRemote("api-session/status", [id, running])`。
- 意义：若未来把「成员进展」做成 Remote 服务事件（如 AgentTeams 已有 `remoteView`），客户端可直接订阅；现状 dsh-team-chat 未用。

### 2.2 关键判定：群聊面板「被推送唤醒而不是 3 秒拉一次」可行，但需要接线

- **结论（已验证基于契约）**：客户端**能够**通过 `session/follow`（或 gateway `$events`）获得成员会话的事件推送——这是平台自带 UI（会话面板）的实时更新方式。
- **现状**：dsh-team-chat 的 `client.js` 只有 `/state`、`/speak`、`/task` 三个裸路由轮询/动作，**没有使用任何 Gateway Remote 流**（client.js 全文 grep 无 `$stream`/`follow`/`remote`）。所以「推送到面板」= **需要在客户端接入 Gateway Remote 客户端能力**，属于有明确契约的下阶段改造，不是现成开关。
- 折中（推荐给工程师）：**宿主侧先接 `session/event` + `agent/status`（零新依赖，插件级 ctx 直接 on），再由宿主把增量经现有 `/state` 回调推给客户端**（如长轮询/SSE 或直接把最新 seq 带进现有响应）。客户端因此不需要接入 gateway 栈即可先行受益；若要求真·推送，再接 `$events`/`session/follow`。

---

## 3. Q3 Service 精确契约与 AgentTeams 自取进展方式

### 3.1 `sessionQuery` 精确契约（platform=host Service，已验证完整返回）

关键方法（全部精确签名，来自 cordis_inspect host listService sessionQuery）：
```
observeSession(sessionId, options?): Promise<SessionObservation>
  → SessionObservation: { source:'live'|'prepared'; header; events; inheritedEventCount; cursor: SessionSeqCursor; revision?; projections?; retain() }
  （见 §4 判读：快照+游标租约，非增量订阅）
abstract searchSessions / searchEvents（全文检索，带 page/cursor）
listSessions(signal?) → SessionRecord[]（newest-first）
readSession(sessionId) → SessionLogSnapshot（完整原始日志，replay 校验）
filterSessions(filters, signal?) → SessionRecord[]
readTitle* / listEvents(sessionId) → SessionEventRecord[]（升序，轻量：仅 sessionId/seq/type/time/surface，无 data）
filterEvents(sessionId, filters) → SessionEventSearchDocument[]（可按 seq/time/type/surface/text 过滤）
readSurface(sessionId) → SessionSurfaceSnapshot（当前模型 surface + capturedThroughSeq）
traceSession / traceEvent / readEvent(SessionEventReadRequest { sessionId, seq, before?, after? }) → SessionEventWindow
```

### 3.2 `subagents` 精确契约（platform=host，已验证）

关键方法：
```
startContinuable(spec) → { childId, messageId }
sendMessage(sender, targetId, content, options) → MessageId
interrupt(targetSessionId, authority)
listChildren(parentSessionId, signal?) → SubagentListEntry[]（含 activity:'running'|'inactive'、label、mode）
listDescendants(rootSessionId, signal?) → SubagentDescendantListEntry[]（树形，含 parentId/depth）
@Remote('list') remoteExportList(parentSessionId, signal?) → SubagentCatalog（browser 用：durable listing + live activity）
@Remote('prompt') prompt(request, signal)
registerProvider / getProvider / list / start
```
- **无「订阅/流式」方法**：subagents 服务本身没有事件/流能力；活动信息来自 listChildren 的 `activity` 字段（宿主侧每次查询现取）。

### 3.3 `agents` 精确契约（platform=host，已验证）

```
currentInitiator()/requireInitiator()/withInitiator()/withoutInitiator()
setFactory(factory)
create(options)/resume(options) → AgentHandle
register(agent)/enter(agent, owner)/announce(agent)
get(id) → Agent | undefined
isOwnedBy(id, owner)
list() → Agent[]（live 注册序）
roots() → Agent[]
```
- **无事件/流**：agents 是注册表 + initiator 因果链；「状态变化」靠 `agent/status` 事件而非服务方法（见 Q1）。

### 3.4 AgentTeams 自身怎么拿成员进展（已安装包源码，已验证 file:line）

包：`C:\Users\bo.yang02\.dsh\profiles\desktop\node_modules\@nanmicoder\dsh-agent-teams\lib\`

**宿主侧：**
1. 状态变化走 **`agent/status` 事件**：`scheduler.js:428` `ctx.on('agent/status', ({ agent, status }) => …)`。
2. 活动快照走 **`ctx.agents.get(id).status`**：`members.js:597-606` `memberActivity(ctx, memberIds)` → `ctx.agents.get(brandedSessionId(id))` → `live.status`（running/idle/ready），**明确不再依赖 listChildren 的投影形状**（:588-592 注释）。
3. 消息/任务持久化走**自建 mailbox**：`state.js:6` `inbox/<agentKey>.jsonl`；`deliverToMember`（members.js:542）+ `kickMember`（scheduler.js:219-237）+ `steerCaptainReport`（members.js:80）。

**客户端侧：** UI 面板也是**轮询**：
- `client/activity-monitor.js:100-101` `ACTIVITY_POLL_MS = 1000`，`:128-229` `startActivityPolling` 每 1s fetch `/plugins/dsh-agent-teams/state`（带 in-flight 防重 :153-155）——**AgentTeams 自己的面板没走推送，1 秒轮询**。
- 启示：团队进展面板用轮询是该插件现状；dsh-team-chat 若想更优，可借到的现成 push 是 `session/event` + `session/follow`，AgentTeams 自身反而没用。

---

## 4. Q4 readSurface 的增量/尾部能力判定

### 4.1 `readSurface` 本身：无增量参数 — 已验证

契约签名：`async readSurface(sessionId: SessionId): Promise<SessionSurfaceSnapshot>`（参数只有 sessionId）。
返回 `SessionSurfaceSnapshot { session; inheritedEventCount; capturedThroughSeq: OptionalSessionSeq; events: SurfaceEvent[] }`。
- **没有** cursor/since/lastN/tail/fromSeq 等任何参数；`events` 是**完整当前 surface**（仅 user/message、assistant/message、tool/result 三类）。→ **readSurface 无可增量读取，明确「没有」。**

### 4.2 平台提供两个真正的增量替代 — 已验证（源码+契约）

**替代 1：`session/follow`（真·增量推送流）**
- 见 §2.1 通道 A。起步 snapshot 带 `cursor`（已有 seq），随后逐条推 `SessionEventEntry`（gap-free，seq 连续校验）。这是官方「从游标继续看」的原语。
- 对成员（subagent）会话需用 `address.kind:'parent'`（history.js:291-294）。

**替代 2：`sessionQuery.filterEvents(sessionId, [{ kind:'seq', from, to }])`（增量拉取）**
- `SessionEventResultFilter` 含 `{ kind:'seq' } & SessionResultRange{ from?, to? }`（sessionQuery 契约 referencedTypes）——可按 seq 区间拉取某一成员从上次游标以来的事件（轻量记录 + text）。配合 `capturedThroughSeq` 做游标。
- 补：`listEvents` 只返回轻量记录（无 data），`readEvent({sessionId, seq, before, after})` 只读单事件+上下文窗口——都不可直接当增量 feed，但可辅助追查。

### 4.3 队长线索核实：`observeSession` 的 cursor/revision — 已验证，「快照租约」而非「续读订阅」

已查 `dsh-session-query/lib/index.js:284-395`（SessionObservationReader）：
- live 路径（:365-387）：`events = session.snapshotEvents()`（**读取时点快照**），`cursor = events.at(-1)?.seq ?? -1`，`retain()` 只是把同一快照再留一份（引用计数），**不订阅后续**。
- prepared 路径（:296-363）：持久化借读，同样 `events` 为一次性数组，`cursor`/`revision` 为快照元数据，`retain()` 延长租约。
- **判定**：cursor/revision 存在（对队长线索：属实），但 `observeSession` **不是**「持有租约然后增量续读」的接口——它是一次观察的租约。**若要增量续读，正解是 `session/follow`。**（推测项：`SessionObservationReader.read` 循环只在找到 live/prepared 时返回，没有轮询/等待后续；函数体已证。）

### 4.4 「step/turn/tool 事件是否实际落盘」— 已验证（产生机制）

- Session 日志 append 后即发 `session/event`（`session/event` 契约「post-commit append feed」）；事件类型全集即 `SessionEventMap`（含 step/start、step/end、tool/call、tool/result、assistant/chunk/message）。
- `dsh-agent-loop` 本身就消费 `session/event` 中的 `user/message` 与 replacement 事件（index.js:50-57）——说明**这些事件在真实运行中产生且可被插件级监听**。
- `readSurface` 只投影 SurfaceEventType（3 类）是**投影层筛选**，不是「没落盘」；事件本体在 session 日志（`session/event`/`session/follow` 可拿全量）。
- **运行时实证（§5.5）**：解码真实会话日志得到 step/turn/tool 事件的实际计数（成员会话 step=224/tool=227/turn=19；captain 会话 step=625/tool=670/turn=46）——**从「类型定义存在」到「实际产生并可消费」已由真实日志直接证实**（非仅源码推断）。

---

## 5. Q5 综合判定：3 秒轮询能不能删

### 判定：**部分保留**（可删 readSurface 全量轮询；必须保留 roster 周期性发现与请求路径去同步化）

理由（逐段）：

**A. 可删除段（替换为事件驱动）— readSurface 逐成员全量轮询（lib/index.js:312 & tick :370）**
- 替代方案（已验证契约均可实现）：
  1. 宿主侧注册 `ctx.on('session/event', (session, event) => …, { global:true })`（仿 history.js:145 / agent-loop:50）：按 event.type 过滤 `assistant/message`/`user/message`/`tool/result`/`step/end`，`event.seq` 做游标推进 `state.seqSeen`，**产出即时到达、零轮询**。
  2. 状态变化注册 `ctx.on('agent/status', …)`（仿 scheduler.js:428）替代活动轮询。
  3. 首次打开/冷启动用一次 `session/follow`（parent 地址）或 `filterEvents(seq)` 追平历史。
- 收益：`readSurface` 双倍调用（tick+请求内 refresh）消失；与 perf-evidence.md 的 F1/F3 直接配套。

**B. 必须保留段（周期或请求级兜底）— 成员 roster 的周期性发现**
- `subagents.listChildren(parentSessionId)` 仍是 roster（成员 id/activity/label）的权威来源；`agents.list()`（:242）遍历全部 agent 也没有对应事件可完全替代「谁是我的成员」的枚举——`agent/created` 提供加入通知、`agent/disposed` 提供离开通知，可**大幅降频**（事件驱动 roster 增减），但**仍需低频兜底探测**（如 30-60s 或客户端切会话时一次 listChildren），防止事件丢失/排水（AgentTeams 自己的 `memberActivity` 也仍直接读 agents.get status，见 members.js:597-606）。
- 结论：**轮询不能全删；但可把「全量 surface 轮询」降为「roster 低频探测 + 事件驱动增量」**。3s 高频可删，保留 30-60s 低频兜底（可配置）。

**C. 必须保留段 — /state 请求路径去同步化（perf-evidence F1）**
- 即便事件驱动到位，`/state` 处理器在请求内 `await refresh`（index.js:420）仍会触发整链读服务；应改为「返回最近缓存快照 + 后台触发增量」，属 F1 范畴，事件化后一并解决。

**D. 订阅形态（可直接照做的最小实现）— 若判定为「删轮询改订阅」，请工程师按此落**

```js
// 宿主侧（dsh-team-chat/lib/index.js 内）
const disposers = []

// 1) 成员产出推送：会话日志追加即回调（global 以收到非本 scope 的成员会话）
disposers.push(ctx.on('session/event', (session, event) => {
  // 过滤：只关心成员会话事件；用 event.seq 作为游标（state.seqSeen 已存在）
  if (!isMemberSession(session.id)) return
  if (event.type === 'assistant/message' || event.type === 'user/message' ||
      event.type === 'tool/result' || event.type === 'step/end') {
    // 与现有 refresh() 内逻辑相同：textOf → push(state, kind, memberName, text)
    // …（复用现有增量解析，只是触发源从轮询 tick 换成事件）
  }
}, { global: true })) // 契约要求 global 才能收非本 scope 事件

// 2) 成员状态推送：idle⇄running（替代活动轮询中的 readSurface; F3）
disposers.push(ctx.on('agent/status', ({ agent, status }) => {
  const member = rosterByName.get(agent.id)
  if (member) pushActivityChange(state, member, status) // 现有「🔨 开始工作/◽ 空闲」
}))

// 3) roster 低频兜底（保留段）— 秒→30-60s 或 session 切页时触发
//    tick() 保留但改为：仅 listChildren（不发 readSurface），且 interval 放大

// 4) 生命周期清理：disposers 的每个回调返回的 disposer push 进 ctx.effect(() => () => {
//      for (const dispose of disposers) dispose()
//    }, 'team-chat: event-driven feed')
```

- 生命周期：`ctx.on(...)` 返回的 disposer 必须在 `ctx.effect` 里收集清理（与现 poller 的 `ctx.effect(() => () => clearInterval(poller))` :374 同模式）。

---

## 5.5 事件落盘实证（t13 独有优势：解码真实会话日志）— 已验证

**方法**：解码 `C:\Users\bo.yang02\.dsh\sessions\--E-DSH_Desktop-DSH~0020Desktop--\<sessionId>\session.jsonl.zstd`（多帧 zstd，按魔数 0x28B52FFD 逐帧解），脚本 `docs/optimization/measure-events.mjs`（可复现）。采样两个真实会话：**researcher 成员会话**（2ef3734b…）与 **captain 会话**（session-f83714c9…，即当前团队队长）。

### 计数（事件确实落盘)

**成员会话（researcher，本任务执行期间）** — decoded 5868 帧 / 5549089 chars：
```
step/start  224        step/end    223
tool/call   227        tool/result 226
turn/start   19        turn/end     18
assistant/message 224  assistant/chunk 2620
user/message  22       agent/inbox/spliced 42
```
**captain 会话** — decoded 17507 帧 / 18558593 chars：
```
step/start  625        step/end    625
tool/call   670        tool/result 693
turn/start   46        turn/end     46
assistant/message 624  compaction/prune 23
user/message 100       agent/inbox/spliced 175
```

**结论（已验证）**：队长线索「类型定义存在 ≠ 实际落盘」已被实测否定其担忧——`step/start`、`step/end`、`tool/call`、`tool/result`、`turn/start`、`turn/end` **在真实成员与队长会话中大量实际产生并写入 session 日志**，且均可被 `session/event`（post-commit append feed）推送消费。`readSurface` 不含 `tool/call` 只是投影层筛选（只挑选 SurfaceEventType），事件本体在日志里存在。

### tool/call 参数的产物线索（群聊信息架构可行性）

对 `tool/call` 的参数做 path/command/cwd 线索统计：

**成员会话**：153 个 tool/call 参数携带路径/命令线索——`pwsh: 84`（command 字段，如 `{"command":"pwd; echo …","description":"Show working directory…"}`）、`read: 30`（file_path 字段，如 `{"file_path":"E:\\DSH_Desktop\\DSH Desktop\\.agent-teams\\…\\team.json"}`）、`grep: 20`、`write: 11`、`edit: 7`、`glob: 1`。
**captain 会话**：`pwsh: 161`、`edit: 134`、`read: 99`、`grep: 56`、`write: 37`、`glob: 11`。

**结论（已验证）**：`tool/call` 的 `arguments` 天然携带**文件路径、命令、目录**等结构化产物线索——即「群聊能从成员会话提取出产生了哪些文件/跑了哪些命令」成立，数据就在事件日志中，无需轮询 surface 即可获得。这直接支撑「事件驱动 + 结构化提取」的双重可行性。

---

## 5.5b 队长线索 1 的最终核实：observeSession cursor 语义（已在 §4.3 结论基础上补充）

- `observeSession` 的 `cursor/revision`：**已验证为「快照租约」**——`dsh-session-query/lib/index.js:284-395`（SessionObservationReader.read），live 与 prepared 两条路径都取一次性事件快照（`events.at(-1)?.seq` 作 cursor），`retain()` 仅按引用计数保留同一份快照的吊销，**没有“持有租约后增量续读”的机制**。
- 因此「按 cursor 只追增量」不能靠 `observeSession` 本身闭环；**正解是 `session/follow`**（history.js:127-224 内部就是 global `session/event` + `session/created` 订阅 + seq 连续性校验的官方增量实现）。若走 `filterEvents` seq 区间拉增量，则是无流式通道时的次优替代（每次拉取仍要 pay 一次查询延迟，但没有 surface 全量成本）。
- **长期持有**：观察租约可 retain，但持有的是快照不是游标订阅；长期增量只能靠 follow 的流 + 事件重放。
- 历史追平：首次打开面板时调用一次 `sessionQuery.filterEvents(memberId, [{kind:'seq', from: initialCursor+1}])` 或 `session/follow({address:{kind:'parent', childSessionId, parentSessionId}})`。
- 风险：`{ global:true }` 会收到全部会话事件，回调内必须按 sessionId 过滤 + 游标去重（seq 单调）；事件风暴时防抖（可用 timer 服务的 throttle/debounce，contract 里就有）。

---

## 6. 已验证 / 推测 总表

| 条目 | 判定 | 依据 |
|---|---|---|
| session/event 精确契约 | 已验证 | cordis_inspect host Event；history.js:145 / agent-loop:50 消费示例 |
| agent/status 精确契约 | 已验证 | cordis_inspect host Event；AgentTeams scheduler.js:428 |
| agent/inbox/inserted、subagent/start/end | 已验证 | cordis_inspect host Event |
| 客户端 $events / session/follow 存在 | 已验证（源码契约） | dsh-api-gateway stream-protocol.js:5；session-controller typert.host.js:822-843；transport.js:74-93 |
| 客户端运行时事件目录 | 未取得（挂起） | platform=client inspect 三次超时；按队长指令放弃，结论基于源码 |
| sessionQuery.filterEvents seq 区间 | 已验证 | cordis_inspect host Service（SessionEventResultFilter） |
| readSurface 无增量参数 | 已验证 | 契约仅 sessionId 参数 |
| observeSession cursor/revision 是快照租约非续读 | 已验证 | dsh-session-query/index.js:284-395 源码 |
| step/turn/tool 事件实际产生 | **已验证（运行时实证）** | 解码真实会话日志：成员会话 step/start=224 step/end=223 tool/call=227 tool/result=226 turn/start=19 turn/end=18；captain 会话 step=625 tool=670 turn=46（§5.5，measure-events.mjs 可复现） |
| tool/call 参数含产物线索 | **已验证（运行时实证）** | 成员会话 153 个 tool/call 带 path/command/cwd 线索（pwsh 84/read 30/grep 20/write 11/edit 7/glob 1）；captain 会话 498 个（§5.5 表） |
| AgentTeams 宿主取活动 = agent/status + agents.get.status | 已验证 | scheduler.js:428；members.js:597-606 |
| AgentTeams 客户端 = 1s 轮询 | 已验证 | activity-monitor.js:100-101, 128-229 |
| 「3 秒轮询能删 surface，roster 保留低频兜底」 | 判定（部分保留） | 由上述契约综合推导 |

---

## 7. 留给下阶段/风险

1. **运行时验证（未做，注明）**：插件级 `ctx.on('session/event', …, {global:true})` 在同一 host 进程实跑确认成员会话事件可达（agent-loop 的证据链已很强，但未在 dsh-team-chat 插件上下文内埋点实测）。建议工程师落地时先加一次 30 秒冒烟。
2. **客户端真推送的复杂度**：接入 gateway `$events`/`session/follow` 需要浏览器侧 Remote 客户端；若求快，先做「宿主事件 → /state 增量响应」的中间形态（不推流，只把最近 seq 传回，客户端比对后增量请求）。
3. **`session/follow` 的 parent 地址**必须带 `childSessionId + parentSessionId`（subagent 会话禁 kind:'session'）——别写成普通会话地址。
4. **roster 探测频率**：推荐 30-60s 兜底 + `agent/created`/`agent/disposed` 事件即时增减，避免「事件丢 → roster 永不更新」。