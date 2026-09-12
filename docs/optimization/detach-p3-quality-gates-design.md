# P3 质量门产品化设计稿（v0.2 · repair-round-2 修订：H7 显式取代声明 + gate 感知校验 + supersede gate 处置 + 补偿语义契约化，待复核）

> **任务**：t100（v0.1 初稿）→ **t102（本修订 · repair-round-2）** · researcher4（研究员）· 2026-09-13。
> **定位**：把本会话**人工运转的质量门实践**（契约四件套 / 对抗复核+结构化 findings / 修复循环 / 能变红判别 / E15 / 零修订硬规则 / 归因对照实验）沉淀为 dsh-team-chat 插件的**系统能力设计**。本稿为设计，不含实现；实现须由后续 implementation 任务按本稿契约派单。
> **纪律**：只改本稿 + `docs/optimization/README.md` 索引行；不改源码；不 push；受复核文档交付即冻结（章程规则 4）；数字全部绑定口径（章程规则 1/2）；指纹表在 §11（最后写，写完即冻结基线）。
> **上游基线**（同一次测量核对，方法 = `Get-FileHash -Algorithm SHA256` + `node C:\Users\bo.yang02\count-lines.mjs`，2026-09-13）：P2 设计稿 v0.7 = `ED95B4DC3C3F` / 78780 B / 551 行；P1 设计稿 v4.5 = `6FBCA6827E25` / 60139 B / 518 行。与任务派单口径及 P2 §11 数值总表逐项一致（已验证）。
> **v0.2 修订登记（t102 承载，前版 = v0.1 `1151996B48A9`）**：①§4.1 增补对 P2 §7.2 H7「不自动开 repair」裁决的**显式取代声明**；②§6.1 增 create 工具层 gate 感知校验（`gate-busy`）；③§4.6 + §5.2/§5.3 supersede 执行路径的 gate 同步处置 + `subject-superseded` reason；④§6.2 sidecar 写失败补偿语义从实现裁量**升级为契约条款**；⑤G8 辨析补 H7 维度；⑥§8 需实测项随④收窄。P2 设计稿 H7 行的对应修订由**独立任务**承载（本稿不改 P2 文件，声明见 §4.1）。

---

## 0. 阅读指南（本稿可独立阅读）

### 0.1 背景与术语

- **质量门（quality gate）**：一个任务从「实施完成」到「被独立核验通过」之间的全部机制约束。本会话以 AgentTeams 的 kind 体系（work / implementation / verification / review / repair / integration）+ 人工纪律运转；P3 把它搬到自建调度体系（P1 状态层 + P2 调度器）上。
- **契约四件套**：objective + acceptance + constraints + knownRisks——本会话每个任务派单的实际形态。
- **findings**：复核产出的结构化问题清单（id/severity/problem/requiredFix/line）。
- **门轮次（round）**：对同一被审对象的一次完整「review →（needs_revision → repair）」循环。
- **升级（escalation）**：循环无法自动收敛时，进入「显式待人工裁决」结构化状态——**不是**现在 AgentTeams/本团队那种无处置建议的卡死 escalated。

### 0.2 P1 / P2 / E15 已落地事实（本稿作者逐项独立核对，非转抄任务描述）

| 组件 | 事实 | 证据（本稿 2026-09-13 实测） |
|---|---|---|
| P1 状态层 | TaskRecord 已含 `objective/inScope/acceptance/verify` 四个契约侧字段；`constraints/knownRisks` 不存在 | task-store.js:212-241（createTask 字段构造，指纹 `9D687A013253` / 35567 B） |
| P1 状态机 | 7 态 `pending/claimed/running/suspended/completed/failed/superseded`；`UPDATE_STATUS` 域仅 running/completed/failed；**无 escalated 态** | task-store.js:77-85（TRANSITIONS）、:51（UPDATE_STATUS） |
| P1 质量门语义 | failed 是 terminal 且向下游写 `dependencyFailedAt` 戳（带戳继续不阻塞）；claim 前置 `dependencyBlocked`（依赖未全 terminal 拒绝认领） | task-store.js:389（failed 传播）、:623-636（dependencyBlocked/taskOpen）、:306-317（claim 前置） |
| P1 持久化 | `$DSH_HOME/dsh-team-chat/<teamId>/team.json`；tmp+rename 原子写；迁移同步落盘 / 活动信号 500ms 聚合 | P1 设计稿 §7:288-295（v4.5）；task-store.js:721-750（save/serialize） |
| P1 投影 | `snapshotRow` 不含契约字段（id/status/assignee/deps/revision/停滞标记/时间戳） | task-store.js:688-707 |
| P2 调度器 | `readyTasksOf` → `dispatchBatch`（E9 每拍 maxWakes=1；无可唤醒 skipped 且 store 零改动）→ `reconcileInFlight`；stale 处置唯一入口 `disposeStale`（缺省 no-auto-requeue） | scheduler.js:33-48/:64-107/:168-177（指纹 `5530BC7B8363` / 8397 B） |
| P2 成员可用性 | `MemberRegistry` 四态 online/breaker-open/quota-exhausted/offline；连败阈值 3 熔断；恢复=显式 `resetBreaker`；退役单向 `markRetired` | scheduler-core.js:24-37/:115-130/:152-180（指纹 `C793138EE4A9` / 12331 B） |
| P2 队长工具 | ×4：`team_create_task / team_update_task / team_send_message / team_status`；create 透传参数 = subject/objective/assignee/dependencies/kind/inScope（**未透传 acceptance/verify**）；update 参数 = taskId/attemptId/revision/status（**无 verdict/findings**） | captain-tools.js:22-71/:87-94/:112-131（指纹 `C2D0A62D4662` / 9790 B） |
| P2 成员工具 | B′ 双工具 `team_claim_task / team_report_task`；report 域 = taskId/status/note（note 只落宿主侧会话事件日志、不入库）；归属=attemptCache | claim-channel.js:31-59/:111-140（指纹 `9F7E3DD5A282` / 7154 B） |
| E15 复核指纹守卫 | 已实现：review 任务 claim 时对 inScope 文件集快照（file→sha256+bytes）；结算 completed 时比对；**警告不阻断**；快照一次性消费（比对即释放）；**存储=宿主侧 sidecar（内存 Map），「入任务记录」待 P1 schema 扩展（基线 §9.7-2 登记的遗留）** | review-guard.js:14-16（诚实披露）/:51-68（snapshotFor）/:73-97（compareFor 一次性）/:99-101（release）（指纹 `8E0B38103B3C` / 4204 B） |
| P2 防双调度 | 过渡期 AgentTeams 仍在跑；自建面 apply 零自动动作；`team_` 前缀与 `agent_teams_*` 结构性隔离 | P2 设计稿 §9.1.1:420-439；p2-impl-baseline.md §9.1（`04FA0A5ECAE3` / 31667 B） |
| /team-tasks 路由 | 5 条：create/claim/update/release/supersede | lib/index.js:1802/:1833/:1860/:1890/:1917（grep 实测，本稿 2026-09-13） |

### 0.3 设计原则（承 P1/P2，全部由事故反推）

1. **零 P1 破坏**：P1 store schema 冻结（v4.5）；一切 P3 元数据先走 sidecar，P1 v2 版本化扩展只收编「最小必要字段」（§3.1 裁决）。
2. **机制化而非纪律化**：本会话证明有效的纪律（零修订/能变红/对照归因）凡可机制化的必须落为代码可判定的检查（E15 是样板）。
3. **升级不是失败**：循环触顶必须产生「结构化待裁决」，绝不产生静默卡死。
4. **引用不重造**：E15/调度器/熔断/防双调度全部已落地，P3 只做接线与扩展。

