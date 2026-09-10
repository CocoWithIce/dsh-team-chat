# 插件市场收录材料

这个目录存放提交到 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
（dsh-market 插件市场的条目数据源）所需的**唯一文件**。

## 当前状态

**尚未提交。** 文件已按真实条目格式备好，随时可以提 PR。

## 怎么提交

1. Fork `awesome-dsh-plugin/awesome-dsh-plugin`。
2. 把本目录的 `CocoWithIce__dsh-team-chat.yml` 原样放到 `data/plugins/CocoWithIce__dsh-team-chat.yml`。
   - 文件名必须是 `<owner>__<repo>.yml`，**一个文件就是一个投稿**。
   - **不要手工编辑两个 README**——它们由 `data/plugins/*.yml` 生成，合并后自动重跑。
3. 开 PR。合并后条目会出现在市场列表与 `awesome-dsh-plugin.com/plugins.json`。

## 字段说明

| 字段 | 值 | 依据 |
|---|---|---|
| `url` | `https://github.com/CocoWithIce/dsh-team-chat` | 必须与仓库完全一致 |
| `name` | `CocoWithIce/dsh-team-chat` | 列表中的链接文字，格式 `owner/repo` |
| `category` | `workflow` | 同类插件（`dsh-agent-teams`、`dsh-agent-team`、`dsh-agent-team-room`、`dsh-agent-team-gui`、`dsh-team`）全部落在 `workflow` |
| `description.en` | 单行、以句号结尾 | 含 `: `，**必须加引号**，否则 YAML 会当成嵌套键 |
| `description.zh` | 可选 | 写不了中文可以留空，维护者会补 |

**不要写 `npm:` 字段**——映射由维护方从 registry 自动采集，手写会被校验拒绝。

## 已满足的硬性要求

收录评审最常见的拒稿原因是*只声明了 `dsh.client`*。本仓库两者都有，且 `cordis.patch.yml` 就在仓库根：

```jsonc
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },  // ← 必需，决定能否被 dsh plugin add 挂载
  "client": { "platform": "web" }               // 仅带前端 UI 时需要
}
```

## npm 不是必需

市场条目里 **51.2%（1746/3408）** 没有 npm 包，市场会为这类条目生成 git 安装命令：

```
dsh plugin --profile web add github:CocoWithIce/dsh-team-chat
```

该命令已在隔离目录实测通过（`pnpm add github:CocoWithIce/dsh-team-chat` → `dsh-team-chat 0.3.5`，
且安装结果包含完整可挂载内容）。发布到 npm 的唯一好处是市场页会显示下载量数字。
