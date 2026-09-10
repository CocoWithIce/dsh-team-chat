# better-sidebar 能力提取：切入子代理会话 + 高负载下仍流畅

> **任务**：t5 — 能力提取（attempt 3）；t12 改派复验（researcher 追加 §10，2026-09-10）
> **目的**：为 dsh-team-chat 补齐「① 从群聊/UI 直接切入某个子代理会话」「② DSH 整体卡顿时自身仍流畅」两项能力，提取参考实现 better-sidebar 的可行模式。
> **证据基线**：`dsh-better-sidebar@0.18.1`（`SIDEBAR_SERVICE_VERSION = '0.18.1'`，service.ts:468）
> **来源**：已安装包的 **TS 源码**（非打包产物）。
> 参考源码根：`C:\Users\bo.yang02\.dsh\profiles\desktop\node_modules\dsh-better-sidebar\src\`
> 平台源码根：`E:\DSH_Desktop\DSH Desktop\resources\app.asar.unpacked\node_modules\@deepseek-ai\`

---

## 0. 结论速览（TL;DR）

| 问题 | 结论 | 可复用性 |
|---|---|---|
| **Q1** 子代理列表/元信息来源 | 宿主侧 `ctx.subagents.listDescendants(rootSessionId)` + 客户端 `ctx.sessions.list` 快照双源 | **DSH 平台公开服务**，可复用 |
| **Q2** 切入子代理会话 | 客户端 `ctx.sessions.openSubagent(address)` / `open(id)` | **DSH 平台公开服务**，可复用 ⭐ |
| **Q3** 卡顿时仍流畅 | 单一 self-scheduling 轮询 + 可见性门控 + 懒加载分片 + 单请求批量折叠 | 模式可复用，代码需自研 |
| **Q4** 公开契约 | `ctx.betterSidebar.registerTab(TabDescriptor)` / `openTab(seed, scope?)` | **公开契约可用**（但它只是「侧边栏页」扩展点） |
| **Q5** 必须自研 | 轮询调度器、批量折叠、懒加载、拓扑渲染 | 不可借用 |

> **最关键判定（本任务核心问题）**：
> **从我们自己的客户端插件出发，把界面切换到任意会话（含子代理会话）在公开契约上完全可行。**
> 依据：`ctx.sessions` 是 **DSH 平台**（`@deepseek-ai/dsh-api-session-controller`）通过 cordis 提供的**公开客户端服务**，其 `open()` / `openSubagent()` 就是官方切换会话的原语。better-sidebar 在这里**只是消费者**，不是实现者。详见 §3。

---

## 1. Q1 — 子代理会话列表与元信息从哪来

**结论：双源。** 元信息走**客户端**会话列表快照；实时活动/血缘走**宿主侧** subagent 服务。**两者都是 DSH 平台能力，不是 better-sidebar 的私有实现。**

### 1.1 数据源 A：宿主侧 — `ctx.get('subagents').listDescendants()`

宿主 Node 进程侧，通过 `ctx.get('subagents')` 取得 subagent 运行时服务：

```ts
// src/subagent-live-route.ts:51-68
const subagents = ctx.get('subagents') as SidebarSubagentsService | undefined
if (subagents === undefined || typeof subagents.listDescendants !== 'function') {
  throw new SidebarError('subagents-unavailable',
    'the subagent service is not mounted in this deployment', 503)
}
descendants = await subagents.listDescendants(rootSessionId)
```

契约（`src/context-types.ts:250-260`）：

```ts
export interface SidebarSubagentsService {
  /** 枚举 root 的完整 session-backed 子代理树，稳定前序，不加载/恢复 Agent
   *  （SubagentRuntime.listDescendants 的结构镜像）。 */
  listDescendants(
    rootSessionId: string,
    signal?: AbortSignal,
  ): Promise<SidebarSubagentDescendantEntry[]>
}
```

返回行形状（`src/context-types.ts:263-280`）：

```ts
export type SidebarSubagentDescendantEntry =
  | { kind: 'child'; id: string; activity: 'running' | 'inactive'
      hasChildren: boolean; mode: 'one-shot' | 'continuable'
      label?: string; parentId: string; depth: number }
  | { kind: 'diagnostic'; id: string; reason: 'corrupt'|'unsupported'|'unavailable'
      parentId: string; depth: number }
