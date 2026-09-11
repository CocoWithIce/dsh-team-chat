# P1 状态层自研设计稿（修订版 · 待评审）

> **任务**：t47 初稿 → t49 对抗性复核（needs_revision）→ **t51 修订落盘**
> **状态**：**待队长/用户评审**。本文档是用户要亲自审的地基，全部结论标注「已验证 / 推测 / 需实测」。
> **范围**：P1 状态层的独立 schema、状态机、依赖失效、可判定性（含 reclaim）、API、持久化、过渡期共存、待决策点。
> **关联**：t42（脱离可行性）/ t46（生效链路实测）/ t48（队长工具面统计）/ t22（孤儿检测）/ t17（事件订阅）/ t19（步骤投影）。

---

## 0. 修订版核心变化（相对 t47 初稿）

| 项 | t47 初稿 | t51 修订版 |
|---|---|---|
| reclaim 依据 | 成员自报 `startedAt` + claim lease | **宿主独立观测的 agent 活动**（`ctx.agents.get(id).status` + 全局 `session/event`），不信任自报 |
| 依赖环/自依赖 | 未检测 | **建任务时拓扑排序拒绝环与自依赖** |
| 状态写 | 无版本控制 | **CAS/版本号**（revision 字段）防后写覆盖 |
| supersede 链 | 无限遍历 | **visited 集合 + 最大深度**防环/过长 |
| `dependencySuperseded` | 未定义下游行为 | **带戳继续**（附依赖作废戳，不阻塞下游，供人工复核） |
| 双执行（S7B） | 有 lease 但依赖自报 | **reclaim = 独立活动判据 + 原子化中断确认**；中断不可确认则 `suspended` 不回收 |
| running 停滞 | 仅标记（可永久持有） | **心跳续租 → `suspended` 需人工裁决**（三选一出口，修法⑥） |
| `suspended` 误判 | 未定义 | **保留 activity 续租**：观测到新活动自动回 running（修法⑦） |

> **修法数量**：t49 verdict 后修法从 5 条扩到 **7 条**（审查员新增 ⑥⑦）；**v4（F4）再补一核心修正（⑧）**：
> ① 建任务 topo sort 拒环/自依赖；② 状态写 CAS 抗竞态；③ supersede 链 visited + 深度上限；④ **lease 以宿主侧 `lastSignalAt` 为核心（非成员自报 `startedAt`）+ 到期先 cancel 原成员再放行**；⑤ `dependencySuperseded` 下游行为明确；⑥ running 停滞 → **`suspended` 需人工裁决**（非仅标记）；⑦ **即使 `suspended` 也保留 activity 信号续租防误判**；⑧ **`hostObservesIdle` 用平台派生 `stateOf`（agent.status + accepted + ownedChildren）而非裸 `agent.status`**——裸 status 在 accepted→admitted 窗口不足承重（F4-b，dsh-subagent/index.js:1361-1370）。

---

## 1. 任务模型 schema（纯结构）

```jsonc
TaskRecord {
  // ── 标识与内容 ──
  "id": "t<seq>",                 // 单调
  "seq": 3,
  "kind": "work|verification|review|repair|integration",
  "subject": "…",
  "objective": "…",
  "inScope": ["…"],               // 验收边界（可读）
  "acceptance": ["…"],            // 验收标准（可读）
  "verify": ["…"],                // 验证命令（可读）
  "dependencies": ["t1","t2"],    // 依赖任务 id（建任务时拓扑校验）
  // ── 状态机 ──
  "status": "pending|claimed|running|completed|failed|superseded",
  "assignee": "researcher",
  "claimedById": "session-uuid",  // 认领身份（防误认领）
  "attemptId": "uuid",            // 每次尝试的能力 id（防 stale）
  "attempt": 2,                   // 尝试代数（1 起）
  "revision": 5,                  // ★ CAS 版本号：每次状态写必须带期望 revision
  // ── 时间戳（全部为宿主写入，非成员自报）──
  "openedAt": 1726000000000,
  "claimedAt": 1726000001000,     // claim 时刻（宿主）
  "startedAt": null,              // 首次可观测活动时刻（宿主观测，见 §5）
  "lastSignalAt": 1726000003000,  // 最近宿主可观测活动时刻
  "supersededBy": null,           // 作废继承链（superseded 时指向替代任务）
  "dependencySupersededAt": null, // ★ 依赖作废戳（带戳继续时写入）
  "dependencyFailedAt": null,     // 依赖失败戳（标记，不阻塞）
  // ── 阈值与标记 ──
  "claimLeaseMs": 600000,         // 建议初值 10min，需实测调校
  "stallThresholdMs": 600000,     // 建议初值 10min，需实测调校
  "stallMarked": false,           // ★ 已标「疑似停滞」供人工确认
  "suspended": false,             // ★ 中断不可确认时置真，需人工裁决
  "createdAt": 1726000000000,
  "updatedAt": 1726000003000
}
```

**与 AgentTeams 的差异（我们能表达而它不能的）**：
- `revision`（CAS）——AgentTeams 无版本，`updatedAt` 后写覆盖先写（S5 根源）
- `claimedAt` / `lastSignalAt`（宿主观测时间戳）——AgentTeams 无时间戳，无法判定停滞
- `supersededBy` / `dependencySupersededAt` / `dependencyFailedAt`——AgentTeams 作废即 terminal，无法传递失效语义
- `stallMarked` / `suspended`——AgentTeams 无人工裁决通道

---

## 2. 状态机（含四死角修正）

```
pending ──claim(宿主记录 claimedAt)──► claimed ──首次可观测活动──► running ──► completed
  ▲                                     │        │                  │
  │  release / reclaim(独立证据)        │        │                  ├─► failed
  └─────────────────────────────────────┘        │                  └─► superseded(supersededBy)
                                                  └─ 有活动后静默 ──► stall(疑似) ──suspended(人工)

状态说明：
- pending → claimed：成员 claim；宿主写 claimedAt + attemptId + revision++
- claimed → running：**宿主**观测到该成员首次可观测活动（不是成员自报 startedAt）
- running → completed/failed/superseded：成员 update_task 带 attemptId + revision（CAS）
- running → stall：lastSignalAt 超阈值 且 宿主观测 agent activity ≠ 进行中（**疑似**，供人工确认）
- stall → suspended：人工确认中断不可靠 → 置 suspended，**不回收**（防双执行）
- stalled/suspended → completed/failed：原成员回来结算（attemptId 仍有效）
```

### 2.1 四死角的状态机处置（每条可在状态机层面证伪）

**S1 依赖环 / S2 自依赖** → **建任务时拓扑排序拒绝**：
- `createTask` 必须满足：`dependencies` 中无自身、无环（Kahn 拓扑对全任务图跑一遍，失败即拒绝）。
- 状态机层面证伪：`taskOpen(t) = pending && 所有依赖 terminal`，若环存在则 `taskOpen` 永假 → 拓扑排序保证环不可建，`taskOpen` 永假不可达。
- **实现位**：DAG 校验在 `createTask`/`editPlan` 原子写入前执行（同 t48 的 create_task 语义）。
- **S11 范围澄清（v4.1）**：
  - **适用范围 = 本 schema 的全部任务入口**：`createTask`（新增）+ `editPlan`（批量改依赖）+ `supersedeBy`（作废链，§2.1 S6 的 visited+深度另管）——三处任一改动全任务图跑 Kahn，拒绝环/自依赖。
  - **干净重来前提（不悬空）**：本 schema 是新起点，**不迁移/不读取 AgentTeams 的既有 DAG**（t42 干净重来裁定：不做任务语义迁移）；环检测只对**我们自建任务**生效，与 AgentTeams 现有任务图无耦合。**脱离完成后（P4）** AgentTeams 任务不存在，环检测覆盖全集。

