# 队长工具面调研（captain-tool-surface）

> **任务**：t48（产出任务 output）→ **t55（本文件落盘）**。t48 结论原只活在任务 output，本文件使其可留存、可复核、可引用（t55 忠实转写 + 落实口径修正）。
> **统计快照口径**：本文数字基于 **2026-09-11 11:43:42 快照**，全量扫描 `C:\Users\bo.yang02\.dsh\sessions` 下 **44 个 `session.jsonl.zstd`**（3 目录组：`--E-DSH_Desktop-DSH~0020Desktop--` 27 + `--F-SomeAgentProjects-dsh-work--` 8 + `--D-deepseek-harness--` 9），**非抽样**。
> **快照偏差声明**：t48 原统计（约 09-10 晚）为 **528 次调用**；本快照为 **575 次**——差异为**日志持续追加**（会话仍在运行），非统计口径变化。**凡涉及「零调用」的结论，必须绑定本快照时刻；跨快照比较时须重扫。**
> **免责**：样本 = 本团队「多角色协作团队」的运行记录；**本文结论只对样本内成立**，不构成对全局工具价值的绝对判断。
> **观察者效应（t60 补充）**：**观测者本身也在样本内。** 样本日志包含**本会话（多角色协作团队）自身运行产生的全部活动**——包括队长、成员、审查员在本团队内的所有 `agent_teams_*` 调用。
> **`edit_plan` 那 1 次的归属（已核实，非推断）**：全量 44 文件中，`agent_teams_edit_plan` 作为 `tool/call` 事件**仅 1 次**，位于会话 **`f83714c9-bbf`（本团队 captain 主会话）**；其前后工具序列为 `prev=[reassign_task, update_task, create_task, create_task, status]`、`after=[send_message, send_message, pwsh, read, grep]`——**队长操作特征**（create/reassign/status 为队长侧工具）。**证实：该 1 次调用来自本会话队长自身**（尝试以 `remove_task t50` 编辑 staged plan，被运行时以「team is already running」拒绝）。
> **推论（对结论强度的影响）**：因此本统计**包含被统计者自身的动作**——「样本内零调用」（approve/remove_member/resume）的口径**必须同时说明「样本包含本会话自身活动」**。**一个把自身活动算进去的统计，不能用来证明「这个工具没人用」**——只能证明「在本团队本快照的活动集合里未出现」。`edit_plan` 从零到 1 正是此效应的实证（样本内出现过一次队长主动尝试）。

---

## 1. 总览（本快照）

- **总调用**：575 次 `agent_teams_*`
- **使用过这些工具的会话**：13 个（其中 3 个为队长侧，见 §3）
- **按工具频次排序**：

| 工具 | 次数 | 归属 | 定性（样本内） |
|---|---|---|---|
| `agent_teams_send_message` | 199 | 队长+成员 | 高频·协作主通道 |
| `agent_teams_update_task` | 134 | 队长+成员 | 高频·状态推进 |
| `agent_teams_create_task` | 75 | 队长 | 高频·任务分派 |
| `agent_teams_status` | 74 | 队长+成员 | 中频·状态观察 |
| `agent_teams_claim_task` | 63 | 成员 | 中频·认领 |
| `agent_teams_reassign_task` | 12 | 队长 | 低频 |
| `agent_teams_add_member` | 11 | 队长 | 低频 |
| `agent_teams_create` | 5 | 队长 | 低频 |
| `agent_teams_edit_plan` | **1** | 队长 | 低频（t48 时为零，本快照新增） |
| `agent_teams_delete` | 1 | 队长 | 低频 |
| `agent_teams_approve` | 0 | — | **本快照样本内零调用** |
| `agent_teams_remove_member` | 0 | — | **本快照样本内零调用** |
| `agent_teams_resume` | 0 | — | **本快照样本内零调用** |

