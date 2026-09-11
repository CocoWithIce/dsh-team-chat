# P2 实现基线（`p2-impl-baseline.md`）

> **任务**：t92 · P2 Slice 1a（自建成员通道 + B′ 认领通道 + 调度核心地基）。
> **定位**：本文件承载 **实现的施工前提与裁定**，**不修订**冻结的设计稿。设计契约 = `detach-p2-scheduler-design.md` **v0.7**（SHA256-12 `ED95B4DC3C3F` / 78780 B / text lines 551），本轮**零改动**。
> **取证来源**：t91 output（E4/E14 源码级取证）；均为**已验证**（附 file:line）与明确标注的**推测/未测**。
> 维护：engineer3 · 2026-09-12 · t92。

---

## 0. 本文件解决的问题

设计稿 v0.7 §4.1/§9.1 假设「成员经 fenced HTTP 路由自调认领」。**该假设经 t91 取证被推翻**（结构性 401）。本文件记录推翻证据、用户裁定（B′）、以及 E4 的落地映射，使 Slice 1a 的施工前提可被复核。

---

## 1. E14 推翻设计稿 §9.1「成员自调 fenced」假设【已验证】

**结论**：成员（subagent 会话）**不能** POST `/team-tasks/*` —— `fenced` 对成员请求恒返回 **401**（结构性，非配置问题）。

**证据链（源码，t91 实测取证，本轮独立复核）**：

| 层 | 位置 | 事实 |
|---|---|---|
| 本插件 fence | `lib/index.js:1523-1531` | `fenced(req,res)` → `ctx.get('connection').requestRejection(req)`；五条 `/team-tasks/*` 路由全部先过它（`:1804/:1835/:1862/:1892/:1919`） |
| 平台判定（1） | `@deepseek-ai/dsh-client-connection/lib/index.js:530-533` | `requestRejection` = `isTrustedApiRequest`（否 → **403**）→ `browserAuth.isAuthenticated`（否 → **401**） |
| 平台判定（2） | 同文件 `:178-192` | Host 须 loopback/trusted + `sec-fetch-site≠cross-site` + `origin` 同源或无 origin —— 成员本机 fetch **大概率通过** |
| 平台判定（3） | 同文件 `:408-418` | 需 Cookie `dsh-auth-<sha256(authority)>`（`:257-258`），**32B secret 签名**（`:239-244`）、authority 绑定、未过期；cookie 仅能经根 URL `?token=` 交换产生（`:363-401`），**launch token 由宿主进程持有** |

**判定**：成员会话无法获得 secret 签名的 cookie（伪造不可行；注入浏览器会话凭证 = 泄密，不合规）⇒ **成员直调 = 401（unauthorized），结构性不可行**。

**推论（设计稿需据此调整，但本轮不改设计稿）**：宿主**无法**从 fenced 请求识别成员身份（无 cookie、无成员 token），故「fenced 沿用 + 成员自调」不能成立；成员侧认领必须有**独立的通道形态**。

---

## 2. 用户裁定：认领通道 = **B′ 宿主工具通道**【已裁定】

**裁定内容**：成员**白名单注入** `claim`/`report` 工具；**宿主侧对接 P1 状态层**（`lib/state/task-store.js` 直调）；**零新 HTTP 鉴权面**；**保留认领语义**（成员自愿 claim，非宿主代派）。

**为什么 B′ 成立**：
1. 零新鉴权面 —— 不经 HTTP，`fenced`/`connection` 完全旁路，E14 的 401 结构性障碍自然消失；
2. 保留认领语义 —— 成员在**自己回合内**调 `team_claim_task`；`claim` 仍是 CAS(pending→claimed) 原语（P1 §6 S13），双 owner 结构性不可能；
3. 与 E4 一致 —— 成员创建既然走 `startContinuable` 直调（宿主进程内），工具白名单同属该进程内能力面（`toolFilter.allow`，`@deepseek-ai/dsh-subagent/lib/typert.host.js:780`）。

**B′ 的边界（如实声明）**：
- 宿主必须在**成员身份可解析**的前提下执行工具（本 Slice 以 `{ memberId, memberName }` 显式传递；真实接线时成员身份 = 其 subagent `childId`，由 platform 在执行器注入 —— **接线细节属 Slice 1b，未实测**）；
- 归属校验由宿主侧 `attemptCache` 承担（claim 时记录 `taskId → { attemptId, memberId }`；report 前校验）——**成员不持有 attemptId**（最小工具面），故 report 的 `attemptId`/`revision` 由宿主从缓存与 store 现取。

---