**S3 依赖作废（解锁 OK，下游行为未定义）** → **选择「带戳继续」**：
- 理由：作废（superseded）语义 = 「此任务不再需要，但依赖方不必等它」。若「暂停复核」则作废一次影响整条下游链，且 AgentTeams 语义中作废本就是「释放下游」。
- 处置：下游解锁条件 = 所有依赖 terminal（含 superseded）；当依赖为 superseded 时，下游写入 `dependencySupersededAt` 戳（**不阻塞**），/state 投影中标注「依赖已作废」供人工复核。
- 证伪：`dependencyBlocked(t) = deps.some(!terminal)`；superseded 属于 terminal → 作废的依赖不再阻塞下游。**不再需要第 2 个谓词**。

**S5 作废 vs 完成竞态（后写覆盖）** → **CAS/版本号**：
- 每次状态写必须携带 `revision`，实现 `compareAndSet(task, expectedRevision, next)`；不匹配即拒绝（`stale-revision`）。
- 证伪：两个并发写（如作废 vs 完成）各自带不同 revision，后到者因 CAS 失败被拒，**不可能后写覆盖先写**。
- 示例：running@r5，A 提交 completed@期望r5，B 提交 superseded@期望r5 → 先到者成功 r6，后到者收到 stale-revision 需重读。

**S6 supersede 链成环/过长** → **visited 集合 + 最大深度**：
- 遍历 `supersededBy` 链限制：visited 去重 + `MAX_SUPERSEDE_DEPTH = 16`（建议初值，需实测）。
- 证伪：深遍历在 visited 或深度上限处终止，**不存在无限循环**。
- 作废时若目标链已含待作废任务的 id → 拒绝（防 A→B→A）。

**S7B 双所有者（最重要）** → **reclaim 谓词 = 宿主独立观测 + 原子化中断确认**（见 §5，本节只给状态机层面处置）：
- 状态机保证：**reclaim 后原任务回 pending 的前提 = 宿主确认原成员已无可观测活动且（若在跑）中断已确认完成**。
- 两个出口：① 中断可确认 → 原子化「cancel 原执行 → 确认终止 → 回 pending」；② 中断不可确认/不可靠 → 置 `suspended`（**不回收**，需人工裁决）。
- 证伪：**双重执行 = 同一任务同时有两个 owner 在跑**。我们在 running 期不 reclaim（只标 stall）；在 claimed 期 reclaim 必先确认无活动；suspended 不回收 → **双执行在状态机定义上不可达**。

---

## 3. 依赖失效语义（修订）

```
terminal = completed | superseded | failed
dependencyBlocked(t) = t.dependencies.some(id => ¬terminal(tasks[id].status))
taskOpen(t) = pending && ¬dependencyBlocked(t)

// 依赖失效传导：
//  superseded → 上游 terminal，下游解锁 + 写 dependencySupersededAt（带戳继续）
//  failed     → 上游 terminal（失败），下游解锁 + 写 dependencyFailedAt（标记，不阻塞，供复核）
//  注意：failed 也是 terminal → 依赖失败不再堵死下游（t6 死锁的完整消除）
```

**约束 1（t6 修复，状态机定义排除）**：`superseded` 与 `failed` 均属 terminal，依赖解锁条件 = 提供者 terminal 而非仅 completed。作废/失败的依赖**不再堵死下游**。

---

## 4. 可判定性：reclaim 谓词（§2 的 S7B 处置细化）

### 4.1 判定依据（采纳队长输入：**宿主独立观测，不信任成员自报**）

**谁**：宿主（dsh-team-chat host half），非成员、非 AgentTeams。
**承重字段与其层次（v4.1 澄清 F2b——字段二态 ≠ 工具列表面三态）**：
- **承重字段 = `ctx.agents.get(memberId).status`（驱动层 agent status）**，取值域 = **`idle | running` 二态**（`dsh-agent-loop/lib/index.js:385-387`：`get status() { return this.phase.kind === 'idle' || 'maintenance' ? 'idle' : 'running' }`）。
- **`ready` 属于另一层（工具层合成态）**：`dsh-tool-subagent-control/lib/types/list-agents.js:24-28` `statusOf`：`agent === undefined → 'ready'`；`status === 'running' → 'running'`；否则 `'idle'`。⇒ **`ready` = 「没有 live agent / `get(id) === undefined`」时由工具层合成的展示态，不是 getter 的取值**；`:86` 的 `enum: ['running','idle','ready']` 是**工具 schema**（列表面描述），不是 getter 取值域。**不要把工具层枚举当作 getter 字段的取值域。**
- **`working` 全文已清除**（t62 全文件零命中，有效引用 0；仅保留「不存在」溯源声明），平台不存在该枚举值（同类缺陷第三次：① `--dsh-*` ② `error.message` ③ `working`）。
- ⚠️ **层次纪律（本轮冲突的根因沉淀）**：引用平台状态时必须写清字段与层次——`agent.status`（驱动层 getter，二态）≠ 工具列表面 status（工具层，三态含 ready，`ready` 为 `get(id)===undefined` 的合成态）≠ 派生 `stateOf`（ residency 层，running/waiting/settled）。本轮 F2b 冲突正是两个成员引用了不同层的枚举；不写清层次，未来读者会再犯。
- **⚠️ 盲区转移（v4.1 显式关闭）**：真正的盲区是 **`get(id) === undefined`**——此时读 `.status` 会 **TypeError**（无 live agent）。v4/v4.1 的 `hostObservesIdle` 用 `stateOf(...) === 'settled'` 处理：`stateOf` 在无 live agent / 无 accepted / 无 ownedChildren 时返回 `settled`（`dsh-subagent:1366-1370`）→ **该盲区已由「undefined → settled」显式关闭**（不再可能出现 getter TypeError）。**注意**：关闭 getter 盲区 ≠ 等效探针覆盖 accepted→admitted 窗口已证——等效探针（turn/start 作已 admitted 信号）仍标「需实测」（§11）。
- **独立证据**（全部宿主侧、不可由被保护对象伪造）：
1. `ctx.agents.get(memberId).status`（驱动层，二态 idle|running）。
2. **⚠️ F4-b（决定性）：裸 `agent.status` 单独不足承重**——`dsh-subagent/lib/index.js:1361-1364` 平台注释原文：
   > "`Agent.status` alone is insufficient: it stays `idle` between an accepted waking send and the microtask that admits it, so a synchronous inbox observer would see `settled` while a turn is already queued. `accepted` holds the ids this manager admitted but has not yet seen drained."
   即：**「已唤醒但回合未 admitted」窗口内 status=idle**（正是 t5/t8 卡死形态窗口），单看 status 会误判。
   → **修法（采纳审查员）**：`hostObservesIdle` 改用平台的**完整派生 `stateOf(activation)`**（`dsh-subagent/lib/index.js:1366-1370`：`agent.status==='running' || activation.accepted.size>0 → 'running'；ownedChildren.size>0 → 'waiting'；否则 'settled'`），或等效的「该 agent session 是否有进行中请求」探针。使「刚唤醒」窗口返回 **false（不回收）**。
   - **等效探针依据（需实现时给源码证据）**：`stateOf` 的 `accepted` 集合是平台内部由该 manager 维护的 admitted 未 drained id 集合（`:1364`）——若我方无法直读它，需用 session/event 的 `turn/start` 出现作为「已 admitted」信号；**该等效方案需实测确认覆盖窗口**。
   - **hostObservesIdle 对第三态的处置（v4.1 明确，不许留空）**：当前 `agent.status` 二态（idle|running）、`stateOf` 三态（running/waiting/settled）下无歧义。**若未来平台新增第三种取值**（如引入区别于 idle 的 paused）：处置规则为**任何「非明确 ongoing（类 running）+ 非明确 settled」的未知取值一律视为 NOT-idle（不回收）**，并记录为需人工复核的未知态——即**未知取值偏保守（不回收）**，宁可人工裁决也不冒险回收在跑任务，此规则写入实现时须作为显式分支。

