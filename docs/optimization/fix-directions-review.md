# dsh-team-chat 修复方向对抗性评审（fix-directions-review）

> 生成：reviewer · 2026-09-10 · t10 任务（独立对抗性评审 t4 的 F1–F6）
> 方法：立场=证伪。所有判断基于**自行阅读源码**（index.js / client.js / shared.js 全文），每条附 file:line；不采信 t4 自述；t4 实测数字不在本任务复核范围（属 t6）。
> 范围：只评修复方向本身；未修改 `lib/`；未动 profile；未写新脚本。
> 标注：「已验证」=我在当前源码中直接核实的机制；「推测」=基于代码路径推演、未经运行验证。

---

## 0. 结论速览

| 方向 | t4 自述 | 我的判定 | 一句话 |
|---|---|---|---|
| F1 /state 缓存快照+后台刷新 | 收益大 | **需修正** | 只改 /state 不动 /speak、/task 的同步 targetState，发送路径卡顿没解决；收益估计不完整 |
| F2 tick in-flight 锁 | 低风险高收益 | **需修正** | readSurface 无超时（index.js:312），一次挂起→全部 tick 被锁跳过→聊天永久冻结，「风险低」估计错误 |
| F3 按 activity 降频 | 可能漏消息 | **需修正** | 与 pendingThread 一次性绑定冲突：成员 <3s 完成时绑定永不消费（TTL 10min），引用回复静默丢失 |
| F4 指纹+滚动去抖 | 已定方案 | **需修正** | 建议用 state.seq 但 snapshotOf 响应**不含 seq**（index.js:460-489），不可直接落地；需服务端补暴露或改自算指纹 |
| F5 切会话保留旧数据 | 低风险 | **需修正** | 旧数据引用会静默丢失（index.js:717 findMessage 查不到 → replyTo 置 null），需防误读 UI |
| F6 routingText 惰性/裁剪 | 中等收益 | **需修正** | 「逐字等价」下可裁剪空间极小；名册缓存缺失效机制；rule 6 与 rule 7 的语义最脆 |

**一句话**：6 个方向方向都对、没到「应否决」的程度，但**每一个的代价与触发条件都被 t4 低估**；且 F1 与 F2 **必须一起做**（F1 的后台刷新若重复 tick 的 refresh 调用，不做 F2 会叠加更狠）。单独实施任何一个都会引入新的可触发缺陷。

---

## 1. F1「/state 返回缓存快照 + 后台刷新」— 判定：需修正

### 1.1 机制核查（已验证）
- `/state` handler（`index.js:682-696`）→ `targetState(sessionId)`（`:416-429`）→ 有 sessionId 时 `resolveTeam` + `await refresh(...)`（`:420`）；无 sessionId 时 `discoverCaptains` + `await refresh`（`:427`）。请求内同步刷新，**成立**。
- `refresh` 内逐成员 `await ctx.sessionQuery.readSurface(member.id)`（`:309-312`）——请求内阻塞链，**成立**。
- `imOriginOf` 在 /state 路径内另有一次 readSurface（`:694` → `:444`，首次无缓存时）。**注意：F1 方案文本未提这一处**——即使 /state 改缓存快照，若 `imOriginOf` 仍保留在请求路径，首次 /state 仍会等一次 readSurface（`imOrigins` 缓存后除外）。需把 `imOriginOf` 也移出请求路径或预取。

### 1.2 能消除根因吗？（验证）
**部分不能，且 t4 漏了发送路径**：
- `/speak`（`index.js:711`）与 `/task`（`:750`）**同样调用 `targetState` 并在请求内同步 `refresh`**。用户的「发消息/派任务」是卡顿体感最强的交互（要等完整 refresh 链才返回 deliver 结果），F1 只改 `/state` 完全不影响这两条路径 → 发送仍卡。t4 声称 F1「直击子 agent 一跑就卡」，但用户感知的一半（发送）未被覆盖。**修正：F1 必须把 `targetState` 的同步 refresh 从所有三个 handler（/state、/speak、/task）统一改为「返回缓存快照 + 后台刷新」，或至少明确拒绝范围**。