## 3. E4 结论：`startContinuable` 直调可行 + 字段映射【已验证】

**契约（`@deepseek-ai/dsh-subagent`）**：
- 签名：`async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>`（`lib/typert.host.js:172-173`；实现 `lib/index.js:1005`）
- `ContinuableStartSpec { provider, label, childId?, request, signal }`（`typert.host.js:375-376`）
- `SubagentStartRequest { label?, prompt: ContentBlock[], parent: Agent, signal, agentOptions?, outputSchema?, maxDepth?, toolFilter?, persona? }`（`typert.host.js:696`）

**P2 需要 ↔ 契约映射（本轮实现逐条落地）**：

| P2 需要 | 契约字段 | 实现位置 |
|---|---|---|
| `dsh-team-chat:` label 前缀 | `spec.label`（顶层必填） | `lib/p2/spawn.js:buildMemberLabel` |
| 成员名（契约无 `name`） | 承载于 `label` 的 `:<memberName>` 段 | 同上（`dsh-team-chat:<teamId>:<memberName>`） |
| executionPrompt 注入 | `request.persona` | `lib/p2/persona.js:renderMemberPersona`（经 `memberPrompt` 渲染后合入） |
| 成员初始消息 | `request.prompt: ContentBlock[]` | `lib/p2/persona.js:memberWelcomeBlocks` |
| 配额感知路由 | `request.agentOptions { provider, model, reasoningEffort? }` | `lib/p2/spawn.js:spawnMember` |
| B′ 工具白名单 | `request.toolFilter { allow }`（`ToolRestriction` 支持 allow/deny，`typert.host.js:780`） | `lib/p2/spawn.js:spawnMember`（`allow: ['team_claim_task','team_report_task']`） |
| captain 作为父 | `request.parent: Agent`（活体） | 宿主经 `ctx.agents.get(captainId)`（`tools.js:1664` 同款；`dsh-agent/lib/index.js:689-690`） |
| provider 能力门 | `provider.prepareContinuable` + `capabilities.persona/toolFilter` | `lib/p2/spawn.js`（缺失即显式失败，不静默） |

**生产同链参照**：`@nanmicoder/dsh-agent-teams/lib/members.js:485-522`（AgentTeams 的真实调用），本轮实现与之同构、差异在 label 前缀与工具面（B′）。

---

## 4. 施工前提清单（已验证 / 推测 / 未测）

**已验证（4）**
1. `startContinuable` 直调可行，spec 字段映射完整（§3 表）；
2. `parent` = captain 活体 Agent，经 `ctx.agents.get(captainId)` 取得（`dsh-agent/lib/index.js:689-690`）；`dsh-team-chat` 已注入 `agents` + `subagents`（`lib/index.js:190`）；
3. 成员直调 fenced 路由 = **401**（§1）；
4. provider 能力门（`persona`/`toolFilter`）必须先查（`members.js:497-502` 同款）。

**推测（2）**
5. `dsh-team-chat` 若需 `ctx.llm.resolveCallConfig` 校验路由，须补注入 `llm` 服务（当前 `inject = ['agents','subagents','sessionQuery','settings']`，`lib/index.js:190` 无 `llm`）；**或**改由宿主配置直接承载 route（→ 实现 Slice 1b 定夺）；
6. B′ 工具的**平台注册形态**（`dsh-tools` 的 `defineTool`/`register` 面向全体会话，成员隔离依赖 `toolFilter.allow`）——本 Slice 以 DTO+执行器交付，注册接线属 1b。

**未测（3）**
7. 真实 `startContinuable` 端到端 spawn 一个 `dsh-team-chat:` 成员（**会改变生产队伍状态，本轮按隔离纪律不做**）；
8. 真实成员进程 fetch 401 的端到端复现（需真实成员会话）；
9. captain 离线时 `ctx.agents.get(captainId)` → `undefined` 的降级路径（需宿主预案：缓存/重试；本 Slice 以显式 `parent-agent-unresolved` 失败代替静默）。

---

## 5. Slice 1a 交付范围（本轮实现）

