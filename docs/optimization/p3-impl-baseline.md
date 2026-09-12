# P3 实现基线（`p3-impl-baseline.md`）

> **任务**：t106 · P3 Slice 1（存储层：store schema v2 + sidecar quality.json + 判别测试）。
> **冻结稿锚点**：P3 设计稿 v0.2 = `D24D63184485` / 55397 B / 508 行；P2 设计稿 v0.8 = `528B865ECB6F` / 79283 B / 551 行（本轮复测均零改动）。client.js = `77D49690DCAB` 零改动。零 push。
> 维护：engineer4 · 2026-09-13 · t106。**本文件指纹表最后写、写完即终态**（§5）。

---

## 1. P1 契约增量清单（版本化声明）

### 1.1 改了什么（全部在 `lib/state/task-store.js`，指纹见 §5）

| # | 增量 | 说明 |
|---|---|---|
| 1 | `export const SCHEMA_VERSION = 2` | 版本化声明常量；`serialize()` 输出携带 `schemaVersion: 2` |
| 2 | `createTask` 新增 `constraints` / `knownRisks` 两扩展列 | 创建期契约字段（P3 设计稿 §3.2 QualityContract 的 sidecar 影子→v2 收编两项）；`stringList` 规整（非数组→[]，滤非字符串项），缺省空数组——旧调用零感知 |
| 3 | `serialize()` 头部增 `schemaVersion` | 磁盘自描述 |
| 4 | `loadTaskStore` v1 零迁移兼容 | v1 文件（无 schemaVersion、记录缺列）→ 缺列补 `[]`、其余整行原样入 Map（设计稿 §3.1「loadTaskStore 对未知字段已宽容」的延续）；`store.schemaVersion` 记录磁盘版本供审计 |
| 5 | `snapshotRow` 投影增两列 | 下游（工程师反问/审查员判范围）随任务可读 |
| 6 | 模块内 `stringList` 助手 | 非导出 |

### 1.2 为什么（设计依据 + 承载声明）

P3 设计稿 §3.1-1/3：constraints/knownRisks 的**目标形态 = P1 v2 扩展列**（创建期输入、与任务同生命周期、下游需随任务可读），且列入「最小必要候选①」；同条要求收编「走独立 P1 v2 任务评审——不在 P3 实现内夹带」。**本任务即该独立承载**：队长 t106 契约显式指令「store schema v2 扩展…改动必须版本化声明：交付 P1 契约增量清单写入 p3-impl-baseline.md」——独立派单 + 版本化声明 + 本清单留痕，满足「不夹带」的实质（独立可审计），非静默 piggyback。范围严格限于候选①两列；候选② gateState 摘要列与③ E15 指纹集**本轮未收编**（设计 §3.1-3 同段明确其属同批 v2 待办，待后续任务）。

### 1.3 受影响核验链评估（t73–t78）

| 链项 | 影响 | 评估 |
|---|---|---|
| t73 §1 schema（createTask 全字段） | +2 列 | 行为面：新增可选输入，缺省零感知——**兼容性增量** |
| t73–t75 §2 状态机 / TRANSITIONS / `_cas` | 零改动 | 不需重跑状态机断言 |
| t75 F1–F4（update 域 / claim 依赖前置 / 悬空依赖 / claim 身份） | 零改动 | 不需重跑 |
| t76 判据（E55EBB3AC1FB 修复前副本锚定） | **指纹失效**（现 B412BC814EFA） | 指纹锚点按流程作废重绑；行为断言零改动 |
| t78 §7 持久化（serialize/load 往返） | serialize +1 字段；load +缺列补缺省 | **需重跑**（已重跑：task-state.test.mjs 21 test() 块全绿，含新增往返用例） |
| t74 对抗性构造（35 项新构造） | 增量面不触状态机/CAS | 评估为无需重跑（理由：v2 仅增创建期字段与读侧缺省，全部写路径/迁移表字节未动） |

**重跑范围声明**：`test/task-state.test.mjs` 全部 21 test() 块（含新增 3 块）+ junction 全仓 248 块——均已重跑全绿（§4）。

---

## 2. sidecar quality.json（`lib/p2/quality-sidecar.js`，新文件）

### 2.1 schema 映射（§3.8 QualityGate 逐字段落地）

`QualitySidecar`（fs 边界可注入）：`openGate`（一任务一 gate，重复 → `gate-exists` 拒绝）/ `gateOf`/`allGates` / `markReviewClaimed` / `markRepairClaimed` / `settleRound` / `recordRepair` / `resolveFindings` / `addPendingInput` / `escalate` / `sweepOrphans(store)` / `findDivergedGates(store)` / `save()`（tmp+rename 原子写）。

