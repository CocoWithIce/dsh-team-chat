# P2 调度器 + 队长工具面自研设计稿（v0.8 · H7 行修订：「不自动开 repair」→ 自动 repair + 安全阀（P3 F-A 取代声明互引，t104 承载），待复核）

> **任务**：t79。上游 = P1 状态层（已实现并两轮独立核验 pass）。
> **状态**：**待对抗复核**。照 P1 模式：设计 → 对抗复核 → 冻结 → 实现。全部结论标注「已验证 / 推测 / 需实测」。
> **范围**：自研调度器（谁派发/成员可用性/生命周期）、队长工具面最小集、routingText 解耦、过渡共存、待决策点。
> **基线**：P1 契约 = `detach-p1-state-design.md` **v4.5**（指纹自行复核见 §0.2）。本文引用 P1 事实全部经本稿作者独立核对，非转抄。

---

## 0. 阅读指南（本稿可独立阅读）

### 0.1 背景与术语

dsh-team-chat 是一个 DSH 宿主/客户端插件，当前依赖 AgentTeams 插件完成「团队组建、成员创建、任务调度」。P1 已自研**状态层**（任务 schema/状态机/依赖失效/持久化），但不负责「任务如何到达成员」。P2 自研**调度器 + 队长工具面**，完成后即具备脱离 AgentTeams 的运行能力（P4 执行移除）。

| 术语 | 含义 |
|---|---|
| **调度器** | P2 新增的宿主侧模块，唯一职责：决定「何时向哪个成员发唤醒」。不分配任务、不开回合。 |
| **唤醒（wake）** | 向成员会话发送一条消息使其开始新回合（平台事实：子代理 idle 后不会自驱醒来，必须被消息唤醒——见 §2.2 论证）。 |
| **认领（claim）** | 成员回合内调用 `POST /team-tasks/claim` 把 pending 任务抢占为 claimed（P1 原语，CAS）。 |
| **成员注册表** | P2 新增的成员元数据（状态/代数/路由），与 P1 任务 store 同文件持久化（§8）。 |
| **成员代数（generation）** | 同一角色的第 N 个实例。轮换 = 代数 +1 + 新名字（本会话实证做法，§4.3）。 |

### 0.2 P1 已落地事实（本稿作者逐项独立核对，非转抄任务描述）

**契约文本指纹（2026-09-12 本回合实测，方法：`node C:\Users\bo.yang02\count-lines.mjs` + `Get-FileHash -Algorithm SHA256`，同一次测量）**：
`detach-p1-state-design.md` v4.5 = SHA256 前 12 位 **`6FBCA6827E25`** / **60139 B** / **518 行**（LF 517, CR 0）。

| P1 事实 | 本稿核对结果 | 来源（file:line，本回合实读） |
|---|---|---|
| 状态层路由 = **5 条 POST** `/team-tasks/*` | ✅ create :1802 / claim :1833 / update :1860 / release :1890 / supersede :1917；**`reassign` 无 HTTP 路由**（store 层已有方法，UI 属 P2+） | `lib/index.js:1794-1948`（注释 :1797-1798 明示 reassign UI 属 P2+） |
| 持久化 `$DSH_HOME/dsh-team-chat/<teamId>/team.json` | ✅ 落盘分级：迁移同步 / observeActivity 聚合 ≤500ms；rename 原子 | P1 v4.5 §7（t77 重写 + t78 核验 pass） |
| CAS / attemptId / 带戳继续 / suspended 三出口 | ✅ `TERMINAL=['completed','failed','superseded']`；claim=CAS(pending→claimed)；`runRoutine` = reclaim+stallMark+checkUnattended | `lib/state/task-store.js:47-56,440-495,647-683` |
| 30s 例程 | ✅ `runStateRoutine` 内部例程驱动 stallMark/reclaim/checkUnattended | `lib/index.js:1794-1798` 注释 + P1 §7 |
| store 公开面 | ✅ 14 方法：createTask/claim/update/observeActivity/release/canReclaim/reclaim/stallMark/suspend/resume/reassign/supersede/checkUnattended/runRoutine（+save/load/snapshotRow 等投影） | `lib/state/task-store.js:185-721`（grep 核对方法签名） |

⚠️ **口径更正**：本任务派单描述称「5 条路由」未列明细；此前入职消息曾把 `/state` 与 `reassign` 混入「6 个 API」——以本表为准：**`GET /state`（投影）+ 5 条 `/team-tasks/*` POST**，`reassign` 是 **store 方法已有、HTTP 路由未接线**（P2 要补的正是这条路由，见 §6.2）。

### 0.3 设计原则（承 P1，全部由事故反推）

1. **干净重来**：不迁移 AgentTeams 任务语义；自建成员 label 前缀 `dsh-team-chat:`；不读 `.agent-teams/`（t22 硬约束）。
2. **调度三解耦**：任务分配（P1 claim 原语）≠ 回合驱动（成员自循环）≠ 成员可用性（P2 注册表）。AgentTeams 的全部调度缺陷源于三者绑死（§2.1 论证）。
3. **自动化最小化**：凡 AgentTeams 因「自动」而出过事故的机制（自动重排、自动投喂、自动修复循环），P2 一律默认关闭或降级为「检测自动 + 动作人工」（§7）。
4. **复用不另造**：attempt/CAS/superseded 链/suspended 三出口/30s 例程全部复用 P1；P2 不新增任何并行状态机制。
5. **同角色多开：支持（v0.5 · F7）**——条件 = 实例独立注册（每实例一条 MemberRecord）+ 命名规范（F7.1，轮换代与并发实例语义分离）+ 「无在途」硬规则 per-instance 沿用（同角色 k 实例 = 至多 k 并发任务）。展开见 §4.5。

---

## 1. 设计输入：真实事故 → 设计约束（逐条映射表）

> 九条全部来自本团队账本（`agent_teams_status` 快照可回溯）与本会话实证。证据列给出账本任务号与 output 原文摘录；「落点」列给出本稿章节。**每条都落到具体机制，不接受「要注意」式泛化。**

| # | 事故 | 证据（账本 output 摘录，快照时刻见 §11 口径） | 设计约束（硬性） | 落点 |
|---|---|---|---|---|
| 1 | **t6 取消依赖死锁** | t6 output：「依赖中含已作废任务，**永久无法认领**（僵尸）」 | `terminal = completed\|failed\|superseded` 全解锁；superseded/failed 带戳继续不阻塞下游 | P1 已实现（task-store.js:47 TERMINAL + :599 戳传播）。**P2 约束：不新增任何「failed 堵下游」路径** |
| 2 | **t5 孤儿 claim** | t5 output：成员发 client 端 Inspect「无超时挂起 15 分钟以上…回合被中止、任务残留 claimed 形成孤儿态」 | claim 与回合驱动解耦（claim 只是状态写，不是回合开工）；claimed 残留由宿主独立观测的 reclaim 谓词兜底 | P1 canReclaim 已实现；P2 例程驱动它（§3.4） |
| 3 | **t8 孤儿 claim（同型第二次）** | t8 output：「Event.listEvents(platform=client)…挂起近 16 分钟…残留 claimed」 | 同上；且同类事故两次 ⇒ 兜底必须**自动周期运行**，不能靠人工发现 | P1 runRoutine 已实现；P2 绑定 30s 例程（§3.4） |
| 4 | **S7B 双所有者** | P1 §2.1/§4（t49 对抗复核发现；t5/t8 单方孤儿已实锤，双执行未见实例——发生率推测） | reclaim 仅限 claimed；running 残留走 stall→suspended；中断不可确认不回收 | P1 已实现已核验（t76/t78）。**P2 约束：调度器永不自动 reclaim running 任务**（§3.4） |
| 5 | **S13 并发双认领** | P1 §6 S13（t66 修复；t76 复核 11/11 反例构造确认） | claim = 宿主 CAS(pending→claimed)，第二个请求不生成 attemptId | P1 已实现。**P2 约束：多成员并发唤醒场景直接继承该保证，调度器不引入第二套分配逻辑**（§2.3） |
| 6 | **移除成员触发 failed 任务重排队列风暴** | t30 output：「本 attempt 3 是**移除旧 reviewer 后被误重排的陈旧条目**」；t49/t52/t59/t67/t68 同型（共 **6 个账本实例**，均 attempt 3） | ①成员移除与任务处置**解耦**：移除前置条件 = 该成员全部非 terminal 任务已显式处置（reassign/supersede，人工逐个确认）；②**不存在任何「移除成员→自动重排其任务」机制**；③已 terminal 的任务永不复活 | §4.2 轮换/移除流程（新增） |
| 7 | **配额耗尽成员仍被投喂（失败风暴）** | t59/t67/t68 output 均载「**被调度器误派给配额耗尽成员**」；账本可见 attempt 1→2→3 连续失败链 | ①成员可用性状态机参与调度：quota-exhausted/unresponsive → **停止唤醒**；②熔断 = 宿主可观测信号（连续失败计数），不依赖单一错误码；③恢复必须人工确认 | §3.2 成员可用性状态机（新增） |
| 8 | **上下文耗尽需轮换（成员生命周期）** | 旧 reviewer/researcher 配额或上下文耗尽 → 轮换为 reviewer2/researcher2，**fresh-instance 后正常工作（本会话实证，含本稿作者本人）**；t46 已验证「改配置必须销毁重建（重新 startContinuable）才生效」（members.js:504-522 装配只在 spawn 时） | 轮换 = 人工触发的三步流程（处置任务 → 标记 removed → spawn 新代）；新代**新名字**；旧代不复活 | §4.3 轮换流程（新增） |
| 9 | **自动修复循环不可靠** | t49→t52→t59→t67 四轮 review 反复 needs_revision，与重排队列风暴交织（t49/t52 attempt 3 被误派），最终由人工逐个作废 + 轮换成员收场（账本各 output 的【队长作废】记录） | ①自动重试/重排/重派**默认关闭**：failed 是 terminal，修复走显式新任务（P1 质量门语义：repair 依赖成功的 source，不依赖 failed review）；②suspended/quota-exhausted/unresponsive **必须人工裁决**，无自动修复出口；③队长介入点显式列出（§7.2） | §7 人工介入点（新增） |

**映射完备性自查**：派单验收列出的 8 项事故（t6 / t5 / t8 / S7B / S13 / 重排队列 / 配额投喂 / 轮换 / 自动修复循环）全部覆盖于上表 #1-#9（t5 与 t8 分列为 #2/#3，合计 9 行）。其中 #1-#5 由 P1 已实现机制承接（本稿只声明「复用 + 不破坏」），#6-#9 是 P2 新增设计的直接动因。