| 模块 | 文件 | 内容 |
|---|---|---|
| persona 渲染 | `lib/p2/persona.js` | 自建成员 persona（身份声明自建调度 + B′ 工具指引）+ welcome + ContentBlock 构造 |
| 自建成员通道 | `lib/p2/spawn.js` | `buildMemberLabel` / `buildContinuableStartSpec` / `spawnMember`（能力门 + 契约映射 + 依赖注入） |
| B′ 认领通道 | `lib/p2/claim-channel.js` | `MEMBER_TOOLS`（claim/report DTO）+ `executeMemberTool`（**直调 P1 store**，归属校验 + CAS 诚实失败） |
| 调度核心地基 | `lib/p2/scheduler-core.js` | `MemberRegistry`（四态：online/breaker-open/quota-exhausted/offline；连续失败阈值熔断 F7.3）+ `pickMemberToWake`（E9 单实例唤醒：无在途→失败少→久未响应→名字序）+ `resolveStale`（**无自动重排**，重排风暴反制） |
| 宿主模块面 | `lib/index.js`（重导出区） | named re-export 上述模块；`apply` **零行为变化**（不自动 spawn / 不注册工具 / 不启唤醒循环） |

**隔离验证纪律（并行双调度防护，§9.1.1 硬约束）**：Slice 1a **不接入**用户现有团队 —— `apply` 不产生任何自动动作；AgentTeams 仍在运行，本轮所有验证均在**隔离测试上下文**（内存 store + 受控桩）中完成。

---

## 6. 待 Slice 1b 的事项（不在本轮）

1. B′ 工具的平台注册与成员身份注入（推测 5/6）；
2. 唤醒循环接线（`pickMemberToWake` → `ctx.subagents.sendMessage`）+ 可用性注册表的真实数据源（`session/event` 观测）；
3. `checkUnattended` 巡检与 stale 处置的宿主调度接入；
4. 端到端真实 spawn（未测 7/8/9 的落定）。

---

## 7. 度量口径

- 指纹方法：`Get-FileHash -Algorithm SHA256` + `node C:\Users\bo.yang02\count-lines.mjs`（章程规则 5 权威行数口径：text lines）。
- 测试口径**分开报**（见 t92 output）：裸检出（peer 依赖不可解析，宿主用例 skip）与 junction 临时树（0 skip）两组，**skip ≠ pass**。
- 判别力：三组「能变红」变异（去熔断 / 去 stale 反制 / 去归属校验），注入副本跑同一测试文件，见 t92 output。

---

## 8. Slice 1b 交付记录（t94 · engineer4 · 2026-09-13）

> 承载：真实端到端（未测 7 落定）+ 调度器批次接线 + 两条 low 修复 + 两个 1a 契约缺口的修复。
> 本节为**纯追加**；§0–§7 保持 t92 交付字节不变（设计稿 v0.7 `ED95B4DC3C3F` 与 client.js `77D49690DCAB` 本轮复测仍零改动）。

### 8.1 真实端到端（已测，取代 §4 未测 7）

**链路**：宿主进程内动态驱动插件 → 真实 `spawnMember`（检出区真实代码，经 node 子进程桥接）算出 spec → 真实 `ctx.subagents.startContinuable(spec)` → 真实成员回合（LLM：zai-coding-cn/glm-5.3-flash）经 B′ 工具认领/回报 → 真实 TaskStore 状态迁移至终态。

**实测终态（store.serialize 摘录，%TEMP%/dsh-t94-e2e/live-state.json）**：
`t1: pending → claimed（attemptId e9e0ef26…，claimedById=189070f2-0f8d-49eb-94cf-089bdbcd845c）→ running（startedAt 落）→ completed（revision 4，attemptCache 清空）`；
label = `dsh-team-chat:p2e2e:probe1`（§9.1.1 前缀隔离）；persona 1571 字符真实注入；toolFilter.allow = [team_claim_task, team_report_task]；
归属守卫实证：非成员会话调用 `team_claim_task` → `identity-required`（agentId 227c5d3b… 被拒）；
隔离实证：AgentTeams 名册 4 成员零变化（probe1 不在其列）；成员枚举仅出现在宿主子代理树（label 前缀 `dsh-team-chat:`）；AgentTeams 发现按 `agent-teams:` 前缀过滤（@nanmicoder/dsh-agent-teams/lib/members.js:278，t91 同源）。

**边界披露（诚实口径）**：动态驱动插件的工具注册/身份映射为**临时胶水层**（验证完即 undefine，未入仓）；B′ 工具的平台注册件与真实 `MEMBER_TOOLS` DTO 经 `tools-check` 判定 description/properties/required 逐字等价（equal=true）；spec 的 `signal` 在插件侧注入鸭子类型不可取消信号（沙箱无 `AbortController` 全局——平台实测事实，见 8.4-F3）。

### 8.2 调度器接线（新模块 `lib/p2/scheduler.js`）