```

**关键语义**：`listDescendants` **不加载也不恢复 Agent**，纯只读枚举（context-types.ts:252-254）。官方 README 印证：服务「回答发现类问题——存在哪些子级、它们的模式、活动状态与血缘——而不加载或恢复它们」（`@deepseek-ai/dsh-subagent/README.zh.md:12`）。

宿主侧读取子代理事件日志（用于实时预览）：

```ts
// src/subagent-live-route.ts:79-82
const activity = lastActivity(
  ctx.sessions.get(entry.id)?.snapshotEvents() ?? [],
  LIVE_WINDOW_MESSAGES,        // = 12
)
```

> ⚠️ 注意此处 `ctx.sessions` 是**宿主侧** SessionStore（`get(id).snapshotEvents()`，见 `context-types.ts:86-97`），与 Q2 的**客户端** `ctx.sessions` **同名但不同物**。这是本项目最易踩的坑，源码注释专门警告过这点（`context-types.ts:9-13`：host `sessions: SessionStore` vs client runtime `sessions: ISessions`，两者类型不同、无法合并）。

### 1.2 数据源 B：客户端侧 — `ctx.sessions.list` 快照

浏览器侧订阅会话列表（含子代理行）：

```tsx
// src/client/SubagentView.tsx:638-645
const list = useSyncExternalStore(
  useMemo(() => (callback: () => void) => sessions.list.subscribe(callback), [sessions]),
  useCallback(() => sessions.list.getSnapshot(), [sessions]),
)
const byId = list.byId
const catalogs = useMemo(() => list.subagentsByParent ?? {}, [list.subagentsByParent])
```

快照形状（`src/context-types.ts:310-321`）：

```ts
export interface SidebarSessionList {
  current: string | undefined
  byId: Record<string, SidebarSessionSummary>
  subagentsByParent?: Readonly<Record<string, SidebarSubagentCatalog>>
  jobsBySession?: Readonly<Record<string, readonly SidebarJobView[]>>
}
```

行形状（`context-types.ts:139-149`）——注意 `origin` / `parentId` 是识别子代理的判据：

```ts
export interface SidebarSessionSummary {
  id: string; cwd?: string; displayTitle: string
  origin?: 'subagent'          // ← 子代理判据
  parentId?: string            // ← 血缘判据
  running?: boolean
}
```

**客户端直接判据**（`src/client/subagent-detect.ts:28-38`）：

```ts
export function directSubagentCount(byId, sessionId): number {
  let count = 0
  for (const summary of Object.values(byId)) {
    if (summary.origin === 'subagent' && summary.parentId === sessionId
      && !isSideThreadSummary(summary)) count += 1
  }
  return count
}
```

**副作用**：客户端要拿到 `subagentsByParent`，必须显式声明「有人在看」——`setSubagentCatalogOpen(parentSessionId, open)`（SubagentView.tsx:657），并在页面隐藏时释放（:668-676）。**不声明就收不到目录更新**（subagent-live-route.ts:5-6 注释）。

### 1.3 「宿主侧」还是「浏览器侧」？

**两者都用，分工明确**：

| 数据 | 侧 | API |
|---|---|---|
| 子代理血缘/活动/模式的**权威枚举** | **Host** | `ctx.get('subagents').listDescendants()` |
| 实时**活动折叠**（最后文本/工具调用） | **Host** | `ctx.sessions.get(id).snapshotEvents()` + `lastActivity()` |
| 会话列表**元信息**（标题/cwd/running） | **Client** | `ctx.sessions.list.getSnapshot()` |
| 子代理**目录行**（懒加载） | **Client**（内容由 Host 拉取） | `list.subagentsByParent` |

---

## 2. Q2 — 如何把主视图切入某个子代理会话 ⭐

**结论：调用 DSH 平台的客户端 `sessions` 服务。这是平台公开能力，不是 better-sidebar 私有实现，完全可复用。**

### 2.1 better-sidebar 的实际调用点

```tsx
// src/client/SubagentView.tsx:698-709 —— 点卡片切入子代理
const openChild = useCallback((address: SidebarSubagentAddress): void => {
  onOpenChild?.(address)          // 先通知 shell（保拓扑页不关）
  try {
    sessions.openSubagent?.(address)   // ← 真正的切换
  } catch (error) {
    console.error('[dsh-better-sidebar] openSubagent failed:', error)
  }
}, [sessions, onOpenChild])

// src/client/SubagentView.tsx:712-719 —— 点根节点跳回主会话
const openMain = useCallback((): void => {
  if (rootId === undefined) return
  try {
    sessions.open?.(rootId)            // ← 切回主会话
  } catch (error) { /* ... */ }
}, [sessions, rootId])
```

better-sidebar 自己声明它只是**镜像**平台能力（`context-types.ts:329-333, 357-361`）：

```ts
export interface SidebarSessionsService {
  list: { getSnapshot(): SidebarSessionList; subscribe(fn: () => void): () => void }
  /** 选择已列出的会话为当前（runtime ISessions.open 的镜像） */
  open?(id: string): void
  /** 通过精确的直系父地址打开健康目录子级（runtime ISessions.openSubagent 的镜像） */
  openSubagent?(address: SidebarSubagentAddress): void
  subagentAddress?(id: string): SidebarSubagentAddress | undefined
  // ...
}
```

注释里反复出现的「**mirror of the runtime ISessions.***」就是证据：**实现方是 DSH runtime，不是它。**

### 2.2 平台权威定义（决定性证据）

真身在 `@deepseek-ai/dsh-api-session-controller` —— 客户端 `sessions` 服务的**唯一提供者**：

```js
// lib/client.js:2307
rootCtx.reflect.provide("sessions", this, void 0);