### 1.3 引入的新问题（触发条件）
1. **写后读延迟 ≤3s**（已验证机制）：`/speak` push 自己的消息（`index.js:722`）后，若 /state 返回的是上一 tick 快照，用户要等下一个 tick（≤3s）才在面板看到自己的发言。与现状（/speak 路径同步 refresh → 下次 /state 即有）不同，属可接受体验退化，但**必须写明**。
2. **IM 进度中继延迟**（推测，基于 client.js:512-549）：中继依赖 `data.threads` 里新 system/task 消息；快照陈旧 ≤3s → IM 播报最多晚 3s，可接受；但若 F1 实现为「后台刷新失败时静默保留旧快照」（readSurface catch 后 `continue`，`index.js:313-314`），进度中继可能**断流无感知**——需在快照上带 `stale` 标记并让客户端提示（t4 已提 `stale:true`，**本评审确认必要**）。
3. **pendingThread 消费推迟但不丢**（已验证）：pendingThread 在 refresh 的 readSurface 循环内消费（`index.js:342-344`），绑定有 10min TTL（`:63`）；后台刷新 ≤3s 一次，不会过 TTL，安全。
4. **并发放大风险（与 F2 联动）**：若 F1 的后台 refresh 与 3s tick 各自独立调用 `refresh`，readSurface 频率**不降反增**（tick 1 次 + 每个 /state 后台 1 次）。**F1 必须复用 tick 的最新快照（共享同一 refresh 结果），否则 F1 单独做等于给故障加倍**——t4 原文「tick 与请求共享同一 refresh 结果」方向对，但实现时极易做成「各自 refresh」，需在验收标准里明确「tick 与后台刷新共用一次 refresh 结果，同周期内 readSurface 调用数 ≤ 现状」。
5. **imOrigins 仍同步**（已验证机制）：`/state` 首次返回前若 `imOrigins` 未缓存，`imOriginOf`（`:694`）仍同步 readSurface——F1 声称「响应不再等完整刷新链」在首次请求上不成立。需把 IM origin 的 resolve 移出请求路径（如 tick 内预取）。

---

## 2. F2「tick 加 in-flight 锁」— 判定：需修正

### 2.1 机制核查（已验证）
- `tick()`（`index.js:360-368`）无任何 busy/in-flight 标志；`setInterval(() => { void tick() }, POLL_MS)`（`:370`）fire-and-forget；`refresh` 内 readSurface 无超时/信号（`:311-312`，`await ctx.sessionQuery.readSurface(member.id)` 无 AbortSignal、无 timeout wrap）。「无重叠防护」**成立**。

### 2.2 能消除根因吗？（部分成立）
- 锁能消除「慢 tick 并行叠加」——正确。但 t4 的**风险估计「低（最多少跑一次轮询）」被证伪**：

### 2.3 引入的新问题（触发条件）
1. **一次挂起 = 全部冻结**（推测，高置信）：`readSurface` 无超时。若任一成员的 readSurface 挂起（外部服务不返回），tick 卡在该 await；加锁后后续所有 setInterval 回调都因 `ticking` 跳过 → `seqSeen`/`actSeen` 全部停滞 → **聊天状态永久冻结，直到该 readSurface 返回（可能永不）**。无锁时反而是「并行重试」能自愈。**修正：锁必须与超时配套**——`refresh` 整体或每次 `readSurface` 加 `Promise.race` 超时（如 5s），超时按「该成员本轮跳过」处理并记 lastError。
2. **刷新间隔被拉长至 ≥tick 时长+3s**（推测）：慢 tick（如 6s）完成后，下一个 setInterval 才触发 → 有效轮询周期从 3s 变 9s；若持续慢则持续拉长。需明确「锁 + 完成后再起一轮」还是「锁 + 固定周期补偿」，否则对高频 readSurface 的敏感场景（正是本插件）会引入「刷新变稀」的次生退化。
3. **锁的作用域需覆盖 `discoverCaptains` 的 `listChildren`**（已验证）：`tick` 内先 `discoverCaptains`（`index.js:362` → `:250` `listChildren`），锁若只包 refresh 不包 discover，叠加风险只移一半。

---

## 3. F3「按 activity 降频 readSurface」— 判定：需修正

### 3.1 机制核查（已验证）
- `refresh` 每成员无条件 readSurface（`index.js:309-312`）；`actSeen` 已有（`:300-306`）；activity 来自 `listChildren` 的 `child.activity`（`:230`）。
- **F3 与 pendingThread 的致命交互（t4 未提及）**：`pendingThread` 一次性绑定（`:731`，`/speak` 引用回复时设置）**只能在 refresh 的 readSurface 循环里消费**（`:342-344`）。若 F3 按 activity 降频：成员在**一个 tick 间隔（3s）内**从收到 /speak → 干活 → 变回 idle，且 `listChildren` 下次快照看到的是 idle → readSurface 被跳过 → **pendingThread 绑定永不消费，10 分钟后 TTL 过期**（`THREAD_TTL_MS = 600000`，`:63`）→ 用户对回复的引用（rootId/replyTo）静默丢失。触发条件：成员快速完成且被 discoverCaptains 判别为 idle 的窗口 ≥1 个 tick。概率虽小，但**这是引用功能的确定性丢失**，不是「可能漏一条」。
- 修正要求：**任何存在未消费 pendingThread 的成员，本轮必须强制 readSurface**（判 `pendingThread.has(member.id)`），或降频仅限「无 pendingThread 且 activity 未变化」的成员。