### 4.2 reclaim 谓词（正式定义 · v3 修订：覆盖两种残留的出口路径，声明与定义一致）

```
// ★ v3 修订：reclaim（回 pending）只对 claimed 残留开放；
//   running 残留走 suspended（人工裁决），不 reclaim（防双执行）。
//   「两种残留都有出口」由两条路径共同保证，不是 canReclaim 单谓词。
// ★ v4 修订（F4-b）：hostObservesIdle 不用裸 agent.status——用平台的派生
//   stateOf（agent.status + accepted + ownedChildren，dsh-subagent/index.js:1366-1370）
//   或等效「有无已 admitted 未 drained 请求」探针。刚唤醒窗口（accepted>0）必须为
//   「不 idle」，否则恰在 t5/t8 卡死形态窗口误回收。

hostObservesIdle(memberId) :=
     stateOf(memberId) === 'settled'    // ★ 平台派生：非 running、非 waiting、无 accepted
  // 或等效探针：该 agent session 无可观测的已 admitted/进行中请求

canReclaim(task) :=
     task.status === 'claimed'                 // ★ 只有 claimed 可回收回 pending
  && now - task.claimedAt > claimLeaseMs       // 认领后空转超期
  && hostObservesIdle(task.assignee)           // ★ 平台派生 stateOf==='settled'（非裸 idle）
  && hostObservesNoRecentSignal(task, now - stallThresholdMs)  // ★ 无消息级活动超过阈值

// running 残留的出口（不 reclaim，防双执行）：
runningResidualExit(task) :=
     task.status === 'running'
  && hostObservesIdle(task.assignee)           // 平台派生 stateOf==='settled'
  && hostObservesNoRecentSignal(task, now - stallThresholdMs)
  → stallMarked → (人工确认) → suspended → (人工三选一或超时升级，§5)
```

- **claimed 但无任何可观测活动** + 超 lease + 宿主观测 idle → **可回收**（真没人干）。
- **claimed 但宿主观测到活动** → **永不回收**（成员活着，双执行在结构上不可能）。
- **running 后有活动又静默** → **stall（疑似）→ suspended（人工）**（既不双执行，也不永久孤儿）。
- **⚠️ v3 修正（F1）**：**running 残留（in_progress 卡死）不 reclaim**——reclaim 会「回 pending 让新成员认领」，而原成员若还在物理执行则双执行。running 残留必须走 **stall → suspended 人工裁决**（有出口，不永久挂着）。「两种残留都有出口」= canReclaim（claimed）+ runningResidualExit（running 走 suspended）**两条路径共同保证**，不是 canReclaim 单谓词覆盖 in_progress。这与 §10 Q1 处置的声称一致。

### 4.3 S7B 原子化处置（双执行的结构性排除）

- **路径 A（中断可确认）**：`reclaim` 触发 → 宿主发给原成员的 `interrupt`（`ctx.subagents.interrupt`）→ **等待中断确认（agent.status 变为非进行中）** → 才允许任务回 pending。
  - 若等待超时（`INTERRUPT_CONFIRM_MS`，建议 15s，需实测）→ 降级路径 B。
- **路径 B（中断不可确认）**：置 `suspended = true`，**不回收**；/state 标注「需人工裁决」；原成员回来用原 attemptId 结算。
- **两条路径都不允许「只记账回收而物理执行还在跑」**——这正是双执行的根源，状态机层禁止。

### 4.4 与 `startedAt` 的关系（修正 t47）

- `startedAt` 仍保留，但**仅作状态记录**（首次可观测活动时刻），**不作为 reclaim 判定的门槛**。
- reclaim 判定的完整依据是 §4.1 的宿主观测三元组；`startedAt` 只是其投影。
- **Q2（自报绕过）结构性失效**：成员卡住时无法伪造 `ctx.agents.get` 状态，也无法伪造宿主 session/event 订阅的活动事实 → 自报 `startedAt` 不再赋予无上限持有。

### 4.5 修法⑦：`suspended` 也保留 activity 信号续租（防误判）

- **问题**：若 `suspended` 一旦置位就永久冻结，而原成员其实还活着（只是活动短暂静默），会误判为「真死」。
- **修法⑦（审查员）**：**`suspended` 不冻结 activity 续租**——即使已标 `suspended`，宿主仍持续写 `lastSignalAt`（来自 §4.1 的独立观测三元组）。
  - 若 `suspended` 后**又观测到新活动**（原成员还在跑）→ **自动回 running**（续租成功，防误判），不清空 attemptId。
  - 若 `suspended` 后持续无活动超过 `SUSPENDED_SETTLE_MS`（建议 5min，需实测）→ 才允许队长「恢复/reassign/supersede」三选一。
  - **无人裁决的最终出口**：队长一直不处理，超过 `SUSPENDED_UNATTENDED_MS`（建议 30min，需实测）→ 自动转 `superseded`（§5 详述；下游自动解锁）。**「永远挂着」不可达。**
- **证伪**：`suspended` 是有出口的中间态（活动回来→回 running；持续静默→人工三选一；无人处理→超时自动 superseded），**不是无出口僵尸**；误判窗口被 activity 续租压缩到 `SUSPENDED_SETTLE_MS` 内，无人场景被 `SUSPENDED_UNATTENDED_MS` 收口。
- **新增待决策点**：`SUSPENDED_SETTLE_MS`（建议 5min）——归入 §9 D 表。

---

## 5. 停滞判定（保留 t47 + t22 基础，标注不确定性）

```
stallMark(t) :=
     t.status === 'running'
  && now - t.lastSignalAt > stallThresholdMs
  && hostObservesIdle(t.assignee)          // 宿主观测，非成员自报
```

- 触达 → `stallMarked = true`，UI 标「**疑似停滞**」（不是「已停滞」）→ 人工确认 → **队长三选一**：
  - **恢复**（带 `revision` stale 校验，原 attemptId 继续）→ 回 running/claimed；
  - **reassign**（带 `revision`）→ 任务重派；
  - **supersede**（带 `revision`）→ 作废，走 §2.1 S6 的 visited+深度链。