// lib/client.js:2320-2321
openSubagent(address) { this.manager.selectSubagent(address); }
```

权威实现（`lib/types/client/sessions/service.js:148-185`）：

```js
export class ClientSessions {
  /**
   * Select a listed or retained catalog-addressed session as current.
   * @param id - listed or addressed session id.
   */
  open(id) {                                   // service.js:152-154
    this.manager.select(id);
  }
  /**
   * Open a healthy catalog child through its direct-parent address.
   * @param address - catalog-derived parent and child ids.
   */
  openSubagent(address) {                      // service.js:159-161
    this.manager.selectSubagent(address);
  }
  /** Resolve an already discovered direct-parent address without opening it.
   *  Feature plugins use this to avoid Agent-bound RPCs in persisted child views. */
  subagentAddress(id) {                        // service.js:168-170
    return this.manager.subagentAddress(id);
  }
  setSubagentCatalogOpen(parentSessionId, open) {   // service.js:176-178
    this.manager.setSubagentCatalogOpen(parentSessionId, open);
  }
  refreshSubagents(parentSessionId) {               // service.js:183-185
    return this.manager.refreshSubagents(parentSessionId);
  }
}
```

**服务类注释明确点名面向插件**（service.js:163-164）：
> *"Feature plugins use this to avoid Agent-bound RPCs in persisted child views."*

**子代理地址的确切形状**（`better-sidebar/src/context-types.ts:179-183`）：

```ts
export interface SidebarSubagentAddress {
  parentSessionId: string
  childSessionId: string
  mode: 'one-shot' | 'continuable'
}
```

地址形状的**权威来源**在 `subagentAddress(id)`：先 `subagentAddress(childId)` 取地址，再 `openSubagent(address)` 切入。参数校验有两处等价位置（源文件与打包产物）：

```js
// lib/types/client/sessions/manager.js:105-109（源），等价于 lib/client.js:1494（打包）
selectSubagent(address) {                                    // manager.js:105
  // ...
  if (entry === void 0 || entry.kind !== "child" || entry.mode !== address.mode)
    throw new Error(`sessions.selectSubagent: ${address.childSessionId} is not a healthy catalog child`);
}                                                            // manager.js:109
```

> **注意**：`openSubagent` 只接受**健康目录子级**（`kind === 'child'` 且 `mode` 必须与目录记录一致），否则抛错。`mode` 不是可选的——必须来自目录行。

### 2.3 选择性调用（`?.`）的必要性

better-sidebar 全部用 `openSubagent?.()` / `open?.()` 可选调用，因为这两个方法在**旧版本 DSH 上可能不存在**（其 `SidebarSessionsService` 把它们声明为可选 `?`）。我们照做即可安全降级。

### 2.4 准确调用形态（可直接照抄）

```ts
// 形态 A：切到任意已知 session id（含子代理会话）
const sessions = ctx.get('sessions')          // 客户端 root 服务
sessions.open?.(childSessionId)

// 形态 B：按「直系父地址」切入子代理（推荐，会让 DSH 正确记录 subagentAddress）
const addr = sessions.subagentAddress?.(childSessionId)   // 或自行构造
if (addr !== undefined) sessions.openSubagent?.(addr)

// 形态 C：订阅「当前会话」变化，用于群聊高亮/跟随
const list = sessions.list
const unsub = sessions.list.subscribe(() => {
  const snap = sessions.list.getSnapshot()
  console.log('current =', snap.current)      // 当前会话 id
  console.log('currentAddress =', snap.currentAddress)  // 当前子代理地址
})
```

> **`current` / `currentAddress` 字段**：客户端快照里就有当前选中态（client.js:2290 与 service.js:505 传入 `current`、`currentAddress`），无需额外查询。子代理被选中时 `current` 就是子代理的 session id（service.js:456-487 会把地址链上的子代理解析进 `byId`）。

---

## 3. 可行性独立判定（本项目核心问题）

**判定：可行 ✅ —— 且是 DSH 平台公开契约，不是私有实现。**

### 3.1 依据链（全部为源码证据）

| # | 证据 | 位置 |
|---|---|---|
| 1 | 客户端 `sessions` 服务的**唯一提供者**是平台包，非 better-sidebar | `dsh-api-session-controller/lib/client.js:2307` `rootCtx.reflect.provide("sessions", this, void 0)` |
| 2 | 该类**就是** `@deepseek-ai/dsh-api-session-controller`（DSH 官方包） | 同文件；包路径在 `app.asar.unpacked/node_modules/` |
| 3 | `open()` / `openSubagent()` 是**公开方法**（有 JSDoc，无 `private`/`#`） | `service.js:152`, `service.js:159` |
| 4 | 注释**明确指名插件**可调用 | `service.js:163-164` "Feature plugins use this to avoid Agent-bound RPCs..." |
| 5 | 第三方插件 **better-sidebar 已在生产环境这么用**且用户满意 | `SubagentView.tsx:705`, `:715` |
| 6 | `subagentAddress` / `setSubagentCatalogOpen` / `refreshSubagents` 同为公开面 | `service.js:168,176,183` |

**这是「公开契约可用」，不是「依赖私有实现」**：`ctx.sessions` 由 DSH 官方包通过 cordis `provide` 发布到 root context，任何客户端插件都能通过 `ctx.get('sessions')` 取到。

### 3.2 获取服务的两种方式

```ts
// 方式一（推荐，better-sidebar v0.18.1 修复后的做法）：root reflect store 解析
const sessions = ctx.get('sessions')     // 不受 fiber 链影响

// 方式二：声明 inject
export const inject = ['sessions']
// 然后 ctx.sessions
```

> **重要踩坑提示**：better-sidebar 曾因直接 `ctx.sessions` 而在 npm 安装版 DSH 上崩溃（`cannot get property "betterSidebar" without inject`），26 处改走 `ctx.get(...)`（README.md:372）。**我们应统一用 `ctx.get('sessions')`**，并对 `undefined` 做降级。

### 3.3 未取得运行时确认的部分（诚实标注）

按队长加固指令，**本轮未调用 `cordis_inspect_query(platform=client)`**（前两次该调用导致回合永久挂起）。因此：

- **源码可证**（已给出 file:line）：服务名 `sessions`、方法名/签名 `open(id)` / `openSubagent(address)` / `subagentAddress(id)` / `setSubagentCatalogOpen(parentId, open)` / `refreshSubagents(parentId)`、地址形状、`provide` 方式、`list` 快照形状与 `current`/`currentAddress` 字段。
- **需运行时确认**（源码无法单独证明，建议落地时用 `ctx.get('sessions')` 做一次探针打印）：
  1. 当前 DSH 版本**是否真的挂载**了 `dsh-api-session-controller`（若未挂载则 `ctx.get('sessions')` 返回 `undefined` → 必须降级）；
  2. `list.current` 在**子代理会话被选中时**的实测取值（源码推导应为子代理 id，但未实测）；
  3. `openSubagent` 对 `mode` 的严格校验在真实目录行上是否总能通过。