---

## 2. 调度模型：宿主管唤醒（push），成员管认领（pull）

### 2.1 裁决：为什么不是纯推、也不是纯认领

**AgentTeams 现状（推式绑死的缺陷实证）**：其调度器把「选任务」「选成员」「开回合」绑成单个自动动作——`scheduler.js:276` `beginTaskAttempt`（P1 §10 Q1 已核验：claim = 调度即分配回合）。三重后果全部在本会话实证：

1. **claim 即回合开工** → 成员首个动作就可能挂死（t5/t8 的 client Inspect 15+ 分钟）→ 回合中止后任务残留 claimed（孤儿）；
2. **不感知成员可用性** → 向配额耗尽成员持续 beginTaskAttempt → 失败风暴（t59/t67/t68）；
3. **ready 判定与真实状态脱节 + 成员移除联动重排** → 已取消/已闭环任务被重复投递（t30/t49/t52/t59/t67/t68 六例）。

**纯认领为何不可行（平台结构约束）**：子代理回合结束后进入 idle，**不会自驱醒来**——必须收到消息才开始新回合（方向性证据见 §11：唤醒与回合开启高度相关；具体比例因口径未定义已降级，v0.4）。若无人发消息，成员永远 idle，任务池永远无人认领。⇒ 某种形式的 push 是**平台结构必需**，无法回避。

**P2 裁决：混合，但把两件事拆给两个主体**：

| 职责 | 主体 | 机制 | 失败模式隔离 |
|---|---|---|---|
| **让成员醒来** | 宿主调度器 | 唤醒消息（**不携带任务 id、不指定行为**） | 成员不可用 → 唤醒失败/无响应 → 只影响这一次通知，任务状态零污染 |
| **醒来后干什么** | 成员自身循环 | GET /state → 过滤可认领任务 → claim（CAS）→ 干活 → update → 循环至池空 | 任务分配正确性由 P1 CAS 保证（S13），与唤醒并发无关 |

**与 AgentTeams 的本质差异**：AgentTeams 的唤醒 = 「你去开任务 X 的回合」（任务语义内嵌）；P2 的唤醒 = 「池子里可能有你的活，去看」（池语义）。由此结构性消除：

- **投喂风暴不可能**：唤醒前置检查池中确有该成员可认领的任务（§2.3）；成员不可用时停止唤醒（§3.2）——即使误判可用，后果也只是「一次无响应唤醒」，不是「失败风暴」（无任务语义可失败）。
- **孤儿快速收敛**：成员挂死 → 任务残留 claimed → 30s 例程 runRoutine 按宿主独立观测 reclaim 回 pending（P1 §4.2），下次池检查重新可派。
- **误重排不可能**：调度器无「重排」概念——它只对 `taskOpen`（pending && 依赖全 terminal）的任务发唤醒；terminal 任务永远不出现在池视图（§3.3 池投影定义）。

### 2.2 成员回合内工作循环（executionPrompt 注入，照 routingText 模式）

```
被唤醒 →
  1. GET /state（含任务投影 snapshotRow）
  2. 过滤：status=pending && 依赖全 terminal && (assignee==我 || assignee==null)
  3. 有 → POST /team-tasks/claim（带 claimedById）→ 成功则执行任务
        → POST /team-tasks/update(running) → …干活… → update(completed|failed)
        → 回到步骤 1（同回合可连续认领多个任务，直到池空）
  4. 无 → 回复「池空空闲」→ 回合结束（回到 idle，等待下次唤醒）
```

- claim 失败（`task-not-claimable` / `dependency-blocked` / `task-terminal`）→ **不重试、不换任务报错**，直接回到步骤 1 重新过滤（CAS 失败 = 别人抢走了或状态已变，重读即可）。
- 该循环写进自建成员的 executionPrompt（由 routingText 的 dsh-team-chat 适配层渲染，§6.4）。

### 2.3 唤醒决策与并发窗口（诚实标注）

**唤醒触发源（三个，全部宿主侧）**：
1. 任务池变化：create / reclaim / release / reassign 成功后（reclaim/release 来自 30s 例程）；
2. 成员回合结束信号（agent/status → idle）；
3. 30s 例程兜底（与 runStateRoutine 同拍，防事件丢失）。

**唤醒前置条件（全部满足才发）**：
- 池投影中存在该成员可认领的任务（§3.3 定义）；
- 该成员注册表状态 = `active`（§3.2）；
- 该成员（实例）**无在途任务**（其名下无 claimed/running 任务——「一人一活」per-instance，本团队章程 §5.2 实践，P2 升格为调度器硬规则；同角色 k 实例 = 至多 k 并发任务，§4.5）。

**实例选择策略（v0.5 · F7.2 升格为必需，不再是可选缓解）**：同角色存在 k≥2 个实例时，**默认策略 = 单实例唤醒**——每角色每拍至多唤醒 1 个实例，杜绝「全部唤醒 → k-1 空转」：
- 定向任务：唤醒 assignee 匹配且满足前置条件的**最闲实例**（同分取 lastResponseAt 最早）；
- 池任务：在 active 且无在途的实例中按「无在途 → 最少 `consecutiveFailures` → `lastResponseAt` 最早」选**一名**唤醒；
- 备选策略（轮询 / 按 route 健康度加权）留 E 表（E9 改写）不实现，除非单实例唤醒实测成为吞吐瓶颈。

**并发窗口（如实声明，不掩盖；v0.5 按单实例唤醒口径重估）**：单实例唤醒下**同角色并发唤醒窗口消失**（每角色同时至多 1 个唤醒在飞）；残余窗口仅存在于**跨角色**（一个新任务同时可由不同角色的实例认领，如 unassigned 池任务对 researcher/engineer 同时可见）。窗口内一人 claim 成功、另一人空转一次回合。CAS 保证**不双认领**（正确性无损）；空转成本 = 一次「池空空闲」回合。**发生率与角色数、任务可见宽度相关，未测——推测**（E9 跟踪）。

### 2.4 定向任务与池任务

- `create` 时带 `assignee` → 定向任务：仅该成员视图可见（§2.2 步骤 2 过滤）。成员不可用 → 任务**停在 pending 等待**，**不自动改派**（防重排队列教训；改派 = 队长显式 reassign，§7.2）。
- `assignee` 为空 → 池任务：任何 active 成员可认领，先到先得（CAS 裁决）。
- 队长在 create 请求中的 assignee 只是「意图标注」；真正的归属写发生在 claim（宿主注入 claimedById/assignee，P1 t75-F4）。两处 assignee 语义不同名同——**保留 P1 字段名**（不另造），差异在 §11 汇总表注明。

---

## 3. 成员可用性：注册表 + 状态机 + 熔断

### 3.1 成员记录 schema（新增，与任务 store 同文件持久化，§8）

```jsonc
MemberRecord {
  "name": "researcher2",            // 全局唯一（命名规范见 §4.3：轮换代 <role><gen> / 并发 <role>-i<idx>，可组合）
  "role": "研究员",
  "generation": 2,                  // 同角色轮换代数（rotated 实例 +1；权威语义见 instanceKind，§4.5）
  "instanceKind": "primary",        // v0.6 合入（F7.1，定义见 §4.5）：'primary'|'rotated'|'concurrent'
  "instanceIndex": 1,               // v0.6 合入（F7.1）：同角色内序号（rotated=代数，与 generation 对齐；concurrent=多开编号）
  "concurrentGroup": "researcher",  // v0.6 合入（F7.1）：= role 名；同组共享实例选择策略（§2.3）与全实例熔断判定（§4.4）
  "label": "dsh-team-chat:trio:researcher2",  // 自建成员标签（前缀见 §6.4）
  "route": { "provider": "", "model": "", "reasoningEffort": "" },
  "status": "active",               // 见 §3.2 状态机；v0.4 新增 standby（spawned 未交接，§4.3）
  "lastWakeAt": null,               // 宿主最近一次唤醒时刻
  "lastResponseAt": null,           // 宿主最近观测到该成员活动时刻（复用 P1 信号源）
  "consecutiveFailures": 0,         // 熔断计数：连续 attempt failed 次数
  "sessionId": null,                // startContinuable 返回的会话 id（§4.1）
  "removedAt": null                 // 非 null = 已移除（记录保留，不物理删除）
}
```

### 3.2 可用性状态机

```
                    ┌─────────── 人工 resume（确认可用）──────────┐
                    ▼                                            │
  active ──┬─ 连续 N 次唤醒无响应（E1 超时）──► unresponsive ──────┤
           ├─ attempt 连续 M 次 failed（E2 阈值）─► degraded ──────┤
           ├─ 观测到配额信号（429，若可观测，E3）─► quota-exhausted ┤
           ├─ 成员侧报告上下文耗尽 ──────────► context-exhausted ───┤
           ├─ 人工暂停 ─────────────────────► paused ──────────────┤
           └─ 无 live agent（get(id)===undefined）─► offline ───────┘
                                                        │
   offline ── roster 例程发现 fresh spawn 完成 ──► active（唯一自动恢复边）
   standby ── 交接完成（新 attemptId 已送达，§4.3 第 3 步）──► active（v0.4 新增）
   （standby = spawned 未交接完成：不接池唤醒、不接定向唤醒，防新代在交接窗口抢走与移交无关的任务）
   removed：终态，不参与调度（§4.2）

  unresponsive / degraded / quota-exhausted / context-exhausted / paused
  → 调度器一律停止唤醒（同一行为，原因不同仅供人工裁决参考）
```

**设计要点**：
- 五种不可用态**对调度器的效果完全一致**（停止唤醒）——调度器不解释原因，只执行布尔判定。原因区分仅供人工裁决（§7.2 的恢复动作不同：配额耗尽等重置 / 上下文耗尽走轮换 / unresponsive 先查死因）。
- **唯一自动恢复边 = offline → active**（roster 例程发现成员重新存在时）。其余恢复全部人工——因为「成员真的恢复了吗」（配额重置？上下文清空了？）宿主**无法可靠判定**，误判恢复 = 重演投喂风暴（事故 #7）。这是事故 #9「自动修复循环不可靠」在成员维度的直接落实。

### 3.3 任务池投影（调度器视图，纯派生不落盘）

```
pool(t) := store.taskOpen(t.id)                      // pending && 依赖全 terminal（P1 :633）
        && (t.assignee === null || registry[t.assignee]?.status === 'active')
visibleBy(m) := { t ∈ pool | t.assignee === null || t.assignee === m }
```