`readyTasksOf`（pending+依赖就绪，定向优先）→ `dispatchBatch`（E9 每拍 maxWakes=1；已在途不重复唤醒；**wake 边界的真实失败结果 = 熔断信号源**，3 连败 → BREAKER_OPEN → 批内即被排除 → 显式 `resetBreaker` 恢复；无可唤醒 → skipped 且 store 零改动）→ `reconcileInFlight`（终态清占位）→ `collectStaleCandidates`/`disposeStale`（无 explicit 一律 `no-auto-requeue`；显式 reassign 用 `to`（task-store.js:530）/supersede 经 `resolveStale` 通道）。

### 8.3 两条 low 修复 + 测试口径

1. 工具名单一常量源：`lib/p2/tool-names.js`（persona/claim-channel/spawn 三处 import；grep 全 lib/ 字面量仅 tool-names.js:12/:14 两处定义）。
2. persona 表述统一：不再让成员「Keep the returned attemptId」，改为宿主代记（与 §2 B′ 边界一致）；测试断言锁定。
3. 测试（三口径分开）：**junction 临时树 204 / pass 204 / fail 0 / skipped 0**；**裸检出 204 / pass 158 / fail 0 / skipped 46**（46 全为环境性 schemastery peer，与 t92 同口径）；**P2 四文件单独 44 / pass 44 / fail 0 / skipped 0**（新增 wiring 10 用例 + spawn 扩 2 断言/2 用例）。
4. 判别变异（最终代码上复跑，%TEMP%/dsh-t94-mutate/）：mutA 吞熔断信号 → 2 红；mutB2 无可唤醒时 auto-claim → 2 红；mutC 白名单字面量分叉 → 1 红。附：mutB（pending 任务 auto-reassign）0 红 —— P1 store 自身以 illegal-transition 拒绝，属防御纵深旁证，判别力以 mutB2 为准。

### 8.4 本轮新发现（真实调用才暴露的 1a 契约缺口，均已修复）

- **F-signal**：平台 `startContinuable` 读 `signal.throwIfAborted`；1a 缺省 `signal: undefined` 直调即 TypeError（1a 单测桩测不出）。修复：`buildContinuableStartSpec` 缺省生成不可取消 AbortController 信号（spawn.js:73-79 注释留痕）+ 测试断言。
- **F-route**：1a 将 `member.provider` 同时填入 spec.provider（spawn 驱动注册表）与 agentOptions.provider（LLM 路由）。AgentTeams 生产链两者不同源（members.js:504 vs :512-518）。修复：`member.route` 显式优先，缺省回退旧形态（兼容 1a 测试）。
- **F3-平台事实（记录，不改码）**：本部署 subagent provider 注册名 = `spawn`/`fork`（非示例的 subagent-spawn）；动态 Host 沙箱无 `AbortController` 全局；`ctx.get('shell')` 指向 WSL bash（Windows node 需走 `subprocess` 服务 argv-array spawn）。

### 8.5 Slice 1b 指纹（同一次测量：Get-FileHash + count-lines.mjs）

- `lib/p2/tool-names.js`（新增）= `0F97D2D603C2` / 934 B / 17 行
- `lib/p2/scheduler.js`（新增）= `5530BC7B8363` / 8397 B / 181 行
- `lib/p2/persona.js` = `7A14698001E1` / 5471 B / 92 行
- `lib/p2/spawn.js` = `CA5122B9D0C0` / 8148 B / 172 行
- `lib/p2/claim-channel.js` = `2B5F435EE462` / 5936 B / 118 行
- `lib/p2/scheduler-core.js` = `69C7B38DA7D0` / 10861 B / 242 行（**与 t92 哈希相同，零改动**）
- `lib/index.js` = `104AFED5C806` / 80406 B / 1982 行（+重导出块）
- `test/p2-scheduler-wiring.test.mjs`（新增）= `E9B002B7DC55` / 12232 B / 225 行
- `test/p2-spawn.test.mjs` = `DC41B90891E2` / 12560 B / 239 行
- `test/p2-claim-channel.test.mjs` = `0A299A3F474D` / 7329 B / 134 行（与 t92 哈希相同，零改动）
- `test/p2-scheduler-core.test.mjs` = `8E096AD9658F` / 11018 B / 234 行（与 t92 哈希相同，零改动）

### 8.6 待 Slice 2/3 的事项

1. B′ 工具注册与成员身份注入的**常驻接线**（本轮为临时驱动插件，未入仓；宿主装配形态 = profile 安装版插件内接 tools 注册 + executeMemberTool 直调，进程内持久 store 取代 %TEMP% 桥接）；
2. 唤醒循环宿主化（sendMessage 边界 + session/event 观测喂 MemberRegistry）；
3. `checkUnattended` 与 collectStaleCandidates 的宿主巡检接入；
4. 未测残留：真实成员在 LLM 路由配额耗尽/上下文轮换下的 1b 链路（本轮成员为健康路由单回合）。

