# dsh-team-chat 优化文档索引

> 维护：researcher · 2026-09-10 · t26
> 本目录是团队角色针对 dsh-team-chat 性能与新信息架构的全部**证据文档**索引；每份文档内含限制与诚实声明，发布时随代码进仓库使改动自解释。
> 目录按主题分组；任务号 = 产生该证据的团队任务。

## 性能根因（P1 链）

| 文档 | 任务 | 一句话结论 |
|---|---|---|
| `perf-evidence.md` | t4 | 3s readSurface 轮询被翻倍（后台 tick + 前端轮询 + /state 请求内同步 refresh）——**机制已验证，主因地位为高置信推测**（服务端耗时不可插桩）；响应体有 200 条封顶；routingText 每请求 2.1–5.9KB。 |
| `fix-directions-review.md` | t10 | F1–F6 六条修复方向全部判定「需修正」（方向成立但代价/触发条件均被低估；无一可照做）。 |
| `browser-measurement.md` | t9 | /state 真实延迟与轮询期主线程表现的浏览器侧实测；环境阻塞致关键项未测到（完整证据链）。 |
| `better-sidebar-pattern.md` | t5 / t12 | better-sidebar「切入子代理会话」与高负载流畅的实现模式提取（注：属 t12 范围，本文档未改）。 |

## 事件驱动改造（P1b）

| 文档 | 任务 | 一句话结论 |
|---|---|---|
| `event-driven-options.md` | t13 | 3 秒轮询可**部分删**：readSurface 全量轮询换 session/event + agent/status 订阅；roster 周期性发现必须保留（低频兜底）。事件落盘实证：step/turn/tool 事件真实产生。 |
| `event-subscription-cost.md` | t15 | 全局订阅**安全（有条件）**：session/event 含 assistant/chunk 流式增量（忙时峰值 14–50 ev/s），回调第一刀滤 chunk 减 60%；安全条件=回调 O(1) + 节流消费 + 超时/心跳 + 背压。 |
| `detail-view-data-source.md` | t24 | 删 readSurface 轮询后，详细视图发言流可从事件流忠实重建——listEvents 的 surface 字段即折叠结果，按 'current' 过滤即得当前表面；绝不恢复周期轮询。 |

## 新信息架构（P2 前提）

| 文档 | 任务 | 一句话结论 |
|---|---|---|
| `client-sessions-access.md` | t23 | sessions 是客户端运行时根服务；我方只需在 lib/client.js 的 exports.inject 加 'sessions'（无需补 inject 包）；t20 跳转子代理会话前提成立，含三条降级链。 |
| `stall-detection-feasibility.md` | t22 | 兄弟插件读不到任务 claimed 状态（直读不可行）；弱替代=成员 idle + 消息级事件超阈值标「疑似停滞」；恢复经队长的唯一权威通道。 |
| `detach-p1-state-design.md` | t47/t49/t51/t52/t58 | P1 状态层自研设计稿（v3 修订，待评审）：任务 schema / 状态机（supersededBy 链 + 双路径 reclaim：claimed→回收、running→suspended）/ 依赖失效 / 可判定性 / API / 持久化 / 过渡共存；t49/t52 复核 + F1-F3 处置于文末「复核意见与处置」节。 |
| `captain-tool-surface.md` | t48/t55 | 队长工具面调研（样本内）：44 会话/575 次快照统计；语义分层（不可替代 3 项 / 可自动化 5 项 / 样本内零调用 3 项）；errors=0 ≠ 机制安全的原始口径；坑→保护设计映射。 |
| `detach-p2-scheduler-design.md` | t79/t82/t86/t87/t89 | P2 调度器 + 队长工具面设计稿（v0.7，t89 收口修订，待复核）：九条真实事故→设计约束映射；调度模型（宿主管唤醒/成员管认领）；成员可用性状态机与熔断（含 standby 交接态）；同角色多开（命名规范 `<role>-i<idx>` 与轮换代正交、单实例唤醒策略、per-instance 熔断）；轮换四步流程（含 attemptId 双通道交接）；4 工具与 P1 API 映射；routingText 解耦（t80 耦合地图五类三级已并入）；防双调度（§9.1.1）；suspended 30min 硬约束 + reassign 快速路径（§4.2）；过渡共存与 P4 切换条件。 |

## 测量脚本

| 脚本 | 用途 |
|---|---|
| `measure-shared.mjs` / `measure-h3-bound.mjs` / `measure-prompts.mjs` | routingText 尺寸（默认/真实/最坏） |
| `measure-state.mjs` / `measure-state2.mjs` | /state 响应体字节数与处理耗时 |
| `measure-403.mjs` | 未鉴权 /state 探针（403 证实路由挂载且加密） |
| `measure-events.mjs` | 会话日志各事件类型计数（t13 实证） |
| `measure-event-rate.mjs` / `measure-chunk-rows.mjs` | 事件每秒速率 / 全类型原始行计数（t15 洪流量化） |

> 说明：上表「任务」列中 t5/t9/t10/t12 分别为其他成员（reviewer/engineer）产出任务；t22/t23/t24/t26 为 researcher 产出。既有文档标题内自带任务标记（better-sidebar-pattern.md: t5；browser-measurement.md: t9；fix-directions-review.md: t10），未改动其内容。