# dsh-team-chat 浏览器侧实测报告（browser-measurement）

> 生成：reviewer · 2026-09-10 · t9 任务（关闭 t4 §5 缺口 1/2 的浏览器侧验证）
> 范围：仅取证，**未修改** `lib/`、未动 DSH profile、未导航/刷新用户正在使用的 GUI 页面。
> 方法声明：所有数字由实测得到（可复核：浏览器侧 evaluate_script 采样 + 主机侧 `node docs/optimization/measure-403.mjs`）。每节标注「实测」/「推测」/「未验证」。

---

## 0. 结论速览（诚实版）

| # | 目标 | 结论 | 类型 |
|---|---|---|---|
| E1 | 在真实页面上下文实测 `/state` 请求延迟 | **未能获得真实 handler 延迟**——代理浏览器无 renderer 鉴权，全部请求在 handler 前被 403 拦截（实测） | 未验证（环境阻塞） |
| E2 | readSurface 服务端成本（空闲 vs 运行中延迟差异） | **无法从浏览器侧间接判定**——同样的 403 拦截使延迟差异不可观测 | 未验证（环境阻塞） |
| E3 | 轮询期页面主线程可观测证据 | **无法获得**——无合法页面上下文，无插件轮询在运行 | 未验证（环境阻塞） |
| E4 | 区分插件自身开销 vs 服务端 readSurface 开销 | 可给出结构性判断（基于 t4 主机侧实测 + 本任务 403 拦截实测） | 推测（高置信） |
| E5 | 什么是 403 拦截本身造成的延迟 | **实测**：拦截在 handler 之前，往返 0.5–3ms 级，非卡顿源 | 实测 |

**一句话**：t9 尝试后发现——t4 §5.2 建议的「带 Connection 鉴权的浏览器会话」在**代理浏览器环境（chrome-devtools-mcp 独立实例）中不存在且无法构造**：renderer token 每次启动随机生成、仅存于 Electron 内存、不落盘；`ordinaryBrowserEnabled` 当前为 false（非 compatibility 模式），任何无 token 请求一律 403。因此「真实 /state 延迟」与「轮询主线程表现」两项缺口在本代理侧**不可关闭**，需用户侧（真实 GUI 内）或 DSH 侧打点完成。

---

## 1. 环境侦查（实测）

### 1.1 MCP 控制的 Chrome 与用户 GUI 不是同一个渲染上下文

- MCP 浏览器进程：`chrome.exe --user-data-dir=C:\Users\bo.yang02\.cache\chrome-devtools-mcp\chrome-profile --remote-debugging-pipe`（PID 3240，独立实例）。
- 用户正在使用的 DSH Web GUI：由 **DSH Desktop**（Electron 主进程 PID 1220）持有 `127.0.0.1:43120` 端口；无额外调试端口暴露（`Get-NetTCPConnection` 仅 43120 一条本地监听）。
- MCP Chrome 页面列表实测：`list_pages` 仅 `about:blank`（连接重连后唯一页面）。打开 `http://127.0.0.1:43120/` 得 **403（forbidden）**。
- msedgewebview2 进程均属于其它应用（Palo Alto PanGPA / clash-verge），与 DSH 无关。

→ **结论（实测）**：代理浏览器 ≠ 用户 GUI 渲染器；二者无法互相附加。任务假设的「页面自身的 fetch 会带上合法连接鉴权」在该环境中不成立。

### 1.2 鉴权机制（源码证据 + 实测行为一致）

- `lib/webserver.js:16-22`：`rejectBrowserRequest` 直接 403 `forbidden`（`no-store`、`text/plain`）。
- `lib/desktop-browser-access-5-Ph3Uv7.js:47-51`：`decideDesktopBrowserAccess`——带 `x-dsh-desktop-renderer: <token>`（43 位 base64url，`timingSafeEqual` 比对）→ `"renderer"` 放行；否则若 `ordinaryBrowserEnabled` 为 false → `"denied"`。
- `lib/main.js:5688`：`createDesktopBrowserAccess(prepared.mode === "compatibility" && prepared.openBrowser)`——普通浏览器访问开关 = **compatibility 模式 && openBrowser**；当前 desktop 模式 → `ordinaryBrowserEnabled=false`。
- token 生成：`randomBytes(32).toString("base64url")`（`desktop-browser-access-5-Ph3Uv7.js:10`）——每次进程启动随机、仅存内存 `rendererHeader`；在 `.dsh` 全库搜索 `x-dsh-desktop-renderer` / `rendererHeader` 无配置落盘（唯一命中是本会话日志，非真实存储）。
- 实测一致：无 token 时 `/`、`/plugins/dsh-team-chat/state`、`?sessionId=…`、HEAD 全部 403。

→ **结论（实测 + 源码）**：不存在可由代理浏览器构造的合法鉴权路径；读取/猜测 token 属越权且无来源，不尝试（符合任务「不动 profile、不改设置」约束）。

---

## 2. 实测数据

### 2.1 浏览器内同源采样（403 拒绝路径，6 次）

evaluate_script（页面 = `http://127.0.0.1:43120/` 的 403 响应页，同源 context）：

