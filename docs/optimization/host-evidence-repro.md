# 如何独立复现 t16 / t17 的宿主侧结论（host-evidence-repro）

> 目的：让核验者（t25）**不需要重写 harness** 就能复现 t16（去同步化 + 超时）与 t17（事件订阅替代轮询）的关键结论。
> 作者：engineer · t16/t17 · 2026-09-10
> 背景：本检出里 `test/host-smoke.test.mjs` 的 16 个用例**全部被跳过**（peer 依赖 `schemastery` 要从安装 profile 解析），因此宿主侧改动在既有套件里**没有覆盖**。`test/host-events.test.mjs`（t17 新增）与本文档就是为补这个缺口。

---

## 1. 一句话结论

宿主侧的关键断言现在**住在检出里**：`test/host-events.test.mjs`（7 个用例）。
- 裸检出运行 → 7 项 **明确 skip 并给出原因**（与 host-smoke 同款降级纪律，不产生假失败）；
- peer 依赖可解析时运行 → **7 项全部真实执行**（实测 7 pass / 0 fail / 0 skipped）。

---

## 2. 为什么需要这份文档（证据缺口）

| 套件 | 裸检出实测 | 说明 |
|---|---|---|
| `test/shared.test.mjs` | 41 pass / 0 fail | 纯函数，无 peer 依赖 |
| `test/client.test.mjs` | 11 pass / 0 fail | 走 client 半侧 stub |
| `test/host-smoke.test.mjs` | **0 pass / 0 fail / 16 skipped** | 全部因 `schemastery` 不可解析而跳过 |
| `test/host-events.test.mjs`（t17 新增） | 0 pass / 7 skipped（裸检出）；**7 pass（peer 可解析时）** | 本文档的主角 |

所以 `node --test test/host-smoke.test.mjs test/shared.test.mjs` 报出的 `pass 41 / skipped 16`，**41 全部来自 shared，host 侧一个都没跑到**。t16/t17 的宿主侧结论不能以该套件的"通过"为依据 —— 本文档给出的才是。

---

## 3. 复现步骤 A：让用例真实执行（推荐）

原理：把仓库 `lib/` + `test/` 复制到临时目录，并在其 `node_modules/` 下链接 profile 的 `schemastery`，使 `import '../lib/index.js'` 可解析。

```powershell
# 1) 建立可解析 peer 依赖的临时树（不污染检出）
$h = Join-Path $env:TEMP 't17-repro'
Remove-Item -Recurse -Force $h -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $h | Out-Null
Copy-Item -Recurse '<repo>\lib'        (Join-Path $h 'lib')
Copy-Item -Recurse '<repo>\test'       (Join-Path $h 'test')
Copy-Item           '<repo>\package.json' (Join-Path $h 'package.json')
New-Item -ItemType Directory -Force -Path (Join-Path $h 'node_modules') | Out-Null
cmd /c mklink /J "$h\node_modules\schemastery" `
  "C:\Users\bo.yang02\.dsh\profiles\desktop\node_modules\schemastery"

# 2) 运行（期望 7 pass / 0 fail / 0 skipped）
node --test (Join-Path $h 'test\host-events.test.mjs')
```

**实测结果（t17 代码）**：
```
✔ E1: a deployment with no members reads no surface, ever
✔ E2: utterances arrive via events and steady-state /state adds zero readSurface
✔ E3: the hot callback drops assistant/chunk (the 53–67% noise)
✔ E4: buffer overflow is capped and flagged (bounded memory)
✔ E5: unload disposes both listeners
✔ E6: agent/status drives an activity system row
✔ E7: the snapshot exposes feed observability (heartbeat visible)
ℹ tests 7 / pass 7 / fail 0 / skipped 0
```

---

## 4. 复现步骤 B：对照组（证明用例真有判别力）

「用例通过」只有在**旧代码会失败**时才有意义。同一份 `test/host-events.test.mjs`，换上 t17 之前的 `lib/index.js`：

```powershell
$ctrl = Join-Path $env:TEMP 't17-repro\control'
New-Item -ItemType Directory -Force -Path $ctrl | Out-Null
Copy-Item -Recurse "$env:TEMP\t17-repro\lib"  (Join-Path $ctrl 'lib')
Copy-Item -Recurse "$env:TEMP\t17-repro\test" (Join-Path $ctrl 'test')
Copy-Item "$env:TEMP\t17-repro\package.json"  (Join-Path $ctrl 'package.json')
# 用 HEAD（t17 之前的版本）覆盖 index.js
git -C '<repo>' show HEAD:lib/index.js | Out-File -Encoding utf8 (Join-Path $ctrl 'lib\index.js')
Copy-Item '<repo>\lib\shared.js' (Join-Path $ctrl 'lib\shared.js')
New-Item -ItemType Directory -Force -Path (Join-Path $ctrl 'node_modules') | Out-Null
cmd /c mklink /J "$ctrl\node_modules\schemastery" `
  "C:\Users\bo.yang02\.dsh\profiles\desktop\node_modules\schemastery"
node --test (Join-Path $ctrl 'test\host-events.test.mjs')
```

