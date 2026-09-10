# 新方案安全论证：session/event 全局订阅的载荷与事件洪流 + session/follow 用法（event-subscription-cost）

> 生成：researcher · 2026-09-10 · t15（attempt 1）
> 前置：t13 判定「3 秒轮询可部分删」→ 宿主侧 `ctx.on('session/event', …, {global:true})` + `ctx.on('agent/status', …)` 订阅。本任务在动手前评估该方案自身的洪流风险。
> 取证：platform=host Inspect（安全）+ 已安装包源码 + **真实会话日志速率实测**。全程零 platform=client 查询。
> 每条结论标「已验证」/「推测」；来源 = 契约签名/file:line/实测命令。

---

## 0. 结论速览（先给判定）

**全局订阅是否安全？→ 安全（有条件的）**。判定依据：
1. `session/event` 载荷 = 完整事件（含 `data`），类型全集 = `SessionEventMap`；**确实包含高频流式增量 `assistant/chunk`**（实测为 feed 主体），这是唯一真正的洪流源。
2. 实测峰值速率：单会话忙时 **24–50 事件/秒**（1s 滑窗，含 chunk 行；仅含 `session/event` 会投递的 `assistant/chunk` 时约 23–50）。团队全部成员同时运行并全部被订阅 = 峰值按会话数近似线性叠加；**但按 3 成员+队长=4 会话同忙最坏估算 ≈ 100–200 ev/s 上限**（推测量级，见 Q2）。
3. **关键**：订阅回调不做重活（只做 O(1) 过滤 + seq 游标 + 入队），100–200 ev/s 对 Node/事件循环完全可承受（每次回调 <1µs 量级）；洪流风险全部来自「回调内 readSurface/解析/渲染」——禁止即可。
4. `{global:true}` = 收所有会话事件；**可用 `session.id` 在回调内一行过滤**；平台无「只订阅指定成员会话」的精确 scope（scope 层按 agent 上下文，非 session id），但回调过滤等价且廉价。
5. 真正的增量续读正解 = **`session/follow`**（Remote 流，内部就是 global `session/event` + `session/created`），可完全替代 `observeSession` 做 cursor 续读；本方案不直接用 follow（它在 client/gateway 栈），宿主直挂事件即可。
6. **必须加的超时/心跳/背压**：见 Q5——本轮已两次被「无界等待+无告警」击穿（client Inspect 16 分钟、better-sidebar 停更），订阅代码不得再犯。

**可直接照做的形态**：见 §Q5.3。

---

## Q1 `session/event` 精确载荷 — 已验证（host 契约 + 源码）

**契约（cordis_inspect host Event，精确原文）**：
```
name:      session/event
mode:      emit
signature: 'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void
描述:      "Post-commit, fire-and-forget append feed. The listener snapshot resolves before
           the log push, but callbacks run after it; observer failures are logged and contained."
参数:      session — 日志增长的会话；event — 追加的事件，**恰好如落盘记录**（the appended event, exactly as recorded）
```

- **完整事件（含 data），不是轻量记录**：`SessionEvent = { type, seq, time, data }`（`data: SessionEventMap[T]`）。与 `listEvents` 的轻量记录（仅 sessionId/seq/type/time/surface，无 data）明确不同。
- **覆盖的 type = `SessionEventMap` 全集**（已验证，契约 referencedTypes）：
  `turn/start`、`turn/end`、`step/start`、`step/end`、`user/message`、**`assistant/chunk`**、`assistant/message`、`tool/call`、`tool/result`、`request/header`、`request/context`、`session/end-seed`。
- **是否包含高频流式增量 → 是，`assistant/chunk` 在事件全集内并实际投递**：
  - 明确写进 `SessionEventMap`：`'assistant/chunk': { turn, step, chunk: StreamChunk }`（StreamChunk 含 text-delta/reasoning-delta/tool-call-delta/block-*）。
  - 实测落盘路径（已验证源码）：`dsh-agent-loop/lib/index.js:628` `this.session.append("assistant/chunk", …)` —— **assistant/chunk 经 `session.append` 写入 → 触发 `session/event`**。这是洪流确认的硬证据。
  - 注：日志中另见 `reasoning-chunks` / `text-chunks` / `tool-call-chunks` 行——**不是 SessionEventMap 类型、不在任何 host `session.append` 路径**，只见于 client/history 渲染层（grep 仅 dsh-api-session-controller/dsh-api-remotes/dsh-client-connection），属于**浏览器线格式的 chunk 打包行**，不会作为 `session/event` 载荷投递。做速率估算时只计 `assistant/chunk`。