- **⚠️ v3 修订（F3）：`suspended` 不能「无人处理就永远挂着」——需真正的超时升级路径**：
  - `suspended` 置位后，若**无人裁决**，超过 `SUSPENDED_UNATTENDED_MS`（建议 30min，需实测）→ **自动转 `superseded`**（作废，`supersededBy` 指向空或重建提示；依赖下游按 superseded 属 terminal 解锁）。
  - **下游影响**（写明）：依赖该任务的下游自动解锁（superseded 属 terminal）；原成员若后续回来，用原 attemptId 提交会收到 **stale-revision/已作废** 拒绝（CAS 保护）；`/state` 记录「suspended 无人裁决自动作废」。
  - **S10 桥接（v4.1，与 §6 逐字一致）**：自动 superseded **复用 §6 的 `/team-tasks/supersede` 端点与同一 CAS 语义**——即 `{ taskId, supersededBy, revision }`，`revision` 必须携带（首写时 = 当前任务 revision），宿主用 `compareAndSet(task, expectedRevision, superseded 态)` 校验；不匹配即拒绝（`stale-revision`）并**不落作废**（重读后重试）。§5 此处讲的「CAS 保护」= §6 :251 的**同一规则**（所有 POST 带 revision + compareAndSet），非两套。
  - **证伪**：`suspended` 存在**两条出口**（人工三选一 + 无人时超时自动 superseded），**不存在无出口挂起**——「永远挂着」在状态机上不可达。
- 误报源（t22 §4）：深度长推理无消息级事件、刚 claim 首回合无消息窗口 → 阈值可调 + 人工确认兜底。
- **不确定性标注**：`stallThresholdMs` 10min 为**建议初值需实测**；stall 仅「疑似」；`SUSPENDED_UNATTENDED_MS` 30min 为**建议初值需实测**。
- **修法⑥（审查员）**：running 停滞**不是仅标记**——必须转 `suspended`（需人工裁决）才停；「人工确认→恢复/reassign/supersede」+「无人时超时自动 superseded」是 suspended 的**显式出口**（永不自动回收在跑任务 → 无双执行；suspended 有出口 → 无永久孤儿）。

---

## 6. API 形状（P1 host route）

```
GET  /state?sessionId=          → 增 tasks[] 投影（id/status/assignee/deps/revision/停滞标记/suspended）
POST /team-tasks/claim          → { taskId }                  → { attemptId, claimedAt, leaseExpiresAt }（CAS，见下）
POST /team-tasks/update         → { attemptId, revision, status: running|completed|failed }
POST /team-tasks/release        → { attemptId }               → 显式归还 pending（CAS）
POST /team-tasks/supersede      → { taskId, supersededBy, revision } → 作废（CAS）[P2 UI]
POST /team-tasks/reassign       → { taskId, to, revision }    → 队长重派 [P2 UI]
```

- **CAS 要求**：所有 POST 必须带 `revision`；`update`/`release`/`supersede`/`reassign` 用 `compareAndSet` 校验。
- **⚠️ S13 修订（t66）：claim 的并发原子语义（填补 `:256 所有 POST 带 revision` 与 claim 形状 `{taskId}` 之间的缝）**：
  - **修法 = (a) 宿主侧 `compareAndSet(pending → claimed, revision++)`**。理由：与 §7「每次状态写原子（读-改-CAS-写）」统一，结构性排除双 owner；不依赖「唯一调度者串行」的外部声称（(b) 需另证外部无法绕过）。
  - **claim 请求 `{taskId}` 的豁免声明**：claim **由宿主管道串行化执行**（宿主进程内单线程状态机，`withTeamLock` 同款锁）→ **claim 请求本身不需要客户端带 revision**（它是「无条件抢占」原语，目标状态唯一是 `pending→claimed`）。**这是显式豁免，非漏保护**：豁免理由 = claim 的语义是「把某 task 从 pending 抢占为 claimed」，前置条件唯一（必须是 pending），且该条件由宿主原子检查——与 update/release（可能有多个合法前置状态）不同，后者必须带 revision 区分写哪个版本。
  - **并发场景处置（两个 claim 同时到达同一 pending task）**：宿主串行处理下的真实顺序 = 第一个 claim 执行 `CAS(pending→claimed, rev++)` 成功 → 第二个 claim 到达时任务已 `claimed` → **`CAS` 失败 → 返回 `{ ok:false, reason:'task-not-claimable', taskId, currentStatus:'claimed' }`，且不生成第二个 attemptId**。
  - **双 owner 结构性不可能（证伪）**：attemptId 只在 `CAS(pending→claimed)` 成功时生成一次；第二请求因 CAS 失败**不生成 attemptId** ⇒ **任何情况下同一任务不会同时存在两个有效 attemptId**。（若宿主进程崩溃/重启，`revision` 持久化于 team.json（§7）——重启后 claim 仍以磁盘状态为准，不会复活两个 attemptId。）

- **当前不可认领的语义完整（t66 补全）**：claim 对非 `pending` 任务的返回：

| 任务当前状态 | claim 行为 | 返回 |
|---|---|---|
| `pending` | 正常抢占 | `{ ok:true, attemptId, claimedAt, leaseExpiresAt }` |
| `claimed`（已有 owner） | CAS 失败，**不生成新 attemptId** | `{ ok:false, reason:'task-not-claimable', currentStatus:'claimed' }` |
| `running` | CAS 失败，**不生成新 attemptId** | `{ ok:false, reason:'task-not-claimable', currentStatus:'running' }` |
| `suspended` | CAS 失败，**不生成新 attemptId** | `{ ok:false, reason:'task-not-claimable', currentStatus:'suspended' }` |
| `completed` / `failed` / `superseded` | CAS 失败（终态不可逆） | `{ ok:false, reason:'task-terminal', currentStatus:'<终态>' }` |

- **P1 必做**：claim / update / release（+ reclaim 后台例程）。
- **P2+**：supersede / reassign 的 UI（状态机先支持）。

---

## 7. 持久化

- 位置：`<workspace>/.dsh-team/<teamId>/team.json`（**不是** `.agent-teams/`——t22 硬约束：不读 AgentTeams 私有格式，我们的 schema 是唯一真相）。
- 写策略：`revision` 单调递增；每次状态写原子（读-改-CAS-写）；`fs.rename` 或等效原子替换。
- 读策略：宿主私有，`/state` 从内存快照投影（t17 事件流驱动），磁盘为持久恢复源。
- 崩溃恢复：启动时读 `team.json` 重建；reclaim/stall 例程立即重跑（孤儿状态重启后可判定）。

---

## 8. 过渡期共存（用户裁定：P1/P2 共存只读，P4 移除）

- **P1/P2**：AgentTeams 仍在 `dsh.profile.bundles`，我们**只读**它的 `/state` 作对照（不写、不抢调度）；我们的任务模型从 `startContinuable` 自建成员开始（t42 P2）。
- **P4**：移出 AgentTeams；我们的 schema/调度/质量门完全自持；终态 = bundles 无 `@nanmicoder/dsh-agent-teams` 且功能不退化（t42 §四）。
- **过渡冲突处理**：不双调度同一批成员——我们只管理自建成员（label `dsh-team-chat:`），AgentTeams 成员只读不抢（t42 §四总原则）。