---

## 9. Slice 2 交付记录（t96 · engineer4 · 2026-09-13）

> 承载：队长工具面 ×4 + 成员退役通道 + E15 机制化 + t95 两条 low 对齐 —— P2 主体拼图收口。
> 本节为**纯追加**；§0–§8 保持既有交付字节不变（v0.7 `ED95B4DC3C3F` 与 client.js `77D49690DCAB` 本轮复测仍零改动；版本 0.5.0 不动；零 push）。

### 9.1 队长工具面 ×4（`lib/p2/captain-tools.js`）

DTO + 依赖注入执行器（与 B′ 同构：宿主侧直调 P1 store + scheduler.js 接线，零 HTTP）。注册名统一 `team_` 前缀（契约名映射：create_task→team_create_task / update_task→team_update_task / send_message→team_send_message / status→team_status；与 agent_teams_* 结构性隔离，§9.1.1）。apply 纪律不变：注册件就绪，是否对 captain 会话生效由宿主装配显式决定，apply 零自动动作。

| 工具 | 语义（§6） | 构造调用证据（test/p2-captain-tools.test.mjs，8 用例） |
|---|---|---|
| create_task | 建任务 + §2.3 触发源 1（pickMemberToWake 一次池检查唤醒；wake:false 可关） | 定向 alice 唤醒 verbatim 断言 driver.calls；池任务名字序；wake:false skipped；subject 缺失拒绝 |
| update_task | CAS 迁移（attemptId+revision），stale/attempt 不符诚实拒绝 | stale-revision / attempt-mismatch / 成功迁移三例；review 任务 completed 自动附 E15 警告载荷（不阻断） |
| send_message | 自由消息 + kind:wake 双用（F3 双通道主路径：taskId 元数据随唤醒下发） | free 与 wake 的 meta 断言；wake 走 pickMemberToWake 选序（熔断成员 member-unavailable 拒发）；wake 失败记账熔断；未知成员拒绝；自由消息不改可用性（不洗白熔断） |
| status | 注册表（可用性/在途/连败/最近响应）+ 池投影 + readyQueue | members/tasks/readyQueue 三段断言 |

### 9.2 成员退役通道（`lib/p2/retire.js`）

三入口：`planRetire`（前置盘点：有未终态任务且无 disposition → **拒绝并列出**（§7 不自动处置同源纪律）；disposition 走 resolveStale 的 supersede/reassign-to= 通道）→ 调用方执行 dispose 边界 → `applyRetire`（registry offline + 移出 memberIds + **无孤儿终校验**，残留则 orphan-detected 如实上报）；`retireMember` 组合入口供测试/简单宿主。

**真实退役演示（隔离上下文，t94 遗留真实成员）**：对象 = `dsh-team-chat:p2e2e:probe1`（childId `189070f2-0f8d-49eb-94cf-089bdbcd845c`，t94 真实 spawn 的成员会话）。①`retire-plan` 无处置 → `member-has-open-tasks`（claimed 任务逐条列出，store 零改动）；②带显式 supersede disposition（grave 任务承接）→ 计划成立、处置逐条 ok；③**真实 dispose** = engineer4 会话对真实 childId 调 `interrupt_agent`（平台回执：interrupt requested）；④`retire-apply` 携真实回执 → `memberIdsAfter=[]`、`availabilityAfter=offline`、`orphans=[]`。**语义披露**：平台无物理删除通道（对已完成会话 interrupt = accepted no-op，会话存档可续存）；退役的硬语义 = 调度面永久摘除（不在任何 memberIds、注册表 offline → 本调度器无任何唤醒路径）+ 任务无孤儿 —— 与 AgentTeams removed members 保留会话档案同构。

### 9.3 E15 机制化（`lib/p2/review-guard.js`）

两个触发点对齐设计 §10 原文：①claim 快照 —— `executeMemberTool` 成功认领 `kind='review'` 任务时对 `inScope` 文件集快照（file→sha256+bytes；readFile 边界可注入，宿主装配接 fs 服务）；②完成比对 —— `updateCaptainTask` / `executeMemberTool` 结算 completed 时自动比对，不匹配 → 警告载荷（match=false + changed 列表，**不阻断**——设计语义「警告」，处置人工）。**存储披露**：P1 store schema 冻结，指纹集存宿主侧 sidecar（taskId 键控）——「入任务记录」完整形态待 P1 schema 扩展任务承载（见 §9.6）。

### 9.4 两条 low 对齐（t95 移交）