> **降级策略**：所有调用都应写成 `sessions?.openSubagent?.(addr)`，失败时群聊仍可正常渲染，仅「切入会话」按钮置灰。

---

## 4. Q3 — 为何 DSH 卡顿时它仍流畅

**结论：不是靠事件推送，而是靠「一个受控轮询 + 强门控 + 懒加载 + 批量折叠」把自身开销压到与主线程无关。**

### 4.1 唯一轮询器 —— `usePolling`（`src/client/use-polling.ts`）

把所有定时请求收敛到**一个**调度器（其文档第 2 行：「the sidebar's ONE polling loop」）：

```ts
// use-polling.ts:37-41 —— 两种模式
mode?: 'fixed-interval' | 'self-scheduling'
/**
 * 'fixed-interval'（默认）用 setInterval，在途任务不延迟下一跳。
 * 'self-scheduling' 只在上一跳 settle 后才 arm 下一跳：
 *   同一时刻至多 ONE request in flight，慢宿主永远不会看到请求风暴。
 */

// use-polling.ts:51-70 —— self-scheduling 实现
if (mode === 'self-scheduling') {
  let disposed = false
  let timer: number | undefined
  const tick = async (): Promise<void> => {
    if (disposed) return
    try { await task(controller.signal) }
    catch { /* A failed poll keeps the last view; the next tick retries. */ }
    if (!disposed) timer = window.setTimeout(() => { void tick() }, intervalMs)
  }
  if (immediate) void tick()
  else timer = window.setTimeout(() => { void tick() }, intervalMs)
  return () => { disposed = true; if (timer !== undefined) window.clearTimeout(timer); controller.abort() }
}
```

**三个关键抗压设计**：
1. **`self-scheduling`**：在途请求不叠加 → 慢宿主下不会产生请求风暴（文档 :34-36 明说「a slow host never sees request storms」）。
2. **每轮一个 `AbortController`**：teardown 时 abort 并停掉所有调度；且**明确警告** abort 不保证 reject，**必须自己检查 `signal.aborted`**（文档 :13-16）。
3. **失败不中断循环**：`catch {}` 吞掉，下一跳重试，保留上一帧视图（:17-19）。

### 4.2 具体数值（全部实测自源码常量）

| 场景 | 间隔 | 模式 | 证据 |
|---|---|---|---|
| 子代理树实时预览 | **3000 ms** | `self-scheduling` + `immediate: true` | `SubagentView.tsx:62` `POLL_MS = 3000`；`:203-207` |
| 侧边对话 transcript | **2000 ms** | 默认 `fixed-interval` | `SideChatView.tsx:79` `POLL_MS = 2000`；`:515` |
| 展开的 job 输出面板 | **2000 ms** | `setInterval` | `SubagentView.tsx:66` `JOB_POLL_MS = 2000`；`:395` |
| Git 状态（GitLens） | **2000 ms** | 默认 | `GitLens.tsx:288` |
| Changes 页 | **2500 ms** | 默认 | `ChangesTab.tsx:112` |
| kill 按钮重新武装 | **3000 ms** | — | `SubagentView.tsx:68` `JOB_KILL_ARM_MS` |

### 4.3 可见性门控 —— 不可见即完全停摆

所有轮询的 `enabled` 都绑定 `visible`/`active`：

```ts
// SubagentView.tsx:203
usePolling(rootId !== undefined && active, poll, { intervalMs: POLL_MS, mode: 'self-scheduling', immediate: true })
// SideChatView.tsx:515
usePolling(visible && running && threadId !== undefined, pollTick, { intervalMs: POLL_MS })
// ChangesTab.tsx:112
usePolling(visible, pull, { intervalMs: 2_500 })
```

`TabComponentProps.visible` 的语义（`service.ts:148-149`）：
> *"Whether this tab is the active one AND the panel is open (**live views pause otherwise**)."*

**这是「卡顿时仍流畅」的核心**：页面不可见时**零请求**。同时 `active` 变化触发 effect cleanup → abort 在途请求 + 清定时器（use-polling.ts:65-69）。

### 4.4 单请求批量折叠 —— 用 1 个请求替代 N 个

```ts
// src/subagent-live-route.ts:1-3（模块头注释）
// 'subagents.live': one request per refresh instead of N per-child
// `subagents.history` calls.

// SubagentView.tsx:182-187
// Unlike the old per-card `subagents.history` timers, this sends at
// most ONE `subagents.live` request at a time
```

宿主侧在一次调用内枚举整棵树并折叠（subagent-live-route.ts:59-90）：一次 `listDescendants` + 逐子级 `snapshotEvents()`，只对 `activity === 'running'` 的行取数据（**:74** 门控），失败只跳过该子级（**:86-88** `catch {}`）。

**窗口上限**（`subagent-live-route.ts:41`）：
```ts
/** 只折叠子级日志最后 12 条 surface message。
 *  把过时的工具调用挡在预览外，并界定每个子级的反向扫描上限。 */
export const LIVE_WINDOW_MESSAGES = 12
```

### 4.5 懒加载分片 —— 启动只下载核心

