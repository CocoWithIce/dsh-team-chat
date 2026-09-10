# 形状假设审计：消费平台载荷的字段访问点（shape-assumption-audit）

> **任务**：t34 — 形状假设审计（attempt 1）· 2026-09-10
> **结论**：审计出 **1 处与 t30 同源的现存缺陷**（`tool/result.error.message` 恒不命中 → 错误明细 100% 静默丢失）+ **1 处观测性缺口**（`artifactParseFailures`/`timeouts` 宿主暴露但客户端从不消费）+ 其余访问点经真实样本核对**成立**。
> **证据出处**：真实会话日志核对（27 个 session、36,480+ 事件，脚本 `shape-probe.mjs` / `shape-probe-result.mjs`）+ host Inspect 契约（`session/event` 的 `SessionEventMap`）+ 源码 file:line。
> **分界**：凡有真实样本或契约支撑的标「已验证」；无法核对的**单独列在 §5**，不含混。

---

## 0. 审计方法与背景

- **起因（t30）**：`artifactOf` 假设 `tool/call.arguments` 是对象，真实载荷是 **JSON 字符串** → `artifact` 列 78.1%/58.1%/100% 为 `—`。合成测试（对象形态）全绿把它掩盖了。t31 已修。
- **本任务**：把「消费平台载荷必须先验证形状」落成一次实际审计 —— **同类假设还剩多少处？**
- **方法**：逐点枚举 file:line → 标注形状假设与依据 → 用真实日志核对 → 按可见后果排序。
- **核对手段**：`%TEMP%` 逐帧 zstd 解码思路复用（多帧魔数 0x28B52FFD），脚本落在本目录 `shape-probe.mjs` / `shape-probe-result.mjs`；会话目录 `C:\Users\bo.yang02\.dsh\sessions\--E-DSH_Desktop-DSH~0020Desktop--\`。
- **隐私**：**只输出聚合统计**；全文无用户会话内容、无原文片段。样例仅脱敏截断（此处连截断样例都未保留）。

---

## 1. 风险清单（按「若假设错误会造成什么可见后果」排序）

| # | 访问点 | 假设 | 依据 | 后果（若错） | 结论 |
|---|---|---|---|---|---|
| **R1** | `lib/index.js:736` `data.error.message` | `tool/result.data.error` 是**带 `message` 字符串的对象** | **仅凭假设**（与契约相反） | **错误明细 100% 静默丢失**：步骤视图结果列只显示裸 `error`，用户看不到失败原因（如 ENOENT/超时原因） | ❌ **缺陷（已实测复现）** |
| **R2** | `lib/index.js:1059` `artifactParseFailures` / `:1058` `timeouts` | 宿主暴露即有人消费 | **仅凭假设** | 解析失败/超时**无法在 UI 观察到**，回归不可见（同类缺陷会再次静默） | ⚠️ **观测缺口** |
| R3 | `lib/index.js:724` `tool/call.arguments` | 字符串或对象双形态 | **真实样本**（1327/1327 字符串）+ t31 已修 | 产物列空白 | ✅ 已验证（t31 修复生效） |
| R4 | `lib/index.js:731` `meta.truncated === true` | `meta` 是对象且含布尔 `truncated` | **真实样本**（562 处 meta 全对象；**50 处 truncated===true**） | 截断标记丢失（列显示 `ok` 而实际被截断） | ✅ 已验证 |
| R5 | `lib/index.js:276` `textOf` 块结构 | `content` 是块数组，块 `type==='text'` 且有 `text: string` | **真实样本**（assistant 1307/1307 数组、user 96/96 数组） | 发言/决策整列空白 | ✅ 已验证（且代码本身防御式） |
| R6 | `lib/index.js:446-457` `event.data.message.content` / `data.content` | 存在即读 | 同上 | 群聊发言流空白 | ✅ 已验证 |
| R7 | `lib/index.js:370-376` `child.kind/label/id/activity` | listChildren 行字段 | **契约**（`SubagentListEntry`）+ 既有生产使用 | 名册/在线状态错乱 | ✅ 已验证（契约） |
| R8 | `lib/index.js:1005` `readSurface().events` + `event.data.content` | `events` 数组、`data.content` 存在 | **契约**（`SessionSurfaceSnapshot.events`）+ 既有生产路径 | IM 来源识别失败（仅影响 IM 中继） | ✅ 契约支撑 |
| R9 | 客户端 `/state` 各字段（`threads/members/feed/error/sessionId`） | 存在即读 | **本仓自产**（非平台载荷） | —— | ✅ 不属本审计范围（见 §3） |
| R10 | 客户端 `/steps` 步骤字段（`turn/step/action/artifact/result/decision`） | 同上 | **本仓自产**（`projectSteps` 产出） | —— | ✅ 不属本审计范围（见 §3） |

---

## 2. 缺陷详情：R1（与 t30 同源，现存）

### 2.1 代码

```js
// lib/index.js:729-741
const failed = data.error !== undefined && data.error !== null
const meta = data.meta || {}
lastResult = failed ? 'error' : (meta.truncated === true ? 'truncated' : 'ok')
for (let i = rows.length - 1; i >= 0; i -= 1) {
  if (rows[i].turn === turn && rows[i].step === step && rows[i].result === '—') {
    rows[i].result = lastResult
    if (failed && data.error && typeof data.error.message === 'string') {   // ← :736 恒为 false
      rows[i].result = rows[i].result + ': ' + data.error.message.slice(0, 80)
    }
```

### 2.2 契约（决定性，host Inspect `session/event`）

```
'tool/result': {
  turn: number; step: number; message: ToolResultMessage;
  error?: { name: string; code: string };      // ← 只有 name / code，没有 message
  meta?: JsonValue;
}
```

→ **契约里 `error` 没有 `message` 字段**；`:736` 的类型判断**结构性不可能成立**。

### 2.3 真实日志核对（27 个会话，全量）

```
failedEvents(data.error 非空)      : 114
  └ errorDetailAppended (:736 真的触发) : 0      ← 一次都没有
  └ errorDetailMissed   (明细被静默丢弃) : 114   ← 100%
data.error 观察到的键              : name, code   ← 与契约一致，无 message
```

**判定**：**确定性缺陷**（非可接受兜底）——与 t30 同一类：**假设了不存在的嵌套字段**。可见后果：步骤视图「结果」列在失败时只显示 `error`，用户看不到失败原因；且**没有任何计数器记录这次丢失**（不像 t31 给 parse 失败加了 `artifactParseFailures`），属**完全静默**。

### 2.4 与 t30/t31 的对照（为何这次没被 t31 一起修掉）

t31 只修了 `arguments` 的**形态**（string↔object），未审计**嵌套字段名**（`error.message` vs `error.name/code`）。可见"形态归一化"解决了 t30，但**同源的字段名假设没有被扫**——本审计正是补这一刀。

---

## 3. 观测缺口：R2

`sanitizeSnapshot`（`lib/index.js:1058-1059`）向客户端暴露：

```js
timeouts: timeoutCount,
artifactParseFailures,
```

但客户端 `lib/client.js` **从不读取**这两个字段（`grep artifactParseFailures|timeouts` 在 client.js 仅命中 3 处无关的 "stale" 字样）。

**后果**：t31 特意加的「不静默」计数器，实际**没有出口**——真实运行中若出现新的 parse 失败，UI 与用户都不知情，只有抓 `/state` JSON 或看日志才能发现。**这与 t30 的教训直接冲突**：缺陷发现依赖可见性，而计数器没有消费点。

**建议（不在本任务实施）**：在 `/state` 快照的诊断行（现有 `mode · sessionId · N 成员 · 有错误`）追加 `· 解析失败 N` / `· 超时 N`，让两个计数器有出口。

---

## 4. 已核对成立项（真实样本/契约支撑）

| 项 | 核对方式 | 结果 |
|---|---|---|
| `tool/call.arguments` 双形态 | 真实样本 1327 条 | 全为 JSON 字符串；`artifactOf` 双形态分支正确，parse 失败数 0 |
| `tool/result.meta` 对象 + `truncated` | 真实样本 562 处 meta | 全为对象；**50 处 `truncated === true`**（该分支确实会走，非死代码） |
| `assistant/message.message.content` 块数组 | 真实样本 1307 条 | 100% 数组，且含 `type:'text'` 块 1001 条 |
| `user/message.content` 块数组 | 真实样本 96 条 | 100% 数组 |
| `tool/result.message.content` 块数组 | 真实样本 1325 条 | 100% 数组，且 100% 含 `type:'tool-result'` 块 |
| `textOf` 的块/字段判断 | 源码 + 上述样本 | 防御式（`blocks \|\| []` + 类型判断），无脆弱假设 |
| `meta` 键空间 | 真实样本（样本键集） | `sources,truncated,url,statusCode,diffs,path,offset,lines,totalLines,lang,shape,paths,total,files,pluginId,packageId,pluginRunId` —— 键很多且**不固定**；当前代码只读 `truncated`，安全 |

> 注：`meta` 键空间很大且随工具不同而变。当前只读 `meta.truncated`（布尔判断）是安全的；**若未来要读 meta 的其他键，必须先按本方法核对形状**。

---

## 5. 无法用真实样本核对的项（单列，不含混）

| # | 项 | 为何无法核对 | 风险 |
|---|---|---|---|
| U1 | `listChildren` 返回行中 `child.activity` 的**全取值域** | 真实样本只覆盖到 `running`/`inactive` 两值（契约 `SubagentListEntry.activity: 'running' \| 'inactive'`）；`rosterFrom` 把非 `running` 一律归 `idle`（`index.js:375`），对未知新值会**误报为空闲** | 低—中（新值出现时静默误标） |
| U2 | `readSurface().events` 中 `event.data.content` 的**块类型全集** | 只核对了 `type:'text'`；`image`/`tool-call` 等块在成员会话中的出现率未测 | 低（`textOf` 会忽略非 text 块，仅少显示文字） |
| U3 | `agent/status` 载荷 `{agent, status}` 的 status 取值域 | 契约给 `'idle' \| 'running'`；真实样本未逐一核对代理事件（属事件流，未在日志中逐条统计） | 低（代码用 `=== 'running'` 判断，未知值归 idle） |
| U4 | 客户端侧 `TabComponentProps.scope.sessionId` 形状 | 需浏览器运行时（client Inspect 挂起，禁用） | 低（既有生产路径已工作） |
| U5 | `/steps` 与 `/state` 在**多会话并发**下的字段稳定性 | 需运行时并发观测（未做） | 低 |

---

## 6. 复现入口

| 想复现什么 | 命令/入口 |
|---|---|
| 载荷形状聚合统计（arguments/meta/content 等） | `node docs/optimization/shape-probe.mjs <session.jsonl.zstd …>` |
| `error.message` 分支是否命中（R1） | `node docs/optimization/shape-probe-result.mjs <session.jsonl.zstd …>` |
| 契约原文（`tool/result.error` 字段） | host Inspect：`platform=host, provider=Event, method=listEvents, event='session/event'` → `SessionEventMap['tool/result']` |
| 逐帧 zstd 解码思路 | 多帧魔数 `0x28B52FFD` 逐帧解；同 `%TEMP%\dump-tail.mjs` |

---

## 7. 结论与建议（供队长决策，不在本任务实施）

1. **R1 建议修复**：`:736` 改为按真实契约取 `error.name` / `error.code`（并保留对历史/合成 `message` 形态的兼容），修复后补一条「`error = {name, code}`」的真实载荷用例——与 t31 给 `arguments` 的双形态测试同款。
2. **R2 建议补出口**：让 `artifactParseFailures` / `timeouts` 在 UI 诊断行可见，否则「不静默」的设计落不了地。
3. **流程建议**（把教训落成机制）：凡新增消费平台载荷的字段访问，**先在 `shape-probe.mjs` 加一条聚合断言再写代码**；`meta` 键空间非固定，是下一个高风险区。

---

> 落盘：t34（2026-09-10）。全文仅聚合统计，未包含任何用户会话内容。R1/R2 为**实测发现**；§5 五条为**未核对项**，不含混入已验证结论。