---

## 9. 待决策点（需实测/需用户）

| # | 项 | 状态 |
|---|---|---|
| D1 | `claimLeaseMs` / `stallThresholdMs` = 10min | **建议初值需实测**（t47 标注保留） |
| D2 | `RECLAIM_CHECK_MS` = 30s / `INTERRUPT_CONFIRM_MS` = 15s | **建议初值需实测** |
| D3 | `MAX_SUPERSEDE_DEPTH` = 16 | **建议初值需实测**（t51 新增） |
| D4 | 中断确认 API（`ctx.subagents.interrupt` 的确认语义） | **需实测**：interrupt 是否提供可确认的完成信号；若不可靠 → 默认走路径 B（suspended） |
| D5 | S7B 实际发生率 | **推测**：取决于「宿主观测到 activity 前成员被中断」的窗口概率；t5/t8 已证孤儿会真实发生，但双执行未见实例——发生率标注「推测」 |
| D6 | `SUSPENDED_SETTLE_MS` = 5min（suspended 持续静默后人工三选一） | **建议初值需实测**（t51 新增，修法⑦） |
| D7 | 心跳续租参数：30s 无信号 + 60s 阈值 → suspended（审查员建议） | **审查员建议非硬性**，需实测对比 §5 的 10min 初值 |
| D8 | `SUSPENDED_UNATTENDED_MS` = 30min（suspended 无人裁决 → 自动 superseded） | **建议初值需实测**（t58 新增，F3） |

---

## 10. 复核意见与处置（t49 + 队长 Q1/Q2/Q3 逐条）

> **规则**：每条写明 采纳 / 修正 / 不采纳 + 理由。不得静默忽略任何一条。

### S1 依赖环
**处置：采纳（修正）**。t47 未检测环；t51 §2.1 在建任务时做拓扑排序（Kahn），拒绝环与自依赖；`taskOpen` 永假不可达作为状态机层证伪。
**理由**：手工建环 = 永久死锁，属于可静态预防的输入错误，应在入口拒绝而非运行期检测。

### S2 自依赖
**处置：采纳（并入 S1）**。自依赖 = 长度为 1 的环；拓扑排序拒绝规则天然覆盖（`dependencies` 不含自身）。
**理由**：同 S1，入口拒绝。

### S3 依赖作废下游行为
**处置：采纳，选「带戳继续」**。§2.1：作废依赖属 terminal → 下游解锁 + 写 `dependencySupersededAt` 戳（不阻塞），/state 标注「依赖已作废」供复核。
**理由**：作废语义本意 = 释放下游；「暂停复核」会让一次作废冻结整条链，且 AgentTeams 的 superseded 语义也是「下游可继续」。选带戳继续符合语义且实现最简。

### S5 作废 vs 完成竞态
**处置：采纳（修正）**。§2.1 + §6：所有状态写带 `revision` 用 CAS；后写者收到 stale-revision 被拒，不可能后写覆盖先写。
**理由**：`updatedAt` 无版本 = 后写覆盖，必须引入 CAS 才能在同一状态机上保证「作废 vs 完成」二选一不丢。

### S6 supersede 链成环/过长
**处置：采纳（修正）**。§2.1：visited 集合 + `MAX_SUPERSEDE_DEPTH`（16，需实测）；作废目标链含自身 → 拒绝。
**理由**：遍历死循环是可静态防的，visited + 深度上限让「无限遍历」在状态机层面不可达。

### S7B 双所有者
**处置：采纳（重构 reclaim 谓词 + 原子化处置）**。§4：
- reclaim 判定 = **宿主独立观测**（agent.status + 全局 session/event + lastSignalAt），**不依赖成员自报 startedAt**；
- 原子化：先 interrupt 并**确认终止**才回 pending；确认不可靠 → `suspended` 不回收；
- 双执行在 running 期不 reclaim（只标 stall），在 suspended 不回收 → 结构不可达。
**理由**：t5/t8 证成员自报可被卡住绕过（Q2），唯有宿主观测不可伪造；中断不可确认时回收 = 双执行，必须降级为 suspended 人工裁决。

### Q1 保护窗口与真实事故窗口错位
**处置：修正（采纳队长质疑的事实，调整设计；v3 F1 闭环）**。
- **核实结论（审查员独立核验，已验证）**：
  - t5（engineer）17:01:05 发出 client Inspect → 17:16:30 cancelled；t8（researcher）17:00:20 → 17:16:16 cancelled（team.json 任务记录时间线）。
  - **机制**：claim = 调度即分配回合（`scheduler.js:276` `beginTaskAttempt` → claimed + 派发）→ **回合已开工**（Inspect 是第一个动作）→ 卡 15+ 分钟 → 回合中止 → 残留 claimed。
  - **两案都在「已开工（startedAt 已写）」一侧** → 若 lease 仅 `!startedAt` 回收，**恰好覆盖不到真实孤儿案**。
  - ⚠️ **更正 t47 §3.2「约束 2 消除 t5/t8」的表述**：t47 初稿声称约束 2 能消除 t5/t8——**与事实不符**（t5/t8 已在 startedAt 之后，lease 覆盖不到）。本修订**已改为 §4 的宿主导立观测谓词**。
- **判定**：t47 的 lease（`!startedAt` 时回收）**确实覆盖不到已开工的孤儿**——队长 Q1 与审查员结论一致。
- **修订（修法④ + v3 F1 闭环）**：§4 的 reclaim 谓词**不再依赖 startedAt 门槛**，以**宿主侧 `lastSignalAt` 为核心**（来自 §4.1 独立观测三元组）。
  - **claimed 残留**（含「已开工但无后续活动」与「未开工空转」）→ `canReclaim` 回 pending（§4.2 定义）。
  - **running 残留（in_progress 卡死）** → **不 reclaim**（防双执行）→ 走 `stall → suspended` 人工裁决/超时升级（§4.2 `runningResidualExit` + §5）。
  - **「两种残留都有出口」由这两条路径共同保证**——声称与定义一致（v3 修正：不再声称「谓词覆盖 in_progress」）。
  - `startedAt` 降为纯记录。到期回收必先 cancel 原成员并确认（§4.3）。
- **诚实标注**：t5/t8 当时具体残留状态（claimed vs in_progress）无法从已作废记录 100% 回读（标注「无法完全确认」）；但两种残留都各有出口（claimed→reclaim；running→suspended），**不存在无出口的孤儿**。

### Q2 可被保护对象绕过（自报 startedAt）
**处置：采纳（重构）**。§4：reclaim 判定三元组全部为宿主观测（`ctx.agents.get` 状态、session/event 事件、lastSignalAt 宿主写入），成员卡住无法伪造 → 自报不赋持有权。**不采用**「成员自报 startedAt」判定（被保护对象可绕过）。
**理由**：唯一能防「自报绕过」的方式就是不信任自报；宿主观测不可伪造（AgentTeams members.js:603 的 activity 同样来自平台 agent 状态，非成员自报）。
**不可能性论证（审查员，请照录）**：
- 若**成员自报** startedAt → claim 后立即写 → 无上限持有 → lease 形同虚设（Q2 攻击面实锤）。
- 若**宿主 claim 即写** startedAt → claim ≡ started → **t5/t8 又不进 lease 范围**（Q1 攻击面实锤）。
- ∴ **lease 无法同时「覆盖已开工孤儿」且「不被成员绕过」**——必须引入宿主侧独立活性信号 `lastSignalAt`，lease 以它而非成员自报的 startedAt 为核心（即 §4 的修正）。
- **口径**：Q2 的「可被绕过」为**逻辑必然（已证）**；实际绕过**概率取决于未来实现，未测** → 标注**推测**（非已验证）。