```ts
// src/client/chunk-loader.ts:1-8
// 重型预览/终端库（CodeMirror、xterm —— 数 MB）放在独立构建产物
// （`lib/client-<name>.js`），只在首次用到该功能时才 fetch，
// 因此启动只下载/解析 ~1MB 核心包。
export type ChunkName = 'terminal' | 'editor' | 'mermaid' | 'locale'
```

三层缓存（:30-44）：内存（一个 chunk 一个 in-flight promise）→ 脚本执行（赋值覆盖而非注册，避免重复注册类错误）→ HTTP（`cache-control: no-cache` + ETag，304 复用）。HMR 时 `revalidateChunksOnReactivate()` 只对 ETag 未变的 chunk 保留缓存（:45-51）。

### 4.6 ⚠️ 纪律性结论：它**没有**用 SSE/长轮询

**全文未发现 SSE / EventSource / WebSocket 用于子代理数据。** 它拿到的推送来自平台已有的 cordis 事件与 Session list store 订阅（`ctx.sessions.list.subscribe`），而非自建实时通道。

**这与 t4 的发现直接相关**：dsh-team-chat 当前的卡顿主因是 **readSurface 轮询被翻倍**（后台 3s + 前端 3s，均 `/state`）。better-sidebar 给出的正是同类问题的解法——**收敛到单一 self-scheduling 轮询 + 可见性门控 + 批量折叠**，即「减少请求数量与在途重叠」，而不是「换更快的推送通道」。

> 对 dsh-team-chat 的直接可迁移结论：**优先做请求收敛与门控**（低风险、可立即见效），`self-scheduling` 模式尤其适合 `/state` 这类重接口——它天然保证「同一时刻至多一个在途」，这正是 t4 所测慢请求叠加场景的解药。

### 4.7 虚拟化 / 增量 transcript：**未发现**

- **列表虚拟化**：未在 `SubagentView.tsx` 中发现 windowing/virtual list。
- **增量 transcript**：`sidechat-transcript.ts` 存在，但 SubagentView 的实时预览是**整份替换**（`setLive(result.live)`，SubagentView.tsx:201），不是增量 patch。

它用**小窗口（12 条）+ 低频率（3s）+ 单请求**替代了虚拟化与增量同步。这是一个**更简单**的取舍，值得借鉴。

---

## 5. Q4 — 对外公开契约

**结论：`ctx.betterSidebar` 是它唯一的公开扩展点，实现「注册一个侧边栏页」。我们可以合法使用，但它不等于「切入子代理会话」能力。**

### 5.1 服务接口（`src/client/service.ts:347-400`）

```ts
export interface BetterSidebarService {
  registerTab(descriptor: TabDescriptor): () => void
  registerFileViewer(descriptor: FileViewerDescriptor): () => void
  getTabs(): readonly TabDescriptor[]
  getFileViewers(): readonly FileViewerDescriptor[]
  getTab(id: string): TabDescriptor | undefined
  isTabEnabled(id: string): boolean
  isViewerEnabled(id: string): boolean
  matchFileViewer(path: string, head?: Uint8Array): FileViewerDescriptor | undefined
  openTab(seed: OpenTabSeed, scope?: SessionScope): void
  closeTab(tabId: string, scope?: SessionScope): void
  // + 状态订阅
}
```

### 5.2 `TabDescriptor` 字段与语义（`service.ts:162-243`）

| 字段 | 类型 | 语义 |
|---|---|---|
| `id` | `string` | **必填**。唯一 id，同时是 `SidebarTab.type` 值（如 `'my-plugin:db'`） |
| `title` | `string \| (() => string)` | **必填**。标题 |
| `component` | `(props: TabComponentProps) => ReactNode` | **必填**。渲染函数 |
| `icon` | `ReactNode \| ((size:number)=>ReactNode)` | 图标 |
| `order` | `number` | + 菜单排序，默认 100 |
| `hidden` | `boolean` | 从 + 菜单隐藏 |
| `available` | `(ctx, scope, state) => boolean` | + 菜单禁用判定（**不**阻止 `openTab`） |
| `single` | `boolean` | `true` = `dedupeKey: () => id` 的语法糖 |
| `dedupeKey` | `(tab) => string \| undefined` | 返回相同 key 则聚焦已存在的 tab |
| `createTab` | `(state) => {tab, patch?} \| null` | 自定义造 tab；`null` = 拒绝创建 |
| `urlTarget` | `(url: URL) => boolean` | 外链接管声明（先注册先得） |
| `settings` | `SidebarSettingsDeclaration` | 声明式设置 |
| `badge` | `(ctx, scope, state) => string\|number\|null` | tab 角标（每次都调用，要便宜） |
| `onOpen` / `onActivate` / `onClose` | `(tab, scope) => void` | 生命周期回调（仅 service 路径触发） |

### 5.3 `TabComponentProps`（`service.ts:143-159`）⭐

```ts
export interface TabComponentProps {
  ctx: Context
  store: SidebarStore
  scope: SessionScope
  tab: SidebarTab
  /** 该 tab 是否处于激活态**且**面板已打开（否则实时视图应暂停）。 */
  visible: boolean
  expanded?: string[]; revealed?: string[]
  onToggleDir?: (path: string) => void
  onReferenceFile?: (path: string, isDir: boolean) => void
  onOpenFile?: (path: string) => void
  onOpenDiff?: (tab: SidebarTab) => void
  onSubagentJump?: (childSessionId: string) => void   // ← 子代理跳转钩子
}
```

**注意 `onSubagentJump?: (childSessionId: string) => void`** —— 这是它给 tab 组件预留的子代理跳转回调（`:158`），但**其实现仍落在 `ctx.sessions.openSubagent`**。