- terminal / suspended / stalled 任务**不出现在池中**（suspended 有 P1 三出口管，不归调度器）。
- assignee 指向不存在/已 removed 成员的 pending 任务 → 不入任何视图，但 `GET /state` 投影标注 `assignee-orphan`，供队长处置（reassign 或 supersede）——**不自动改派**。

### 3.4 与 P1 例程的对接（30s 一拍，两件事）

| 拍内动作 | 执行者 | 说明 |
|---|---|---|
| `runRoutine(observe)` | P1 store（已有） | reclaim claimed 残留 / stallMark running 残留 / checkUnattended 自动 superseded——语义零改动 |
| 池检查 + 唤醒 | **P2 调度器（新增）** | 对每个 active 且无在途任务的成员：`visibleBy(m)` 非空 → 发唤醒 |

- **调度器永不调用 reclaim**（它不回收任务，只消费 reclaim 的结果——池子变了的信号）；永不触碰 running/suspended 任务。事故 #4（S7B）的「不自动回收在跑任务」由 P1 结构保证 + P2 不新增路径双重成立。
- 观测函数 `observe`（observeIdle/lastSignalAtOf）沿用 P1 Slice 2 已实现的信号链路（turn/start 探针 memberTurnOpen，t77/t78 已核验），P2 零改动复用。

---

## 4. 成员生命周期：spawn / 轮换 / 移除

### 4.1 spawn（创建自建成员）

- **创建路径（v0.2 按 t80 取证更新）**：现状链路 = 设置页编辑 `settings.teams` 模板（client.js:1826/:2247 → index.js:1712）→ routingText 渲染建队指令 → captain 调 `agent_teams_add_member` → AgentTeams 内部（tools.js → members.js:485 spawnMember → :504 startContinuable）。**创建动作 100% 发生在 AgentTeams 内部**，本插件唯一参与 = 写配置 + 写指令。t46 已验证**装配只在 spawn 时**（members.js:504-522, continuation.js:299；AgentTeams 内部行号为 t80/t46 转引，两任务独立取证一致）。
  ⇒ **P2 必须开辟新创建通道**（本设计第一块拼图）：`subagents` 已在宿主注入清单（lib/index.js:174，DSH 平台服务非 AgentTeams）⇒ **自建通道两条候选（v0.3 按 engineer2 移交细化）**：**(a) 宿主路由直接调 `ctx.subagents.startContinuable`**（架构改动小、指令面零依赖——本稿倾向）；**(b) captain 新指令间接调**（保留「经 agent 指令」形态，但 reintroduces 行为面依赖）。候选 (a) 下 memberPrompt 渲染逻辑（shared.js:320-337）**原样复用**，仅注入者从 AgentTeams persona 参数换成 startContinuable 的 persona/agentOptions 参数——**具体字段名需实现时对 AgentTeams members.js:504-522 传参取样**（t46 已实测过该链）。label 打 `dsh-team-chat:` 前缀。⚠️ **候选 (a) 直调的签名与可达性 = 需实测**（E4；链路两端已被 t46/t80 分别证实，唯「我方直调」这一步未跑通，实现 Slice 前必须实测）。
- **persona 组成**：executionPrompt = routingText dsh-team-chat 适配层渲染的成员块（角色人格 + §2.2 工作循环 + 章程人格句），与现有 `memberPrompt()`（shared.js:320-337）同构。
- **注册**：spawn 成功 → 写 MemberRecord（status=active, generation=1）→ 同步落盘（迁移级）。
- 失败处理：spawn 失败 → MemberRecord 不落盘（或标 `spawn-failed` 待清理），重试由人工发起——**不自动重试 spawn**（事故 #9 原则）。

### 4.2 移除成员（remove）——结构性排除重排队列风暴（事故 #6 的直接反制）

**AgentTeams 缺陷机制**：remove_member 联动「该成员 failed 任务重新入池」→ 已闭环/已取消的陈旧任务被重复投递（账本 6 实例，见 §1 #6）。

**P2 规则（三条，全部硬性）**：
1. **移除是纯注册表动作**：`removedAt` 置时间戳，status=removed；不触碰任何任务记录。
2. **移除前置条件（调度器强制）**：该成员名下不得有非 terminal 任务。即移除前必须逐个显式处置：claimed/running → `reassign`（换人）或 `supersede`（作废）；suspended → 三出口人工裁决（P1 §5）。条件不满足 → 拒绝移除，返回待处置任务清单。
   - 由此，**「移除成员时任务的去向」问题在结构上不存在**——移除时任务已全部归属清晰。
3. **terminal 任务永不复活**：池投影只含 pending（§3.3）；移除动作对 completed/failed/superseded 记录零操作。AgentTeams 那种「failed 重排」在 P2 **没有可执行的代码路径**。

**与 checkUnattended 的交互（t81 round 1 finding · v0.4 按验收选项 (a) 如实重写；v0.3 的「流程顺序规避/零改动关闭」表述被复核否正，此处修正）**：suspended 任务在人工裁决期间受 `SUSPENDED_UNATTENDED_MS`（30min 建议值，D8）硬约束——**超时即被 checkUnattended 自动 superseded，轮换/移除的流程顺序不能豁免这个时限**。三选一裁决 = **选 (a)**：
- **suspended 处置优先走快速路径（全部 P1 既有原语，零 P1 改动）**：**reassign 单步即达**——`reassign(suspended→claimed)` 是合法迁移（task-store.js:525-527 三态入参），`_cas` 成功写刷新 `updatedAt`（:173）且 status 不再是 suspended → `checkUnattended` 的 `status==='suspended'` 过滤直接跳过（:650-651）。轮换流程对 suspended 任务的默认动作 = 直接 `reassign(to=新代)`，不经过 resume。**resume(suspended→running)** 同样刷新 updatedAt 且 running 不受 unattended 影响——仅用于「误挂起、原成员继续」的恢复场景（P1 §5 出口①）。
- **30min 时限标注为硬约束**：人工裁决若超 30min，任务被自动 superseded——这本身是 P1 的安全网（「永远挂着不可达」，P1 §5 证伪），不是缺陷；被自动作废的任务下游照常解锁（P1 §3 带戳继续）。
- **回退路径**：轮换流程发现目标任务已被 30min 安全网自动 superseded 时，改走「新代 create 新任务 + supersededBy 链」（§6.3 模式），不重排旧任务（事故 #6 约束）。
- **不选 (b)**（P1 为轮换中成员加 unattended 豁免/延长机制）：需 P1 契约版本化 + 重跑受影响核验，而快速路径已实际消除「裁决中被自动作废」的场景——豁免机制无必要成本。**不选 (c)**（降格为已知残余风险）：快速路径关闭缺口后无残余可降格。

### 4.3 轮换成员（rotate）——上下文耗尽的标准处置（事故 #8）

**fresh-instance 模式已验证有效**：本会话 reviewer→reviewer2、researcher→researcher2 两次轮换后均正常工作（本稿作者即轮换产物）；t46 已验证旧实例无法热更新配置——**轮换本来就是唯一正确的更新方式**，不是权宜。

**轮换流程（人工触发，四步，顺序强制 · v0.4 按复核验收改定）**：
1. **spawn 新代（不入池待命）**：spawn 新成员，名字 = 角色名 + 代数后缀（researcher → researcher2 → researcher3…），generation+1，新 session 全新上下文；MemberRecord 置 **`standby`**（§3.2 v0.4 新增）——调度器不唤醒 standby 成员（池唤醒与定向唤醒都不发），防止新代在交接窗口抢走与移交无关的任务。**standby 新代的 reclaim 窗口已被保守未知态封死（v0.7 · t89 合入）**：reclaim 判定对非 claimed 状态一律落 **false**——成员状态读取为未知（`status===undefined`）时亦不回收（§3.2 未知态语义），交接前新代不存在任何可回收/可派活路径；结构性安全，不依赖时序。spawn 失败 → 中止轮换（旧代未动，零损失）。
2. **reassign(to=新名)**：旧成员名下非 terminal 任务逐个 reassign（新 attemptId，attempt+1；claimed/running/suspended 三态入参，task-store.js:525-527；suspended 的 30min 硬约束见 §4.2 快速路径）。**旧成员无需响应**——reassign 是 store 层 CAS 操作。
3. **宿主把新 attemptId 送达新代（交接语义 · v0.4 补齐）**：双通道，无需专用端点——**主通道 = wake 消息附带**（wake(member, { tasks: [{taskId, attemptId}] })，复用 §6.2 工具 3 的元数据字段，唤醒即交接）；**兜底 = 成员自查**（`GET /state` 任务投影的 snapshotRow 已含 attemptId，task-store.js:699——成员回合内按 assignee==自己过滤即可读出，§2.2 循环步骤 1 天然覆盖）。两通道任一可达即完成交接。
4. **新代转 active + 旧代 removed**：交接确认后 standby→active（§3.2）；旧代 MemberRecord 标 removed（记录保留——账本/审计不丢）。此时旧代名下无非 terminal 任务（§4.2 移除前置条件天然满足）。

上下文交接 = 章程 + 账本 + 设计稿（文档化知识），**不迁移会话上下文**（fresh-instance 的本意）。

**为什么新名不同名**（本会话实践，标注为「已验证可工作、规范化待确认 E6」）：同名会让旧 attempt 记录、账本历史与新实例混淆；新名使 `claimedById`/`assignee` 全程无歧义，且 reassign(to=新名) 天然表达「移交」语义。

**轮换代 ≠ 并发实例（v0.5 · F7.1 声明，命名与身份规范落位）**：本节「轮换」与 §4.5「多开」是两种正交的实例来源，MemberRecord 以结构化字段区分（字段定义见 §4.5；`instanceKind: 'primary'|'rotated'|'concurrent'` + `instanceIndex` + `concurrentGroup`）：
- **轮换代**：接替已停用实例（上下文耗尽等），命名 `<role><gen>`（researcher → researcher2 → researcher3…，本会话已验证实践）；`instanceKind='rotated'`；
- **并发实例**：同角色并行扩容（§4.5），命名 `<role>-i<idx>`（engineer-i1 / engineer-i2）；`instanceKind='concurrent'`；
- **可组合**：轮换后的多开实例 = `engineer2-i2`（rotated 组内的第 2 个并发实例）——命名即语义，无碰撞（`-i<idx>` 连字符格式与纯数字代数后缀可区分）；
- 全部形态合法于 `MEMBER_NAME_PATTERN`（shared.js:31，`/^[a-z0-9][a-z0-9_-]{0,40}$/`：数字后缀与 `-i` 连字符均允许——本稿已核对 pattern）。
- 调度语义差异：轮换走本节四步流程（含任务处置与 removed）；**多开不触发任何任务处置/removed**——就是 spawn 一个 `concurrent` 实例入注册表（§4.5）。