1. **note（DTO 描述与 store 能力不符）**：选「修描述」而非「store 加通道」——P1 store 冻结且 lib/state 不在本任务 in-scope；新描述如实声明「随工具结果留痕于宿主侧会话事件日志；P1 store 无 note 字段，不入库」，测试断言锁定（不得再出现 lastNote）。note 值回传于工具结果（claim/report 返回携带）= 会话事件日志可查。
2. **welcomeText 透传**：`spawnMember` 新增 `input.welcomeText`（1a 曾丢弃）；缺省仍 renderMemberWelcome。taskId 下发按设计 §2.3 走唤醒消息元数据（`sendCaptainMessage` kind:wake 携 taskId = F3 主通道），welcome 不承载任务信息 —— 实现 + 显式声明双落位。

### 9.5 验证口径（分开报）与判别力

- **junction 临时树**：224 tests / pass 224 / fail 0 / skipped 0（宿主用例真实执行）；
- **裸检出 npm test**：224 / pass 178 / fail 0 / skipped 46（46 全为环境性 schemastery peer，与 t92/t94 同口径；相对 t95 基线 204/158 净增 20 用例全绿）；
- **契约命令 `node --test test/p2-*.test.mjs` 单独**：64 / pass 64 / fail 0 / skipped 0（新增 captain-tools 8 + retire 6 + review-guard 5 = 19 用例，扩 spawn 1 + claim-channel 断言）；
- **判别变异（最终代码，%TEMP%/dsh-t96-mutate/，3 组全红）**：mut-create-nowake（create 跳过池检查唤醒）→ 8/6/2 红（『建任务+触发源』『池任务选序』）；mut-retire-nocheck（plan 跳过 open-task 检查）→ 6/2/4 红（『拒绝并列出』『disposition 成立』『组合恰一次』『无边界拒绝』）；mut-e15-skip（compareFor 恒 match）→ 5/2/3 红（『一次性消费』『unreadable/release』『端到端警告』）。

### 9.6 Slice 2 指纹（同一次测量：Get-FileHash/count-lines.mjs 双源）与 diff 声明

- `lib/p2/captain-tools.js`（新增）= `C2D0A62D4662` / 9790 B / 201 行
- `lib/p2/retire.js`（新增）= `6D79A6A03391` / 6251 B / 123 行
- `lib/p2/review-guard.js`（新增）= `8E0B38103B3C` / 4204 B / 104 行
- `lib/p2/claim-channel.js` = `9F7E3DD5A282` / 7154 B / 141 行（note 描述 + E15 两触点）
- `lib/p2/spawn.js` = `5F255EE79533` / 8728 B / 178 行（welcomeText 透传）
- `lib/p2/tool-names.js` = `0F97D2D603C2`（与 t94 同 → 零改动）；`lib/p2/scheduler.js` = `5530BC7B8363`（同）；`lib/p2/scheduler-core.js` = `69C7B38DA7D0`（同）；`lib/p2/persona.js` = `7A14698001E1`（同）
- `lib/index.js` = `5AB1429A947A` / 80803 B / 1993 行（+Slice 2 重导出块）
- `test/p2-captain-tools.test.mjs`（新）= `42DD5C1B5329` / 10598 B / 215 行；`test/p2-retire.test.mjs`（新）= `E4A1428E2135` / 5864 B / 127 行；`test/p2-review-guard.test.mjs`（新）= `635147AFE335` / 5447 B / 123 行；`test/p2-spawn.test.mjs` = `F8651E7E4065` / 13424 B / 256 行；`test/p2-claim-channel.test.mjs` = `AABD3EB50FFB` / 7743 B / 138 行；`test/p2-scheduler-core.test.mjs` = `8E096AD9658F`（同 t92/t94）；`test/p2-scheduler-wiring.test.mjs` = `E9B002B7DC55`（同 t94）

diff 声明：以上 17 文件 + 本文档（§9 追加后指纹 `见 t96 output`）为全部改动；lib/client.js、设计稿、package.json、scripts/ 零触碰。

### 9.7 待后续（Slice 3+ / P4 前置）

1. 工具注册常驻化（captain ×4 + B′ ×2 进 profile 安装版插件的 apply，配合宿主装配开关——§9.1.1 过渡期默认关闭）；
2. E15 指纹入 store 记录（P1 schema 扩展任务承载）+ fs 服务适配 readFile 边界；
3. 唤醒循环宿主化与 session/event 观测喂注册表；reassign HTTP 路由（§6-2 唯一新增面）；
4. 退役的 roster 持久化（本轮注册表为内存态；持久名册属宿主装配）。