### 3.2 漏消息的概率与后果（评估）
- **概率**：成员 idle 期间新消息 ≈0（idle 不产出）；主动误判窗口 = 成员在单 tick 内完成一轮输出且快照恰为 idle。考虑到成员任务通常数秒起步，概率低（推测 5% 以下），但后果是「该成员最后一条收尾消息永久缺失」。
- **兜底触发（t4 的「activity 变化事件」）**：需确认 `listChildren`/AgentTeams 是否暴露 activity 事件——**本仓库代码可验证的是轮询快照**（`rosterFrom`），事件兜底在代码里**不存在**（`:222-235` 只有轮询读取）。F3 若依赖「activity 变化事件」作为兜底，该依赖**未经证实存在**，属推测性兜底——**建议改为「最后一次 readSurface 后成员 idle 超过 N 个 tick 再跳过」的保守策略**，或至少「activity 变化 tick 必读一次」。

### 3.3 补充
- F3 声称「空闲时段趋近 0 成本」：空闲成员 `readSurface` 虽跳过，但 `discoverCaptains` 的 `listChildren` 仍在每 tick 全量跑（`index.js:362`、`:250`）——**空闲降的是 readSurface，不降 listChildren**。若 listChildren 同样昂贵（agent 数线性），空闲收益被高估。需在 F3 里同时声明 listChildren 的降频策略（如每 5 tick 一次）或明确其成本可忽略的依据。

---

## 4. F4「客户端指纹比较 + 滚动去抖」— 判定：需修正

### 4.1 机制核查（已验证）
- 三路径全量 setData：`fetchNow`（client.js:182）、切会话首拉（`:203`）、轮询（`:218`）——成立。
- 滚动 effect `[data.threads]` → `scrollTop = scrollHeight`（client.js:451-454）——成立。
- **全文 0 处 React.memo**（grep 独立复核）——成立。

### 4.2 「用 state.seq 做指纹」不可直接落地（t4 关键缺陷）
- t4 F4 建议「比较指纹可用 state.seq（index.js:141 已有）」。**但 snapshotOf（index.js:460-489）的响应体不含 seq 字段**（只有 sessionId/team/activeTeam/teams/defaultTeamId/members/threads/hasTeam/error/im/imPush）。客户端拿不到 seq。
- 修正选项：① 服务端 snapshotOf 增加暴露 `seq`（一行改动，但**改变了 /state 合约**，需同步测试）；② 客户端自算指纹（threads 长度 + 末条 id + members activity，均可从现有 data 取）——**推荐 ②**，不经服务端改合约。

### 4.3 引入的新问题（触发条件）
1. **activity 变化但 messages 不变是否能刷**（t4 自查点）：`refresh` 在 activity 变化时 push system 消息（index.js:301-305），所以 activity 变化**必然产生新消息** → 末条 id 指纹能捕获。**结论：用「末条消息 id + threads 结构」指纹即可覆盖 activity 切换；若指纹只含 messages 数量而忽略 members.activity，则换团队/成员配置变化（`/team` handler push system，index.js:840）仍会触发消息变化，不会漏**。关键是要把 **members.activity 也纳入指纹**（activity 变化 → 有 system 消息时已被消息指纹覆盖；但要覆盖「activity 变化恰好无消息」的边界——虽然机制上会 push，仍建议 members 指纹兜底，防服务端改动后失配）。
2. **滚动去抖阈值未定义**（t4 自查点，确认未定义）：「位于底部附近」无阈值。需定义为「`scrollTop + clientHeight >= scrollHeight - 48px` 视为在底部」并写在验收里，否则实现者会拍脑袋。
3. **IM 中继对 setData 节流的依赖**：IM 中继 effect 依赖 `[data]`（client.js:512-549），每个新对象重跑。F4 节流后无变化不出新对象 → 中继只在有新内容时跑——**行为正确**；但要防止「指纹判定无变化但实有新 system 消息」的漏刷场景（见 4.2 ②：指纹必须覆盖 system 消息，否则 IM 播报漏发）。