### 4.4 配额处置层级（v0.5 · F7.3 改写：熔断 per-instance，轮换降为兜底）

- **第一层（默认）——熔断该实例**：单实例 quota-exhausted → 按 §3.2 熔断（停止唤醒该实例）→ **同角色其余实例照常接活**（池任务由实例选择策略自动流向健康实例，§2.3；定向任务按 H4 处置）。配额是**实例属性**（route/账号绑定），不是角色属性——k 实例下单实例熔断不构成角色不可用。
- **第二层（兜底）——轮换**：**角色的全部实例**均进入不可用终态（quota-exhausted 全体 + 无健康实例可接）时，才升级为队长决策（§7.2 H2）：等配额重置，或按 §4.3 轮换 spawn 新代（可带新 route）。v0.4 及以前「配额耗尽 → 轮换」的粗粒度语义废止——单实例耗尽就走轮换 = 无谓丢弃其余健康实例的并发能力。
- **route 切换仍走轮换特例**：需换 provider/model 时 = fresh-instance + 新 route（§4.4 原有语义保留）；「运行中自动切换模型」**不做**（t46 已证装配只在 spawn 时）。
- 自动化 fallback（按错误类型自动选备用 provider）维持延后（E10）。

### 4.5 同角色多开（concurrent instances · v0.5 新增 · F7 展开）

**能力声明（§0.3 原则 5 的展开）**：同角色多开**支持**——条件 = ①实例独立注册（每实例一条 MemberRecord，各自 status/route/熔断计数）；②命名规范（F7.1：`<role>-i<idx>`，与轮换代 `<role><gen>` 语义分离，可组合如 `engineer2-i2`）；③「无在途」硬规则 per-instance 沿用（同角色 k 实例 = 至多 k 并发任务，§2.3）。

**MemberRecord 扩展三字段（F7.1 结构化定义；**§3.1 schema 行的合入已于 v0.6 完成**——v0.5 时因 diff 纪律暂放本节，t87 repair-round-3 兑现该承诺。§3.1 为权威定义，本节保留展开语义与理由）**：
```jsonc
  "instanceKind": "primary",        // 'primary'（首个/默认实例）| 'rotated'（轮换代，§4.3）| 'concurrent'（多开实例，本节）
  "instanceIndex": 1,               // 同角色内序号：rotated = 代数（与 generation 同义对齐）；concurrent = 多开编号
  "concurrentGroup": "engineer",    // = role 名；同组的实例共享「实例选择策略」（§2.3）与「全实例熔断 → 兜底轮换」判定（§4.4）
```

**多开操作（队长触发，无流程负担）**：spawn `<role>-i<idx>` → 注册表建档（`instanceKind='concurrent'`，`concurrentGroup`=role，status 直接 `active`——**无 standby/交接语义**，多开不涉及旧实例任务移交）→ 即入池参与实例选择。移除单个并发实例 = §4.2 流程（前置条件照旧）。

**与既有机制的相容性自查**：
- claim CAS（S13）：多实例并发认领的正确性由 P1 CAS 保证，与 §2.3 论证同源——双 owner 结构性不可能；
- 熔断/可用性：五态状态机 per-instance 独立运转（§3.2），`concurrentGroup` 仅供 §4.4 第二层判定（「全部实例熔断」）聚合查询；
- 池投影（§3.3）：`visibleBy` 天然支持多实例（每个实例独立视图 + 实例选择策略择一唤醒）；
- 「一人一活」：升级为 per-instance 表述（§2.3），k 实例 = 至多 k 并发任务——并发度随实例数线性扩展，正确性约束不变。

---

## 5. attempt 语义与 P1 状态层的对接（零新增语义）

**裁决：P2 不新增任何 attempt 概念。** attempt 的生命周期完全属于 P1 状态机，调度器对它不可见也不可操作：

| attempt 关注点 | 承接（全部 P1 已实现，file:line 本稿已核） | P2 的关系 |
|---|---|---|
| attemptId 生成 | claim CAS(pending→claimed) 时生成一次（task-store.js:295-347）；reassign 生成新 attemptId 且 attempt+1（:519-540） | 调度器唤醒**不生成** attemptId——唤醒与 attempt 无关 |
| attempt 防 stale | update/release 必带 attemptId+revision，CAS 校验（:349-391, :413-431）；attempt-mismatch 错误码（:64） | 成员循环（§2.2）照带；调度器不碰 |
| attempt 代数保留 | reclaim 清 attemptId 保留 attempt 代数（:456-460）——审计可追溯 | 同上 |
| 成员身份防误认领 | claimedById/assignee 宿主注入（t75-F4，路由 :1846-1852） | 自建成员的 claimedById = 其 sessionId（§3.1） |
| stale 后的自愈 | 成员收到 stale-revision/attempt-mismatch → 重读 /state 重新决策（P1 §6 语义） | 写入成员循环规则（§2.2 步骤 3 括号） |

**一个命名澄清（防混淆，不引入新字段）**：`attempt`（P1，任务维度，尝试代数）与 `generation`（P2，成员维度，实例代数）是**正交**的两个计数器：轮换 = generation+1（成员换了），任务的 attempt 只在被 reassign 时 +1（同一任务换了执行者/重试）。两者组合恰好刻画「t79 的第 2 次尝试由 researcher2 的第 1 代执行」这类事实。

---

## 6. 队长工具面：最小集 4 工具 + P1 API 映射

### 6.1 统计基线（引用口径，不重扫）

t48/t55 调研（落盘 `captain-tool-surface.md`，**2026-09-11 11:43:42 快照**，44 个 session.jsonl.zstd 全量非抽样）：总 575 次 `agent_teams_*` 调用；队长面最小集 = create_task(75) / update_task(134) / send_message(199) / status(74)，合计 482/575 ≈ **84%**（快照内口径，比例关系稳定、绝对数随日志追加漂移——引用时必须带快照时刻，t65 口径）。样本内零调用：approve / remove_member / resume（受观察者效应约束的弱化口径，见 §6.3）。

### 6.2 4 工具语义 + 与 P1 状态层 API 映射表

| # | 工具（样本内频次） | P2 承载 | 语义（自研，非照抄 AgentTeams） | 现状 |
|---|---|---|---|---|
| 1 | **create_task**（75；45% 带 dependencies、96% 带 assignee、100% 带 subject——快照口径） | `POST /team-tasks/create` | 建任务（subject 必填；DAG 拓扑校验拒环/自依赖/悬空告警）；成功后**触发一次池检查**（§2.3 触发源 1）——若有成员可认领则自动唤醒（可按 config 关闭自动唤醒，改为队长手动唤醒） | **P1 已实现**（lib/index.js:1800-1829） |
| 2 | **update_task**（134；96% 带 attempt_id——4% 绕过路径正是 P1 CAS 要兜的） | `POST /team-tasks/update` + `POST /team-tasks/supersede` + **`POST /team-tasks/reassign`（P2 新增路由）** | update：成员推进 running/completed/failed（attemptId+revision CAS）。supersede：队长作废（visited+深度链）。reassign：队长重派（to + revision，claimed/running/suspended 三态入参）——**路由新增但语义零新增**（store.reassign :519 已有，t78 核验口径「UI 属 P2+」的兑现） | update/supersede **P1 已实现**；**reassign 路由 = P2 实现项**（唯一新增 HTTP 面） |
| 3 | **send_message**（199，最高频） | 宿主消息通道 + **调度器唤醒原语** | 两用：①队长↔成员自由消息（协作/指导）；②**wake(member)**：调度器的正式动作（§2），带 `kind:'wake'` 标记便于统计区分自由消息与调度唤醒 | 消息通道已有（/speak 风格路由）；**wake = P2 新增**（复用同一通道，加元数据字段） |
| 4 | **status**（74） | `GET /state`（已有投影）+ 扩展 | 单只读端点：threads/members/feed（已有）+ **tasks 投影（P1 snapshotRow 已接）** + **members 注册表投影（P2 新增：status/generation/consecutiveFailures/lastWakeAt）** + pool 摘要（可认领任务计数） | 任务投影 P1 已接；**注册表投影 = P2 实现项** |

**映射表要点**：4 工具中**只有 reassign 路由、wake 元数据、注册表投影**三项是 P2 净新增实现面；其余全部复用 P1 已核验落地物。工具面膨胀被显式控制在最小。

### 6.3 零调用工具的处置（样本内口径，含一处口径张力的如实披露）

| 工具 | 快照口径 | P2 处置 | 理由与重评估条件 |
|---|---|---|---|
| approve | 零调用 | **不做** | 本团队 approval=automatic；自建团队沿用 automatic 默认。重评估条件：若未来需要 approval=required 形态（高风险任务审批），届时按 P1 质量门的 review 流程扩展，不预先实现 |
| edit_plan | 1 次（且为队长一次被运行时拒绝的尝试——captain-tool-surface.md §0 已核实归属） | **不做** | P2 无 staged 计划概念：任务直接 create，改需求 = supersede 旧任务 + create 新任务（supersededBy 链保持历史，见 §6.3 补充）。staged 编辑的低频样本不足以支撑实现 |
| remove_member | **零调用——但存在口径张力，如实披露** | **不做成独立工具**；并入 §4.2 流程 | 张力：快照内 remove_member 零调用，但账本多处记载「移除旧 reviewer」（t30/t49/t52 等）——移除动作可能发生在快照（09-11 11:43:42）之后，或经非工具路径。**诚实结论**：低频可信（无论口径内外都极少），「零调用」仅绑定快照。P2 把移除做成**流程约束下的注册表操作**（§4.2 前置条件强制），而非自由工具——比「做不做工具」更重要的是移除永远走安全流程 |
| resume | 零调用（halt 场景本样本未出现） | **不做独立工具**；成员暂停/恢复并入注册表（paused 态 + 人工恢复，§3.2） | halt/resume 是「整个团队停止」语义；P2 的等价物 = 全员 paused + 调度器停摆，队长一人一操作恢复。场景罕见（样本内零），实现推迟到首次真实出现（E11） |

**补充（supersede 取代 edit_plan 的用法示例，本任务即是活例）**：t79（本任务）就是「前任 researcher 被轮换」后的替代任务——AgentTeams 里它与旧任务无链接；P2 里队长可 create 新任务时带 `supersededBy` 语义标注（或事后 supersede 旧任务指向新任务），链式保持「被取代」历史可追溯——这正是验收要求「任务被取代必须建模」的另一面：**取代关系显式建链，而非靠重排队列隐式复活**。