- `QualityGate`：taskId / gateState（六态，GATE_TRANSITIONS 表驱动）/ round（口径 §3.7：结算完成的 review 数；创建未结算的 re-review 不增）/ maxRounds（缺省 4，§9-G1）/ contract 影子（constraints/knownRisks——v2 后迁出）/ rounds[] / repairs[] / pendingInputs[] / escalation / updatedAt（+ 标注位 orphaned / pendingReview / pendingRepair）。
- 转移全部事件驱动（P1 结算事件入参），sidecar 无定时器（§3.7）；非法转移按 GATE_TRANSITIONS 表拒绝。
- 一致性校验（§3.3/§3.4/§6.2）：pass 带 findings → `pass-with-findings`；pass 带 failed 证据 → `pass-with-failed-evidence`；needs_revision 无 findings → `findings-required`；finding 非 low 缺 requiredFix → `finding-invalid`（G3 口径）；verdict 域 = 三值（`blocked` 归升级 reason，§3.5 裁定）。

### 2.2 escalation（§5.2）与 reason 枚举口径声明

- `ESCALATION_REASONS` = 设计 §5.2/§5.3 的 **8 种**（round-limit-exceeded / repair-failed / reject-no-repair / reviewer-unavailable / insufficient-evidence / e15-breach-unresolved / subject-superseded / manually-raised）+ `sidecar-unwritable`（§6.2 补偿路径专用变体）= **9 个可接受值**。
- ⚠ **契约文字差异声明**：t106 契约写「含 7 种 reason 枚举」，冻结设计实列 8 种（+补偿变体）。按「先通读冻结稿」纪律以冻结稿为准实现，差异在此如实声明——如队长裁定须收敛枚举，属独立修订任务（本 Slice 不回改冻结稿）。
- `buildEscalation`：reason 枚举 / roundsAttempted 非负 / summary 必填 / findingsDigest{byRound,trend} 形状 / suggestions、pendingDecisions 数组——**缺关键字段显式拒绝**（`escalation-invalid`，验收判别点）；`digestRounds` 自动聚合（byRound 按 severity 计数；趋势：递减 converging / 递增 diverging / 持平 flat）；`pendingDecisions` 缺省 A-D 模板（§5.2）。

### 2.3 §6.2 补偿契约（`persistWithCompensation`）

阶梯实现（全同步原语，G10 退避由 Slice 2 异步层承载）：
1. sidecar 写入重试 N=3（可配）；
2. 全败 → ①P1 `update(failed)` + insufficient-evidence findings（id=C1/high，problem 含「证据链不完整」）——本轮结算作废为 durable 账本真相；②①不可行（terminal/并发取代，实测 illegal-transition）→ sidecar 内存态 `escalate(reason='sidecar-unwritable')` + 尽力落盘一次；
3. **绝不静默**：compensation `{taken, detail{sidecarError,retries,p1,p1Failure,escalation,escalationSaved}, findings}` 全量上抛。

---

## 3. 冻结稿对照的如实声明

1. **§3.1-3「不在 P3 实现内夹带」vs 本任务收编**：见 §1.2（独立承载声明映射；范围仅候选①）。
2. **reason「7 种」vs 设计 8 种**：见 §2.2（按冻结稿实现，差异声明）。
3. **§6.2 补偿②的持久化语义**：sidecar 持续不可写时 escalation 仅存内存态 + 随返回值上抛（持久层不可能写是前提）；durable 真相 = P1 failed 或人工介入——设计原文「把现场交给人工」的机制化，非缺陷。
4. **版本号现值**：package.json 现为 0.6.0（本任务开工前已由他人入库；git status 无 package.json 修改项，非本任务改动）。本任务版本号零改动、零 push。

---

## 4. 验证口径（分开报；skip ≠ pass）