## Q2 频率量级（实测）— 已验证（解码真实日志）

**方法**：解码 `C:\Users\bo.yang02\.dsh\sessions\--E-DSH_Desktop-DSH~0020Desktop--\<sessionId>\session.jsonl.zstd`（多帧 zstd 逐帧解，脚本 `measure-event-rate.mjs` / `measure-chunk-rows.mjs` 可复现）。采样本团队 3 个真实会话。

### 2.1 条数分布（全类型，实际落盘）

| type | researcher 会话 | captain 会话 | engineer 会话 |
|---|---|---|---|
| assistant/chunk | 2,907 | 6,153 | 991 |
| tool/call | 260 | 689 | 163 |
| tool/result | 259 | 712 | 163 |
| step/start | 259 | 637 | 150 |
| step/end | 258 | 637 | 149 |
| assistant/message | 259 | 636 | 149 |
| turn/start | 22 | 49 | 14 |
| turn/end | 21 | 49 | 13 |
| user/message | 25 | 110 | 16 |
| agent/inbox/spliced | 47 | 193 | 28 |
| （其余 request/header 等小项） | 各 ≤8 | 各 ≤23 | 各 ≤6 |
| 原始总行数（含 chunk 打包行） | 9,287 | 25,562 | ~1,900 |

（数值来自 decode 实测；captain 会话是 3 成员队列的中枢，chunk 密度最高。）

### 2.2 每秒预期事件数（订阅后）

**「有成员在运行」情形（忙时段）**——1s 滑窗峰值速率（实测）：
```
researcher: 峰值 24 ev/s（原始行；session/event 会投递的 assistant/chunk ~23）
engineer:   峰值 14 ev/s
captain:    峰值 50 ev/s（4 任务并行队列，最忙会话）
```
- **单会话忙时上限 ≈ 50 ev/s**（captain 实测）。
- **全团队同忙最坏估算（推测，叠加）**：3 成员 + 队长 = 4 会话同时流式，若全部被全局订阅 → **≈ 100–200 ev/s 上限**（50+24+14+14≈102，chunk 分配不均匀；标注为推测，因多会话同忙并发未直接观测）。
- 这些事件的**处理代价**（已验证语义）：每个 `session/event` 回调若只做「session.id 比对 + type 过滤 + seq 游标推进 + 字符串入队」，为 O(1) 轻操作（µs 级）；100–200 ev/s 完全在 Node 事件循环承受范围内（对比：每秒几千次 `setTimeout` 也能跑）。
- **结论：事件洪流的代价不在数量，而在回调里做了什么。** 若回调内做 readSurface/JSON.parse 大对象/渲染，50–200 ev/s 立刻成灾；若只做游标+入队+另行节流消费，安全。

**「团队空闲」情形（实测）**：会话语义事件（非 chunk）在无 turn 时几乎为零——空闲时段只有 `agent/inbox/spliced`（入队提示）与零星 user/message；**订阅后空闲期事件率 <0.1 ev/s**（实测整体均值 0.07–0.34 ev/s，绝大部分来自忙时 burst）。

### 2.3 区分「流式噪声」与「有意义事件」

- chunk 类（`assistant/chunk`）占会话原始事件的 **53–67%**（researcher 67%、captain 62%——实测）。**群聊步骤行不需要它** → 订阅后第一件事就是按 type 过滤掉。
- 有意义事件（turn/step/tool/assistant-message/user-message）：忙时峰值 11 ev/3s（researcher）、23 ev/3s（captain）——**过滤后事件率不到 10 ev/s**，这是群聊实际要消费的量级，完全轻松。

## Q3 `{global:true}` 语义与代价 — 已验证（dsh-scope 源码 + host 契约）