### 6.4 routingText 解耦方案

**耦合点清单（本稿作者逐行核对 shared.js 全文 445 行，2026-09-12）**：

| 层 | 位置 | 内容 | 耦合性质 |
|---|---|---|---|
| 指令注入层 | shared.js:249-291 `routingText` | :257 createLine 内嵌 `agent_teams_create`/`agent_teams_add_member` 工具名与 approval 参数；:284/:286 `agent_teams_status`/`agent_teams_send_message` 工具名；:284-287 「群聊侧栏」「成员空闲时由调度器接管」等 AgentTeams 机制表述 | **主要耦合**（任务描述「:257-288」与此吻合；精确边界为 255-290） |
| 标签解析层 | shared.js:13 `LABEL_PREFIX='agent-teams:'`；:96-118 `roleFromLabel`/`teamFromLabel`/`isTeamLabel` | 按 `agent-teams:<team>:<member>` 前缀解析成员身份 | **任务描述未列出的第二处耦合**——P2 自建成员标签 `dsh-team-chat:<team>:<member>` 必须能被同一套 UI 识别，否则 roster/discoverCaptains 链路（lib/index.js:388-405 列子代理、:482/:1103 写 parentSessionId）对自建成员失效 |

> ⚠️ 任务描述称 :257-288 为「唯一硬耦合」——**核对后不成立**：标签解析层是第二处，且是 P2 自建成员被现有 UI 感知的**前提**（口径：routingText 函数体全区间 = **shared.js:249-291**，:257-288 仅为其中段；调用方核对见下）。

**t80 耦合地图并入（v0.2 初并 / v0.3 按 engineer2 逐位置清单细化；本稿作者独立复核通过，非转抄）**：全仓 AgentTeams 相关命中，**代码级依赖 = 0**（无任何 `import`/`require` 指向 AgentTeams；grep `startContinuable|spawnMember|add_member|addMember` 全 lib/ 仅命中 shared.js:257 的 prompt 字符串——engineer2 复验与本稿 grep 一致）。**计数口径差异（如实并注，不抹平）**：「23 处」存在两种复算——t80/engineer2 口径 = grep lib/（含 client.js）23 处；本稿口径 = 全仓 js/mjs 22 行 + package.json:11（keywords）1 处 = 23。两口径结论一致（零代码依赖），逐位置清单以下表为准（v0.3 起以 engineer2 移交清单为主干，本稿行级 grep 交叉验证）。五类分级（类 = 处置时机；层级判定 = **仅 A 是行为耦合，B/C 为数据约定，D/E 为文案常量**——「唯一硬耦合」的准确表述是「三层：A 指令注入 + B 标签解析 + C 渲染通道约定」）：

| 类 | 位置清单（v0.3 主干 = engineer2 移交；本稿抽验一致） | 层级 | 处置时机 |
|---|---|---|---|
| **A prompt 行为耦合** | shared.js:254（approval 枚举→agent_teams_create 参数）、:255-257（createLine）、:267（executionPrompt「必须原样传入」= add_member 参数约定）、:272-274（agent_teams_send_message）、:284（agent_teams_status）、:286（status+send_message）；index.js:26；「群聊侧栏/调度器接管/成员空闲」概念表述（:284-287）归此类 | 指令注入层（**行为耦合**） | **P2 重写**（本节适配层） |
| **B label 前缀识别** | 定义：shared.js:13、:96-118（roleFromLabel :96-99 / teamFromLabel :107-110 / isTeamLabel :116-118）、index.js:13；**使用点：index.js:403（rosterFrom 过滤）、:406（成员名）、:507（teamName）**；测试桩 6 处（host-smoke:312/345、host-events:81、shared.test:27-43、team-tasks.test:249） | 标签解析层（数据约定） | **P2 扩双前缀**（`dsh-team-chat:` + 存量兼容） |
| **C executionPrompt 渲染通道** | shared.js:264/:267/:320-337（memberPrompt）；index.js:1688（preview）；client.js:1784/:2038（编辑框）、:1979/:2221（「指引级」文案） | 渲染通道约定（数据约定） | **P2 保留通道、换注入者**（startContinuable 直注，§4.1） |
| **D 纯文案/注释** | index.js:7/:9/:13/:19/:26/:1437；shared.js:12/:30/:33-34/:91/:102/:113/:238-243/:314；client.js:2221；README.md 约 12 处、market/README.md:24、package.json:11 keywords | 文案 | P4 |
| **E 常量语义对齐** | shared.js:33-34 MAX_MEMBERS=8（对齐 AgentTeams maxMembers 默认） | 常量 | P4 |

**决定性结论（校准 P2/P4 工作量与风险）**：P4 的「切换」主要是 **prompt/文案层面替换**，不存在需要拆除的服务或代码依赖；P2 的重心同样在 **prompt 重写 + 自建通道 + label 双前缀 + 指令换 `/team-tasks` 语义** 四件事（t80 工作量表 P2×4 / P4×2，与本稿 §6.4/§4.1/§9 一致）。routingText 调用方全仓仅 **index.js:1408 / :1449 两处**（本稿逐行核对：均为 `systemPrompt.section` 的 text 工厂）——解耦只碰两个调用点，改动面收敛。

**重写方案（纯模板分层，零新依赖）**：

```
routingText(config, team, backend)          // backend ∈ 'agent-teams'（默认）| 'dsh-team-chat'
├── 通用层（平台无关，两后端共享）
│   ├── 团队模式说明 + 名册渲染（roster/memberPrompt 逻辑不动，:259-268/:320-337）
│   └── 协作规则骨架（任务优先团队 / 队长拆解分派不亲自实现 / IM 播报条款）
└── 适配层（backend 特定模板字符串，各自独立维护）
    ├── 'agent-teams'：现 :255-290 文本原样迁移（逐字保留，含 approval 参数与工具名）
    └── 'dsh-team-chat'：新模板
        ├── 建队：无需 agent_teams_create/add_member——成员注册表驱动（§4.1），队长只管 create 成员配置
        ├── 派发：POST /team-tasks/create（DAG/assignee）→ 调度器自动唤醒
        ├── 观察：GET /state（任务+成员注册表投影）
        ├── 成员循环：§2.2 的四步（注入每个自建成员 executionPrompt）
        └── 移除/轮换：§4.2/§4.3 流程提示（先处置任务再 removed）
```

- 标签层解耦：`isTeamLabel(label)` 改为前缀集合匹配 `['agent-teams:', 'dsh-team-chat:']`；`roleFromLabel`/`teamFromLabel` 参数化前缀（两前缀标签格式同为 `<prefix><team>:<member>`，解析逻辑天然共享）。
- 后端选择：config 新增 `scheduler: 'agent-teams' | 'dsh-team-chat'`（默认 `'agent-teams'`）——**默认行为逐字节不变**，切换是显式配置动作。

**回归验证方式（四层，实现任务照此验收）**：
1. **不破坏**：`node --test` 现有 shared 断言全绿（默认后端行为不变）；
2. **golden 快照**：agent-teams 后端输出与解耦前**逐字节一致**（diff 为空）；dsh-team-chat 后端输出满足新契约断言（含 §2.2 循环文本、无 agent_teams_* 字样、含 dsh-team-chat: 前缀说明）；
3. **尺寸口径**：`measure-prompts.mjs`（README 已登记的 routingText 尺寸脚本）复跑，默认/真实/最坏三口径对比解耦前后，偏差写入交付；
4. **判别力（能变红）**：故意改动 golden 基准中一个工具名（如 agent_teams_create→agent_teams_creat）→ 快照断言必须失败——证明基准真有判别力，不是橡皮图章（AGENTS.md §2 对照组纪律）。

---

## 7. 队长（人）的显式介入点（事故 #9 的制度化）

### 7.1 原则

**检测可以自动，处置必须人工**——凡是「宿主无法可靠判定真伪」或「处置不可逆/影响下游」的动作，一律人工。AgentTeams 的失败不在缺自动化，而在**错误的自动化**（自动重排、自动投喂、自动 review-repair 循环）。

### 7.2 介入点清单（穷举调度器全部「停下来等人」的场景）

| # | 触发 | 调度器行为 | 队长动作 | 依据 |
|---|---|---|---|---|
| H1 | 任务 suspended（stallMark 人工确认后 / 中断不可确认） | 不入池、不唤醒 | 三选一：resume / reassign / supersede（P1 §5；超时自动 superseded 兜底） | P1 已定义，P2 零改动 |
| H2 | 成员 quota-exhausted / unresponsive / context-exhausted / degraded | 停止唤醒该成员，/state 标注 | 查明原因 → 等重置（配额）/ 轮换（上下文，§4.3）/ 排查（unresponsive） | §3.2 唯一自动恢复边只有 offline |
| H3 | assignee-orphan 任务（assignee 指向不存在/removed 成员） | 不入任何成员视图，/state 标注 | reassign 或 supersede | §3.3 |
| H4 | 定向任务 assignee 不可用 | 任务停在 pending | 等成员恢复 / reassign 换人 / supersede | §2.4 不自动改派 |
| H5 | 熔断成员的恢复 | 停止唤醒直到人工确认 | 确认配额重置/故障排除后 resume | §3.2 |
| H6 | spawn 失败 | 不自动重试 | 排查后重试 | §4.1 |
| H7 | review verdict needs_revision | **自动创建 repair 任务（承载 findings）+ 轮数上限 + 结构化升级 EscalationRecord**（v0.8 · t104：原「不自动开 repair（与 AgentTeams 自动 review-repair 循环的本质区别）」立场被 **P3 设计稿 §4.1 显式取代声明**取代，P3 v0.2 = `D24D63184485`，两文档互引） | 队长保留升级裁决权（P3 §5.4 A-D）与 gate 框架外禁止；**取代依据** = P3 v0.2 安全阀（轮数上限 / EscalationRecord / 依赖只指成功源）+ 本会话五次手工修复循环运行证据（如 t74→t75→t76、t81→t82→t84→t86→t89→t90） | 原依据（账本 t49→t52→t59→t67 四轮循环失控的直接教训）的担忧由上述安全阀逐一对冲——取代论证详见 P3 设计稿 §4.1 与 §9-G8 H7 维度 |
| H8 | 移除/轮换成员 | 前置条件不满足即拒绝并返回待处置清单 | 按流程处置任务后重试 | §4.2/§4.3 |