---

## 1. 设计输入：本会话真实事故 → 设计约束（逐条映射表）

> 与 P2 设计稿 §1 同格式。全部来自本团队账本（`agent_teams_status` 快照可回溯）与仓库文档。证据列给出任务号/文档节与原文要点；「落点」列给出本稿章节。每条都落到具体机制，不接受「要注意」式泛化。

| # | 事故 | 证据（账本/文档，快照口径见 §8） | 设计约束（硬性） | 落点 |
|---|---|---|---|---|
| 1 | **自动循环触顶即 escalation、无处置建议** | 本团队当前即处于 escalated（`agent_teams_status`：「Loop: escalated — Automatic review/repair loop hit its ceiling…」）；t88（review-round-3）被误派成 claimed 残留，Delivery blocked；系统提示只有「Escalate to the user」，无已尝试轮次/无建议/无待裁决项 | 升级必须是**结构化记录**：升级原因（枚举）+ 已尝试轮次 + findings 摘要 + 处置建议 + 待人工裁决项（显式选项）；升级后任务保持可观测、被审文件保持冻结 | §5 |
| 2 | **复核中基线漂移 ×5** | t84-F8 当场抓获：「开始 45383FAF4D3E/495 行 → 结束 2AF8B687F19D/501 行（v0.5 正在写入），无任务承载（t82 已 terminal）」；账本谱系 v0.2/v0.3/t84-v0.5/t96 追加等 5 次 | 复核期零修订 = 机制（E15 已落地，引用不重造）；**升级期同样冻结**（E15 快照在 escalated 期间不释放）；任何修订必须由新任务承载并登记基线演进 | §4.8、§5.4 |
| 3 | **复核者规格中途到达** | t85（作废记录）：「reviewer2 定 medium 的 F7 未进 t82 契约……researcher2 已按新流程正确拒绝口头合并指令并要求正式派单」→ t86 正式承载「F1 补录 + F7 合并」；t96 同型：reviewer4 规格（退役 v2）由队长并入 t96 契约后落地（p2-impl-baseline.md §9.8） | 复核期新输入**排队不插入**：进 sidecar `pendingInputs`，当轮终态后由新任务承载；「口头合并指令」无效（成员有权拒绝，队长入职指令已确认此纪律） | §4.7 |
| 4 | **重复任务** | t83 作废记录：「与 t84（round 2 复核 t82/v0.4）完全重复，t84 验收更完整」；t85 被新任务取代作废 | 循环创建（repair / re-review）前必须做**存在性去重**（同 source + 非 terminal 同类任务已存在则复用不新建）；队长显式取代走 P1 `supersede`（supersedes 语义） | §4.6 |
| 5 | **stale 重排风暴** | t30 attempt 3 作废记录：「移除旧 reviewer 后被调度器误派的陈旧条目」；t49/t52/t59/t67/t68 同型共 6 例（P2 §1 #6 口径） | 循环**不自动重排任何任务**：repair/re-review 全部是新任务（新 id、新 CAS 生命周期）；唤醒只走 P2 dispatchBatch（no-auto-requeue 语义继承） | §4.3-4.4 |
| 6 | **成员不可用误派（配额/上下文/熔断）** | t59/t67/t68 三次「被调度器误派给配额耗尽成员」（账本原话）；t87 attempt 2 重派 engineer3 后成功；旧 reviewer/researcher 轮换为 reviewer2/researcher2 后正常（本会话实证） | review/repair 派发前查 `MemberRegistry.availabilityOf`（引用 P2，不重造）；目标成员不可用 → 不创建/不唤醒，任务留在池中；持续不可用 → 升级（reason=reviewer-unavailable） | §4.4、§5.3 |
| 7 | **僵尸依赖（t6 型）** | t6 作废记录：「依赖中含已作废任务，永久无法认领（僵尸）」 | 循环新任务的依赖**只指向成功源**（被审 implementation/repair 任务），**永不依赖 failed 的 review 任务**（继承 AgentTeams 质量门语义与 P2 §1 #9） | §4.2 |
| 8 | **双调度风险** | P2 §9.1.1 硬约束（AgentTeams 过渡期仍在跑）；t98 Slice 3 已把「新任务一律走 /team-tasks」写进 routingText | P3 全部循环动作走自建工具面（`team_*`）；不调用、不模拟 `agent_teams_*`；apply 零自动动作的装配纪律不变 | §7.5 |

**映射完备性自查**：任务契约列出的 6 项事故（escalated 卡死 / 基线漂移 ×5 / 规格中途到达 / 重复任务 / 成员不可用 / 双调度）全覆盖于 #1/#2/#3/#4/#6/#8；#5（stale 重排）与 #7（僵尸依赖）为契约原文「升级判定的教训映射」语境下必须同防的账本实例，一并列入。无遗漏项。

---

## 2. 本会话人工质量门实践盘点（P3 产品化对象，逐项附证据与载体缺口）

| # | 实践 | 本会话人工做法（证据） | 现有机制载体 | 缺口（P3 要补） |
|---|---|---|---|---|
| 1 | 契约四件套 | 每次派单附 objective/acceptance/constraints（纪律节）/knownRisks（如本任务契约四段式） | P1 store 已有 `objective/inScope/acceptance/verify`（task-store.js:218-221）；**队长工具未透传 acceptance/verify**（captain-tools.js:87-94 实测）；constraints/knownRisks 无字段 | ①create 工具透传补缺；②constraints/knownRisks 落 sidecar 影子字段（§3.2） |
| 2 | 对抗复核 + 结构化 findings | t74 对 t73 的 F1-F6、t81 对 t79 的 F1-F7、t84 的 F7/F8、t87 的 F9/F10——全部 id/severity/problem/requiredFix(+定位) 格式 | AgentTeams `update_task` 的 findings 参数（id/severity/problem/requiredFix/file/line/resolved）；**自建面 report 无 findings 通道**（claim-channel.js:43-58） | findings schema 定版 + report/update 工具扩展（§3.3、§6） |
| 3 | 修复循环 | needs_revision → 系统开 repair（findings 附带、依赖成功源）→ re-review；账本闭环实例：P1 设计线 t74→t75→t76、P2 设计线 t81→t82→t84→t86→t89→t90 | AgentTeams 自动开 repair+next review；**自建面无任何循环机制** | §4 全节 |
| 4 | 「能变红」判别力 | t21 反例验证（注入原始 bug→检查失败→还原 SHA256 全等）；t25 故障注入（readSurface 永不 resolve→5021ms settle）；t74 红绿对照（M1 去 CAS→1/21 红）；t92-t96 判别变异（mut-create-nowake 8/6/2 红、mut-e15-skip 5/2/3 红等）；verification-record.md §9.6 教训 3/6（控制组必须能变红；编码前形状抽查可执行规则） | 实现任务验收惯例（手工人肉执行） | 把「能变红」写为 review/verification 任务的**验收标准模板字段**（§3.4），并在 P3 实现任务的 verify 中自证（§8） |
| 5 | E15 复核指纹 | t84-F8 三次偏差后机制化；t96 实现并经 mut-e15-skip 判别验证 | `lib/p2/review-guard.js` 已落地（快照/比对/一次性/警告不阻断）；指纹入任务记录是已登记遗留（p2-impl-baseline.md §9.7-2） | **引用不重造**；升级期冻结扩展 + 指纹入 P1 v2（§4.8、§3.1） |
| 6 | 零修订硬规则 | 章程规则 4「受复核文档交付即冻结」；t84 当场抓获违反实例 | E15 机制已覆盖「复核窗口」；**升级窗口无冻结** | §5.4 |
| 7 | 归因对照实验 | 章程上位规则（t69）：「任何归因必须由实测或对照实验支撑；推理与实测冲突时实测赢」 | 章程纪律 | 升级记录的 `summary` 字段要求附证据入口（§5.2），纪律进 schema 约束 |

