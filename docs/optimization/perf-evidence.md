# dsh-team-chat 性能根因证据清单（perf-evidence）

> 生成：researcher · 2026-09-10 · 被分析对象 `dsh-team-chat`（纯 JS，无构建步骤）
> 范围：仅取证 + 建议，**未修改** `lib/` 任何源码；未执行 git push；未动 DSH profile 安装态。
> 方法声明：所有数字由 node 实测（脚本在 `docs/optimization/measure-*.mjs`，可复制重跑）；所有行号以当前文件为准（已复核，与任务锚点一致）。每节标注「已验证」/「已否定」/「推测」，硬性区分。

---

## 0. 结论速览（按影响排序）

| # | 根因 | 对应假设 | 判定 | 实测/证据要点 |
|---|---|---|---|---|
| R1 | readSurface 轮询被翻倍 + 无重叠防护 + 请求路径同步刷新 | H1（+局部 H2） | **已验证（机制）/ 主因地位=推测** | tick 3s 一次 + 浏览器轮询 3s 一次 = 每成员 readSurface **≈2 次/3s**；tick 无 busy 锁；/state 请求内同步 refresh |
| R2 | 客户端每轮询整树重渲染 + 滚动条每次跳底 + 无 memo/虚拟化 | H4 | **已验证** | client.js:182 / :218 每次 setData 全量重建；`:453` 每 3s scrollTop 跳底；全文无 React.memo |
| R3 | 切会话：客户端先清零再全量拉取，且请求内同步 refresh 阻塞响应 | H2（切会话慢） | **已验证**（机制）；「响应体随消息量无限增长」=**已否定** | client.js:198-203 清零+全量；服务端 :420 请求内 refresh；body 有 200 条上限 |
| R4 | routingText 无条件注入每个会话的每次模型请求 | H3 | **已验证**；对「卡顿」贡献=推测（每请求 token 成本） | index.js:567-577 全局 section + :588 scoped；实测 2105–5851 B/请求 |

**H5 判定：已否定（就本插件代码而言）**——轮询路径不含任何 sendMessage，模型回合由 AgentTeams 的唤醒机制触发，不在 dsh-team-chat 代码内。

---

## 1. 实测数据（可复核）

### 1.1 routingText 字符数 / UTF-8 字节数（H3）

```text
默认铁三角名册（soul only）      : 931 chars / 2,105 B / 21 行
当前 multi-role-team 真实配置     : 1,530 chars / 3,577 B / 21 行
最坏情况（每个成员 1200 字符上限）: 4,595 chars / 5,851 B / ~26 行
memberPrompt 截断校验            : 2000 chars 输入 → 1201 chars 输出（cap=1200 + '…'）
```

复现：`node docs/optimization/measure-shared.mjs`、`measure-prompts.mjs`、`measure-h3-bound.mjs`

### 1.2 /state 响应体典型字节数（H2）

```text
50 条消息  → 13,227 B   threads=50
200 条消息 → 50,825 B   threads=200   ← 已达 WINDOW_MESSAGES 上限
400 条消息 → 50,935 B   threads=200   ← 封顶（slice(-200)），不随消息量继续增长
回复密集 200 条（40 根×5 回复）→ 82,123 B  threads=40   ← 实际形态上限约 82KB
stringify 0.04–0.22 ms | parse 0.09–1.69 ms（200 条级别，主机侧微不足道）
```

复现：`node docs/optimization/measure-state.mjs`、`measure-state2.mjs`

### 1.3 readSurface / tick 主机侧成本（H1）

```text
首次全量扫描 events（找 max seq）: 1k=0.095ms  5k=0.160ms  20k=0.710ms
FRESH_LIMIT(24) 尾部增量扫描     : 0.020ms（有界）
groupThreads(slice(-200))        : 0.09–1.15 ms
→ 主机侧纯处理全部 <2 ms，插件自身 CPU 开销可忽略；
→ 成本集中在外部服务调用自身（sessionQuery.readSurface / subagents.listChildren），本环境无法插桩实测（外部服务），判为推测但频率是硬事实。
```

### 1.4 实况探针

```text
GET http://127.0.0.1:43120/plugins/dsh-team-chat/state（未鉴权）
→ HTTP 403（fenced）——路由已挂载且受 Connection 鉴权保护；无法匿名实测响应延迟。
```

---

## 2. 假设逐条判定

### H1：3 秒轮询对每个成员调用 readSurface → 高频磁盘 I/O + 大对象解析/序列化 → 「子 agent 一跑就全 DSH 卡顿」主因

**判定：机制已验证；「主因」地位=推测（服务端成本不可插桩）**