### 9.8 退役通道 v2（t96 范围追加 · reviewer4 规格 · 2026-09-13）

> 队长将 reviewer4 对 retire 通道的裁定 + 平台原语 + 五条最小验收并入 t96 契约（取代 §9.2 的笼统表述）。本轮全部落地并验证。

**平台原语接线**：`makeDrainDispose({parent, drainChildren})` 把 `subagents.drainContinuableChildren(parent, [childId])`（dsh-subagent/lib/index.js:2810——按 childId 精确释放 resident 子代理；越权 UNAUTHORIZED、absent accepted no-op）包装为 retire 的 dispose 边界；`annotateChildren(children, registry)` 对 `listChildren`（:2832，含冷态 durable 记录）逐行标注 `retired` 布尔——**明确标注而非伪装删除**。`MemberRegistry` 增加退役注销语义：`markRetired`（offline + retired 集合，单向注销——markActive/markQuotaExhausted/resetBreaker 均不可复活）+ `isRetired`/`retiredMembers()`（roster 落盘数据源，持久化属宿主装配）。

**五条验收逐条落测试（test/p2-retire.test.mjs，9 → 12 用例全绿）**：
- a. retire 后 `dispatchBatch` 不再 pick（定向任务 → no-eligible-member skipped 且 store 零改动；池任务改选剩余成员）；
- b. drain 接线：`makeDrainDispose` 以 `(parent,[childId])` 精确传参断言 + `annotateChildren` 标注断言（输入行不改写）；**真实调用**：动态插件直调 `drainContinuableChildren`（parent=engineer4 会话，childId=189070f2…）→ 正常返回（该成员非 resident = accepted no-op，契约原话兑现）；`listChildren` 仍枚举冷态记录（durable 持久为平台设计）且 `retired:true` 标注可见；
- c. 幂等：重复 retire = `{ok:true, noop:'already-retired'}` 且不再触发 dispose；非本队/不存在成员 → 显式 `unknown-member` 失败（不静默）；
- d. 变异判别：mut-retire-nodrain（retireMember 跳过 drain 接线）→ **3 红**（『dispose 恰好一次』『验收 b 接线』『验收 c 幂等』——精确命中接线断言）；
- e. 前缀隔离：对 `agent-teams:*` 名义成员 retire → 显式 unknown-member 失败且 store/注销集合零改动（结构性：retire 只作用于本队 memberIds）。

**两条佐证并入（如实口径）**：
1. continuable 子会话 durable 持久是平台设计语义：DUPLICATE_CHILD 检查读 `persistence.listSnapshots`（dsh-subagent/lib/index.js:1044-1049）；spawn-in-process 完成后 dispose 的是**活体句柄**，持久层不删（dsh-subagent-spawn-in-process:34-36）——故 retire 后冷态记录存在 ≠ 未退役，发现面以 `retired` 标注为准。
2. **t95 结论精度口径修正（reviewer4 自纠，本基线如实并入）**：t95「成员自动 dispose…零残留」的准确范围 = 活体 registry + AgentTeams 名册 + 仓库文件；**durable 持久层冷态记录未验证且按契约保留**——与第 1 条平台语义一致，不构成缺陷。

**追加后指纹（同一次测量）**：`lib/p2/scheduler-core.js` = `C793138EE4A9`（原 69C7B38DA7D0 +retired 语义）；`lib/p2/retire.js` = `6A54AD887801`（原 6D79A6A03391）；`test/p2-retire.test.mjs` = `3CACEEF56F3B`；其余 §9.6 文件哈希不变（captain-tools C2D0A62D4662 / review-guard 8E0B38103B3C / claim-channel 9F7E3DD5A282 / spawn 5F255EE79533 / lib/index.js 5AB1429A947A / scheduler 5530BC7B8363 / tool-names 0F97D2D603C2 / persona 7A14698001E1）。红线复核：client.js `77D49690DCAB`、设计稿 `ED95B4DC3C3F`、版本 0.5.0、零 push 全过。

**追加后验证口径**：junction 227/227/0 skip；裸检出 227/181/46 skip（环境性）；`node --test test/p2-*.test.mjs` 单独 67/67/0（+3 用例：验收 a/b/e）。

---

## 10. Slice 3 交付记录（t98 · engineer4 · 2026-09-13）

> 承载：routingText 解耦 —— AgentTeams 指令退场、/team-tasks 新语义进文本、label 双前缀解析、executionPrompt 通道保留。**P2 随此收口**。
> 本节为**纯追加**（§0–§9 字节不变，交付纪律：指纹表最后写、写完即终态——本节指纹表即终态承载）。