**盘点结论**：7 项实践中 5 项已有部分机制载体（#1 部分/#5/#6 部分），2 项纯人工（#2 自建面/#3/#4）。「每项实践的『缺口』列」即 P3 设计范围；P1/P2 已覆盖的部分只引用不重造。

---

## 3. 质量门元数据 schema

### 3.1 选型裁决：扩展列 vs sidecar（证据与理由）

**候选对照**：

| 维度 | 扩展列（P1 TaskRecord 加字段） | sidecar（独立 QualityRecord，按 taskId 键控） |
|---|---|---|
| 事务性 | 与状态写同一 CAS（task-store.js:164-176），天然原子 | 双写窗口：任务终态与质量记录落盘非同一事务，需自管一致性 |
| 持久化 | 复用 team.json 单文件（P1 §7 分级写） | 独立 quality.json，复用同款 tmp+rename 纪律 |
| 生命周期适配 | 契约字段=创建期输入（合适）；findings/rounds=追加型审计（塞进任务行会让每次 CAS 携带全量 findings，revision 频繁空转） | 追加型审计与任务行解耦，评审轮记录独立演进 |
| 冻结约束 | P1 schema 冻结（v4.5）；改动需版本化声明 + 旧 JSON 兼容（loadTaskStore 对未知字段已宽容：task-store.js:764-766 直接整行入 Map） | 零 P1 改动，可立即设计落地 |
| 先例 | — | E15 即 sidecar 起步（review-guard.js:14-16），attemptCache 同款宿主态（p2-impl-baseline.md §2）；两者都把「入任务记录」登记为 P1 v2 遗留 |

**裁决（分层）**：

1. **创建期输入字段**（constraints/knownRisks）→ **P1 v2 扩展列**为目标形态；v2 落地前先存 sidecar 影子（`contract` 字段）。理由：它们改变 createTask 输入语义、与任务同生命周期、且下游（工程师反问/审查员判范围）需要随任务一并可读；sidecar 只是过渡。
2. **结算期审计产物**（findings/acceptanceResults/rounds/repairs/escalation）→ **sidecar 常驻**（quality.json）。理由：追加型、体积随轮次增长（口径估算见 §8 推测 3）、与 CAS 状态机无关；塞扩展列会造成「一次结算整行重写 + revision 空转」。
3. **P1 v2 收编清单（最小必要，候选）**：①`constraints/knownRisks` 两列；②`gateState` 单列摘要（调度器/投影判定用，明细留 sidecar）；③E15 指纹集（承接 p2-impl-baseline.md §9.7-2 遗留）。收编必须携带版本化声明（schema version 字段 + 旧文件零迁移兼容声明），并走独立 P1 v2 任务评审——**不在 P3 实现内夹带**。

### 3.2 任务契约四件套（QualityContract）

| 字段 | 形态 | 必选性 | 载体 | 说明与兼容 |
|---|---|---|---|---|
| objective | string | 是 | P1 已有列（task-store.js:217） | 不变；队长工具已透传 |
| acceptance | string[] | 是 | P1 已有列（:219） | **工具透传缺口**：captain-tools.js:87-94 未传 → P3 补透传（§6.1，向后兼容的可选参数） |
| verify | string[] | 条件必选（implementation/repair/verification 类必选） | P1 已有列（:220） | 同上补透传；与 AgentTeams 质量门 kinds 的 verify 合同对齐 |
| constraints | string[] | 否（建议必填） | **sidecar `contract.constraints`**（P1 v2 后迁入） | 语言/版本/平台、可用依赖、路径规范——本任务契约「纪律」节的结构化 |
| knownRisks | string[] | 否（建议必填） | **sidecar `contract.knownRisks`** | 失败情形/外部依赖可用性/可复用失败案例 |
| inScope | string[] | implementation/repair/review 必选 | P1 已有列（:218） | 不变；E15 快照的数据源（review-guard.js:52） |

**必选性执行**：工具面校验（create 时 kind∈{implementation,repair,verification} 且 acceptance 空 → 显式拒绝 `acceptance-required`），错误码学 P1 ERR 集中风格。注意：P1 `createTask` 本身不做此校验（纯核心不假设调用方语义），校验放工具执行器层——与 B′「store 纯核心 + 工具层语义」分工一致（claim-channel.js:77-89 同款分层）。

### 3.3 findings 结构（QualityFinding）

```jsonc
Finding {
  "id": "F1",                       // 轮内唯一，F1..Fn（本会话 t74 F1-F6 / t81 F1-F7 同款）
  "severity": "blocker|high|medium|low",
  "problem": "…",                   // 问题描述（对事不对人）
  "requiredFix": "…",               // 可执行修复要求——「改成什么」，不是「这不行」（章程 §7.2）
  "file": "lib/xxx.js",             // 可选：定位文件
  "line": 42,                       // 可选：定位行号
  "resolved": false                 // repair 结算时回写（本会话 AgentTeams findings 同款字段）
}
```

与既有形态完全一致（AgentTeams `update_task` findings 参数；t74/t81/t84/t87 实例），**零学习成本迁移**。`requiredFix` 非空为必选校验点（工具层拒绝空 requiredFix 的 non-low finding——low 允许留空作为风格建议，口径见 §9-G3）。

### 3.4 acceptanceResults（验收对照记录）

```jsonc
AcceptanceResult { "criterion": "…", "status": "passed|failed", "evidence": "…" }
```

- review/verification 任务结算时随 findings 一并上报；`criterion` 与被审任务 `acceptance` 数组逐条对应（本会话 t90「九项验收全 passed」的人工格式结构化）。
- 判别力模板（承接实践 #4）：implementation/repair 任务的 verify 数组**应包含至少一条「能变红」对照命令**（注入变异→旧行为红）。P3 不强制（待决策 G6），但 `verify` 透传补缺后队长可按惯例写入。
- 结算校验：review 任务 `verdict=pass` 时 acceptanceResults 不得含 failed 项（工具层一致性校验，防「pass 但有 failed 证据」的自相矛盾结算）。

### 3.5 verdict 三值

| verdict | P1 status 映射 | 门行为 |
|---|---|---|
| `pass` | review 任务 `completed`（现状：t90 completed+pass） | gate → `closed`；被审对象正式放行 |
| `needs_revision` | review 任务 `failed`（现状：t74 failed+needs_revision） | gate → `needs-revision` → 自动创建 repair（§4.3） |
| `reject` | review 任务 `failed` | **不进修复循环**（章程 §7.1：范围跑偏/证据缺失/验收被破坏需重新规划）→ gate → `escalated`（reason=`reject-no-repair`） |