**语义**：
- 平台是 scope 分发（`@deepseek-ai/dsh-scope`）：事件带 scope carrier（`scopeTarget(base, subject)`），监听者按 scope key 路由。`ScopedLayers` 有 **global 层**（`createLayer(void 0)`，收所有事件）与 **精确 scope overlay**（按 agent 上下文 key，收该上下文相关会话的事件）；祖先 scope 的监听者接收派发到后代的 events（scopeParents 链，`dsh-scope/lib/index.js:225-280`）。
- `ctx.on('session/event', handler)` **默认**：监听者注册在哪个 context，就收该 context 相关会话的事件（agent-scoped 监听只收该 agent 上下文进入的会话——契约注明）。
- `ctx.on('session/event', handler, { global: true })`：**明确进入 global 层 → 收到所有会话（全部 agent）的 session/event**。这是 history.js:145（`this.ctx.on('session/event', …, { global: true })`）与 dsh-scope invariant.js:64 的用法。

**代价与过滤**：
- 代价：每个会话每次 append 都会把事件分发给 global 监听者 → 事件频率 = 全 harness 所有会话的事件总和（本部署 ~12 个会话，忙时约 4 个活跃）。回调对不关心的 session 会**空转被调用**，但过滤成本 O(1)。
- **能按 session 过滤吗**：能——回调第一行 `if (session.id !== wantedId) return`（正是 history.js:145-150 的做法：`if (session.id !== target) return`）。等价且廉价。
- **有没有「只订阅我们关心的几个成员会话」的精确 scope**：**没有按 session-id 精确定位的订阅方式**（scope 是按 agent 上下文 key，不是按 session id）；`session/follow`（Remote 流）是唯一按 address 精确订阅的通道，但它属于 client/gateway 栈。宿主侧全局订阅 + 回调过滤是最接近的形态，代价可忽略。
- 补充（已验证语义）：`subagent/start`/`end`、`agent/status` 事件同理需在回调内按 agent.id/member 集合过滤；无会话级 scope。

## Q4 `session/follow` 精确契约与用法 — 已验证（session-controller 契约 + 源码）

**契约（typert.host.js:1245, 1651-1656；远程 `mode:'stream'`）**：
```
@Remote({ mode: 'stream' }) follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame>
SessionFollowRequest  = { address: SessionAddress; maxMessages?: number }
SessionFollowFrame    = { type:'snapshot'; header; cursor: number; records: SessionHistoryRecord[]; hasMore: boolean; projections } | SessionEventEntry
SessionEventEntry     = { type:'event'; event: SessionWireEvent }
SessionAddress        = { kind:'session'; sessionId }
                      | { kind:'subagent'; parentSessionId; childSessionId; mode:'one-shot'|'continuable' }   // ← subagent 的正确形态
```

**'kind:subagent' 地址含义**（此前我 t13 里写的「kind:parent」不准确，现予更正）：本 harness 用 **`{ kind:'subagent', parentSessionId, childSessionId, mode }`** 寻址子代理会话——`validateAddress`（history.js:289-323）对 `kind:'session'` + `header.origin === 'subagent'` 直接拒绝（「subagent Sessions require their durable parent address」，:291-294），必须用 subagent 地址（child + parent + mode），并校验 descriptor（mode 匹配、子代理存在）。成员是 continuable 子代理 → `{ kind:'subagent', parentSessionId: 队长id, childSessionId: 成员id, mode:'continuable' }`。

**用法**：
- 起点：`follow` 先推一个 `snapshot` 帧（含 `cursor` = 起始 seq、`records` = 已有历史、`hasMore`）；随后推 **gap-free** `event` 帧（seq 连续校验，:203-209，跳过=报错 `gateway/internal`；漏 seq 会断流）。
- 客户端消费（官方自带，transport.js:74-93）：`for await (const frame of remote.session.follow({address, maxMessages?}, signal))`；`frame.type==='snapshot'` → opened（记 cursor），否则 `entry`（append 事件）。
- **取消**：`signal`（AbortSignal）取消流；实现内 `signal.addEventListener('abort', notify)`（history.js:165-166）；取消后 closeFollowers 移除。
- **能否替代 observeSession 做增量续读 → 能（且是正解）**：`observeSession` 是快照租约（cursor 是读取时点的尾 seq，`retain()` 只保留同一快照，无续读机制，已核 dsh-session-query/index.js:284-395）；`session/follow` 内部就是 global `session/event` + `session/created` 订阅 + seq 连续性校验（history.js:127-224），**从 cursor 起持续推增量**——真正的增量续读。宿主若要精确按会话订阅且要断点恢复，follow 是比裸 global 订阅更强的形态（有 cursor/seq 校验/断流报错）。