- **junction 临时树**：248 tests / pass 248 / fail 0 / skipped 0（宿主用例真实执行）；
- **裸检出 npm test**：248 / pass 202 / fail 0 / skipped 46（46 全为环境性 schemastery peer；相对 t97 基线 229 净增 19 test() 块：task-state +3、p2-quality-sidecar 新文件 16）；
- **P1 回归零破坏**：task-state.test.mjs 21 test() 块全绿（含既有 t73/t75/t76 判据用例原样通过——v2 为纯增量）。
- **判别变异（%TEMP%/dsh-t106-mutate/，node 版注入，3 组全红）**：
  - mut-v2-drop（createTask 丢弃 v2 列 → 契约字段静默丢弃）→ task-state 28/25/**3 红**（『收编』『schemaVersion+投影』『v1 兼容』）；
  - mut-sc-direct-write（sidecar 直接写最终路径，绕过 tmp+rename）→ 16/15/**1 红**（『原子写：先写 .tmp 再 rename；直接写最终路径 → 红』）；
  - mut-sc-esc-novalidate（escalate 跳过关键字段校验）→ 16/15/**1 红**（『reject→escalated；escalate 校验与缺省 A-D』）。

---

## 5. Slice 1 指纹（同一次测量：Get-FileHash + count-lines.mjs；本表最后写）

- `lib/state/task-store.js` = `B412BC814EFA` / 37529 B / 796 行（原 t76 链锚 9D687A013253 → schema v2；增量清单见 §1）
- `lib/p2/quality-sidecar.js`（新增）= `2A4FCB434B6E` / 22671 B / 499 行
- `test/task-state.test.mjs` = `AD8FDE5BEC74` / 32871 B / 545 行（+3 test() 块）
- `test/p2-quality-sidecar.test.mjs`（新增）= `A5A762DF0503` / 18332 B / 367 行（16 test() 块）
- `docs/optimization/p3-impl-baseline.md`（本文件）终态指纹见 t106 output（自指不写）。

diff 声明：以上 4 文件 + 本文件为全部改动；lib/client.js、两设计稿、lib/p2/ 其余文件、scripts/、package.json 零触碰。

---

## 6. 待 Slice 2（循环机制 + 工具面接线）

1. §4.1 三自动动作（verdict → repair 创建/re-review 排队/gate 转移）接线 `settleRound`/`markRepairClaimed`/`markReviewClaimed`；
2. captain-tools §6.1/§6.2 扩展（acceptance/verify/constraints/knownRisks/maxRounds/supersedes 透传 + gate 感知校验 gate-busy + verdict/findings/acceptanceResults）——含 t100 发现的 acceptance/verify 透传缺口修复；
3. §6.3 B′ report 扩展（单一写入函数与队长工具共用，防双实现漂移）；
4. §6.4 team_status gates 视图；§3.9 崩溃重放（findDivergedGates → 以 P1 为准重放转移）；
5. E15 快照与轮记录联动（每轮 review claim 新快照——一次性消费语义恰好匹配，§0 设计已核）。

---

## 7. Slice 2 交付记录（t108 · engineer4 · 2026-09-13）

> 承载：修复/复核循环机制（三自动动作 + 安全阀）+ 工具面接线 + E15 调用点集成。**P3 主体随此闭合**。
> 本节为**纯追加**（§0–§6 字节不变；指纹表最后写，写完即终态——见 §7.5）。

### 7.1 循环引擎（`lib/p2/quality-loop.js`，新文件）

- **三自动动作**（§4.1，且仅此三个；其余零自动化）：`settleReviewTask`（verdict 结算单一写入函数）→ needs_revision 自动创建 repair（`subject='repair-round-<N+1>'` 惯例、objective 引用 sidecar findings 防超长、verify 拼接各 finding 的 requiredFix 验证入口、inScope 同被审文件集、**依赖只指成功源 `[被审对象]`**）；repair completed → `queueReview` 排队 re-review（依赖 = [repair]，round 待结算）；两者创建后经 dispatch 边界（dispatchBatch 单拍）唤醒。
- **事务顺序**：E15 追加 finding（内存）→ sidecar.settleRound（内存，一致性校验失败零副作用）→ P1 CAS（失败 → `sidecar.load()` 回滚内存）→ save（persistWithCompensation §6.2 阶梯；补偿触发 = 结算作废，循环动作不继续）。
- **安全阀**（对冲 P2 H7 担忧，§4.1 取代声明）：§4.5 触顶（round ≥ maxRounds → escalate round-limit-exceeded，全结构 EscalationRecord）；§5.3 repair-failed 升级；§4.3 去重（findOpenRepair 复用非 terminal repair，不新建）；§4.4 可用性前置（全员不可用 → setWaitingReviewer 零账本污染 + `retryWaitingReview` 复活入口 + `escalateIfWaitingTooLong` 阈值升级 reviewer-unavailable）。
- **§4.6 取代同步**：`syncGateOnSupersede`（captain-tools）——escalated(subject-superseded) 或 closed+supersededBy 二选一 + loopSuspended 挂起。
- **§4.7/§4.8**：escalated 期间新输入排队（createCaptainTask → escalated-queued + pendingInputs）；E15 match=false → 不阻断结算但写入当轮 findings（id=E15, severity=high）。

### 7.2 工具面接线（§6.1/§6.2/§6.3/§6.4）

- `team_create_task` DTO + 执行器扩展：acceptance/verify/constraints/knownRisks/maxRounds/sourceTaskId/supersedes 全参数化；**§3.2 必选性校验**（implementation/repair/verification 类 acceptance/verify 必填 → acceptance-required/verify-required）；**gate 感知先于契约校验**（gate-busy 附现存任务 id；escalated → 排队冻结）；supersedes 失败 → 回滚新任务（自我作废）+ 整体失败；被审对象建档 openGate（constraints/knownRisks 影子）。
- `updateCaptainTask`：review 任务带 verdict → 路由 settleReviewTask（循环引擎；needs_revision 自动 repair/触顶升级/pass 关门）；非 review 或未带 verdict → 纯 CAS + E15 比对保留。
- `executeMemberTool`（B′ report，§6.3 单一写入函数）：gate 内 review/repair 结算路由循环引擎（settleReviewTask/settleRepairTask；verdict/findings/acceptanceResults 从 report 参数；归属 attemptId/revision 仍由 attemptCache）；claim 挂钩 gate 转移（repair → markRepairClaimed；review → markReviewClaimed + E15 快照既有钩子不变）；MEMBER_TOOLS report DTO 增 verdict/findings/acceptanceResults 参数。
- `captainStatus` gates 视图（§6.4）：taskId/gateState/round/maxRounds/lastVerdict/waitingReviewer/escalationDigest/pendingInputsCount/orphaned，escalated 置顶。

### 7.3 E15 集成（不重造）

review-guard.js 零改动（指纹不变）。调用点：①claim 快照（t96 既有钩子，kind=review 认领时 snapshotFor）在循环创建的 re-review 上同样触发（每轮新快照，一次性消费语义 §4.4 已核）；②结算比对移入 settleReviewTask（reviewGuard.compareFor → match=false → 写当轮 findings id=E15/severity=high，§4.8）。

### 7.4 验证与判别力

- 三口径：junction **259/259/0 skip**；裸检出 **259 / pass 213 / fail 0 / skipped 46**（环境性）；新增 `test/p2-quality-loop.test.mjs` **11 test() 块**全绿（全仓净增 11 块，259 = t106 的 248 + 11）。
- 判别变异（%TEMP%/dsh-t108-mutate/，node 版注入，3 组全红）：mut-loop-norepair（去 repair 自动创建）→ 11/6/**5 红**；mut-loop-nolimit（去轮数上限）→ 11/4/**7 红**；mut-loop-nobusy（去 gate-busy）→ 11/10/**1 红**（红锚点 = createCaptainTask 真实路径 gate-busy 用例）。

### 7.5 Slice 2 指纹（同一次测量：Get-FileHash + count-lines.mjs；本表最后写）

- `lib/p2/quality-loop.js`（新增）= `972CA7986F9F` / 16785 B / 368 行
- `lib/p2/quality-sidecar.js` = `8A2BDCD8EDB2` / 25433 B / 557 行（+gateByRepairTask/gateByReviewTask/queueReview/waitingReviewer 原语）
- `lib/p2/captain-tools.js` = `B5E6D8EF135D` / 18276 B / 349 行（create 扩展 + syncGateOnSupersede + update 路由 + status gates 视图）
- `lib/p2/claim-channel.js` = `7CB2A9E32F7E` / 10960 B / 221 行（claim/report gate 挂钩 + report DTO 三件套）
- `lib/index.js` = `380BEAE67823` / 81354 B / 2017 行（+P3 re-export 块）
- `test/p2-quality-loop.test.mjs`（新增）= `2444F6219D16` / 17630 B / 318 行（11 test() 块）
- 不变（指纹同 t106）：`lib/state/task-store.js` B412BC814EFA；`test/task-state.test.mjs` AD8FDE5BEC74；`test/p2-quality-sidecar.test.mjs` A5A762DF0503；`test/p2-claim-channel.test.mjs` AABD3EB50FFB；`test/p2-captain-tools.test.mjs` 42DD5C1B5329。
- 本文档追加 §7 后终态指纹见 t108 output（自指不写）。

diff 声明：以上 6 改 2 新 + 本文件（§7 纯追加）为全部改动；lib/client.js、两设计稿、scripts/、package.json 零触碰。

### 7.6 遗留（Slice 3+/宿主装配）

1. P1 `/team-tasks/supersede` 路由的 gate 同步处置接线（syncGateOnSupersede 已备，路由侧需 sidecar 实例——宿主装配层）；
2. reviewer-unavailable 阈值（30min）与 G10 重试的运行期校准；
3. 循环创建任务的宿主装配开关（§9.1.1 过渡期默认关闭）与 quality.json 落盘目录接线（`$DSH_HOME/dsh-team-chat/<teamId>/`）。