**显式设计决定：不引入第四值 `blocked`**。本会话实际使用过的 verdict 只有 pass/needs_revision/reject 三值（账本 t74/t30/t90 等）；「blocked/证据不足拒绝出结论」是**程序性情形**（章程 §3.3 四种拒绝出结论的情形），其正确出口是 `failed + findings(kind 程序性)` 或直接升级（§5.3 reason 枚举含 `insufficient-evidence`），而不是与实质判定混同的新 verdict 值——混同会让收敛统计失真。契约原文「verdict 三值（pass/needs_revision/blocked…）」的 `blocked…` 按上述裁定落为升级原因枚举项，不落为 verdict（待决策 G4 复核此裁定）。

### 3.6 溯源字段

| 字段 | 形态 | 语义 |
|---|---|---|
| `sourceTaskId` | string | repair/re-review 指向**成功源**（被审的 implementation/repair 任务 id）——永不指向 failed review（事故 #7 约束） |
| `sourceFindingIds` | string[] | repair 任务声称处理的 finding id 集（如 `["F1","F3"]`）；re-review 结算时逐条回写 `resolved`；**未声称的 finding 不要求修**（防修复范围无限膨胀），但 re-review 可发现新 finding（进入下一轮） |
| `reviewTaskId` | string（轮记录内） | 本轮 review 任务 id——账本可回溯 |

### 3.7 round 计数与 gateState

- `round`：**已完成的评审轮数**（0 = 从未评审；首轮 review 结算后 round=1）。口径声明：以「结算完成的 review 任务数」计，创建未结算的 re-review 不增加 round（与本会话「review r1/r2/…round N」的账本口径一致）。
- `gateState` 状态机（sidecar 持有，P1 状态机零改动）：

```
open ──review claim（E15 快照）──► in-review ──verdict=pass──► closed
  │                                   │
  │                                   ├─verdict=needs_revision─► needs-revision
  │                                   │                             │ repair 创建+claim
  │                                   │                             ▼
  │                                   │                          in-repair ──repair completed──►
  │                                   │                             │        （新 review 排队，round+1）
  │                                   │                             ▼
  │                                   │                          in-review（下一轮）
  │                                   └─verdict=reject / 触顶 / repair failed──► escalated（结构化待裁决）
  └──────────（人工裁决出口：追加一轮 / 接受现状 / 作废重来）──────────────► closed / 回 in-review
```

- 每步转移都由 **P1 任务的结算事件驱动**（review/repair 任务 completed/failed），sidecar 不引入自己的定时器——循环没有时间驱动逻辑，只有事件驱动（防 P1 §5 stall 类「时间窗竞态」在门系统重演）。
- 被审对象任务在门打开期间保持其 P1 状态（completed），**门状态不入 P1**——下游依赖照常工作（P1 dependencyBlocked 只看 P1 terminal）；「下游是否应等门关闭」由 DAG 设计时显式连依赖决定（队长职责，章程 §5.2），P3 不隐式阻塞下游。

### 3.8 QualityRecord sidecar 完整 schema

```jsonc
// $DSH_HOME/dsh-team-chat/<teamId>/quality.json —— { "version": 1, "gates": { <taskId>: QualityGate } }
QualityGate {
  "taskId": "t103",                  // 被审对象（implementation/repair/work）
  "gateState": "open|in-review|needs-revision|in-repair|escalated|closed",
  "round": 2,                        // 已完成评审轮数（口径 §3.7）
  "maxRounds": 4,                    // 创建 gate 时从团队配置拷贝（可单任务覆盖，§9-G1）
  "contract": {                      // 契约影子（P1 v2 后 constraints/knownRisks 迁出）
    "constraints": ["…"],
    "knownRisks": ["…"]
  },
  "rounds": [                        // 追加式；每轮一条
    {
      "round": 1,
      "reviewTaskId": "t104",
      "reviewer": "reviewer4",
      "verdict": "needs_revision",
      "findings": [ Finding… ],
      "acceptanceResults": [ AcceptanceResult… ],
      "settledAt": 1726000000000
    }
  ],
  "repairs": [                       // 追加式
    { "repairTaskId": "t105", "round": 1, "sourceFindingIds": ["F1","F3"], "settledAt": … }
  ],
  "pendingInputs": [                 // 复核/升级期到达的新输入（事故 #3 约束）
    { "receivedAt": …, "from": "captain", "summary": "…", "handledByTaskId": null }
  ],
  "escalation": null | EscalationRecord,   // §5.2
  "updatedAt": …
}
```

### 3.9 持久化

- **位置**：`$DSH_HOME/dsh-team-chat/<teamId>/quality.json`——与 P1 team.json 同目录、同 `<teamId>` 净化规则（`[A-Za-z0-9._-]`，P1 设计稿 §7:288 逐字复用）；绝不入仓库/workspace（隐私纪律，同 P1 裁定 1）。
- **写策略**：质量记录只在**结算/创建/升级等低频事件**时写（每轮一次量级），无热路径 → 全部同步 tmp+rename 原子写，不做 500ms 聚合（P1 分级写纪律的「迁移同步落盘」级，P1 设计稿 §7:290-292）。
- **崩溃恢复**：quality.json 与 team.json 独立；启动时若 gate 指向的 taskId 在 P1 中不存在/已 superseded → 该 gate 标注 `orphaned`（**保留不删**——t6 僵尸教训的另一面：不静默抹数据，标注后人工处置）。
- **重启后门状态的再判定**：gateState 若为 `in-review/in-repair` 而对应 P1 任务已 terminal（崩溃窗口跨结算），以 P1 为准重放转移（P1 是唯一状态真相，sidecar 是审计投影——该重放逻辑是实现 Slice 的验收点）。

---

## 4. 修复/复核循环语义

### 4.1 循环的三个自动动作（全部经 P2 已落地边界）

1. review 结算 `needs_revision` → **自动创建 repair 任务**；
2. repair 结算 `completed` → **自动排队 re-review**（round+1）；
3. 两者创建后 → **经 `dispatchBatch` 唤醒**（P2 触发源 1 同款：captain-tools.js:97-103 建任务后唤醒的既有模式）。

除这三个动作外，循环**零自动行为**：不自动重排、不自动改派、不自动降级 findings、不自动关闭 gate。

> **⚠ 显式取代声明（v0.2 · t102，对 P2 设计稿 §7.2 H7）**：P3 §4.1 的**自动 repair 创建**修订 P2 §7.2 H7 的「**不自动开 repair**」裁决（H7 原文，P2 设计稿:393：「review verdict needs_revision → 不自动开 repair（与 AgentTeams 自动 review-repair 循环的本质区别）……依据 = 账本 t49→t52→t59→t67 四轮循环失控的直接教训」）。**取代理由**：H7 立规时无任何安全阀，P3 为同一自动化加装了**四重安全阀**——①maxRounds 触顶即升级（§4.5）；②repair-failed 即升级（§5.3），不存在无限修复出口；③创建前去重（§4.3，同 source 非 terminal repair 存在则复用不新建，防 t83/t84 重复任务型污染）；④派发前可用性前置（§4.4，全员不可用不创建，防 t59/t67/t68 误派型 stale 候选）——使该自动化可控；且 H7 要求的人工裁决（create/supersede/搁置三选一）由升级裁定出口承接（§5.4 A-D）。**边界不变式**：H7 对「无限自动循环」的担忧仍然成立并被尊重——P3 只在有轮数上限、有升级出口、有去重与可用性前置的 gate 框架内自动创建 repair；框架外的任何「自动开修复任务」依然禁止。P2 §7.2 末「反面对照」清单（:396）中「不自动开修复任务」条目同步受本取代影响，适用范围收窄为「gate 框架外」。
>
> **冻结纪律声明**：P2 设计稿 v0.7（`ED95B4DC3C3F`）已冻结，本稿**不直接修改 P2 文件**；P2 H7 行与反面对照清单行的对应修订（标注「被 P3 §4.1 取代，见 detach-p3-quality-gates-design.md v0.2」）**由独立任务承载**——该任务未执行前，P2 文本与 P3 本声明并存，以本声明为最新裁决（登记为 P3 实现前置待办，见 §9-G9）。