**实测结果（t17 之前的代码）**：`tests 7 / pass 1 / fail 6`
```
✔ E1   （两边都过：没有成员 ⇒ 两种设计都不读 surface，符合预期）
✖ E2   utterances 不再经事件到达 / 稳态仍在读 surface
✖ E3   assistant/chunk 未被首刀丢弃
✖ E4   没有缓冲上限与 lag 标记
✖ E5   没有可释放的订阅
✖ E6   agent/status 未驱动活动行
✖ E7   快照没有 feed 可观测字段
```

> 结论：**t17 代码 7/7 通过、旧代码 1/7 通过** —— 用例集确实判别这两版行为，且核验者可自行复现。

---

## 5. 用例断言了什么（与 t17/t19 验收的对应）

| 用例 | 断言 | 对应验收 |
|---|---|---|
| E1 | 无成员 ⇒ readSurface 恒为 0 | t17「空闲时 readSurface 调用为 0」 |
| E2 | 发言经 `session/event` 到达；稳态 `/state` 计数**持平** | t17「成员活跃时不再逐成员全量 readSurface」 |
| E3 | 50 条 chunk 全部被丢弃（`dropped≥50`、`eventCount=0`） | t17「回调第一刀滤 assistant/chunk」 |
| E4 | 2100 条洪峰被上限截断并标 `lag` | t17「溢出重同步背压」 |
| E5 | unload 后两个监听器计数归 0 | t17「订阅在 stop/update 后彻底清理」 |
| E6 | `agent/status` 产生活动系统行 | t17「状态推送替代活动轮询」 |
| E7 | 快照 `feed` 五个数值字段齐备 | t17「可观测的调度心跳」 |
| P1 | 成员运行投影成「一行一步」：pwsh→command 产物、read→file_path 产物、error 结果、assistant/message 决策折入该步 | t19「步骤行（角色/动作/产物/结果/决策）」+「产物能展示工具名与关键参数」 |
| P2 | 缺产物字段渲染 `—` 而非假值 | t19「缺失字段显示 — 而非假值」 |
| P3 | `/steps` 路由**不**触发 readSurface（投影为内存折叠） | t19「不引入每次请求全量重读成员事件的新热点」 |

---

## 6. 静态回归保护的位置

`scripts/verify.mjs` 里有三组检查（随每次 `node scripts/verify.mjs` 执行，无需 peer 依赖）：

- `[host perf guard]`（8 项，t16）：readSurface 唯一有界包装 / 超时存在 / listChildren 有界 / 单飞锁 / 首拉同步 / stale+generatedAt / stale 门控 / timeoutCount 记录。
- `[host event feed guard]`（14 项，t17）：全局订阅 / chunk 首刀 / 只入队 / 上限+lag / 节流消费 / 心跳 / 自检 / 卸载清理 / 45s 兜底 / 周期不读 surface / 首拉 catch-up / t24 surface 保留 / 回调 try-catch。
- `[host steps guard]`（6 项，t19）：`/steps` 路由存在 / 步骤事件与聊天同源（同一 feed）/ 投影为纯内存折叠无读调用 / `/steps` 路由体不含 readSurface·filterEvents·readEvent / 产物参数提取且缺失→`—` / 步骤数与消息同窗口封顶。

这三组是**静态**（源码正则）保护，负责防回归；`test/host-events.test.mjs` 是**行为**验证，负责证明运行期语义。两者互补：静态检查保证"不会悄悄退回轮询或少读路径"，行为用例保证"步骤真的能从事件流投影出来"。

---

## 7. 诚实声明

- 步骤 A/B 的实测数字均由我本机执行得到（t17 attempt 1）；`schemastery` 来自安装 profile 的 junction，**临时树位于 `%TEMP%`，未污染检出**。
- 裸检出下 `test/host-events.test.mjs` 会**跳过**（与 host-smoke 相同）——这不是失败，但也**不构成** t17 结论的证据；核验者需按步骤 A 让它真正执行。
- 未做浏览器内实测（`/state` 端到端延迟）：属 t9 已判定的环境阻塞范畴（MCP Chrome 与非用户 GUI 渲染上下文隔离），不影响本文件的宿主侧结论。