```
GET /plugins/dsh-team-chat/state  → 403 × 6
单次耗时(ms): 2.8, 1.8, 1.8, 1.4, 1.5, 1.6
median=1.8 ms  max=2.8 ms  总墙钟 10.9 ms / 6 次
变体: bare=1.6ms / ?sessionId=…=2.5ms / HEAD=3.3ms / / =1.5ms  → 全部 403
页面 longtask 计数 = 0（403 空响应页，无插件逻辑运行）
```

采样上下文：**未鉴权、handler 未执行、响应为鉴权拒绝**。此数字不代表真实 `/state` 延迟，仅证明「拒绝路径」本身毫秒级。

### 2.2 主机侧交叉验证（10 次，可复现）

`node docs/optimization/measure-403.mjs`：

```
403  7.2 / 0.85 / 0.55 / 0.56 / 0.61 / 0.48 / 0.45 / 0.45 / 0.56 / 0.61 ms
median=0.56 ms  min=0.45 ms  max=7.2 ms（首包含 TCP 握手）
变体: sessionId=0.37ms / HEAD=0.64ms / / =1.78ms  → 全部 403
```

→ **实测**：鉴权拦截路径往返中位数 <1ms，即使含连接建立也 ≤7.2ms。**403 拦截不是卡顿来源。**

---

## 3. 与 t4 的对照（缺口判定）

| t4 结论 | 本任务核实 | 判定 |
|---|---|---|
| 主机侧 refresh 链内纯处理 <2ms（node 实测） | 不重复测量；本任务的 403 拦截实测（median 0.56ms）独立佐证「插件自身 HTTP/JSON 层开销可忽略」 | 一致，无需修正 |
| 服务端 readSurface 调用成本无法插桩（缺口 1） | **仍然无法插桩**：代理浏览器无鉴权拿到真实响应；延迟差异测量（空闲 vs 运行中）因 403 不可观测 | 缺口仍在（环境阻塞） |
| 「带 Connection 鉴权的浏览器会话实测 /state 延迟」（t4 §5.2 建议） | **该路径在代理浏览器侧不可行**：鉴权 = Electron renderer 独有随机 token，代理 Chrome 无该 token 也无法获得（源码证据见 §1.2） | **证伪该建议的代理执行前提** |

**服务端调用到底占多少毫秒？** → **未验证**。基于证据链的推理（推测，高置信）：真实 `/state` 延迟 = 403 拦截（~0.5ms 实测）之后才开始的 refresh 链 = `listChildren` + 每成员 `readSurface` 的服务端耗时（t4 已实测主机侧解析 <2ms，故剩余大头在外部服务调用本身）。量级无法从代理侧给出，只能定性为「服务端调用占主要部分」。

---

## 4. 主线程 / 卡顿量级判定

- **可观测证据：无**（未验证，环境阻塞）——无合法页面上下文，插件轮询未运行，无法采集 longtask / 帧率 / 请求时序叠加。
- t4 H4 已从源码断言客户端每轮询整树重渲染 + 滚动跳底（client.js:182/218/453），属**渲染线程内的面板开销**量级中等；本任务无法为此补充浏览器侧定量证据。
- t4 R1 的「tick 无 in-flight 锁 → 叠加放大」推断（index.js:360-368）在本任务中**无法从请求时序证实**（无合法上下文，看不到插件轮询）。如实保留为推测。

---

## 5. 实测 / 推测 / 未验证清单

**实测（可复核）**：
- 代理浏览器与用户 GUI 分离（进程/端口/页面列表证据）。
- 鉴权机制：token 头 + `ordinaryBrowserEnabled=false` 时全 403（源码行号 + 行为一致）。
- 403 拒绝路径往返：浏览器侧 median 1.8ms / max 2.8ms；主机侧 median 0.56ms / max 7.2ms（10 次，脚本可重跑）。

**推测（高置信，标注依据）**：
- 真实 /state 延迟大头在服务端 readSurface 调用本身（依据：403 拦截 ~0.5ms + t4 主机侧解析 <2ms → 剩余时间只能来自外部服务调用）。
- 卡顿主因仍指向 R1（readSurface 高频 2×/3s/成员 + 无重叠锁 + 请求内同步 refresh），浏览器侧无新证据推翻，也无新证据坐实其毫秒量级。

**未验证（环境阻塞，明确声明）**：
- 真实 /state handler 延迟分布（含切会话）——需要 renderer 鉴权。
- readSurface / listChildren 服务端耗时与 IO 量——需要 DSH 侧打点。
- 轮询期主线程 longtask / 帧率 / 请求时序叠加——需要合法页面上下文。
- tick 叠加放大的时序证实。

---

## 6. 给下游的建议（替代路径，按可行性排序）

1. **DSH 侧打点（推荐，可彻底关闭缺口）**：在 `refresh()`（index.js:312）与 `/state` handler（index.js:690-695）两侧加耗时日志/计数器（不属本任务 in-scope，需 engineer 另立任务）。
2. **用户侧实测**：在真实 GUI 的 DevTools 里对 `/plugins/dsh-team-chat/state` 采样 ≥5 次（fetch 天然带 renderer token），或录制 Performance 面板 30s。此为唯一能用「带鉴权浏览器上下文」完成本任务原意的方式。
3. **不改动选项**：若无法打点/用户侧实测，t4 §5 缺口 1/2 维持「未验证」，R1 保持「机制已验证 / 主因=推测」的诚实定位，不建议升级为已证实。