### 4.2 needs_revision 的 P1 映射与依赖纪律（事故 #7）

- review 任务结算 = P1 `update(failed)` + sidecar 写 verdict/findings/acceptanceResults。与账本现状一致（t74/t81/t84 均 failed+needs_revision）。
- **repair 依赖 = `[被审对象]`（成功源）**，不是 failed 的 review：AgentTeams 语义「repair + next review depend on the successful source, never the failed review」逐字继承。failed review 留在账本作审计（P1 `dependencyFailedAt` 带戳继续，task-store.js:389），不阻塞 repair 认领。
- re-review 依赖 = `[repair]`（或 needs_revision 但修复被裁定「无需修复」时的直接重审——仅人工路径，§5.4）。

### 4.3 repair 自动创建（去重先行，事故 #4/#5）

创建前检查（同一 gate 内）：
1. 已存在非 terminal 的 repair 任务（同 sourceTaskId）→ **不新建**，走 `dispatchBatch` 唤醒既有任务；
2. 已存在 `in-review` 状态的 re-review → 不可能（gateState=needs-revision 才进本流程，状态机保证）；
3. 创建参数：`kind=repair`、`subject='repair-round-<N+1>'`（账本惯例 t56/t69/t82 同款）、objective=本轮 needs_revision 摘要、acceptance=「sourceFindingIds 逐条 resolved + 不破坏既有验收（原 acceptance 重跑全绿）」、inScope=被审文件集（与 review inScope 同源）、`verify`=原 verify + findings 逐条的 requiredFix 验证入口、dependencies=`[被审对象]`、findings 全文附带（objective 内引用 sidecar，工具参数只带 id 引用，防超长）。

### 4.4 re-review 排队（round+1 + 新快照 + 可用性前置，事故 #6）

- repair completed → gateState=in-review（下一轮）→ 创建 `kind=review` 任务：inScope 同被审文件集、acceptance=逐条对照被审对象 acceptance + 上轮 findings 逐条 resolved 复核。
- **E15 新快照**：review-guard 比对即消费（review-guard.js:94-95）→ 每轮 review claim 自动建立新快照（既有行为，零改动即正确）。
- **派发前可用性检查**：目标 reviewer（assignee 具名）或池内成员经 `registry.availabilityOf` 全部不可用 → **不创建 review 任务**，gate 停在 needs-revision→in-repair 完成态并记 `waitingReviewer` 标记；持续等待超阈值 → 升级（reason=`reviewer-unavailable`，§5.3）。「全部不可用时不创建」比「创建后无人认领」优：后者会制造 stale 候选（collectStaleCandidates 谱系），前者零账本污染。
- 唤醒走 `dispatchBatch`（E9 每拍 maxWakes=1 纪律不变，scheduler.js:26/:71-74）。

### 4.5 收敛判定与轮数上限

- **收敛 = 某轮 verdict=pass** → gate closed，账本自然留档（t90「round 4 收口复核 pass = P2 设计冻结」模式）。
- **触顶 = round 达到 maxRounds 仍 needs_revision** → 不再自动创建 repair/re-review → gate escalated（§5）。
- **maxRounds 建议初值 = 4（可配置）**。历史口径（绑定 §8 数值总表）：P1 设计线 6 轮闭环（t49→t52→t59→t63→t67→t72），其中末两轮（t67/t72）修的是指纹归因等**纪律类**问题而非内容缺陷；P2 设计线 4 轮闭环（t81→t84→t88[误派作废]→t90）。正常内容收敛 ≤4 轮；触顶更可能意味着「规格未对齐/范围漂移」（t84-F7 型）而非「再多来一轮就好」——触顶即升级把这类问题交还人工，正是本会话 escalated 卡死缺失的东西。
- 轮内递增的 findings 数趋势写入升级摘要（收敛趋势 vs 发散趋势，t63 有「收敛趋势达成」先例口径）。

### 4.6 去重与取代语义（事故 #4）

- 循环内去重：§4.3-1 的存在性检查。
- 跨系统取代：队长显式取代用 `supersedes` 参数（§6.1）→ P1 `store.supersede(oldId, {supersededBy: newId})`（task-store.js:543-564 既有 API，含 S6 链校验）；被取代任务的 gate 记录保留、标注 supersededBy。
- **「gate 关联任务被外部 supersede」的处理**：review/repair 任务被作废 → gate 回退到前一稳定态（in-review 被作废 → 回 needs-revision 或 escalated）并记 pendingInputs 留痕；不自动重建（人工裁决）。
- **supersede 执行路径的 gate 同步处置（v0.2 · t102）**：任何 supersede 入口（§6.1 `supersedes` 参数、P1 路由 `/team-tasks/supersede`、宿主显式通道）执行成功后，执行器必须**查询 quality.json**：被作废任务存在 open gate（gateState ≠ closed）→ 同步处置，二选一（按上下文自动选择，选择写入 gate 记录留痕）：
  1. **gate escalated**（reason=`subject-superseded`，§5.3 枚举）——被审对象被作废通常意味着「重新规划」，保留审计现场待人工；
  2. **gate closed 标注 `supersededBy: <新任务 id>`**——取代方显式承接了门职责（新任务自建新 gate）时。
  同步处置同时**挂起该 gate 的循环创建**（§4.1 三动作对该 gate 不再触发——被审对象已 terminal-superseded，继续循环无对象）；处置失败的孤儿 gate 由启动时 orphaned 检查兜底（§3.9，标注保留不删）。

### 4.7 输入排队（事故 #3）

- 触发条件：gateState ∈ {in-review, escalated}（复核/升级窗口内）。
- 到达的新规格/新验收要求/新意见 → 追加 `pendingInputs`（receivedAt/from/summary），**不修改当轮任何任务契约**。
- 窗口结束（当轮结算）→ pendingInputs 逐条投影到 `team_status` 的 gate 视图 → 队长裁决后**由新任务正式承载**（t85→t86 的「拒绝口头合并、正式派单」流程机制化）。

### 4.8 升级期冻结（E15 扩展，事故 #2）

- escalated 期间 E15 快照**不释放**（现状：比对即消费；升级路径若发生在比对前，快照保持；若发生在比对后，升级结算时对新 inScope 集重新快照）——把「零修订硬规则」从复核窗口延展到升级窗口。
- 人工裁决出口若选「接受修改后再议」→ 显式释放快照并留痕；默认拒绝一切未声明修改。
- E15 警告（match=false）在 review 结算时的处置：**不阻断结算，但必须写入当轮 findings（severity=high，kind=纪律违反）**——t84-F8 的人工裁决惯例机制化；「警告后无人处置」→ 下一轮升级判定输入（§5.3 reason=`e15-breach-unresolved`）。

---

## 5. 结构化升级裁定（「卡死的 escalated」替代品）

### 5.1 为什么现状不可接受（证据）

本团队 escalated 现状（§1 #1）：系统只说「hit its ceiling…Escalate to the user」，无已尝试轮次、无 findings 摘要、无建议、无待裁决项；t88 同时是「误派残留 claimed」——升级与垃圾态混在一起。人工收场的真实成本：队长逐个作废 + 轮换成员（P2 §1 #9 原文）。**升级的价值在「让人接得住」，不在「宣布停机」。**