## Q5 安全用法（生命周期 / 回调纪律 / 背压与丢弃 / 超时心跳 / 可直接照做形态）

### 5.1 生命周期清理（ctx.effect）
- `ctx.on(...)` 返回 disposer；必须在 `ctx.effect(() => () => { …disposers… }, 'team-chat: event feed')` 收集，插件卸载时一并释放（与现有 poller 同模式 index.js:374）。
- 同时清理 `setInterval` 心跳 timer（ctx.timer.interval 或 clearInterval）。

### 5.2 回调内该做什么 / 不该做什么（洪流控制的全部要点）
- **做**：O(1) 过滤（session.id ∈ 成员集合、type ∈ 关注集）→ seq 游标推进 → 把事件 `push` 进轻量环形缓冲/队列（纯内存操作）。
- **不做（严禁）**：回调内 `sessionQuery.readSurface`、`JSON.stringify` 大对象、React 渲染、文件 I/O、任何 await 慢调用——**这些会把「读服务卡顿」原样搬进事件回调**，且阻塞宿主事件循环（global 层同步分发，回调慢=全部会话事件排队）。
- 消费侧：独立的节流消费（如 `ctx.timer.interval` 或尾随 300–1000ms 的批量 flush），从缓冲批量取增量再更新状态；消费侧可以做重活，回调侧不行。
- **背压与丢弃**：缓冲设上限（如 2000 条/会话）；溢出时**丢弃低价值事件（chunk 早已过滤，剩的都是步骤级，丢整条会破坏 seq 连续）**→ 正确策略是溢出时标记 `lag=1` 并触发一次「快照重同步」（用 `session/follow snapshot` 或 `filterEvents` 从最后 seq 重拉），而不是无限入队；anti-flood：回调按 type 对 `assistant/chunk` 直接 `return`（一步过滤），这是减 60% 流量的第一刀。

### 5.3 必须的超时与心跳（本轮两次被「无界等待无告警」击穿的教训）
- **事件流自身不设超时（它是 push 源）**，但**消费/同步路径必须设超时**：任何 `await`（catch-up 拉取、follow 打开、状态刷新）都加 AbortSignal 超时（如 5–10s），超时后重试/报错，绝不无界等待——client Inspect 的教训是 16 分钟静默挂起。
- **心跳**：宿主维护一个 30s 心跳定时器（`lastEventAt` 与 `lastTickOk`），若成员正在 running 但 60s 无事件且心跳失败 → 打日志 + 触发一次 `filterEvents` 自检（防止事件静默停更——better-sidebar 教训）。
- **错误可见**：任何订阅回调异常都要 `try/catch` 并 `ctx.logger.warn`（契约注明 observer failures 被 contain 但不告知调用方？——契约说 "observer failures are logged and contained"，但仍建议显式 try/catch 加告警），避免静默吞噬。

### 5.4 可直接照做的订阅形态（事件名 + 回调签名 + 过滤 + 清理）
```js
// dsh-team-chat/lib/index.js 内
const disposers = []
const WATCHED = new Set() // 成员 session id（roster 变化时增删）
const BUFFER = new Map()  // memberId -> { seq, rows: [] }，上限 2000

// 1) 成员产出推送（global → 全量事件；回调内只做 O(1) 过滤+入队）
disposers.push(ctx.on('session/event', (session, event) => {
  try {
    if (!WATCHED.has(session.id)) return            // 一行过滤到成员会话
    if (event.type === 'assistant/chunk') return     // 第一刀：滤掉 60% 流式噪声
    const cell = BUFFER.get(session.id)
    if (cell === undefined) return
    if (event.seq <= cell.seq) return                // 游标去重
    cell.seq = event.seq
    cell.rows.push(event)
    if (cell.rows.length > 2000) {                   // 背压：溢出→标记 lag，另走快照重同步
      cell.lag = true
      cell.rows.length = 0
    }
  } catch (error) { ctx.logger.warn('team-chat: session/event handler: ' + String(error)) }
}, { global: true }))

// 2) 成员状态（替代活动轮询）
disposers.push(ctx.on('agent/status', ({ agent, status }) => {
  if (!WATCHED.has(agent.id)) return
  /* push 系统行：🔨 开始 / ◽ 空闲 → 直接进 UI 缓冲 */
}))
// agent/created / agent/disposed → WATCHED 增删（成员增减）

// 3) 独立节流消费（重活在这里做，不在回调内）
const flushTimer = ctx.timer.interval(500) // 或 setInterval；消费缓冲→ update state / 持久化
// 4) 心跳（30s）：lastEventAt 老于 60s 且有 running 成员 → logger.warn + filterEvents 自检
// 5) 清理
ctx.effect(() => () => { for (const d of disposers) d(); clearInterval(flushTimer) }, 'team-chat: event feed')
```
- 签名依据：`session/event` 回调 `(this: Scoped<Session>, session, event)`；`agent/status` 回调 `(payload: {agent, status})`。
- 生命周期：全部 disposer 进一个 `ctx.effect`；HMR 安全（effect 卸载即清理）。