---

## 5. F5「切会话保留旧数据直到新数据到达」— 判定：需修正

### 5.1 机制核查（已验证）
- 切会话清零：client.js:198 `setData(EMPTY_STATE)` + 立即 fetch（`:200`）；effect 依赖 `[url, pollSeconds, active]`（`:231`）。

### 5.2 引入的新问题（触发条件）
1. **旧数据引用 → 引用静默丢失**（推测，代码路径明确）：保留旧数据期间（fetch 未返回），用户若点击旧 threads 里的「引用/回复」，`/speak` 的 `findMessage(state, payload.replyTo)`（index.js:717）在**当前会话** state 里查不到旧消息 → `quoted === undefined` → `replyTo = null` → 用户以为在引用，实际变成普通发言。触发条件：切会话后 fetch 慢（正是本插件病根）且用户手快。**修正：F5 实现时须在旧数据视图上叠加「切换中」遮罩并禁用交互**（t4 已提标识，本评审确认为刚性要求而非提示）。
2. **旧数据与 pendingThread/IM origin 的会话绑定**：pendingThread 按 member.id（index.js:123、:342），与 sessionId 无关——保留旧数据不影响绑定。IM origin 按 sessionId（`:125`、`:441`）缓存，与视图无关。**结论：不冲突**——此两点是安全的（已验证）。
3. **fetch 失败时永远展示旧会话**（推测）：若 F5 去掉清零且 fetch 抛错（client.js:205-209 的 catch 保留旧 data + error 字段），用户看到的是**上一会话内容 + 错误提示**，易误读为当前会话异常。需在 error 态也显示「会话未加载或已切换」。

---

## 6. F6「routingText 惰性/裁剪」— 判定：需修正

### 6.1 机制核查（已验证）
- `routingText`（shared.js:249-291）：规则 1-7；第 7 条 IM 播报条款为条件文本（imProgress=false 时省略，`:272-274`）；文本在 section 的 `text: () => …`（index.js:531-534、:574）每次模型请求求值。
- `memberPrompt` 已有 1200 截断（shared.js:320-337，MEMBER_PROMPT_LIMIT）。

### 6.2 「逐字等价」下可裁剪空间极小（收益再评估）
- 若规则语义必须逐字等价（t4 F6 自己承认），则**文本本身不可压缩**，F6 只剩两件事：① `enabled=false` 时短路（shared.js:250 已有 `if (config.enabled === false) return ''`——**全局 section 路径 index.js:574 未前置短路**，此处成立）；② 名册/文本缓存。**t4 声称「每次请求少带 2.1–5.9KB」的收益，缓存后只在 settings 不变时成立——而缓存恰恰缺失效机制**：
- **缓存失效时机未定义**（t4 未提）：`/settings` 更新（index.js:799 `ctx.settings.update`）、`/team` 切换（`:838` sessionOverrides）、成员模板变更——都会改变 routingText 输出。若按 settings 内容哈希做缓存键，`normalizeTeams` 每次返回新数组、`readSettings()` 无版本号（index.js:196-218），**缓存键无处可挂**。修正：需在 `readSettings` 或 settings 服务上加版本/变更事件订阅（`ctx.settings` 事件未在插件内使用），否则 F6 缓存本身会引入「改了配置但路由文本不更新」的**语义漂移**。

### 6.3 哪些条款一旦被裁剪直接破坏路由（逐条）
| 规则 | 内容 | 裁剪后果（已核实代码/提示词依赖） |
|---|---|---|
| rule 1 | 建队 + approval 参数（`index.js` 经 `shared.js:254-257`） | 裁剪 approval 细节 → autoApproveTeam=false 的强制审批被绕过（approval="required" 语义丢失） |
| rule 2-4 | status 核对/DAG/调度口径 | 裁剪后队长行为依赖模型默认，路由口径漂移（推测，行为性） |
| **rule 5** | 「群聊侧栏的发言与任务广播会直接送达成员」 | 裁剪后队长可能改用非群聊路径汇报/派发，成员收不到（推测；此条款是「消息协作」的唯一显式指引） |
| **rule 6** | 「子代理请完全忽略本节」 | **最高危**：这是防止**成员会话**把 routingText 当指令执行的隔离条款（shared.js:288）。裁剪后成员（subagent）收到完整团队模式指令 → 可能自建队/自拆任务，产生级联破坏。**严禁裁剪** |
| **rule 7** | IM 播报（shared.js:270-274） | 裁剪或压缩「唤醒时播报」时机措辞 → 队长在成员汇报时不播报，IM 用户失去进度（imProgress 功能失效）。且 condition 分支（imProgress=false）若被写死省略，会破坏「开启 imProgress 后恢复播报」的语义 |