### 5.2 EscalationRecord schema

```jsonc
EscalationRecord {
  "reason": "round-limit-exceeded | repair-failed | reject-no-repair |
             reviewer-unavailable | insufficient-evidence | e15-breach-unresolved |
             subject-superseded | manually-raised",
  "roundsAttempted": 4,              // 与 gate.round 同口径
  "summary": "…",                    // 结论必须附证据入口（章程上位规则：归因要有对照/实测支撑）
  "findingsDigest": {                // 各轮 findings 聚合（趋势一眼可读）
    "byRound": [ {"round": 1, "total": 7, "blocker": 0, "high": 2, …} ],
    "trend": "converging|flat|diverging"
  },
  "suggestions": [ "…", "…" ],       // 结构化处置建议（非命令；见 5.3 映射）
  "pendingDecisions": [              // 待人工裁决项，显式选项
    "A: 接受当前版本为终态（关闭 gate）",
    "B: 追加 1 轮复核（队长确认后 maxRounds+1 或本轮豁免）",
    "C: 作废被审对象，重新规划（supersede）",
    "D: 改派 reviewer / 轮换成员后重开"
  ],
  "escalatedAt": …
}
```

`suggestions` 按 reason 模板生成，例：`round-limit-exceeded` + trend=flat → 建议「B 或 C，并检查是否规格中途变更（查 pendingInputs）」；`reviewer-unavailable` → 建议「D：轮换/熔断复位后重开，引用 resetBreaker 边界」。模板只是初始值，人工可改——**升级记录可编辑（留痕），gate 状态转移不可**。

### 5.3 升级触发条件（枚举，全部事件驱动）

| reason | 触发 |
|---|---|
| round-limit-exceeded | §4.5 触顶 |
| repair-failed | repair 任务 P1 结算 failed（修复本身失败——不给「无限修复」出口） |
| reject-no-repair | review verdict=reject（§3.5） |
| reviewer-unavailable | waitingReviewer 持续超阈值（建议初值 30min，借 P1 SUSPENDED_UNATTENDED_MS=1800000 同口径，task-store.js:56；需实测） |
| insufficient-evidence | review 结算 failed 且 findings 为空/全程序性（章程 §3.3 拒绝出结论情形的机制化归箱） |
| e15-breach-unresolved | E15 警告产生后跨轮未处置（§4.8） |
| subject-superseded | 被审对象被 supersede 后 gate 未 closed（§4.6 同步处置路径 1；v0.2 · t102 新增） |
| manually-raised | 队长经工具显式升级（含成员「越级上报」消息触发，章程 §8 越级条款） |

### 5.4 升级后的行为

- gate 挂起：不再创建任何任务；被审文件冻结（§4.8）；`team_status` gate 视图置顶显示（投影排序 escalated 在前）。
- 裁决执行（全部显式、全部走既有 P1 API）：A → gate closed（verdict 按最后轮）；B → maxRounds 调整或豁免标记，回 in-review（新建 review 任务）；C → `store.supersede(被审对象)`；D → 处置成员（P2 retire/轮换通道）后回 §4.4 重开。
- 裁决与 pendingInputs 一起结算；升级记录**永不删除**（追加式审计）。

### 5.5 与 P1 状态机的关系

- P1 零新状态、零新迁移：escalated 完全活在 sidecar。理由：P1 状态机 v4.5 经 6 轮对抗复核冻结（t49→t72），为「门挂起」加状态需要重开状态机复核，收益（投影便利）远小于代价；`snapshotRow` 不动的代价由 §6.4 的 `team_status` gate 视图补偿。
- P1 v2 候选（§3.1-3）中 `gateState` 摘要列若收编，投影与调度判定可直读——但那是带版本化声明的独立任务。

---

## 6. API 面（全部向后兼容的扩展）

### 6.1 `team_create_task` 扩展（captain-tools.js:22-38 的 parameters 增补）

| 新参数 | 形态 | 说明 |
|---|---|---|
| `acceptance` | string[] | **补既有缺口**：P1 createTask 早已支持（task-store.js:219），工具未透传（captain-tools.js:87-94 实测） |
| `verify` | string[] | 同上（:220 未透传） |
| `constraints` | string[] | sidecar `contract.constraints` |
| `knownRisks` | string[] | sidecar `contract.knownRisks` |
| `maxRounds` | number | 可选，覆盖团队默认（仅 kind∈{implementation,repair,work} 有意义） |
| `supersedes` | string | 取代语义：创建成功后对目标执行 `store.supersede`（显式传 revision 校验；失败则整体失败——取代不静默） |

**gate 感知校验（v0.2 · t102，create 工具层）**：创建 `kind ∈ {review, repair}` 的任务时，执行器必须先查 quality.json——目标被审对象（sourceTaskId/subject 指向的任务）已存在 open gate 且 `gateState ∈ {in-review, in-repair}` → **拒绝 `gate-busy`**，拒绝载荷附现存任务 id（该 gate 当前 in-review/in-repair 对应的 P1 任务 id，供调用方直接定位）；调用方坚持创建 → 必须显式携带 `supersedes` 参数（走 §4.6 取代路径，同步处置旧 gate）。设计理由：in-review/in-repair 窗口内的 gate 已有活跃任务在承载本轮循环，静默再建同类任务 = t83/t84 双复核事故的机制化重演；把「重复创建」从「靠人眼发现」变为「结构性拒绝」。gateState ∈ {open, needs-revision, escalated, closed} 时不受此校验限制（open=待首轮、needs-revision=等待修复创建属正常循环间隙、escalated=人工已接管、closed=门已关）。

### 6.2 `team_update_task` 扩展（:39-52）

| 新参数 | 形态 | 说明 |
|---|---|---|
| `verdict` | `pass\|needs_revision\|reject` | kind=review 结算 completed 时**必填**（缺失 → `verdict-required` 显式拒绝）；非 review 任务忽略 |
| `findings` | Finding[] | verdict=needs_revision 时**必填**且 requiredFix 校验（§3.3）；verdict=pass 时必须为空（一致性校验） |
| `acceptanceResults` | AcceptanceResult[] | 可选上报；pass 时不得含 failed（§3.4） |
| `output` | string | 结算摘要（现状仅能塞 note 事件日志，升级为 gate 轮记录字段） |

结算流程：P1 `update` CAS 成功 → sidecar 写轮记录 → gate 转移 → （needs_revision 时）§4.3 repair 创建。**CAS 失败则 sidecar 零写入**（先 store 后 sidecar 的顺序保证无「门记录领先于账本」的幻影）。

**sidecar 写失败补偿（v0.2 · t102，设计期定死为契约条款，不再留实现裁量）**：P1 CAS 已成功而 sidecar 写入失败（磁盘满/IO 错/进程将亡）时，执行器必须按序执行：
1. **重试 sidecar 写入，N=3 次**（建议初值，退避重试；N 可配置，§9-G10）；3 次全败 → 放弃 sidecar 写入；
2. 放弃后**二选一补偿**（按失败点自动判定并留痕于工具返回值）：
   - **向 P1 补一次 `update(failed)` + `insufficient-evidence` findings**——本轮结算作废为「证据链不完整」（评审已发生但门记录丢失，按章程 §3.3「证据不可复现不出结论」归箱，防「评审结果只活在内存里」的幽灵 pass/needs_revision）；
   - 或**直接创建 escalation（`manually-raised` 变体，reason 标注 `sidecar-unwritable`）**——适用于补偿 update 本身也不可行（如任务已被并发 superseded）的场景，把现场交给人工。