**反面对照（写明「不自动」的完整清单，防实现时顺手加回来）**：不自动重试失败任务、不自动重排任何任务、不自动改派定向任务、不自动恢复不可用成员、不自动开修复任务、不自动 reclaim running 任务、不自动 spawn。

---

## 8. 持久化（复用 P1 §7，扩展同文件）

- **位置**：`$DSH_HOME/dsh-team-chat/<teamId>/team.json`（P1 裁定 1/2/4 全部沿用：`$DSH_HOME` 空缺默认 `~/.dsh`；teamId 净化防穿越；rename 原子；绝不进仓库）。
- **扩展**：文件 schema 增加顶层 `members: MemberRecord[]`（§3.1）与 `scheduler: { wakeEnabled: boolean }`（自动唤醒总开关，默认 true）。P1 的 tasks 数据结构零改动。
- **members 扩展的实现归属（v0.4 按复核验收增补）**：推荐**宿主层包装序列化**——MemberRegistry 的读写由 lib/index.js 宿主层在同一 team.json 上包装（save = 读 store 快照 + 合并 members 段后一次 rename；load = 双段分发），`task-store.js` **零改动**；若实现中证明必须改 P1 文件（如 store 需感知成员状态做联合校验），则**列出入 P1 契约的增量变更清单**（改动点 + 影响的 P1 章节 + 受影响的测试项）并**重跑受影响核验**（t74-t78 链对应项），不得静默改 P1。
- **落盘分级（沿用 P1 两级）**：成员状态迁移（active→不可用→removed）与注册表结构变更 = **迁移级同步落盘**；lastWakeAt/lastResponseAt/consecutiveFailures 等高频计数 = **聚合级**（≤500ms flush + 退出/读前 flush，与 observeActivity 同拍）。
- **崩溃恢复**：P1 语义不变（启动重读、损坏文件改名保留现场）。成员注册表与任务记录同文件原子覆盖——不会出现「任务已 reassign 而成员状态未迁移」的半态。
- **版本兼容**：旧文件无 members 段 → 读入时补空数组（成员注册表为空 = 调度器空转，任务池只读）。不迁移 AgentTeams 任何数据（干净重来）。

---

## 9. 过渡共存与 P4 切换条件（前置声明）

### 9.1 P2 期共存规则（沿用并细化 P1 §8）