## 6. 最终判定与替代

**判定：全局订阅安全（有条件）**，条件为：
1. 回调只做 O(1)（过滤+游标+入队），重活全部移到节流消费侧 —— 满足则 100–200 ev/s 上限可承受；
2. 第一刀过滤 `assistant/chunk`（减 60% 流量）；
3. 消费/同步路径带超时（5–10s）+ 30s 心跳 + 溢出重同步背压；
4. 全回调 try/catch + 日志。

**替代方案（若判定不安全或想更稳）**：
- **首选增强**：宿主仍直挂 `session/event`，但把「增量续读+断点恢复」交给 `session/follow`（对每个成员开一条 Remote 流，`{kind:'subagent', parentSessionId, childSessionId, mode:'continuable'}`，snapshot 起步+cursor+seq 校验+abort 取消）——比裸订阅更强（有 seq 校验与 error 可见性），代价是要接入 gateway Remote 客户端能力。
- **降级**：保留低频轮询（30–60s）但**去掉逐成员 readSurface**（只需 listChildren 拿 roster + 状态），事件驱动负责增量消息——这是「部分保留」的兜底档。
- **不需要**：scoped 订阅（无 session 级 scope，等价做法是回调过滤，已含在首选内）。

## 7. 已验证 / 推测总表

| 条目 | 判定 | 依据 |
|---|---|---|
| session/event 载荷=完整事件含 data | 已验证 | host 契约（"exactly as recorded" + SessionEvent 结构） |
| assistant/chunk 包含在 session/event | 已验证 | SessionEventMap 含之 + agent-loop:628 session.append 落盘 |
| reasoning/text/tool-call-chunks 非 session/event 载荷 | 已验证 | grep 仅见 client/history 层，无 host append 路径 |
| 忙时峰值 14–50 ev/s（单会话） | 已验证 | 解码 3 真实日志 1s 滑窗实测 |
| 全团队同忙 100–200 ev/s 上限 | 推测 | 4 会话峰值线性叠加估算，未直接观测并发 |
| chunk 噪声占 53–67% | 已验证 | 实测占比 |
| 过滤后有意义事件峰值 <10 ev/s | 已验证 | 实测（11/23 ev/3s → ÷3） |
| global:true=收所有会话，可回调过滤 | 已验证 | dsh-scope ScopedLayers + history.js:145-150 用法 |
| 无按 session id 的精确 scope | 已验证 | scope 按 agent 上下文 key（dsh-scope 源码） |
| session/follow 契约与 subagent 地址 | 已验证 | typert.host.js:1245/1651-1656 + history.js:289-323 |
| follow 可替代 observeSession 续读 | 已验证 | history.js:127-224（snapshot+cursor+gap-free+abort） |
| 全局订阅安全的最终判定 | 判定 | 本报告 §6，条件为本报告 §5.2-5.3 |

---

## 8. 留给下阶段

1. **并发多会话同忙的峰值实测**（本报告为推测叠加）：可在优化落地后加一次多成员同时运行时的 60s 采样打点。
2. **回调真实负载验证**：实现后给回调加 `performance.now()` 采样，确认单回调 <1ms（探测用，不随产品发布）。
3. **client 端能否直接开 session/follow**（需浏览器上下文）：列入「队长代查」，不影响宿主方案。
4. **心跳阈值**：30s/60s 为初始建议，上线后按真实事件间隔校准。