> **口径修正 1（队长要求）**：`approve` / `remove_member` / `resume` 在**本快照、本样本内为零调用**——这是**样本内事实**，**不构成「这三工具无价值」的全局结论**。样本内零调用 ≠ 全局无价值（例如：approve 在本团队是 approval=automatic 配置，approval=required 的团队仍会用到；resume 在 halt 场景才会出现，本样本未 halt 故零调用）。**P4 取舍必须以「样本内零调用」表述，不得绝对化。**
> `edit_plan` 在 t48 原快照为零、本快照为 1——**自身证明了「零调用」结论的快照敏感性**。

---

## 2. 语义分层（样本内，统计支撑）

### 2.1 不可替代（调用重度 + 语义核心，P4 必须自研）

1. **任务 DAG 分派**（`create_task`，本快照 75 次）：
   - **45% 带 dependencies**（33/74，另计一次缺省）→ 依赖 DAG 是真实高频语义，不能退化为纯消息
   - **96% 带 assignee**（71/74）→ 定向派发是主流
   - **100% 带 subject**（74/74）
2. **attempt 防 stale**（`update_task`，本快照 134 次）：
   - **96% 带 attempt_id**（128/134，**6 次未带**）→ attempt 语义被一致遵守，但**存在绕过路径**（6 次未带）——正是 t47/t51 设计要兜住的
3. **定向唤醒**（`send_message`，本快照 199 次，最高频）→ 队长/成员定点消息是协作主通道

### 2.2 可自动化或约定取代（样本内低频）

| 工具 | 次数 | 替代思路 | 依据（样本内） |
|---|---|---|---|
| `create` / `add_member` | 5 / 11 | 路由提示层（routingText 改造）承载建队 | 建队是低频一次性操作 |
| `reassign_task` | 12 | P1 的 release+claim 可自动化（队长按钮一键重派） | 低频 |
| `status` | 74 | 轮询化 → /state 投影（t47 §6）替代 | 可被动可读 |
| `delete` | 1 | 并入约定 | 低频 |
| `edit_plan` | 1 | 可并入约定（staged 计划编辑低频） | 低频（本快照才出现） |

### 2.3 本快照样本内零调用 → P4 不做等价实现的候选

- `approve` / `remove_member` / `resume`——**本快照内零调用**。
- ⚠️ **口径修正（队长要求 1）**：以上为**样本内结论**；P4 取舍文档必须写「本团队本快照样本内零调用」，不得写「无需实现」或任何绝对判断。**若 P4 面向其他团队/其他批准模式（approval=required）/其他 halt 场景，必须重新评估。**
- **观察者效应关联（t60）**：此「零调用」结论受**样本包含本会话自身活动**约束（§0 观察者效应）——`edit_plan` 从「零」到「1」正是本会话队长主动尝试产生的样本内变更。因此「零调用」**不构成「无人使用」的证据**，仅构成「本团队本快照活动集合内未出现」；P4 取舍必须按此弱化口径。

---

## 3. 队长侧 vs 成员侧（本快照）

- **队长侧会话（3 个，用过 create/add_member/reassign）**：
  - `f83714c9-bbf`（主队长）：create=3, add_member=5, create_task=70, status=21, send_message=66, reassign=11, update=8, edit_plan=1
  - `044e1625-b3b`：create=1, add_member=3, create_task=3, status=6, reassign=1, send_message=1, delete=1
  - `5de94cc2-f56`：create=1, add_member=3, create_task=2, status=1
- **成员侧会话（10 个）**：仅用 claim_task / update_task / send_message / status。
- **结论（样本内）**：队长工具面 = 建队 + 分派 + 状态 + 重派 + 消息；成员工具面 = 认领 + 状态推进 + 消息 + 观察。**分界与「队长/成员职责边界」完全对应**。

---

## 4. errors=0 的解读（口径修正 2）