3. **绝不静默**：任何补偿路径的执行与结果都随工具返回值上抛（`compensation: {taken, detail}` 字段），并可从宿主侧会话事件日志审计——「有计数不等于有出口」（verification-record.md §9.6 教训 4）在门系统的对偶约束。

### 6.3 `team_report_task`（B′ 成员工具）扩展（claim-channel.js:43-58）

- 新可选参数 `verdict / findings / acceptanceResults / output`——与 §6.2 对称；非 review 任务零负担（参数缺省即现状行为）。
- 执行器变化：结算 completed 且 task.kind=review 时把上述字段经与队长工具同一条 sidecar 写入路径落盘（**单一写入函数**，两工具共用，防双实现漂移）。
- 归属校验不变（attemptCache，claim-channel.js:115-118）；E15 比对触发点不变（:136-138）。

### 6.4 查询面：`team_status` 扩展（:66-70/:186-200）

返回值增 `gates` 段：`[{taskId, gateState, round, maxRounds, lastVerdict, escalationDigest?, pendingInputsCount}]`（quality.json 投影；escalated 排序置顶）。明细（findings 全文/轮记录）不进 status（防载荷膨胀，P1 perf 教训 readSurface 200 条封顶同因），按需另设只读查询（实现 Slice 定夺，§9-G7）。

### 6.5 路由面

- 现有 5 条 `/team-tasks/*`（lib/index.js:1802-1917）**零新增**：循环创建走宿主进程内函数（与 captain-tools 同层），不经 HTTP。
- P2 §9.7-3 已登记的 reassign HTTP 路由（唯一新增面）维持其独立待办，不与 P3 绑定。

---

## 7. 与已落地组件的集成点（引用不重造，逐项给锚点）

| 组件 | 集成方式 | 锚点（本稿实测指纹/行号） |
|---|---|---|
| **E15**（review-guard.js `8E0B38103B3C`） | ①每轮 review claim 自动新快照（一次性消费语义恰好匹配多轮）；②升级期冻结扩展（§4.8）；③警告入 findings；④指纹入 P1 v2 遗留承接 | review-guard.js:51-68/:73-97；p2-impl-baseline.md §9.3/§9.7-2 |
| **P2 调度器**（scheduler.js `5530BC7B8363`） | repair/re-review 创建后 `dispatchBatch`（触发源 1 同款）；no-auto-requeue 语义继承（循环永不自动重排） | captain-tools.js:97-103（既有唤醒模式）；scheduler.js:64-107 |
| **成员可用性**（scheduler-core.js `C793138EE4A9`） | review 派发前 `availabilityOf` 检查；`reviewer-unavailable` 升级判定读注册表事实 | scheduler-core.js:84-95；§4.4 |
| **队长工具**（captain-tools.js `C2D0A62D4662`） | §6.1/§6.2/§6.4 扩展；create 后唤醒模式复用 | captain-tools.js:82-104 |
| **B′ 成员工具**（claim-channel.js `9F7E3DD5A282`） | §6.3 扩展；归属/E15 触发点不动 | claim-channel.js:90-140 |
| **P1 store**（task-store.js `9D687A013253`） | verdict→P1 映射（§3.5）；supersedes 复用（:543-564）；依赖纪律（:389/:623-636）；持久化纪律复用（P1 §7） | §3、§4.2 |
| **防双调度**（P2 §9.1.1） | 循环全部动作走 `team_*` 工具与宿主进程内函数；apply 装配纪律不变 | P2 设计稿:420-439 |
| **群聊步骤视图**（可选展示面） | gate 状态变化走既有 session/event 步骤投影展示（escalated 置顶）——展示为增强非依赖（待决策 G2） | README（P2 步骤链 t19/t20 交付）；§9-G2 |

---

## 8. 已验证 / 推测 / 需实测（口径绑定）

**已验证（本稿作者亲自核对，标注方法）**：
- 上游基线指纹：P2 v0.7 = `ED95B4DC3C3F`/78780 B/551 行；P1 v4.5 = `6FBCA6827E25`/60139 B/518 行（方法：Get-FileHash + count-lines.mjs，2026-09-13 同一次测量会话）。
- §0.2 表全部条目（方法：逐文件通读源码 + grep `team-tasks` 定位 5 条路由行号 + 逐节读 P1/P2 设计稿与 p2-impl-baseline.md）。
- 队长工具未透传 acceptance/verify（方法：读 captain-tools.js createCaptainTask 入参构造 :87-94 与 P1 createTask 字段清单 :212-241 对照）。
- 8 条事故全部有账本 output / 仓库文档原文支撑（方法：agent_teams_status 快照 + spill 文件 + verification-record.md §8/§9 + p2-impl-baseline.md §9.8 回读；快照时刻 = 本任务 t100 执行中，任务总数 100）。
- verdict 三值实际使用史（方法：账本 t74/t81/t84/t87=needs_revision、t30/t34=reject、t90=pass 等结算记录抽查）。
- E15「指纹入 store」为已登记遗留（方法：review-guard.js:14-16 + p2-impl-baseline.md §9.7-2 双源一致）。
- **P2 §7.2 H7 原文与行号（v0.2 · t102 取证）**：P2 设计稿:393「review verdict needs_revision → 不自动开 repair……队长决定：create 修复任务（依赖成功的 source，不依赖 failed review）/ supersede / 搁置｜依据 = 账本 t49→t52→t59→t67 四轮循环失控的直接教训」；反面对照清单 :396 含「不自动开修复任务」（方法：直接读 P2 设计稿 §7.2，本修订时点 = t102 执行中；P2 文件未改动，指纹仍 `ED95B4DC3C3F`）。

**推测（显式标注，不可当事实用）**：
- quality.json 体积量级（估算：每轮 findings 全文数 KB、数十轮数十 KB 级——按 t74（6 findings）与 t84 轮记录外推，未实测落盘体积）。
- `reviewer-unavailable` 阈值 30min 的合宜性（借 P1 D8 口径，真实分布未测——P2 §11 推测 2「成员不可用五态分布频率未测」同源）。
- 「正常内容收敛 ≤4 轮」作为默认值的普适性（本会话两条设计线 4/6 轮的归纳，样本=2，标注推测；有 G1 待实测校准）。

**需实测（实现 Slice 前必须落定的用 ⚠ 标出）**：
- ⚠ sidecar 与 P1 结算的崩溃窗口一致性（§3.9 重放逻辑的「能变红」测试设计）。
- ⚠ §6.2 补偿条款（v0.2 已契约化：重试 N=3 → 补 update(failed+insufficient-evidence) 或 escalation）的异常路径验证——「补偿后 P1 与 quality.json 的终态一致性」需构造「sidecar 持续写失败」故障注入（复用 t25 readSurface 永不 resolve 同法），证明补偿真被执行且不静默。
- maxRounds=4 / reviewer 阈值 30min / 补偿重试 N=3（运行期校准项，可带建议值上线观察——P2 E1/E2 同策略）。

**数值口径总表**：

