# 客户端插件访问 sessions 服务的前提验证（client-sessions-access）

> **任务**：t23 — 前提验证（attempt 1）
> **结论**：可得（源码可证）——我们的客户端插件**能**拿到 `sessions` 服务；t20「点击步骤 → openSubagent 跳转子代理会话」前提成立，无需宿主代理。
> **证据出处**：已安装包源码（`@deepseek-ai/dsh-api-session-controller`、`dsh-better-sidebar`）+ 本项目 `package.json` / `lib/client.js`。
> **已验证 / 推测分界**：服务提供位置、方法签名、better-sidebar 用法 = 源码可证；「sessions 在我方运行时已 resolve」= 推断（运行时根服务随组合生效，未运行时打点）。

---

## 1. 结论（三行）

1. `sessions` 是**客户端运行时根服务**（`rootCtx.reflect.provide('sessions', this, undefined)`），不是需要 `require` 的包。
2. 我们要做的只有一行：`lib/client.js` 的 `exports.inject` 从 `['slots']` 改为加 `'sessions'`；**无需补任何 `dsh.client.inject` 包**。
3. 失败降级链已给出（sessions 缺失 / 地址未发现 / openSubagent 抛错），t20 照抄即可，点了不会崩。

## 2. 证据链

### 2.1 sessions 是客户端运行时根服务 — 源码可证

- 提供位置：`@deepseek-ai/dsh-api-session-controller/lib/types/client/sessions/service.js:146`：
  `rootCtx.reflect.provide('sessions', this, undefined)` —— **根 context**（客户端运行时核心）。
- 关键方法（service.js）：
  - `openSubagent(address)` :159 —— `this.manager.selectSubagent(address)`（跳转子代理会话）
  - `subagentAddress(id)` :168 —— `this.manager.subagentAddress(id)`（返回 retained 的直接父地址；feature plugins 用它避免 Agent-bound RPC）
- 地址形状：`{ parentSessionId, childSessionId, mode: 'continuable' }`（manager.js:143, session.js:187-189；typert.host.js `SessionAddress` 契约确认 subagent 变体）。
- 失败语义：`selectSubagent` 对「非健康 catalog child」抛错（manager.js:108-109）——这是降级链第 3 处的依据。

### 2.2 better-sidebar 同款消费者 — 源码可证（对照样本）

- better-sidebar 客户端 apply 级 inject：`["slots","sessions","locale","modules","connection"]`（`dsh-better-sidebar/lib/client.js:19200-19206`）。
- 使用方式（`ctx.sessions` 直接取）：
  - `sessions.list.subscribe/getSnapshot`（:12271 附近、:13266）
  - `sessions.openSubagent?.(address)`（:12315）
  - `sessions.open?.(rootId)`（:12324）
  - `sessions.refreshSubagents?.(parentSessionId)`（:12330）
  - `sessions.setSubagentCatalogOpen?.(parentSessionId, open)`（:12282）
- 其 `package.json` 的 `dsh.client.inject` 含 `@deepseek-ai/dsh-client-modules`（+ slots + conversation + locale）——**sessions 不作为 inject 包出现**，佐证「sessions 是运行时服务」。

### 2.3 我们的当前形态 — 源码可证

- 本项目 `package.json`：`dsh.client.inject = ["@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-ui-conversation"]`，`dsh.client.platform: "web"`。
- `lib/client.js`：`exports.inject = ['slots']`（:1159）；`exports.apply = function apply(ctx)`（:1177）；通过 `window.__ModuleLoader__.load({ id, factory: (require) => … })` 载入。
- **需要改的**：仅 `exports.inject` 加 `'sessions'`（与 better-sidebar apply 级 inject 一致）。

## 3. 可直接照做的获取形态（含三条降级链）

```js
exports.inject = ['slots', 'sessions']

// apply(ctx) 内：
const sessions = ctx.get('sessions')          // 可选：需要 undefined 检查

// 点击步骤时：
function jumpToSubagent(childId) {
  try {
    if (sessions === undefined) return showStepDetail()        // 降级①：服务缺失 → 仅显示步骤详情
    const address = sessions.subagentAddress(childId)         // 可能 undefined
    if (address === undefined) return showAddressMissing(childId) // 降级②：地址未发现 → 提示 + 复制 sessionId
    sessions.openSubagent(address)                            // 失败 catch
  } catch (e) {
    return showStepDetail()                                    // 降级③：openSubagent 抛错（非健康 child）→ 降级同前
  }
}
```

## 4. Q5 澄清

- 未走到「客户端拿不到」分支 —— 判定 **可得**。
- 若上线后 `sessions` 不存在（组合缺 session-controller 客户端时），降级链兜底（显示步骤详情 + 复制 sessionId 供手动切换），不崩。

## 5. 已验证 vs 推断

- **源码可证**：服务提供位置（service.js:146）、方法签名与地址形状、better-sidebar 用法、我方 exports.inject 现状。
- **推断**：「sessions 在本部署已安装可 resolve」——运行时根服务随组合生效，未做运行时打点（client 端 Inspect 会挂起，禁用）。若需要铁证，可在实现时加一行 `console.warn('sessions', sessions === undefined)` 采样确认后移除。

---

> 落盘：t26（2026-09-10）。诚实声明保留：「sessions 可 resolve」为推断；运行时断言一律标推断。