### Q3 风险换位置（误回收→双执行 vs 真死→永不回收）
**处置：采纳，但升级为「第三种机制」（审查员判定更优）**。§4.5 修法⑦：
- 原设计（running 停滞仅标记 → 任务永久持有）**与 t6 僵尸同类**——审查员判定不充分。
- **第三种机制（采纳）**：running **心跳续租**（依赖 §4.1 的 lastSignalAt 宿主观测）→ 30s 无信号（建议，需实测）→ 60s 阈值（建议，需实测）→ **`suspended` 需人工裁决**。从不自动回收在跑任务（**无双执行**）+ `suspended` 显式可处置（**无永久孤儿**）。
- **队长确认动作三选一**（§5）：恢复（带 `revision` stale 校验）/ reassign / supersede。
- **修法⑦ 防误判**：`suspended` 后仍保留 activity 续租——观测到新活动自动回 running，防「真死/误判」。
- **可接受吗**：可接受——「真死需人工」的窗口被压缩到 `SUSPENDED_SETTLE_MS`（建议 5min）内，且 suspended 有显式三选一出口，不是无出口僵尸。
- **边界条件**：仅当 ① claimed 超 lease、② 宿主观测无活动、③ interrupt 无法确认终止 三者同时成立 → suspended；running 心跳续租中断超时 → ③' suspended。任一不成立则走正常路径。

### 本轮 F1 / F2 / F3 处置（t58 · 契约第 6 条要求）

#### F1（high）：声称与定义一致
**处置：修正（采纳审查员）。** v3 不再声称「谓词覆盖 in_progress」，改为**双路径**：
- `canReclaim(task)` 定义体**只限 `task.status === 'claimed'`**（§4.2:157-161），回 pending；
- 新增独立谓词 **`runningResidualExit(task)`**（§4.2:163-168）：`task.status === 'running'` 且宿主导立观测无活动 → `stallMarked` → 人工确认 → `suspended` → 三选一/超时升级（§5）。
- `canReclaim` 不含 `in_progress` 分支——**in_progress 残留不 reclaim**（防双执行），走 runningResidualExit。
**理由**：二选一的两条路径（给 canReclaim 加 in_progress / stallMark 升级）中，**所选方案=「stallMark 升级为可回收」的变体**：running 残留不直接回 pending（会双执行），而是走 stall→suspended 人工裁决（有出口、无永久孤儿）。声称与定义严格一致（§10 Q1 同此覆盖）。

#### F2（medium）：承重信号取值
**处置：采纳（补充证据 + 标注）。** §11 已验证区新增：平台 `agent.status` **只有 `idle`/`running` 两值**（`dsh-agent-loop/lib/index.js:385-387`）；**长工具调用期间 = `running`**（:456-463 wakeDriver setPhase running 覆盖整个 turn；:487-493 kick finally 才回 idle）→ `hostObservesIdle` 长调用期间为 false，**不误回收**。
- 补充限定（推测）：`agent.status` 是 turn 级粒度；turn 结束瞬态窗口「成员在 turn 完成与下次 kick 间短暂静默」可能被误标——**该窗口存在性为推测**，P1 实测确认（t59 重点）。
- 误判可检测/可回退：`suspended` 后 activity 续租（§4.5 修法⑦）——观测到新活动自动回 running；且 stall 仅「疑似」人工确认。

#### F3（medium）：suspended 无人时的出口
**处置：修正（采纳审查员）。** `SUSPENDED_SETTLE_MS` 回答「多久开始人工裁决」；**无人裁决的最终出口由 `SUSPENDED_UNATTENDED_MS`（建议 30min，需实测）给出**：
- 超时 → 自动转 `superseded`（作废，`supersededBy` 指向空/重建提示）；下游按 superseded 属 terminal 自动解锁；原成员回来提交收到 **stale-revision** 拒绝（CAS）；`/state` 记录「suspended 无人裁决自动作废」。
- 证伪：`suspended` 有三条出口（人工三选一 + 活动续租回 running + 无人时超时自动 superseded），**「永远挂着」在状态机上不可达**。

#### F4-a（high）：设计稿引用了不存在的枚举值
**处置：修正（采纳审查员；v4.1 补充分层澄清 F2b）。**
- **`working` 是平台不存在的值**——`dsh-agent-loop/lib/index.js:385-387` 承重字段 `agent.status` 仅 **`idle | running` 二态**（这是**驱动层**）。
- **`ready` 属于另一层**：`dsh-tool-subagent-control/lib/types/list-agents.js:86` 的 `status enum: ['running','idle','ready']` 是**工具列表面**的枚举；其 `statusOf`（:28）实际把 `agent.status` 映为 `running | idle`，`ready` 由「agent 仅存储可恢复」产出（:57-61）。
- **更正结论**：承重字段 = `agent.status`（驱动层，二态 idle|running）；`ready` 不是该字段取值；`working` 不存在。§4.1 已统一为二态并写明层次（v4.1）。
- **同类缺陷第三次（上升为纪律）**：① `--dsh-*` 主题令牌（t7 前）；② `error.message`（t34 前）；③ `working`（本轮）。前两次都靠真实样本才暴露——**本次同样附源码 `file:line`**。§4.1 新增**取证纪律**：凡引用平台字段名/枚举值必须附出处，无出处视为假设显式标注。**并新增层次纪律**：引用状态时写清字段与层次（驱动层 agent.status 二态 ≠ 工具列表面三态含 ready ≠ 派生 stateOf 三层）。

#### F4-b（high · 决定性）：`hostObservesIdle` 恰在 t5/t8 卡死窗口误判
**处置：修正（采纳审查员）。** 平台源码原文（`dsh-subagent/lib/index.js:1361-1364`）：
> "`Agent.status` alone is insufficient: it stays `idle` between an accepted waking send and the microtask that admits it, so a synchronous inbox observer would see `settled` while a turn is already queued."
- 即：**「已唤醒但回合未 admitted」窗口 status=idle**，单看裸 status 会误回收——**正是 t5/t8 卡死形态窗口**。
- **修法**：§4.2 `hostObservesIdle` 改用平台**完整派生 `stateOf`**（`dsh-subagent/lib/index.js:1366-1370`：`agent.status==='running' || activation.accepted.size>0 → 'running'；ownedChildren>0 → 'waiting'；否则 'settled'`），或等效「该 agent session 是否有已 admitted 未 drained 请求」探针 → 刚唤醒窗口返回 **false（不回收）**。
- **等效方案需实测**：若我方无法直读平台的 `accepted` 集合，用 `turn/start` 事件作为「已 admitted」信号——**该等效是否完整覆盖窗口需 P1 实测确认**（t59 重点；不预先断言覆盖）。
- **对 Q2 结论的影响（如实记录，不扩大不缩小）**：
  - 「**自报不可伪造**」**仍成立**（agent.status 是宿主导读，成员改不了）；
  - 但「**宿主独立观测能够可靠判卡死**」这一**承重前提不成立**——信号在该判的窗口不可靠。
  - ∴ 文档区分两句话：**"不可伪造" ≠ "足以判定"**。Q2 只证明了前者；后者依赖 stateOf/等效探针，属**需实测**。