| 数字 | 口径 | 可复现入口 |
|---|---|---|
| P2 v0.7 = ED95B4DC3C3F / 78780 B / 551 行 | 本任务 t100 执行中，2026-09-13 同一次测量 | `Get-FileHash -Algorithm SHA256` + `node C:\Users\bo.yang02\count-lines.mjs "<文件>"` |
| P1 v4.5 = 6FBCA6827E25 / 60139 B / 518 行 | 同上 | 同上 |
| 基线漂移 5 次 | 账本谱系 v0.2/v0.3/t84-v0.5/t96 追加等（任务契约口径，t84-F8 为当场抓获实例） | `agent_teams_status` t84 output + P2 设计稿落盘记录节 |
| stale 重排 6 例 | t30/t49/t52/t59/t67/t68，均 attempt 3（P2 §1 #6 口径，未重扫） | `agent_teams_status` 各任务 output |
| P1 设计线 6 轮 / P2 设计线 4 轮 | 分别 t49→t72、t81→t90 的 review 轮次计数（含作废轮；t88 误派轮计入 P2 线） | `agent_teams_status` 各 review 任务 |
| 任务总数 100（t1-t100） | 本任务 t100 执行中快照 | `agent_teams_status`（持续增长，引用须带时刻——章程规则 2） |

---

## 9. 待决策点（G 表，全部需实测或需用户/队长）

| # | 项 | 建议初值 | 状态 |
|---|---|---|---|
| G1 | `maxRounds` 默认值 | 4（§4.5 历史口径） | 建议初值需实测；可按任务覆盖 |
| G2 | gate 状态是否进群聊步骤视图展示 | 进（escalated 置顶） | 需用户确认（透明度 vs 噪音，P2 E8 同型） |
| G3 | findings 必选性细则 | needs_revision 时必填 + requiredFix 必填（low 可豁免 requiredFix） | 需队长确认 |
| G4 | verdict 是否引入第四值 | **不引入**（§3.5 裁定：blocked 归升级原因） | 需队长复核本裁定 |
| G5 | constraints/knownRisks 入 P1 v2 的时机 | 与 gateState 摘要列、E15 指纹同批（单次 schema 版本化，避免多次迁移） | 需队长排期 |
| G6 | 「能变红」对照是否强制为 verify 模板字段 | 不强制、模板提示 | 需队长确认 |
| G7 | quality 明细查询面（独立工具 vs status 参数） | 独立只读查询（防 status 载荷膨胀） | 实现 Slice 定夺 |
| G8 | 自动 repair 默认开 or 关 | **开**，但仅指「新任务创建」（§4.1 三动作）；对 attempt 的自动重试仍绝对禁止（P2 §1 #9 不松动） | 需用户确认（与 P2 自动化边界的关系见下方辨析） |
| G9 | **P2 H7 行的独立修订任务**（v0.2 · t102 登记）：修订 P2 设计稿:393 H7 行 + :396 反面对照清单行，标注「被 P3 §4.1 取代，适用范围收窄为 gate 框架外」 | 由队长单独派单承载（P2 文件不在 P3 任何任务 in-scope） | **前置待办**：P3 实现 Slice 前必须完成，否则 P2 文本与 P3 取代声明并存期过长 |
| G10 | §6.2 补偿重试次数 N | 3（退避重试） | 建议初值需实测（v0.2 · t102 随补偿契约化新增） |

> **G8 张力辨析（必须写清，防设计自相矛盾）**：P2 §1 #9 约束「自动重试/重排/重派默认关闭」针对的是**对失败任务同一 attempt 的自动重排**（t30 attempt 3 误派型——重排风暴的根源）与「对 suspended/quota 的自动修复出口」。P3 循环创建的是**新任务**（新 id、新 CAS 生命周期、依赖成功源、findings 附带、轮数上限兜底），失败模式与重排风暴不同构；且 P2 #9 要求的人工裁决由升级裁定（§5）承接。两者并存不冲突。
>
> **H7 维度（v0.2 · t102 补全）**：P2 §7.2 H7「不自动开 repair」是比 §1 #9 更直接的裁决冲突——P3 §4.1 第一动作就是自动创建 repair。处理方式 = **显式取代而非回避**（§4.1 取代声明）：H7 的立规依据（t49→t52→t59→t67 循环失控）在 P3 框架下被四重安全阀逐一对冲（触顶升级 ↔ 无限循环；repair-failed 升级 ↔ 无限修复；去重 ↔ 重复任务；可用性前置 ↔ 误派），H7 的队长裁决权由升级出口（§5.4）承接而非剥夺。P2 文本修订由 G9 独立任务承载，冻结纪律不受破坏。

---

## 10. 事故映射完备性自查（对照任务契约）

| 契约要求 | 本稿落点 |
|---|---|
| escalated 卡死 → 结构化升级 | §1 #1 → §5 全节 |
| 基线漂移 ×5 → E15 + 升级期冻结 | §1 #2 → §4.8、§5.4 |
| 复核者规格中途到达 → 输入排队 | §1 #3 → §4.7 |
| 重复任务 → 去重/取代 | §1 #4 → §4.6、§6.1 supersedes |
| stale 重排风暴 | §1 #5 → §4.1（零自动重排） |
| 成员不可用 | §1 #6 → §4.4、§5.3 |
| t6 僵尸依赖（自加） | §1 #7 → §4.2（依赖只指成功源） |
| 双调度风险 | §1 #8 → §7（team_* 工具面）+ §9-G8 辨析 |
| 契约四件套 schema（字段/必选性/兼容方式+证据） | §3.1（选型）+ §3.2（字段表） |
| findings/acceptanceResults/verdict/sourceTaskId/sourceFindingIds/round | §3.3-§3.7 |
| 循环语义（needs_revision→repair→re-review→上限→升级） | §4.1-§4.5 + §5 |
| 与 E15/P2 调度器/队长工具/成员工具集成 | §7（逐项锚点） |
| 已验证/推测/需实测 + 不确定性标注 + 待决策点 | §8 + §9 |
| 只改设计稿 + README 索引行；不改源码；不 push | 本任务交付纪律（改动面见 §11 与任务结算 changedPaths） |
| **（t102 · repair-round-2）H7 显式取代声明 + P2 修订独立承载** | §4.1 取代声明框 + §9-G9 |
| **（t102）create 工具层 gate 感知校验（gate-busy）** | §6.1 校验段 |
| **（t102）supersede 执行路径 gate 同步处置（subject-superseded）** | §4.6 末条 + §5.2 枚举 + §5.3 表 |
| **（t102）sidecar 写失败补偿契约化（N=3 → 补 update 或 escalation）** | §6.2 补偿条款 + §8 需实测收窄 + §9-G10 |

自查结论：契约验收列出的全部要点均有对应章节；无「要注意」式未落地点。

---

## 11. 交付指纹（同一次测量；本表最后写，写完即冻结基线）

> 方法：`Get-FileHash -Algorithm SHA256`（前 12 位）+ `node C:\Users\bo.yang02\count-lines.mjs`（章程规则 5 权威行数口径），两文件同一次 pwsh 会话测量。

**基线演进链**：
- v0.1（t100 交付）= `1151996B48A9` / 46755 B / 476 行——已被本修订取代。
- **v0.2（t102 · repair-round-2，当前）**：指纹见任务结算 output 与 README 索引行；本次改动 = 头部版本头 + §4.1 取代声明 + §4.6 末条 + §5.2/§5.3 reason 枚举 + §6.1 gate 感知校验 + §6.2 补偿条款 + §8 两处 + §9-G9/G10 与 H7 辨析 + §10 四行 + 本节；**其余章节字节不变**。

（本稿冻结后任何修改由新任务承载并在此登记新指纹与前版差异。）

---

> 维护：researcher4 · 2026-09-13 · t100（v0.1）→ t102（v0.2 · repair-round-2）· 待复核。