### 5.4 `openTab` 签名与语义（`service.ts:392`）

```ts
openTab(seed: OpenTabSeed, scope?: SessionScope): void

export interface OpenTabSeed {   // service.ts:328-342
  type: string          // 对应 TabDescriptor.id
  title?: string
  path?: string         // 文件路径（editor tab）
  diff?: SidebarTab['diff']
  id?: string           // 显式 tab id，默认 = type
  url?: string          // browser tab 的导航目标
  meta?: unknown        // JSON 可序列化的自定义状态（持久化）
}
```
**重要语义**（:377-380）：`scope` 给定时，open 落到**那个会话**的侧边栏状态，**不切换 UI 当前会话**；不给则落到当前活动会话。
→ 也就是说 `openTab` **不是**「切换主视图到某会话」的 API，而是「在某会话的侧边栏开个页」。

### 5.5 官方接入形态（README.md:176-189，可照抄）

```ts
import type {} from 'dsh-better-sidebar'  // 触发 ctx.betterSidebar 类型合并
export const inject = ['betterSidebar']
export function apply(ctx: Context) {
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'my-plugin:db', title: 'Database',
    component: ({ scope }) => <DbView sessionId={scope.sessionId} />,
  }))
  ctx.effect(() => ctx.betterSidebar.registerFileViewer({
    id: 'my-plugin:csv', exts: ['csv'], fetchStrategy: 'custom',
    load: async (path, scope) => parseCsv(await fetchText(scope, path)),
    component: ({ customData }) => <CsvGrid rows={customData} />,
  }))
}
```

### 5.6 能力探测（`service.ts:487-499`）

```ts
export const SIDEBAR_FEATURES = [
  'badge','tabLifecycle','updateTab','openFile','targetedOpen',
  'stateSubscription','tabMeta','pluginSettings','urlTarget',
  'settingSelect','floatWindows',
] as const
export const SIDEBAR_SERVICE_VERSION = '0.18.1'
```
「单调递增的能力列表，消费者用它来门控新 API 用法（**功能永不移除**）」（:471-472）。

### 5.7 我们能合法用什么

| 能力 | 可用？ | 说明 |
|---|---|---|
| `ctx.get('betterSidebar').registerTab(TabDescriptor)` | ✅ | 注册一个群聊侧边栏页 |
| `openTab(seed, scope?)` | ✅ | 打开/聚焦我们的 tab |
| `TabComponentProps.scope.sessionId` | ✅ | 知道当前会话 |
| `getTab/isTabEnabled/stateSubscription` | ✅ | 能力探测与状态订阅 |
| **`ctx.sessions.open/openSubagent`** | ✅ **但属于 DSH 平台，不属 better-sidebar** | ⭐ 切入会话靠这个 |
| better-sidebar 内部模块（`src/...` 深路径） | ❌ | **禁止 import**（本任务约束 + 它未承诺公共导出） |

---

## 6. Q5 — 必须由我们重新实现的部分

| # | 事项 | 为什么不能借用 |
|---|---|---|
| 1 | **轮询调度器**（self-scheduling + AbortSignal + 可见性门控） | `use-polling.ts` 是内部模块，未导出为公开 API；且我们必须按自己的数据面重写 |
| 2 | **批量折叠路由**（`subagents.live` 的服务端折叠 + `LIVE_WINDOW_MESSAGES=12`） | `subagent-live-route.ts` 走它自己的 `/sidebar/api` 路由与鉴权，我们无法复用其 HTTP 面 |
| 3 | **懒加载分片**（`__dshChunks__` + `/sidebar/bundle/<name>.js`） | chunk 注册表与 bundle 路由都是它插件私有（`chunk-loader.ts:15-23` 明说是 plugin-owned） |
| 4 | **群聊 UI 与消息渲染** | 与它无关，纯自研 |
| 5 | **`setSubagentCatalogOpen` 的消费声明配对** | 逻辑简单，但必须在我们自己的组件生命周期里正确 add/release，否则泄漏（SubagentView.tsx:665-696 是范式） |
| 6 | **群聊场景的「当前会话」高亮/跟随** | 需自研：订阅 `list` 快照并比对 `current` / `currentAddress` |

**可以直接借用（平台公开面）**：
- `ctx.get('sessions').open?.(id)` / `.openSubagent?.(address)` —— 切入会话 ⭐
- `ctx.get('sessions').list`（`getSnapshot` / `subscribe`）—— 会话列表与当前选中
- `ctx.get('subagents').listDescendants(rootId)` —— **宿主侧**子代理血缘
- `ctx.get('sessions').subagentAddress(id)` / `.setSubagentCatalogOpen(p, open)`

---

## 7. 给 dsh-team-chat 的落地建议（可照做）

### 7.1 切入子代理会话（对应能力 ①）

```ts
// 客户端插件内
export const inject = ['sessions']        // 或全程用 ctx.get('sessions')

function jumpToSession(ctx: Context, childSessionId: string): boolean {
  const sessions = ctx.get('sessions')
  if (sessions === undefined) return false          // 平台未挂载 → 降级
  // 优先用「直系父地址」路径：DSH 会正确记录 subagentAddress
  const addr = sessions.subagentAddress?.(childSessionId)
  if (addr !== undefined && typeof sessions.openSubagent === 'function') {
    try { sessions.openSubagent(addr); return true } catch { /* fall through */ }
  }
  // 回退：直接 open(id)
  if (typeof sessions.open === 'function') {
    try { sessions.open(childSessionId); return true } catch { return false }
  }
  return false
}
```

