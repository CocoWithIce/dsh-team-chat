# 「详细」视图完整发言流的数据源判定（detail-view-data-source）

> **任务**：t24 — 新方案自查（attempt 1）
> **结论**：删掉 readSurface 轮询后，详细视图完整发言流可从事件流忠实重建——有现成 API，无需自造折叠。
> **证据出处**：`@deepseek-ai/dsh-session`（surface 折叠）+ `@deepseek-ai/dsh-session-query`（classifySurface）+ 先前 t13/t15 契约。
> **已验证 / 推测分界**：surfaceOp/fold 语义与 listEvents surface 字段实现 = 源码逐行核对；「事件已落盘」= t13 实测；未做运行时埋点验证该路径（见 §诚实声明）。

---

## 1. 结论（三行）

1. `readSurface` 返回的当前模型表面（user/message、assistant/message、tool/result）可从事件日志**忠实重建**。
2. **现成 API**：`listEvents` 的 `surface` 字段（`'current' | 'shadowed' | 'log-only'`）就是折叠结果（`classifySurface = foldSurface(events)`），按 `surface='current'` 过滤即得当前表面，**无需自己写 fold**。
3. 推荐：事件流增量维护为主（与 t17 同源）+ 打开详细视图瞬间一次 `listEvents(surface:'current')`/`readSurface` 对齐；**绝不允许恢复周期性 readSurface 轮询**。

## 2. Q1 surfaceOp 语义（源码验证）

`dsh-session/lib/types/surface.js` + `index.js`：

- `surfaceOp='append'` → 该事件作为当前表面节点追加（surface.js:143-144）。
- `surfaceOp={op:'replace', start, end}` → 区间 `[start, end]` 的**现有节点被标记 shadowed**，并由该新事件替换；替换必须满足 provenance：`sourceEventSeqs` 覆盖每个被 shadow 的节点（`assertProvenance`，surface.js:154-201；`replacementRange`，index.js:199-201）。
- **被替换/shadowed 的事件从当前模型表面移除**——不再作为 user/assistant/tool 消息参与「当前发言流」（`foldSurface` 仅保留 `nodes`，surface.js:306-315）。
- `tool/result` 的替换是**单节点重写**（`assertToolResultRewrite`，surface.js:220-224）。
- 当前表面 = 有序 `nodes`（seq 列表）+ `replaceGeneration`（index.js:279, 340-342）。

**对详细视图的含义**：简单「按 seq 顺序把所有 user/assistant/tool 事件堆出来」**不是**忠实发言流——被 replace/shadowed 的事件会被显示出来，造成「修过的内容还显示旧版」。必须按 surfaceOp 折叠。

## 3. Q2 从事件流能否忠实重建 — 能，双重现成路径

**路径 ①（推荐）：`listEvents` 的 `surface` 字段**
- `listEvents(sessionId)` → `SessionEventRecord[]`，字段含 `surface: SessionEventSurface`（`'current' | 'shadowed' | 'log-only'`）。
- 该字段就是折叠结果：`dsh-session-query/lib/index.js:474-522` —— `buildSessionEventRecords` 调 `classifySurface(events)`，内部 `foldSurface(events)` 后把 `folded.nodes` 标 `'current'`、`folded.replacements[].shadowedSeqs` 标 `'shadowed'`、其余标 `'log-only'`。
- **按 `surface='current'` 过滤 → 得到忠实当前模型表面（user/message + assistant/message + tool/result 当前节点）**，不用自己写 fold。

**路径 ②：`foldSurface(events)` 直接折叠**
- `foldSurface(events)`（surface.js:306-315）返回 `{ nodes, replacements }`——宿主若已持有事件序列（如 t17 事件缓冲），可本地折叠；`Session.surface`（Session 类 getter）同款。

## 4. Q3 两条路径代价对比与推荐

| 维度 | 路径 A：事件流增量 | 路径 B：按需 readSurface |
|---|---|---|
| 触发方式 | session/event 订阅增量维护（t15 已证安全） | 打开详细视图瞬间一次 |
| 成本 | O(增量)，零请求往返，与 t17 同源 | 单次完整 surface 读 |
| 一致性 | 与 t17 步骤视图同源同数据 | 与 A 需对齐（capturedThroughSeq 游标） |
| 说明 | 推荐主路径 | 推荐作 gap 补齐/对齐（打开瞬间、A 有缺口时） |

**最终推荐**：默认路径 A（增量维护）；打开详细视图瞬间如有 gap，用一次 `listEvents(surface:'current')` 或 `readSurface` 对齐（路径 B）。**两者都远低于旧 3s 全量轮询；不要两条都周期运行。**

## 5. Q4 明确约束

- 允许：打开详细视图时**一次**按需 `readSurface` 或 `listEvents(surface:'current')` 对齐。
- **禁止：恢复周期性 readSurface 轮询**（t17 正在删它；这是本优化方案的倒退）。

## 6. 给 t17 / t20 的可执行结论

- t17 把 readSurface 轮询替换为 session/event 订阅时，**事件缓冲区保留 surface-eligible 事件**（`user/message`、`assistant/message`、`tool/result`，带 `surfaceOp`）。
- 详细视图默认直接从该缓冲渲染（按 surfaceOp append/replace 维护节点集）；打开瞬间一次 `listEvents(surface:'current')` 对齐。
- 结果：**步骤视图 + 详细视图同源同数据**，t20 无需第二个数据通道。

## 诚实声明

- 全部源码取证（client 探针不可用——Inspect 挂起教训）。
- fold/surface 语义与 classifySurface 实现逐行核对；**未做运行时埋点验证**该重建路径（但 t13 已实测这些事件确实落盘）。
- 若实现后发现有 gap（例如缓冲未追平），降级为打开瞬间一次 readSurface 对齐，不改变主路径架构。

---

> 落盘：t26（2026-09-10）。诚实声明保留：未运行时埋点验证重建路径。