t48 原统计 errors 全 0。**必须带原始口径解读，不得泛化**：
- **事实**：本样本内 `agent_teams_*` 的 tool/result 均无 error（errors=0）。
- **关键限定**：**孤儿事故（t5/t8）发生当时，工具 errors 同为 0**——t5/t8 是「成员回合中止 → 任务残留 claimed」，发生在**工具返回成功之后**，工具自身不报错。
- **因此「errors=0」不能推导为「机制安全」**：它只说明「工具调用本身都执行成功」，不说明「调度/状态机没有产生孤儿/死锁」。
- **对本设计的含义**：质量门/孤儿检测**不得依赖工具错误码**（errors=0 ≠ 无孤儿）；必须独立于工具错误码做验证（对照可复现的孤儿场景，如 t22 的反例）。

---

## 5. 坑 → 保护设计（统计映射，样本内）

| 今日坑 | 统计证据（本快照） | 保护设计（t47/t51） |
|---|---|---|
| 作废依赖死锁（t6） | create_task 45% 用依赖 → DAG 是真实语义 | supersededBy 链（作废非 terminal，解锁按 producer terminal，§3 t51） |
| 孤儿 claim（t5/t8） | update_task 6/134 未带 attempt_id → 存在绕过 attempt 的路径 | reclaim 谓词 = 宿主侧 lastSignalAt（非自报）+ claim lease 超期回收（§4 t51） |
| 判别力（t30） | errors=0 但孤儿已发生 → 工具错误码不可作质量门依据 | 质量门独立于工具错误码；验证需能变红的对照（AGENTS.md §2） |
| attempt 语义 | 96% 遵守 + 4% 违反（6/134） | attemptId + lease 自动归还 = 违反者自愈（§4 t51） |

---

## 6. 给用户的「调研结果决定」落点（样本内）

- **队长工具面最小集 = 4 个**：`create_task`（DAG）/ `update_task`（attempt）/ `send_message`（唤醒）/ `status`（可读）——**本快照覆盖 (75+134+199+74)/575 = 482/575 ≈ 84%** 的调用且语义核心。
  - ⚠️ 口径：84% 为**本快照**数字；其他工具（claim 等）也会被保留为成员面，故「最小集」指**队长面**而非全集。
- **本快照样本内零调用 3 工具**：approve / remove_member / resume —— **候选不做等价实现**（样本内依据）；如 P4 覆盖其他团队形态，须重评估（口径修正见 §2.3）。
- **低频 5 工具**：create / add_member / reassign / delete / edit_plan —— **交约定或自动化**（样本内低频）。
- 与 t47/t51 API 形状对齐：/team-tasks/claim|update|release（P1）+ supersede/reassign（P2），队长侧承载 create_task 等价物。

---

## 7. 已验证 vs 推测（口径诚实）

- **已验证（本快照全量扫描）**：575 次调用分布、13 会话、队长/成员侧分离（3/10）、create_task 依赖/assignee/subject 使用率（45%/96%/100%）、update_task attempt 使用率（96%）、三工具样本内零调用（approve/remove_member/resume）、edit_plan 样本内 1 次。
- **推测/需注意**：
  - 「errors=0 → 机制安全」**不成立**（孤儿发生时 errors 同为 0，实测 t5/t8）——这是**已验证的反例**，不是推测。
  - 「84% 覆盖」等比例**随快照变化**（日志持续追加）；**比例关系（依赖/assignee/attempt 使用率）稳定**，不随样本增大翻转。
  - P4 面向其他团队/其他批准模式时的工具需求 = **推测**（本样本未覆盖 approval=required 团队、halt 场景）。

---

> 落盘：t55（2026-09-11 11:43:42 快照）。t48 结论忠实转写 + 队长口径修正落实：①「零调用」绑定本快照样本内；② errors=0 绑定孤儿发生时 errors 同为 0；③ 口径完整（44 会话 / 575 次 / 13 会话 / 快照时刻）。数字可复核：重扫脚本（%TEMP% 已清理）同法可得。