#### F4a/b 与 F2 的关系（澄清，防止混淆）
- **F4-b 不解答 F2**：平台注释只证明「accepted→admitted 窗口不可靠」，不自动回答「长工具调用期间 status 真实取值」（F2 的取证要求仍单独成立：给证据或标需实测）。
- F2 已由 `dsh-agent-loop:385-387` 证 `agent.status` 两值且长调用=running；**但这是「驱动层 status」**，与 F4-b 的「accepted 窗口」是不同观察面——**两者都要在 P1 实测**（t59 已列）。

---

## 11. 已验证 vs 推测 vs 需实测（汇总）

**已验证（源码 + 审查员独立核验）**：
- AgentTeams 无 `startedAt` 字段（state.js 零命中）
- AgentTeams activity 来自平台 `ctx.agents.get(id).status`（members.js:603）→ 宿主可独立观测
- AgentTeams 依赖仅认 completed、作废即 terminal（state.js:92-95/144-154）→ t6 根源
- ownedOpenTask 永久占有 + recovery 仅过程内（scheduler.js:109-112/254-264）→ 孤儿根源
- 我们 /state 已有 lastEventAt/eventCount（lib/index.js:198-201）
- t17 全局 session/event 订阅具备（第 4 项契约可证）
- **Q1 时间线（审查员已验证）**：t5 17:01:05→17:16:30、t8 17:00:20→17:16:16（team.json 记录）；claim=调度即分配回合（scheduler.js:276 beginTaskAttempt）+ 回合已开工 → 两案都在「已开工」一侧 → lease（!startedAt）覆盖不到真实孤儿（t47 §3.2 归因已更正）
- **Q3 机制（审查员已验证）**：running 仅标记=与 t6 僵尸同类；第三种机制（心跳续租→中断超时→suspended）判定更优
- **F2 承重信号取值（t58 已验证源码）**：平台 `agent.status` **只有 `idle` 与 `running` 两个值**（`dsh-agent-loop/lib/index.js:385-387`：`phase.kind === 'idle'||'maintenance' ? 'idle' : 'running'`）；**长工具调用期间 = `running`**（`wakeDriver` :456-463 setPhase running 覆盖整个 turn → 所有工具调用；`kick` finally :487-493 才回 idle）。→ `hostObservesIdle` 在长工具调用期间为 false，**不会误回收**（这正是 reclaim 谓词的承重依据）
- **F4-a（t58-F4 已验证源码）**：承重字段 `agent.status` = **驱动层二态 `idle | running`**（`dsh-agent-loop/lib/index.js:385-387`，无 working）；**`ready` 属工具层合成态**（`dsh-tool-subagent-control/lib/types/list-agents.js:24-28` `statusOf`：`agent===undefined → 'ready'`；:86 enum 是工具 schema 非 getter）——**工具层合成态 ≠ getter 取值域，两层的枚举不可混用**
- **F4-b（t58-F4 已验证源码）**：平台自身注释声明 `Agent.status` **alone insufficient**（`dsh-subagent/lib/index.js:1361-1364`：accepted→admitted 窗口 status 停留 idle）；平台用 `stateOf`（`agent.status` + `activation.accepted.size` + `ownedChildren`，:1366-1370）补足——**裸 status 不可作 hostObservesIdle 承重依据**

**推测**：
- S7B 实际发生率（取决于窗口概率，未见双执行实例，t5/t8 单方孤儿已实锤）
- t5/t8 当时具体残留状态（claimed vs in_progress，无法从作废记录 100% 回读）
- **Q2「可被绕过」为逻辑必然（已证），但实际绕过概率取决于未来实现（未测）**——标注推测，非已验证
- **F2 补充限定（推测）**：`agent.status` 是 **turn 级粒度**（running=整个 turn）；turn 结束瞬间变 idle，若成员在「turn 完成与下次 kick 之间」短暂静默可能被误标——**该窗口的存在性为推测**，需在 P1 实测确认（t59 重点）
- **F4-b 等效探针（推测）**：若我方无法直读平台的 `activation.accepted` 集合，用 `turn/start` 事件作「已 admitted」信号的**等效是否完整覆盖 accepted→admitted 窗口 = 推测**，需 P1 实测（t59 重点）

**需实测（D1-D8 + F4）**：
- `claimLeaseMs`/`stallThresholdMs`/`RECLAIM_CHECK_MS`/`INTERRUPT_CONFIRM_MS`/`MAX_SUPERSEDE_DEPTH`/`SUSPENDED_SETTLE_MS`/`SUSPENDED_UNATTENDED_MS` 全部为**建议初值**
- 心跳续租 30s/60s（审查员建议）与 §5 的 10min 初值的对比（D7）
- `ctx.subagents.interrupt` 的可确认语义（D4）——若不可靠 → 默认走 suspended
- **F2 承重信号（t59 重点）**：长工具调用期间 `agent.status` 取值已由源码证为 running，但需 **P1 运行时确认**（源码≠运行态，见 t52 待核项）
- **F4-b（t59 重点）**：`stateOf` 或等效探针在 accepted→admitted 窗口是否真返回「不 idle」——需 P1 运行时确认（源码已证平台自身如此实现，我方接入的完整性待实测）

---

> 落盘：t51 v2 → t58 v3 → v4（F4）→ v4.1（t62 收口）→ v4.2（t66 · S13）→ **v4.3（t71 · 指纹归因实测更正）**。本文件取代 t47 的任务 output 作为 P1 状态层设计稿的正式载体；t47 output 保留为历史草稿。v4.1 处置：F2b（§4.1 统一为驱动层二态 idle|running + 层次纪律：`ready` 属工具列表面另一层 + `working` 有效引用 0 处，仅保留「不存在」溯源声明）、hostObservesIdle 第三态处置（未知取值偏保守不回收）、S10（自动 superseded 复用 §6 `/team-tasks/supersede` 同款 CAS、逐字桥接）、S11（环检测范围 = 本 schema 三入口 + 干净重来前提）。修法 7 条（§0）+ 取证纪律 + 层次纪律。不确定性只增不减（见 §11 对比表），未删任何标注。**v4.2 处置 S13（claim 并发原子性）：§6 选修法 (a) `compareAndSet(pending→claimed, rev++)`，非 pending 返回 `task-not-claimable` 且不生成第二个 attemptId；双 owner 结构性不可能；claim 带 revision 豁免已显式声明；不可认领语义表完整（§6）。v4.3 处置指纹归因：:496 括号内被否证归因（「方法不可靠 / 0x0A 编码解释不了」）改为实测归因（Get-Content 默认 gb2312 解码读 UTF-8 无 BOM ⇒ 编码问题），删除伪归因附搜索证据，写入上位规则「机制推理不是证据；推理与实测冲突实测赢」。**