已验证的事实（file:line）：
- 轮询存在且周期 3 秒：`lib/index.js:58` `const POLL_MS = 3000`，`:370` `setInterval(() => { void tick() }, POLL_MS)`。
- 每 tick 对**每个成员**调用 readSurface：`:312` `surface = await ctx.sessionQuery.readSurface(member.id)`（在 `refresh()` 的 `for (const member of roster)` 循环内，`:309`）。
- **调用被浏览器轮询翻倍**：客户端默认每 3s 轮询 `/state`（`client.js:101` 默认 `pollSeconds: 3`，`:211-226` setInterval），而 `/state` 处理器在请求内**同步执行完整 refresh**（`index.js:690-695` → `targetState` → `:420` `await refresh(...)`）。即：后台 tick（3s）+ 前端轮询（3s）= 平均 **≈2 次/3s/成员**，且二者无协调。
- **tick 无重叠防护**：`:360-368` `async function tick()` 无 busy/in-flight 锁，`:370` fire-and-forget——若某次 tick 超过 3s（成员活跃、日志增长时很可能），下一次 setInterval 回调会**并行叠加**，readSurface 调用数成倍放大。
- 发现开销也随 agent 总数缩放：`discoverCaptains` 每 tick 调 `ctx.agents.list()` + 对每个 agent 调 `listChildren`（`:242-256`、`:250`），与团队数/agent 数线性相关。
- IM origin 的那次 readSurface 有缓存（`:439-457`，`imOrigins` map），一次性，不构成高频。

推测的部分（明示）：
- readSurface 服务端实现（磁盘读取+整份事件数组物化+传输）不在本仓库，无法插桩实测耗时/IO 量；「高频磁盘 I/O」成立的前提是该服务按事件日志全量读取，需在 DSH 侧打点确认。主机侧对返回值的处理已实测为 <2ms，故**卡顿大头在服务调用本身而非插件解析**。
- 依据：成员运行期会话日志持续增长 → readSurface 返回值单调增大 → 服务端序列化/IO 成本随之上升，同时在 2×/3s 频率下被放大。此推断符合症状（“子 agent 一跑就卡”），但归因强度 = 推测（高置信），非实测。

### H2：/state 响应体随群聊消息量增长，客户端每次切会话全量拉取 → 「切会话内容刷出来很慢」主因

**判定：部分已验证（全量拉取、无缓存）；「响应体随消息量无限增长」= 已否定；「主因」= 修正为服务端同步 refresh 延迟**

已验证（file:line）：
- 客户端切会话**先清零再全量拉取**：`client.js:193-231` useEffect 依赖 url 变化；`:198` `setData(EMPTY_STATE)`，`:200` 立即 fetch 全量 `/state?sessionId=…`。无缓存、无 diff、无去抖。
- 服务端**在请求路径内同步执行刷新**：`index.js:690-695`（/state handler）→ `targetState(sessionId)`（`:416-429`）→ `:420` `await refresh(...)` → 逐成员 `readSurface`（`:312`）。响应要等完整 refresh 全部完成后才返回——这是切会话延迟的直接来源。
- 请求内还会再次 `imOriginOf`（`:694` → `:444` 另一次 readSurface，首次无缓存时）。

已否定的部分：
- 「响应体随消息量增长」**有硬上限**：`WINDOW_MESSAGES=200`（`:62`），`snapshotOf` 中 `groupThreads(state.messages.slice(-WINDOW_MESSAGES))`（`:485`）。实测 200 条后 body 封顶 ~50–82KB。body 本身主机侧 stringify/parse <2ms，网络本地传输 82KB 也非瓶颈。
- 结论：**切会话慢的主因不是响应体大小，而是请求内同步 refresh 链（listChildren + 每成员 readSurface）的服务端耗时**；body 大小是小项。H2 的机制（全量拉取、无缓存）成立，但“主因”应归到 R1 的读服务频率/请求内阻塞。

### H3：全局 systemPrompt section 把 routingText 注入**每一个**会话，每次模型请求提示词膨胀

**判定：已验证（机制 + 精确数字）**

已验证（file:line）：
- 全局 section **无条件安装**：`installGlobalSection()`（`:567-577`）在 `ensureRouting()`（`:580` 无条件调用，仅检查 systemPrompt 服务存在，不检查 `config.enabled`）中注册，作用域为插件自身 scope；文本来自 `:574` `routingText(readSettings(), activeTeamOf(readSettings()))`。
- 每个 root agent 另有 scoped section 同文本：`installScopedSection`（`:499-535`，`:588`/`:596` 对每个 root agent 安装），routingText 取的是同一份材料。
- 路由文本第 6 条自带“subagent 请忽略本节”，说明该文本**也可能到达子代理**（AgentTeams 重建机制下发时），即注入范围覆盖 root + 部分成员会话。
- 每次系统提示组装都会执行 `text()` → `readSettings()`（settings.get + normalizeTeams）+ `routingText()`（字符串拼接）——每次模型请求都重复计算并携带。