1. **只管理自建成员**：调度器唤醒、池投影、注册表只认 label 前缀 `dsh-team-chat:` 的成员。AgentTeams 成员（`agent-teams:` 前缀）对调度器**不可见**——不会被唤醒、不会出现在成员视图。
2. **AgentTeams 只读**：若同一会话仍有 AgentTeams 团队在跑（如当前过渡期），其 /state 仅作对照观察（P1 §8 原文），P2 不写不抢。
3. **两套成员不混调**：自建任务池与 AgentTeams 任务互不引用（id 空间独立：P1 自建 = `t<seq>`，AgentTeams = 其自有 id）；不出现「A 队任务派给 B 队成员」。
4. **fenced 鉴权沿用**：/team-tasks/* 的调用方校验不区分前后端（同一 fenced 机制），自建成员的 claimedById 注册表可查（§5）。

### 9.1.1 防双调度（过渡期硬约束 · v0.2 新增，t80「零服务依赖」结论直接导出）

过渡期 AgentTeams 仍在 bundles，其 captain 侧 `agent_teams_*` 工具随时可用——**两套调度器并存是 P2 最大的流程风险**（AgentTeams 调度器全部已知缺陷见 §1）。三条硬约束 + 一套误用处置：

**约束（写入 dsh-team-chat 后端 routingText 的队长指令，§6.4 适配层交付物之一）**：
1. **不得用 `agent_teams_create` / `agent_teams_add_member` 建队/建成员**——成员一律经 §4.1 自建通道（startContinuable + 注册表）；
2. **新任务一律走 `POST /team-tasks/create`**——不得用 `agent_teams_create_task`；
3. AgentTeams 只读（§9.1 规则 2）——不向其调度器分派任何工作。

**误用识别与处置（检测自动、处置人工——§7.1 原则）**：

| 误用情形 | 自动识别（机制） | 处置（人工） |
|---|---|---|
| captain 误用 `agent_teams_add_member` 建了成员 | roster 例程按 label 前缀发现 `agent-teams:` 新子代理 → /state 标注 **foreign-member**（非注册表成员，调度器永不唤醒） | 队长用 AgentTeams 自身工具移除；或认可则重新走 §4.1 建档入注册表 |
| captain 误用 `agent_teams_create_task` 建了任务 | 该任务只存在于 AgentTeams 状态，**结构性不进 /team-tasks 池**（id 空间隔离，§9.1 规则 3），池投影无感 | 队长在 AgentTeams 侧作废；工作仍需要则经 /team-tasks/create 重建并建 supersededBy 链（§6.3） |
| 自建成员误用 AgentTeams 工具汇报/推进 | dsh-team-chat 后端 executionPrompt 不含任何 agent_teams_* 指令；成员对 AgentTeams 任务账本无可见域（agent 专用工具 requireCaptain） | 无系统性动作；观察期记录违规次数（E13） |
| captain 会话出现 `agent_teams_*` tool/call（疑似绕过约束 1/2） | **feed 层即时识别（v0.7 · t89 合入）**：复用 t17 现有 session/event 订阅（零新增读）——captain 会话 tool/call 事件中 name 匹配 `agent_teams_*` 前缀即命中 → /state 标注 **foreign-action** + 群聊侧栏提醒 | 人工（与前两行一致）：队长确认归因后按账本处置（认可则记录归因如 t89 合并裁定，不认可则作废/重建）；不自动动作 |

**残余风险如实声明**：识别依赖两个结构性事实（label 前缀格式固定 + id 空间隔离——均已验证），但「captain 无视指令误用」是**行为风险**，机制只能标注不能阻止；列观察期监控（E13）。**⚠ 升级（v0.7 · t89 合入）**：过渡期 AgentTeams 调度器仍在运行（checkUnattended 30min 自动 supersede 等），误用会直接造成**真实双调度**——旧成员被真实派活、消耗配额、双账本（AgentTeams 任务账本 vs /team-tasks 账本）分裂；且发现窗口若无增强可达数天（E13 现无自动比对、靠人工日志观察）。

### 9.2 P4 切换条件（全部满足才移除 AgentTeams，前置声明防「切早了」）

| # | 条件 | 现状（本稿交付时点） |
|---|---|---|
| C1 | P1 状态层落地并独立核验 pass | ✅ 已达成（5 路由 + 持久化，t77/t78 pass） |
| C2 | P2 调度器 + 工具面落地：自建成员全生命周期（spawn/唤醒/认领/结算/轮换/移除）可运行 | 本设计稿 = 第一步 |
| C3 | routingText 解耦完成，双后端 golden 回归全绿（§6.4 四层验证） | 未开始 |
| C4 | **混跑观察期**：≥ N 个真实任务全链路（create→唤醒→claim→交付→核验 pass→闭环）经自建调度完成，期间孤儿/双执行/投喂风暴/误重排 **零发生**（N 建议 5，需用户/队长确认，E5）；**多开场景（v0.5 · F7.5）**：≥2 同角色实例并发认领的全链路各 ≥1 例（验证 §4.5 相容性 + §2.3 单实例唤醒策略实测） | 未开始 |
| C5 | ~~t80 耦合地图确认无第三处未处理的 AgentTeams 耦合~~ **✅ 已达成（v0.2）**：t80 耦合地图完成并经本稿独立复核并入 §6.4——全仓 23 处命中、零代码 import、五类分级全部有处置方案（P2×A/B/C，P4×D/E），无未处理项 | ✅ t80 完成（2026-09-12） |

**P4 动作预告（不在 P2 范围）**：bundles 移除 `@nanmicoder/dsh-agent-teams`；routingText 默认后端切 `dsh-team-chat`；标签解析层保留 agent-teams: 前缀只读兼容（历史账本仍可显示）。

---

## 10. 待决策点（D/E 表，全部需实测或需用户/队长）

| # | 项 | 建议初值 | 状态 |
|---|---|---|---|
| E1 | 唤醒无响应超时（→ unresponsive） | 10min（借 P1 stallThresholdMs 同口径） | 建议初值需实测 |
| E2 | 熔断阈值 consecutiveFailures | 3 次 | 建议初值需实测 |
| E3 | 429/quota 错误的宿主侧可观测性（session/event 是否携带模型调用错误信号） | — | **需实测**：不可观测则 quota-exhausted 态由 E2 熔断兜底（降级为「原因未分类的不可用」） |
| E4 | 兄弟插件宿主侧**直调** `subagents.startContinuable` 的签名与可达性（链路两端已被 t46/t80 证实，唯我方直调未跑通）；通道候选 (a) 宿主直调 vs (b) captain 间接调（§4.1，本稿倾向 (a)） | 候选 (a) | **需实测**（实现 Slice 前必须落定，否则 §4.1 无法施工） |
| E5 | 混跑观察期任务数 N | 5 | 需用户/队长确认 |
| E6 | 轮换命名规范（新名+代数后缀 vs 同名） | 新名（本会话已验证可工作） | 需用户/队长确认规范化 |
| E7 | reassign 路由鉴权（队长专用 vs 成员可自请） | 队长专用（与 AgentTeams reassign 语义对齐，账本 12 次全部队长侧——t48/t55 快照口径） | 需队长确认 |
| E8 | wake 消息是否对成员可见（透明度 vs 噪音） | 可见（群聊侧栏同款时间线，标注 kind:'wake'） | 需用户确认 |
| E9 | 多实例唤醒策略（v0.5 · F7.2 **升格为必需**）：默认 = 单实例唤醒（§2.3：定向→assignee 匹配最闲；池→无在途→最少连续失败→lastResponseAt 最早选一）；备选 = 轮询 / route 健康度加权 | 单实例唤醒（默认已定）；备选不实现除非实测成为吞吐瓶颈 | 空转发生率未测（跨角色残余窗口）——实测扰人再评估备选 |
| E10 | 配额感知自动路由 fallback | 延后（§4.4） | 延后，非拒绝 |
| E11 | 团队级 halt/resume 独立工具 | 延后至首次真实需求（§6.3） | 延后 |
| E12 | t80 推测「每 turn 的 agent_teams_* 调用频率」——影响解耦后指令密度评估 | — | **推测显式处置（队长要求，不默默吸收）**：实现后用 session/event 统计每 turn 工具调用分布（复用 measure-events.mjs 同法）验证；设计期不依赖该数字 |
| E13 | t80 推测「captain 自発用旧工具建队」的风险——防双调度（§9.1.1）的行为面残余 | — | **推测显式处置（同上）**：机制层已做 foreign-member 标注 + 池隔离（检测自动）；行为面列 C4 观察期监控项，违规次数写入观察期报告 |
| E14 | **成员侧 /team-tasks 可达性与鉴权**（v0.4 按复核验收新增）：fenced 对成员会话请求的行为（成员会话能否携带正确凭证调 POST /team-tasks/*）、成员身份凭证机制（claimedById 宿主注入依赖宿主识别调用方——成员自调时身份如何建立） | — | **需实测 ⚠**，实现 Slice 前与 E4 同批落定（成员循环 §2.2 的施工前提） |
| E15 | **复核窗口文档只读的机制化**（v0.7 · t89 合入）：review 任务 claim 时宿主自动快照被审文件指纹（file→sha256 入任务记录）；update_task 完成时自动比对，不匹配即警告——把「复核期零修订」从纪律承诺升级为机制强制（t84-F8 / t87-F9 两次偏差的直接教训） | claim 时快照 + completed 时比对（P1 任务记录扩展字段） | **需实测/需设计**：与 /team-tasks 路由、任务记录 schema（P1 §1 扩展）一并落定 |

---

## 11. 已验证 / 推测 / 需实测（汇总，口径绑定）

**已验证（本稿作者亲自核对源码/账本/文档，标注验证方式）**：
- P1 契约指纹 `6FBCA6827E25` / 60139 B / 518 行（方法：count-lines.mjs + Get-FileHash，2026-09-12 本回合，同一次测量）。
- 5 条 `/team-tasks/*` POST 路由 + reassign 未接线（方法：grep 'team-tasks' 全仓 + 逐行读 lib/index.js:1794-1948）。
- store 14 方法公开面及 reassign 三态入参（方法：grep 方法签名 + 通读 task-store.js:390-699）。
- routingText 耦合点双层结构（方法：通读 shared.js 全文 445 行，逐行定位 :13/:96-118/:249-291）。
- 九条事故全部有账本 output 原文支撑（方法：agent_teams_status 快照 + spill 文件回读；快照时刻 = 本回合 t79 执行中，任务总数 80）。
- fresh-instance 轮换有效（方法：本会话两次轮换后成员正常工作——含本稿作者；t46 源码验证装配只在 spawn 时）。
- **唤醒与回合开始 = 方向性证据（v0.4 按复核验收降级）**：回合开启与成员被注入（唤醒）高度相关——但原引用的两个比例（239/534≈45%、58/75=77%）**口径未定义**：「紧邻」是何种事件关系（tool/result 后下一条同会话 turn/start？窗口多长？）、send_message 在日志中如何识别（tool/call.name='send_message' 且 recipient=该成员？）均未标注——按章程规则 1（无口径数字不可采信）**降级，不再引用具体比例**。**口径规格（供重测）**：send_message 识别 = 宿主侧 `tool/call` 且 name='send_message' 且参数接收者为该成员会话；「紧邻」建议定义 = 该 `tool/result` 之后、同成员会话内第一条 `turn/start` 且间隔 < 30s；重测方法 = `measure-events.mjs` 同法全量扫描。重测前本条维持方向性证据级别。**口径分歧实证（v0.5 注，呼应 F4/F5）**：reviewer2 在 t78 复核中按另一口径复算得 **42.7%（紧邻 inbox，单会话）/ 83%（全局前驱）**，与 P1 转引的 45%/77% 并存——同一现象在不同「紧邻」定义下数字显著不同，正是本条降级为方向性证据的直接依据；两组数字在统一口径重测完成前均不得引用。
- 工具面统计 575/84%/零调用三工具（方法：转引 captain-tool-surface.md 并绑定其快照 2026-09-11 11:43:42，未重扫——重扫结论必变，比例关系稳定）。
- **全仓耦合量化（v0.2，t80 并入 + 本稿独立复核）**：23 处命中（js/mjs 22 + package.json keywords 1）、**零代码 import**、五类分级（A/B/C 归 P2、D/E 归 P4）；routingText 调用方仅 index.js:1408/:1449 两处（方法：本稿作者独立 grep 全仓 + 逐行读调用点 + 读 package.json 上下文，与 t80 结论一致）。
- **成员创建链路现状（v0.2）**：创建动作 100% 在 AgentTeams 内部（settings.teams → routingText → captain add_member → tools.js → members.js:485/:504 startContinuable）；方法 = t80 取证与 t46 源码交叉印证（AgentTeams 内部行号为两任务转引，本稿未直接读 AgentTeams 包源码——标注转引口径）。

**推测（显式标注，不可当事实用）**：
- 并发唤醒空转一次回合的发生率（§2.3，未测）。
- 成员不可用五态在真实运行中的分布频率（哪些态常见，未测——设计按「五态同效」降低误判代价）。
- startContinuable 之外是否还需其他平台配合（如 toolFilter 形状）才能spawn 出功能等价成员（t46 只证到了 AgentTeams 的调用方式）。

**需实测（实现 Slice 前必须落定的用 ⚠ 标出）**：
- ⚠ E4 兄弟插件宿主侧直调 `startContinuable` 的签名与可达性（§4.1 施工前提；链路两端已证，唯直调未跑通）。
- ~~t80 全仓耦合地图与 §6.4 耦合清单的并集核对~~ **✅ 已合并（v0.2）**：五类分级全部并入 §6.4 并经独立复核，无未处理项。
- E1/E2 阈值、E3 429 可观测性、E9 空转发生率（运行期校准项，可先带建议值上线观察）。
- 双后端 golden 快照的「能变红」对照（§6.4 第 4 层，实现任务验收时执行）。

**数值口径总表**：

| 数字 | 口径 | 可复现入口 |
|---|---|---|
| 518 行 / 60139 B / 6FBCA6827E25 | P1 设计稿 v4.5，2026-09-12 测量 | `node C:\Users\bo.yang02\count-lines.mjs "<文件>"` + `Get-FileHash -Algorithm SHA256` |
| 575 次 / 84% / 44 会话 | agent_teams_* 调用，2026-09-11 11:43:42 快照，全量非抽样 | captain-tool-surface.md（重扫同法，结论必随快照漂移） |
| 6 个重排队列实例 | 账本 t30/t49/t52/t59/t67/t68，均 attempt 3 | `agent_teams_status` 各任务 output |
| 任务总数 80（t1-t80） | 本回合 t79 执行中快照 | `agent_teams_status`（持续增长，引用须带时刻） |

---

## 12. 与 P1 契约的一致性自查（对照 v4.5 逐条）

| P1 契约点 | 本稿关系 | 冲突检查 |
|---|---|---|
| 状态机 7 态 + 迁移表（P1 §2） | 原样复用，P2 零新增态 | ✅ 成员状态机是**成员维度**新状态机，与任务状态机正交，无迁移交叉 |
| claim CAS / 不生成第二 attemptId（S13） | 成员循环与并发唤醒直接继承 | ✅ 调度器不做任何「分配」，无第二套认领路径 |
| reclaim 谓词 / running 不回收（S7B/F1） | 30s 例程原样驱动 | ✅ 调度器永不调 reclaim/stallMark 的写路径 |
| suspended 三出口 + 超时自动 superseded（F3/D8） | 原样保留；§4.2 轮换期以 reassign 快速路径处置（30min 硬约束如实标注，v0.4） | ✅ 未改 P1 任何语义 |
| update 域限制（t75-F1）/ claim 依赖前置（F2）/ 悬空告警（F3）/ claimedById（F4） | 成员循环照用 | ✅ |
| 持久化位置与分级（§7 裁定 1/2/4） | 同文件扩展 members 段 | ✅ 原子性增强（同文件同 rename）而非削弱 |
| 干净重来 / 不读 .agent-teams / P1-P4 共存只读（§8/§11） | §9 细化 | ✅ |

---

> **落盘**：t79 初稿（2026-09-12）。作者 = researcher2（glm 路由）。基线引用：P1 v4.5（6FBCA6827E25 / 60139 B / 518 行，本回合实测）；captain-tool-surface.md（t60 更新版，7C6D160398A3 / 10918 B / 122 行——账本 t60 口径，本稿未改动该文件）。下一步 = 队长派对抗复核（照 P1 模式：复核 → 修订 → 冻结 → 实现）。指纹见交付记录（本文件 + README 两件同源）。
>
> **v0.2 修订（2026-09-12，承载依据 = 队长指令「t80 耦合地图并入 t79 设计稿」；t79 attempt 1 已 terminal，本修订按章程规则 3 声明与前版差异）**：前版基线 = **BC77B0A73288 / 46453 B / 442 行**。本版改动：①§4.1 创建路径按 t80 取证重写（创建动作 100% 在 AgentTeams 内部 → P2 新通道 = startContinuable 直调）；②§6.4 并入 t80 耦合地图（23 处/零 import/五类分级表/调用方 ：1408/:1449，全部经本稿独立复核）+ 更正区间口径（函数体全区间 249-291）；③新增 §9.1.1 防双调度（三条硬约束 + 误用识别处置表 + 残余风险声明）；④§9.2 C5 达成；⑤§10 E4 细化 + 新增 E12/E13（t80 两条推测的显式处置，队长要求不默默吸收）；⑥§11 已验证区/需实测区同步更新。其余章节（§0-§3、§5、§7、§8、§12）零改动——九条事故映射表（§1）未动。
>
> **v0.3 修订（2026-09-12，承载依据 = engineer2 清单正式移交消息「t80 清单移交」）**：前版基线 = **D107BD641396 / 53695 B / 480 行**。本版改动仅三处：①§6.4 五类表按 engineer2 逐位置清单细化（A 类补 :254/:267/:272-274；B 类补使用点 index.js:403/:406/:507；C 类补 :264/:1688/client.js:1784/:2038/:1979/:2221；D 类补代码内注释清单）+ 新增两种「23 处」计数口径差异声明（lib/ 口径 vs 全仓 js/mjs+package.json 口径，结论一致不抹平）+ 层级判定升级（三层：仅 A 行为耦合，B/C 数据约定）；②§4.1 补自建通道两条候选（(a) 宿主直调——本稿倾向 / (b) captain 间接调）；③§10 E4 补候选倾向。设计裁决零变化（五类处置时机、防双调度、调度模型、九条映射表全部不动）。
>
> **v0.4 修订（2026-09-12，承载依据 = t82 repair-round-2 正式派单——本版起严格执行「修订必须由独立任务承载，修订与复核不并发」，队长警告后的第一次合规修订）**：前版基线 = **9B9B6A8BC1D4 / 56331 B / 482 行**。六项验收逐条落位：①流程项——本任务即修订承载；t81 round 1 复核已终结（findings 已产出），下一轮复核依赖本 repair，无并发。②§4.2 checkUnattended 交互段按验收选项 **(a)** 如实重写：v0.3 的「流程顺序规避/零改动关闭」表述被复核否正——30min 为硬约束、流程顺序不能豁免；快速路径 = reassign 单步（suspended→claimed 合法迁移 task-store.js:525-527，_cas 刷新 updatedAt :173，checkUnattended 过滤 :650-651——本稿本回合逐行核验）；resume 仅用于误判恢复；不选 (b)（P1 豁免机制无必要成本）与 (c)（缺口已关闭无残余可降格）。③§4.3 轮换三步改四步（spawn 新代 standby 不入池 → reassign(to=新名) → 新 attemptId 双通道送达：wake 附带主通道 + /state 自查兜底（snapshotRow 含 attemptId task-store.js:699）→ 旧代 removed）；§3.1/§3.2 配套新增 standby 态。④§11 唤醒因果比例（45%/77%）按验收降级为方向性证据 + 补重测口径规格（「紧邻」= tool/result 后同会话第一条 turn/start 且 <30s；send_message 识别 = tool/call.name 且 recipient 匹配）。⑤§10 新增 E14（成员侧 /team-tasks 可达性与鉴权，⚠ 需实测，与 E4 同批）。⑥§8 增补 members 扩展实现归属（推荐宿主层包装序列化，task-store.js 零改动；若必须改 P1 文件则列增量清单并重跑核验）。附：标题版本号补齐（v0.3 时遗漏，:1 直接从 v0.2 跳到 v0.4）。
>
> **F1 裁定补录（v0.5 · 队长三条裁定，独立条目落盘，不淡化）**：
> ① **v0.2/v0.3 两次复核中途换基线，定性为流程偏差（两次），责任在队长指令**——v0.2 由队长口头派单合并 t80（当时 t81 复核已创建）、v0.3 由 engineer2 清单移交到达时机促成；执行成员（researcher2）在 v0.3 时点明知复核进行中仍修订，构成第二次违反的要件，已记入偏差档案；规则修订后（「包括队长口头指令在内，一切合入必须走派单」）流程已闭环——本 v0.5 即正式派单（t86）承载的修订。
> ② **最终复核基线 = v0.3（9B9B6A8BC1D4 / 56331 B / 482 行）**——t81 复核 findings 基于该基线产出；v0.4/v0.5 的全部修订均是对 findings 的响应，可回溯到具体 finding。
> ③ **v0.4/v0.5 冻结前提 = round 2 复核（t84）期间零修订**——期间一切新输入由队长排队，复核结束后由新任务承载；执行成员已确认遵守。
>
> **v0.6 修订（2026-09-12，承载依据 = t87 repair-round-3 正式派单；round 3 复核 = t88 在本版基线上执行）**：前版基线 = **AF4A2FD101FB / 70736 B / 535 行**。四项落位：
> ① **基线重锚（队长裁决②）**：本回合实测当前文件 = **AF4A2FD101FB / 70736 B / 535 行（LF 534, CR 0）**——与 t86 交付逐项一致。漂移链补全定性：`45383FAF4D3E`（v0.4，t82 交付）→ `2AF8B687F19D`/501 行（**t84 复核期间采样到的 t86 修订序列中间快照**——t86 修订由多次原子 edit 组成，reviewer2 采样落在其中间态；非独立版本、从未交付，其「无任务承载」定性在采样时点成立，随后 t86 正式派单使该序列获得承载）→ `AF4A2FD101FB`（v0.5 终态，t86 交付，当前实测复核通过）。**以承载任务交付的最终指纹为准 = AF4A2FD101FB**（本版基线）。
> ② **§3.1 三字段行合入（兑现 v0.5 承诺）**：instanceKind/instanceIndex/concurrentGroup 三字段正式合入 §3.1 schema（v0.5 时因 diff 纪律暂放 §4.5，明确「随下一承载任务合入」——t87 即该任务）；generation 注释同步改为与 instanceIndex 对齐的表述；name 行注释指向 §4.3 命名规范。
> ③ **tmpdir 残留核验（队长裁决「另」项）**：实测 `docs/optimization/` 目录（`Get-ChildItem -Force`）共 28 个条目全部为文件，**无任何子目录、无 tmp/temp 命名条目**——t84 所述「tmpdir 残留证据」在当前目录状态下不存在（或为临时性观察，已被清理）；无需清理动作，如实记录。
> ④ README 索引行同步至本版口径（v0.4 口径滞后补正，本轮 in-scope）——**⚠ 本条为 t87 attempt 1 的失实声明，attempt 2 已更正**：attempt 1 落盘时 README 索引行实际仍为「v0.4，repair-round-2」字样（实测 grep `v0.4`=命中、`v0.6`=0 命中），本条声称与文件状态不符；attempt 2 已实际改写 README 对应行为 v0.6 口径并复测通过。失实归因：attempt 1 在写入本条时把「计划动作」记为「已完成动作」，未在落盘后回读 README 复核（违反章程规则 1「数字/状态必须附可复现核验」，同类教训见 t65）。
> ⑤ **§4.5 承诺兑现回写（attempt 2 补，消除自相矛盾）**：§4.5 原文仍写「§3.1 schema 行的合入随下一承载任务」，与本版④②已合入的事实自相矛盾（同一文件内两处陈述互斥，且是复核方最易命中的一致性缺陷）。attempt 2 已改为「§3.1 schema 行的合入已于 v0.6 完成……§3.1 为权威定义，本节保留展开语义」。**复测口径（可复现）**：`grep -n 随下一承载任务` 于本文件 → 命中 2 行（L539、L542），**全部为对历史承诺的引述**（L539 记述 v0.5 当时的暂放决定，L542 记述本次更正本身）；**原承诺位（§4.5 段首，原 L265）已零残留**——即「作为未兑现承诺的活体陈述」计数 = 0。
> ⑥ **版本号提升 v0.6 → v0.6.1（attempt 2 补）**：attempt 1 已落盘 v0.6 标题，但 attempt 2 在同一承载任务（t87）内新增了④⑤两处更正（失实声明更正 + 自相矛盾消除）。按章程「修订必须可追溯」，同任务内的后续更正以 **v0.6.1** 标识，避免 attempt 1 落盘态与 attempt 2 终态共用同一版本号导致复核歧义（t84 的 F8 即基线歧义教训的同型预防）。README 索引行同步为 v0.6.1。
> 其余章节零改动。F1 补录三条（上一版已落盘）继续有效；round 2 复核（t84）的 F2-F6 闭环结论在其 output 中已确认（「F1-F6 六项在 v0.4 全部闭环且为本人亲手验证」），round 3（t88）增量核对范围 = F7 五项 + v0.5/v0.6/v0.6.1 新增段 + 指纹链。
>
> **t87 attempt 2 终态（v0.6.1 基线）· F9/F10 更正（t89 承载；v0.7 下已非自指，可安全落盘）**：`README.md` 于 v0.6.1 时点实测 = SHA256 前 12 位 **`33066B5F406F`** / 4759 B / 44 行（v0.7 下 README 已再修订至 `5D017F3DFFB8`，见下条；原写 `53E45BCC5EC9`/4757 B 为 t87 编辑中途的过期采样值，失实——F9，已更正为实测值）。`detach-p2-scheduler-design.md` v0.6.1 终态 = **`807603ACDBF9` / 74757 B / text lines 547（LF 546, CR 0, 无 BOM）**（原写「545 行（LF 545）」失实——F9：LF 实测 546；**行数权威口径 = count-lines.mjs 的 text lines（分割计数 = LF+1，2026-09-12 实测输出 `text lines : 547`，exit 0）**，LF 与 text lines 两值并存注明以消歧义，不得以 LF 充当行数）。基线演进链（口径：bytes/行数均为字节级 count-lines）：`45383FAF4D3E`/495 行（v0.4 · t82 交付）→ [`2AF8B687F19D`/501 行 = t84 复核期间采样的 t86 修订序列中间快照，非交付版本] → `AF4A2FD101FB`/535 行（v0.5 · t86 交付终态）→ **v0.6.1（t87 attempt 2 交付终态）**（F10 更正：原「本版（v0.6）」版本号与 t87 attempt 2 的 v0.6.1 标识不符）。
>
> **v0.7 修订（2026-09-12，承载依据 = t89 repair 正式派单——队长裁定：t88 的 F9/F10 与 t89 四项合并为一次 v0.7 收口修订，随后一轮复核冻结、进入 P2 实现）**：前版基线 = **v0.6.1（`807603ACDBF9` / 74757 B / text lines 547（LF 546））**。本版六项落位：①**F9** 上条 v0.6.1 终态块两处失实更正（README `53E45BCC5EC9`→实测 `33066B5F406F`；行数「545（LF 545）」→「text lines 547（LF 546）」按 count-lines 权威口径并存注明）；②**F10** 演进链「本版（v0.6）」→「v0.6.1」、标题同步 v0.7，全文版本引用核查（历史引述 v0.4/v0.5/v0.6/v0.6.1 保留其史料动因，本版引用全部为 v0.7）；③**§4.3** 补 standby 新代 reclaim 窗口保守封死明示句（`status===undefined`→false）；④**§10** 新增 E15「复核窗口文档只读的机制化」（review 任务 claim 时快照 file→sha256 入任务记录、update_task 完成时自动比对、不匹配即警告）；⑤**§9.1.1** 误用识别表增第 4 行（captain 会话 `agent_teams_*` tool/call → feed 层即时识别〔复用 t17 订阅，零新增读〕→ /state 标注 foreign-action + 提醒，处置人工）+ 残余风险声明升级（过渡期 AgentTeams 调度器仍运行 → 误用造成**真实双调度**：旧成员被真实派活/消耗配额/双账本分裂，发现窗口无增强可达数天）；⑥**README 索引行同步 v0.7**（本批同改）。**本版 README** = SHA256 前 12 位 **`5D017F3DFFB8`** / 4775 B / 44 行（同批实测）。`detach-p2-scheduler-design.md` **自身终态指纹由任务 t89 output 承载**（本文件自指：任何写入本文件的指纹值都会立即使自身失效，故不写自指哈希，改由任务 output 记录权威值）；其行数口径同前（count-lines text lines = LF+1，以 t89 output 实测值为准）。其余章节（§0–§12 正文）零改动；diff 边界 = 落盘记录 / §4.3 / §9.1.1 / §10 / 标题版本引用，无夹带。