**落地注意**：
1. `mode` 必须来自目录行（`openSubagent` 会校验，`manager.js:105-109`）——所以优先 `subagentAddress(id)` 而不是自己拼地址。
2. 全程可选调用 + `undefined` 降级，UI 上按钮置灰而非崩溃。
3. 子代理列表取 `list.byId` 中 `origin === 'subagent'` 的行，或宿主侧 `listDescendants`。

### 7.2 让群聊在高负载下仍流畅（对应能力 ②）

按收益排序（与 t4/t10 的根因结论一致）：

1. **收敛轮询**：把多处 `setInterval` 合并到一个调度器，`/state` 这类重接口用 **`self-scheduling`**（保证同刻至多一个在途，直接消解 t4 测到的慢请求叠加）。
2. **可见性门控**：群聊不可见（tab 未激活 / 面板收起）时**完全停轮询**，并 abort 在途请求（照抄 `usePolling` 的 cleanup 语义）。
3. **批量折叠**：N 个成员各一个请求 → **1 个**聚合请求，并限制窗口（参考 `LIVE_WINDOW_MESSAGES = 12`）。
4. **提升间隔**：3s → 5s 或按需；仅在「有成员 running」时轮询。
5. **懒加载重资源**：把重型依赖从启动包拆出去。
6. **信号卫生**：abort 后**必须**查 `signal.aborted` 再写 state（abort 不保证 reject）。

### 7.3 与 t4/t10 结论的衔接

- t4 根因：`readSurface` 轮询被翻倍（后台 3s + 前端 3s）+ `/state` 请求内同步 refresh。
- 本报告给出的正是**同类问题的成熟解法**：单调度器 + self-scheduling + 门控 + 折叠。
- **风险提示（呼应 t10）**：`self-scheduling` 在**单次请求永久挂起**时会停止后续调度——better-sidebar 靠「失败没超时」的假设运转。若我们的 `/state` 可能长时间挂起，**必须为任务本身加重试或超时**，否则 UI 会静默停更（这比 t10 指出的 F2 缺陷更隐蔽，因为它不报错）。

---

## 8. 证据台账（file:line 汇总）

| 问题 | 证据位置 |
|---|---|
| Q1 宿主枚举 | `src/subagent-live-route.ts:51-68`；`src/context-types.ts:250-280` |
| Q1 宿主事件读取 | `src/subagent-live-route.ts:79-82`；`src/context-types.ts:86-97` |
| Q1 客户端列表 | `src/client/SubagentView.tsx:638-645`；`src/context-types.ts:310-321,139-149` |
| Q1 子代理判据 | `src/client/subagent-detect.ts:28-38` |
| Q1 目录消费声明 | `src/client/SubagentView.tsx:657`；`src/context-types.ts:369` |
| Q2 切入调用 | `src/client/SubagentView.tsx:705,715` |
| Q2 better-sidebar 声明其为镜像 | `src/context-types.ts:329-333,357-361` |
| **Q2 平台权威定义** | `dsh-api-session-controller/lib/types/client/sessions/service.js:152,159,168,176,183` |
| **Q2 平台 provide** | `dsh-api-session-controller/lib/client.js:2307,2320-2321` |
| Q2 地址形状 | `better-sidebar/src/context-types.ts:179-183` |
| Q2 校验 | `dsh-api-session-controller/lib/types/client/sessions/manager.js:105-109`（等价打包位 `lib/client.js:1494`） |
| Q2 插件面向声明 | `service.js:163-164`「Feature plugins use this to avoid Agent-bound RPCs」 |
| Q3 调度器 | `src/client/use-polling.ts:37-41,51-70,13-16` |
| Q3 间隔常量 | `SubagentView.tsx:62,66,68`；`SideChatView.tsx:79`；`ChangesTab.tsx:112`；`GitLens.tsx:288` |
| Q3 门控 | `SubagentView.tsx:203-207`；`SideChatView.tsx:515`；`service.ts:148-149` |
| Q3 批量折叠 | `src/subagent-live-route.ts:1-3,41,59-90`；`SubagentView.tsx:182-187` |
| Q3 懒加载 | `src/client/chunk-loader.ts:1-8,30-51` |
| Q4 服务接口 | `src/client/service.ts:347-400` |
| Q4 TabDescriptor | `src/client/service.ts:162-243` |
| Q4 TabComponentProps | `src/client/service.ts:143-159` |
| Q4 openTab 语义 | `src/client/service.ts:328-342,377-380,392` |
| Q4 官方接入示例 | `README.md:176-189` |
| Q4 能力列表/版本 | `src/client/service.ts:468,487-499` |
| Q4 inject 踩坑 | `README.md:372` |
| 平台 subagent 文档 | `@deepseek-ai/dsh-subagent/README.zh.md:12,51` |

---

## 9. 未决与限制（诚实声明）

1. **客户端 Inspect 未执行**：按队长加固指令，本轮**未调用** `cordis_inspect_query(platform=client)`（该调用前两次导致回合永久挂起）。§3.3 已列出「源码可证」与「需运行时确认」的边界。
2. **未做运行时验证**：本报告全部结论来自**静态源码阅读**，未启动 GUI 实测 `openSubagent` 的实际行为。建议 t6/后续实机任务补一次探针（`console.log(ctx.get('sessions')?.openSubagent)`）。
3. **版本绑定**：结论基于 better-sidebar `0.18.1` 与随包 `dsh-*` 版本；DSH 升级后 `provide('sessions')` 的行号会变，但服务名与方法名是稳定契约（better-sidebar 明确承诺「功能永不移除」）。
4. **未修改任何 better-sidebar 文件**，未 import 其内部模块，未改 DSH profile 安装态，未执行 git push —— 符合任务约束。