精确数字（实测，见 §1.1）：**默认 2,105 B；当前真实团队 3,577 B；最坏 5,851 B/请求**。即每个受影响会话**每次模型请求**多携带约 2.1–5.9KB（≈0.5–1.5k tokens）。

推测的部分：
- 对「DSH 卡顿」的直接贡献：prompt 膨胀是每请求 token 成本（模型侧读入），不是主机 CPU/IO 卡顿；在子 agent 高频回合时它放大的是每回合延迟与 token 开销，属于次级因素。Metric 影响: 非“卡顿”主因，但影响所有会话的成本。

### H4：客户端轮询回包后整树重渲染、切会话无缓存/去抖 → 卡顿与刷新慢

**判定：已验证**

已验证（file:line）：
- 每次轮询成功即全量 setData：`client.js:181-183`（fetchNow）、`:202-203`（切会话首拉）、`:217-219`（周期轮询）——三个路径都 `setData(next)` 整包替换。
- 整树重建：`ChatBody` 内 `threads.map`（`:650`）逐条重建 `ThreadView`/`MessageCard`；全文**无 React.memo / 无虚拟滚动**（grep 全文件 0 处 memo）。
- **滚动条每轮询跳底**：`:451-454` `useEffect(..., [data.threads])` 每次新数组（每轮询都是新对象）触发 `scrollTop = scrollHeight`——即使用户已上滑阅读，3s 后也会被拉回底部。
- 切会话无缓存：`:198` 清零 EMPTY_STATE → 全量 fetch；无去抖。
- IM 中继 effect（`:512-549`）依赖 `[data]`，每轮询重跑（有 sent 集合幂等，代价小，但仍是每次轮询的遍历）。

评价：200 条消息 × 每 3s 全量重建 DOM + 滚动跳底，是**面板自身卡顿/闪烁**的直接来源；对“整个 DSH 卡顿”贡献为面板所在渲染线程的开销，量级中等（不跨进程）。

### H5：成员汇报唤醒与轮询叠加，额外触发不必要的模型回合

**判定：已否定（就本插件代码而言）**

证据：
- 轮询/刷新路径**不含任何 sendMessage**：`tick`（`:360-368`）→ `discoverCaptains`（只 list/readSurface）→ `refresh`（只 readSurface）。全文件 sendMessage 仅出现在 `deliver()`（`:393`），而 `deliver()` 只被用户主动的 `/speak`（`:734`）与 `/task`（`:757`）调用。
- 成员汇报唤醒（成员 send_message → 队长回合）由 **AgentTeams 插件的唤醒/调度机制**产生，其代码不在 dsh-team-chat 仓库内；dsh-team-chat 的轮询是纯读操作，不触发模型回合。
- 附注（推测）：路由提示词中的 IM 播报条款（shared.js:274，rule 7）可能诱导队长在 IM 会话外也额外汇报，这是提示词层面的鼓励，不是轮询叠加——与新症状的“子 agent 一跑就卡”无直接因果。

---

## 3. 修复方向（按影响排序，绑定根因编号）

### F1（根因 R1/H1）给 /state 请求路径去同步化 + 轮询去重 —— 影响最大，直击「子 agent 一跑就卡」

- **最小可验证改动**：`/state` handler 不再在请求内 `await refresh`（`index.js:420`）；改为“先返回最近一次 tick 的缓存快照，同时后台触发一次 refresh（fire-and-forget update）”。tick 与请求共享同一 `refresh` 结果，避免同一轮询周期内两次 readSurface。
- **预期收益**：readSurface 频率从 ≈2 次/3s/成员 降到 1 次/3s/成员（有前端轮询时）；切会话响应不再等待完整刷新链；成员运行期整体读服务压力减半。
- **引入风险**：快照最多陈旧 3s（本就有 3s 轮询心智）；切会话首屏可能显示上一 tick 内容，需在响应里带 `stale:true` 标记由客户端提示，或首拉仍同步 refresh（仅首拉）。

### F2（根因 R1/H1）tick 加 in-flight 锁，杜绝叠加 —— 低成本高确定

- **最小改动**：`tick` 顶部 `if (ticking) return`，`finally { ticking = false }`（`index.js:360-368`）。
- **预期收益**：任何超过 3s 的慢 tick 不再并行叠加，readSurface/listChildren 调用数在高峰期不再倍增——即「卡顿放大」的乘法项被移除。
- **风险**：低（最多少跑一次轮询，下个周期补上）。