### 10.1 routingText 重写（`lib/shared.js:249-291` 区域）

指令文本全面换血，签名 `(config, team) → string` 不变（调用方 `index.js:1408/:1449` **零改动**——契约「仅当签名变化才动」的兑现）：
- **指引类具体工具名零残留**：`agent_teams_create` / `agent_teams_add_member` / `agent_teams_send_message` / `agent_teams_status` 在 shared.js 全文 **grep = 0 命中**（独立 grep + 测试双证）；禁令句保留通配表述 `agent_teams_* 已退场`（「不得用」必须点名禁的对象，用通配避免与指引混淆）。
- **新语义写入**（§9.1.1 三条硬约束进指令文本）：①新任务一律走 `/team-tasks`（P1 状态层，账本唯一）；②不得用 AgentTeams 建队/建成员/派活，名册保持**只读**，成员由自建调度器管理（`dsh-team-chat:` 前缀，与旧前缀结构性隔离）；③观察走 P1 `/state` 投影与群聊步骤视图。
- **executionPrompt 通道保留**（t80 C 类）：roster 渲染的 `executionPrompt（必须原样传入该成员）` 通道原样保留（`memberPrompt` 未动），测试 `routingText renders the team it is given` 全绿证实通道在本切片后仍可用——注入者由后续 Slice 替换。
- 既有 config 键行为保留：`autoCreateTeam:false` → 「本会话不自动建队」变体仍在；`autoApproveTeam` 不再进文本（approval 参数属已退场的 agent_teams_create）；`imProgress:false` → IM 条款剔除逻辑不变（IM 条款内 `agent_teams_send_message` 汇报措辞改为「任务回报通道」）。

### 10.2 label 双前缀（`shared.js:13` 与 `:96-118` 区域）

- 新常量：`LABEL_PREFIX_P2 = 'dsh-team-chat:'`；`LABEL_PREFIXES = [P2, 旧]`（P2 在前）；`LABEL_PREFIX`（agent-teams:）保留为存量兼容。
- `isTeamLabel` 接受双前缀（`startsWith` 整段匹配——`dsh-team-chat-clone:x:y` 正确拒绝）；`roleFromLabel`/`teamFromLabel` 逻辑本为前缀无关（`parts[1]/parts[2]`），双前缀同构解析，docblock 补双例。
- 消费面（`index.js:403/:406/:507` roster 发现与投影）自动获得双前缀能力，混合名册（agent-teams: 存量 + dsh-team-chat: 自建）渲染为同一团队；**index.js 本轮零改动**。

### 10.3 红线（本切片最大风险点）与验证口径

- `lib/client.js` **零 diff**（指纹 `77D49690DCAB` 复测一致）：结构性安全 = client.js 自带本地 `roleMeta`、不 import shared.js（grep 证实）；行为安全 = client 既有测试全绿（裸检出 0 fail）。设计稿 `ED95B4DC3C3F`、版本 0.5.0、零 push；git 改动面不含 client/state/scripts/package。
- 测试计数绑定 **test() 块数**（reviewer4 纪律）：shared.test.mjs **43 个 test() 块**（新 4 + 改 3，其余不变）。
- 三口径分组：**junction 229/229/0 skip**；**裸检出 npm test 229 / pass 183 / fail 0 / skipped 46**（46 全为环境性 schemastery peer，skip ≠ pass）；**契约命令 `node --test test/shared.test.mjs` 43 / pass 43 / fail 0 / skipped 0**。
- 判别变异（%TEMP%/dsh-t98-mutate/，node 版注入，2 组全红）：mut-rt-legacy（routingText 重引入 `agent_teams_create` 指引行）→ 43/40/**3 红**（『retires legacy』『auto-creation off-switch』『source zero-residue』）；mut-label-single（isTeamLabel 回退单前缀）→ 43/41/**2 红**（『isTeamLabel 双前缀』『mixed roster』）。

### 10.4 Slice 3 指纹（同一次测量：Get-FileHash + count-lines.mjs；本表最后写）

- `lib/shared.js` = `7E6B3F982A53` / 18573 B / 455 行
- `test/shared.test.mjs` = `FFA26C1A9396` / 16519 B / 425 行
- `lib/index.js` 零改动（= `5AB1429A947A`）；`lib/client.js` 零改动（= `77D49690DCAB`）；lib/p2/、lib/state/、scripts/、package.json 零触碰。
- 本文档追加 §10 后终态指纹见 t98 output（自指不写）。

diff 声明：以上 2 文件 + 本文档（§10 纯追加）为全部改动；其余零触碰。