---

## 12. v4.1（t62）修订记录与不确定性基线对比

| 项 | t59 基线 | v4.1 当前 | 变化 |
|---|---|---|---|
| 「需实测」出现 | 27 | 29（+2：F4-b 等效探针、stateOf 接入完整性） | 只增 |
| 「推测」出现 | 11 | 13（+2：F4-b 等效覆盖、第三态未来出现与否） | 只增 |
| 「疑似」出现 | 7 | 7 | 持平 |
| D 项「需实测」 | 8 | 7（D7 心跳参数并入 D1 对比说明） | 表面-1，实际合并非删除 |
| `working` 有效引用 | —（当时在正文误用） | **0**（仅保留「不存在」溯源声明，L150/378/380/381/412/431） | 清除误用 |

**v4.1 修订明细**：
- **F2b**：§4.1 承重字段统一为驱动层二态 `idle|running`（dsh-agent-loop:385-387）；`ready` 明确属工具列表面另一层（list-agents.js:86/28/57-61）；`working` 有效引用清零；新增**层次纪律**（驱动层 agent.status ≠ 工具列表面 status ≠ 派生 stateOf）。
- **hostObservesIdle 第三态**：未知取值偏保守（NOT-idle 不回收）+ 显式分支要求，不留空（§4.1）。
- **S10**：自动 superseded 的 CAS 与 §6 `/team-tasks/supersede`（revision + compareAndSet + stale-revision）逐字桥接（§5）。
- **S11**：环检测范围 = createTask / editPlan / supersedeBy 三入口，干净重来前提（不读 AgentTeams 既有 DAG，P4 后覆盖全集）（§2.1）。

---

### 本节（t62）复核意见与处置（F2b / S10 / S11）

#### F2b（medium）—— §4.1 与 §11 的枚举矛盾（字段二态 vs 工具列表面三态）
**处置：修正（采纳审查员分层结论）。** §4.1 统一为**驱动层二态 `idle|running`**（`dsh-agent-loop/lib/index.js:385-387`），与 §11 一致；`ready` 明确属**工具列表面**另一层（`list-agents.js:86` enum + `statusOf`:28 + ready 语义 :57-61），不是本字段取值。`working` 有效引用清零（全文件 8 处为「不存在/无/清零/同类缺陷/有效引用0」否定声明，零有效引用）。
**理由**：本轮冲突根因 = 两个成员引用了不同层的不同枚举；统一分层（驱动层 2 态 / 工具列表面 3 态含 ready / 派生 stateOf 3 态）后不可再混用。
**防再犯**：新增**层次纪律**（§4.1）。

#### S10（low）—— 自动 superseded 的 CAS 绑定需与 §6 逐字桥接
**处置：修正（采纳审查员）。** §5 新增桥接说明：自动 superseded **复用 §6 `/team-tasks/supersede` 同款 CAS**——`{taskId, supersededBy, revision}` + `compareAndSet(task, expectedRevision, next)` + `stale-revision` 拒绝 + 重读重试；明写「§5 CAS 保护 = §6 同一规则，非两套」。
**理由**：避免两处写两套 CAS 语义漂移。

#### S11（low）—— 环检测适用范围 + 干净重来前提
**处置：修正（采纳审查员）。** §2.1 补充：环检测范围 = 本 schema 三入口（`createTask` / `editPlan` / `supersedeBy`）；**干净重来前提** = 不迁移/不读取 AgentTeams 既有 DAG（t42 干净重来裁定），环检测只对本 schema 自建任务生效，P4 后覆盖全集——不悬空。
**理由**：范围不写清 = 实现时不知道在哪些入口校验；干净重来不声明 = 会误以为要处理历史 DAG。

### 本节（t66/t71）复核意见与处置（S13 + 指纹/计数 low + 指纹归因实测更正）

#### S13（medium）—— claim 并发原子性缺口（双 owner 变体）
**处置：修正（采纳审查员，选修法 a）。** §6 已补全：
- **修法 = (a) 宿主侧 `compareAndSet(pending → claimed, revision++)`**；非 pending 时返回 `task-not-claimable` 且**不生成第二个 attemptId**。
- **理由**：与 §7「每次状态写原子（读-改-CAS-写）」统一，结构性排除双 owner；(b)「唯一调度者串行」需额外证明外部无法绕过，不如 CAS 直接可证伪。
- **并发场景**：两 claim 同时到达同一 pending → 第一个 CAS 成功得 attemptId；第二个 CAS 因已 claimed 失败，返回 `{ok:false, reason:'task-not-claimable', currentStatus:'claimed'}`，**无第二个 attemptId** → 双 owner 结构性不可能（§6 证伪段）。
- **§6 空子已补**：claim 请求 `{taskId}` **显式豁免带 revision**（理由：claim 前置条件唯一=pending，由宿主原子检查；update/release 有多前置状态故必须带 revision）——豁免声明写清，不留「claim 不受保护」的缝。
- **不可认领语义完整**：claimed/running/suspended → `task-not-claimable`；终态 → `task-terminal`（§6 表）。

#### 指纹 low —— 行数必须字节级
**处置：修正（采纳，自认错误；v4.3 更正为实测归因）。** 此前 t56/t62 交付报「252 行」及「根因 = 方法不可靠（0x0A 不可能在 UTF-8 多字节内，编码解释不了行数差）」——**后者已被对照实验否证**。实测（t68/t69 复现，同一文件 `detach-p1-state-design.md`）：
```
(Get-Content <文件>).Count                  → 252（t62 版）/ 271（t66 版）  ← 默认解码
(Get-Content <文件> -Encoding UTF8).Count   → 467（t62 版）/ 499（t66 版）  ← 仅改编码参数
node C:\Users\bo.yang02\count-lines.mjs <文件> → LF 466/498, text lines 467/499 ← 字节级
```
**只改 `-Encoding UTF8` 一个参数，行数即与字节级一致 ⇒ 根因 = `Get-Content` 默认按系统 ANSI 代码页（本机实测 `Default.WebName = gb2312`）解码读取 UTF-8 无 BOM 文件，解码错误使 LF 边界错位，返回对象数 ≠ 逻辑行数。** 权威以字节级 count-lines 为准。
**一句话总结（t71 写入）：机制推理不是证据。** 一个听起来自洽的推导（如「0x0A 不可能在 UTF-8 多字节内 ⇒ 编码解释不了」），**在跑对照实验之前不得作为归因**；**推理与实测冲突时，实测赢**。

#### 计数规则说明 —— 不确定性口径
**处置：修正（采纳审查员口径）。** 审查员本轮口径 = **需实测 31 / 推测 14 / 疑似 8**（出现次数）。计数规则：**「需实测」= 字面「需实测」出现次数**（含「建议初值需实测」等复合词），同一行内多次出现各计一次（L240/L352 各 2 次）；「推测」= 字面次数（L287/369/420/421 各 2 次）；「疑似」= 字面次数（8 行各 1 次）。**本设计稿按此规则 = 31/14/8，与审查员一致**；此前 29/13/7（行数口径）、30/14/8（审查员上轮）差异源于**计数规则不同**（行数 vs 出现次数）——已统一为「出现次数」并写明规则。