### F3（根因 R1/H1）按活动状态降频 readSurface —— 空闲时段几乎零成本

- **最小改动**：`refresh` 中仅当 `member.activity === 'running'` 或自上次以来 activity 变化（`:300-306` 已有 actSeen）时才调用 `readSurface`（`:312`）；空闲成员只消费 listChildren 的 activity。
- **预期收益**：团队空闲时读服务调用趋近于 0（仅 listChildren 轻量）；成员运行期保持 3s 全量。语义上“有人干活才盯日志”。
- **风险**：activity 未变化但成员静默产出了消息（尚未改 activity）时可能漏一条——需同时监听 activity 变化事件作为兜底触发；收益以“运行期”为主，仍显著。

### F4（根因 R2/H4）客户端增量渲染 + 滚动去抖 —— 直接消除面板自身卡顿/跳屏

- **最小改动**：① 轮询回包先做浅比较（threads 长度/末条 id/members activity 指纹）无变化则不 `setData`；② 滚动 effect（`client.js:451-454`）只在“消息追加且用户位于底部附近”时跳底，用户上滑阅读时不拉回；③ 对 `MessageCard`/`ThreadView` 包 `React.memo`。
- **预期收益**：无人发言时轮询零重渲染（只做比较），面板内存与合成压力趋近 0；有人发言时也只重建增量卡片；阅读位置不被 3s 轮询打断。
- **风险**：低；比较指纹需与服务端保持一致（可用 state.seq，`index.js:141` 已有）。

### F5（根因 R3/H2）切会话保留旧数据直到新数据到达 —— 消除空白闪烁

- **最小改动**：去掉 `client.js:198` 的 `setData(EMPTY_STATE)`，改为保留旧 `data` 并显示 `loading` 遮罩；服务端配合 F1 的缓存快照后首拉即快。
- **预期收益**：切会话不再闪空白、不再清空后重建；结合 F1 延迟显著下降。
- **风险**：切换瞬间显示的是上一会话内容，需在 UI 明确“切换中”标识防误读。

### F6（根因 R4/H3）routingText 惰性/裁剪 —— 降低全量会话的每次请求开销

- **最小改动**：① `text()` 内先判 `config.enabled === false` 返回 `''`（`shared.js:250` 已有此分支，但全局 section 的 `:574` 未短路，建议在 section 层短路）；② 将路由文本按“名册 + 规则”拆分，名册部分在 settings 无变化时缓存渲染结果（避免每次请求重算 normalizeTeams + 拼接）；③ 长 executionPrompt 已受 1200 截断（`shared.js:37`、`memberPrompt`），确认即可。
- **预期收益**：每次模型请求少带 2.1–5.9KB（约 0.5–1.5k tokens），对会话数量多的部署是全量 token/延迟节省；对“卡顿”本身贡献有限（次级）。
- **风险**：medium——路由行为完全依赖这段文本，改动须保证规则语义逐字等价（尤其 rule 1-6 与 IM 条款）；建议先在非运行会话对比 systemPrompt 前后差异再做移除。

---

## 4. 判定汇总表

| 假设 | 判定 | 一句话依据 |
|---|---|---|
| H1 readSurface 高频轮询是卡顿主因 | **已验证机制 / 主因=推测** | 2×/3s/成员 + 无重叠锁 + 请求内同步（index.js:58,312,370,420）；服务端成本无法插桩 |
| H2 响应体随消息量增长导致切会话慢 | **部分否定 / 主因修正** | 全量拉取、无缓存已验证；body 有 200 条上限（≤82KB），慢在请求内同步 refresh 而非 body |
| H3 routingText 注入每个会话 | **已验证** | 全局+scoped 双 section 无条件；实测 2105–5851 B/请求 |
| H4 客户端整树重渲染无缓存 | **已验证** | 三路径全量 setData + 无 memo + 滚动每次跳底（client.js:182,218,453） |
| H5 轮询与唤醒叠加触发额外模型回合 | **已否定** | 轮询路径零 sendMessage；唤醒属 AgentTeams 机制（index.js:393 仅 /speak /task 触发） |

## 5. 留给下阶段的验证缺口（诚实声明）

1. readSurface / listChildren **服务端侧耗时与 IO 量**：需要 DSH 侧打点（或带鉴权 session 实测 /state 延迟），本报告只能证调用频率与主机侧处理，不能证服务端成本量级。
2. /state 请求内 refresh 的实际阻塞时长：可用带 Connection 鉴权的浏览器会话实测切换延迟分布（≥3 次采样取中位数）。
3. H3 的每请求 token 成本：需在真实会话的 systemPrompt 组装端采样（未改动 profile，未采样）。