- **结论**：可安全裁剪的只有**名册部分的行内空白/换行格式**；规则 1/5/6/7 语义不可动。F6 的「收益」应重估为「名册缓存 + enabled 短路 + 格式压缩」，2.1-5.9KB/请求的声称只有在**全量规则压缩**（即语义漂移）下才成立——这是 t4 F6 一个**错误的收益估计**（语义等价与收益两者不可兼得）。

---

## 7. t4 未提及的新风险清单（≥1 处要求，实际发现 6 处）

| # | 风险 | 证据 | 等级 |
|---|---|---|---|
| N1 | **F1 忽略 /speak、/task 的同步 targetState**：发送路径仍卡，收益估计不完整 | index.js:711、:750 均走 targetState 同步 refresh | high |
| N2 | **F2 锁 + readSurface 无超时 = 一次挂起冻结全部**；t4「风险低」错误 | index.js:311-312 无 AbortSignal/timeout；:370 fire-and-forget | high |
| N3 | **F3 + pendingThread：快速成员引用绑定永不消费（TTL 丢失）**；t4 只字未提 | index.js:342-344 消费点 + :731 绑定 + :63 TTL | high |
| N4 | **F4 建议的 state.seq 根本不在 /state 响应里**；「可用 seq」不可直接落地 | snapshotOf index.js:460-489 无 seq | medium |
| N5 | **F5 旧数据期间引用静默丢失**（replyTo 置 null 无提示） | index.js:717 findMessage → undefined → null | medium |
| N6 | **F6 收益与语义等价自相矛盾**：缓存无失效机制（settings 无版本号）+ 名册缓存键无处可挂 | index.js:196-218 无版本；:799 更新无事件订阅 | medium |
| N7 | **imOrigins 首次请求仍同步 readSurface**，F1「不再等完整链」首次不成立 | index.js:694 → :444 | low |
| N8 | **listChildren 每 tick 全量跑**，F3 空闲收益只降一半 | index.js:362 → :250 | low |

---

## 8. 建议实施顺序（供实施任务参考，非本任务强制）

1. **F2 改造版（锁 + readSurface 超时 5s + 锁覆盖 discoverCaptains）**——先止血叠加；无 F3 联动，独立安全。
2. **F1 改造版（三个 handler 统一走缓存快照；tick 与后台共享同一 refresh 结果；imOriginOf 预取；响应带 stale 标记）**——必须与 F2 同批，否则后台刷新叠加更狠。
3. **F4 改造版（客户端自算指纹【末条 id + members.activity】+ 滚动去抖阈值 48px + 可选 memo）**——client 侧独立，配合 F1 后轮询成本趋零。
4. **F3 改造版（pendingThread 存在则强制读 + activity 变化必读 + idle 跳过前 N 个 tick 保守窗口）**——必须在 F4 之前或同批，配合验证「引用不丢」。
5. **F5 改造版（旧数据视图叠加切换中遮罩并禁用交互 + error 态区分）**——小改，可后置。
6. **F6 改造版（仅 enabled 短路 + 名册格式压缩；规则文本零改动；缓存需先解决 settings 版本号）**——收益最小、风险最细，最后做。

**配套验收建议**：每一项的新缺陷（N1–N8）写入实施任务的验收标准（如「readSurface 挂起 10s 时聊天在 5s 内恢复并记录 lastError」「引用回复在切会话 2s 内点击仍送达 rootId」），确保「修复不引入新回归」有明确定义。

---

## 9. 实测 vs 推测声明

- **已验证（直接读码确认）**：三 handler 同步 refresh 路径（index.js:416-429、690-696、711、750）；tick 无锁 + readSurface 无超时（:360-370、:311-312）；pendingThread 消费点与 TTL（:342-344、:63、:731）；snapshotOf 无 seq（:460-489）；client 三路径 setData（client.js:182/203/218）、滚动 effect（:451-454）、全文无 memo；imOrigins 同步首查（index.js:694→:444）；listChildren 每 tick 全量（:362→:250）；routingText 规则结构与条件分支（shared.js:249-291）。
- **推测（代码路径推演，未运行）**：N2 冻结行为、N3 快速成员绑定丢失概率、N5 引用丢失触发、F1 写后读 3s 延迟体验、F6 语义漂移后果——均给出触发条件与依据，但量化为「概率」处为推测（无运行验证，本任务约束只读）。