---

## 10. t12 复验审计（researcher 追加，2026-09-10）

> 本段由 researcher 在 t12 改派后追加：对 §0–§9 做**独立复验**（抽查每条最吃重的 file:line 与实际源码比对），并按队长要求把「源码可证 vs 需运行时确认」的分界**按问题逐条列清**。**未改动上文任何结论。**

### 10.1 复验结果（抽查全部通过）

| 复验点 | 文档引用 | 实测源码 | 结果 |
|---|---|---|---|
| `openSubagent` 调用点 | §2.1 `SubagentView.tsx:705` | `src/client/SubagentView.tsx:705` `sessions.openSubagent?.(address)` | ✅ 一致 |
| 切回主会话 | §2.1 `SubagentView.tsx:715` | `src/client/SubagentView.tsx:715` `sessions.open?.(rootId)` | ✅ 一致 |
| 目录消费声明配对 | §1.2/§6 `SubagentView.tsx:657,668-676` | `:657` `setSubagentCatalogOpen?.(parentSessionId, open)`；`:673/:693` 释放 | ✅ 一致 |
| 「ONE polling loop」 | §4.1 `use-polling.ts:2` | `src/client/use-polling.ts:2` "The sidebar's ONE polling loop: every timed client fetch…" | ✅ 一致 |
| self-scheduling 实现 | §4.1 `use-polling.ts:37-41,51-70` | `:37` `mode?: 'fixed-interval' | 'self-scheduling'`；`:51` if 分支 | ✅ 一致 |
| sessions 提供者 | §2.2 `lib/client.js:2307` | `dsh-api-session-controller/lib/client.js` `rootCtx.reflect.provide("sessions", …)`（打包位；源位 `lib/types/client/sessions/service.js:146`） | ✅ 一致 |
| openSubagent 方法 | §2.2 `service.js:159`（文档 §2.2 另有 `lib/client.js:2320`） | `lib/types/client/sessions/service.js:159` `openSubagent(address) { this.manager.selectSubagent(address); }` | ✅ 一致 |
| selectSubagent 校验 | §7.1 `manager.js:105-109` | `lib/types/client/sessions/manager.js:105-109` 对非健康 child 抛错 | ✅ 一致 |
| context-types 镜像声明 | §2.1 `context-types.ts:329-333,357-361` | `:330` "mirror of the runtime ISessions.open"、`:359` "mirror of the runtime ISessions.openSubagent" | ✅ 一致 |

### 10.2 逐问题「已验证 / 需运行时确认」分界（队长要求补齐）

| 问题 | 源码可证（file:line） | 需运行时确认（推断） |
|---|---|---|
| **Q1** 子代理列表/元数据 | `ctx.subagents.listDescendants(rootId)` 存在且为公开服务（context-types.ts:250-280；`@deepseek-ai/dsh-subagent/README.zh.md:12`）；客户端 `sessions.list` 快照形状（context-types.ts:310-321,139-149） | 当前部署是否已挂载 `dsh-api-session-controller`（未挂载则 `ctx.get('sessions')` 为 undefined → 降级） |
| **Q2** 切入子代理会话 | `openSubagent(address)` / `open(id)` 为公开方法（service.js:152,159；JSDoc 无 private）；better-sidebar 生产已用（SubagentView.tsx:705,715） | `list.current` 在子代理被选中时的实测取值（源码推导=子代理 id）；`openSubagent` 对真实目录行的 mode 校验是否总能通过 |
| **Q3** 卡顿仍流畅 | 单一轮询器（use-polling.ts:2）、self-scheduling（:51-70）、可见性门控（SubagentView.tsx:203-207 等）、批量折叠（subagent-live-route.ts:59-90）、懒加载（chunk-loader.ts:30-51）、**无 SSE/长轮询/虚拟化** | 这些模式移植到群聊场景后的真实收益（需 t16/t17 落地后以探头验证） |
| **Q4** 公开契约 | `ctx.betterSidebar.registerTab/openTab/TabComponentProps` 字段（service.ts:143-159,162-243,347-400,392,468）均来自随包 TS 源码 | better-sidebar 在**我方实际运行组合**中是否注册成功（未直接 import，仅消费其公开面） |
| **Q5** 必须自研 | 轮询调度器/批量折叠/懒加载/拓扑渲染为内部模块未导出（chunk-loader.ts:15-23 明说 plugin-owned） | 无（纯结论） |

### 10.3 与 t23 / t24 的衔接（跨任务一致性）

- **t23（client-sessions-access.md）独立复证了 §2.2 的核心**：`sessions` 由 `rootCtx.reflect.provide` 发布（t23 引源位 `service.js:146`，本报告引打包位 `lib/client.js:2307`——同一事实的两个位置），且 t23 给出了与 §7.1 一致的降级链建议。两文档结论互相印证。
- **t24（detail-view-data-source.md）与 §4 无冲突**：t24 讨论的是详细视图数据源（事件流重建），不涉及 better-sidebar 的轮询模式；两文档可并行采用。

### 10.4 复验判定

- 本报告 **§0–§9 通过 t12 验收标准**（Q1–Q5 均有 file:line 证据、可行性判定明确、诚实声明保留）。
- 复验**未发现**事实性错误；`lib/client.js:2307` 与 `service.js:146` 的行号差异为打包/源文件位置（已在 10.1 注明）。
- t14（独立核验）可依此抽查：所有关键行号均已按「文档引用 → 实测源码」对照表列于 10.1。
