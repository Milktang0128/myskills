<p align="center">
  <img src="build/icon.png" width="120" alt="MySkills" />
</p>

<h1 align="center">MySkills</h1>

<p align="center">
  <em>一个窗口，管你所有 AI agent 技能。</em><br/>
  <sub>Claude Code · Codex · 共享池 · 任何读 <code>SKILL.md</code> 的工具</sub>
</p>

<p align="center">
  <a href="https://github.com/Milktang0128/myskills/releases/latest">
    <img src="https://img.shields.io/github/v/release/Milktang0128/myskills?label=download&color=111" alt="最新版本" />
  </a>
  <img src="https://img.shields.io/badge/platform-macOS-111" alt="macOS" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-111" alt="License: MIT" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>中文</strong>
</p>

---

如果你同时用着多个 AI 编程 agent —— 这个项目里跑 Claude Code、那个项目里跑 Codex、上面再套个自己的 shell agent —— 你的技能就散在好几处了。同一个 `pdf-toolkit` 出现在三个地方；从 [skills.sh](https://skills.sh) 装的新技能不知去哪了；你的"工具箱"早就看不清形状。

**MySkills 是一个本地 Mac 应用，它扫描这些目录，按 `(name, source)` 去重，给你一个统一、连贯的视图。**

> 截图占位 —— 拍好以后放到 `docs/screenshots/`：
>
> ![覆盖矩阵](docs/screenshots/coverage.png)
> ![AI 透视](docs/screenshots/ai-lens.png)

## 安装

从最新版本下载已签名、已公证的 DMG：

**[→ Releases 页面](https://github.com/Milktang0128/myskills/releases/latest)**

v0.1.0 仅支持 Apple Silicon，macOS 13 (Ventura) 及以上。

DMG 用 Developer ID 证书签过名，并附了 Apple 公证票据 —— 不需要再手动 `xattr -d com.apple.quarantine`。

## 它能做什么

三件 AI 技能重度用户每天都在手动做的事：

### 在一个地方看完你的库

- **列表**、**场景看板**（按场景分组）、**覆盖矩阵**（行 = 唯一技能，列 = 平台，单元格颜色显示漂移）。
- 单技能详情抽屉显示 `mtime`、内容哈希、磁盘真实路径。
- **设为标准副本**：把某个平台的版本提升为标准，其他平台符号链接过去。

### 写入永远安全 —— 不会出错

- 每次写入都走 **Plan → Confirm → Execute**。你看到 diff，自己选动作。
- 所有破坏性操作先备份到 `~/Library/Application Support/MySkills/backups/`。
- **一键回滚**，在同步历史里。
- 通过临时目录 + `rename` 实现原子化；用 inode pinning 防 TOCTOU。

### 从 skills.sh 发现并安装

- 内置搜索对接 [skills.sh](https://skills.sh) —— 39.5 万+ 社区贡献的 SKILL.md，免账号。
- 安装前可预览 GitHub raw 上的 SKILL.md。
- 可安装到任意几个平台组合，走同一条 plan-confirm-execute 流水线。

### AI 辅助（可选，自带 API key）

- 支持 OpenAI / Anthropic / OpenRouter / DeepSeek / Ollama / 自定义 baseURL。
- **AI 透视** 给你的整个库生成聚簇地图，可一键把 AI 命名的簇提升为正式场景。
- **自动分类** 把新技能归到你定义的场景里。
- **AI 搜索** 在 Discover 里按自然语言需求重排目录结果。
- 每个功能在设置里独立开关。Key 通过 Electron `safeStorage` 存进 macOS 钥匙串。

## 它是怎么工作的

**技能的身份由 `(name, source_key)` 这对组合决定。** `source_key` 目前是 `local`，未来会是仓库/市场的 slug。内容通过 `SKILL.md` 的 SHA-256 指纹标识 —— 技能更新只改 `content_hash`，不改身份。场景、标签和任何用户态都活在 DB 里，编辑技能时不丢。

**MySkills 不在技能目录里写任何东西。** 所有 MySkills 特有的状态都在 `~/Library/Application Support/MySkills/myskills.db`（SQLite）。`SKILL.md` 原文件分毫不动。

**写入流水线 Plan → Confirm → Execute：**

1. **Plan** 纯只读：遍历来源，分类（`in_sync` / `stale` / `only_here` / `missing`），算 diff 哈希，预分配备份路径。输出是一个类型化的 `SyncPlan`。
2. **Confirm** 把 plan 一行行展示给你。
3. **Execute** 先备份，写入临时目录，最后原子 `rename` 到位。

每次成功的写入都记录 `before_hash`、`after_hash`、`backup_path`、原始 `dry_run_plan` 到 `sync_history` —— 都可回滚。

## 隐私

- **100% 本地。** 无遥测，无埋点，无后台回家。
- **扫描器只扫你配置的目录**（默认：`~/.claude/skills`、`~/.codex/skills`、`~/.agents/skills`）。
- **AI 功能默认关闭。** 启用后，请求从你的机器直接走到你的 provider —— 不经我们任何中转。
- **设置里"允许外部网络"总开关**，关掉之后包括 skills.sh 目录在内的所有出站调用都会拒绝。

## 从源码构建

```bash
npm install
npm run rebuild     # 把 better-sqlite3 重新编译到 Electron 的 ABI
npm run dev         # Next.js (:4477) + Electron 并发起
```

`npm run package` 会产出已签名的 DMG，需要 Apple Developer ID 证书和一个 `xcrun notarytool` 钥匙串 profile（默认 `myskills-notary`，参见 `scripts/notarize.cjs`）。

**环境要求：** Node 22+，npm 10+，macOS 13+。

## 架构

仓库里两个 TypeScript 项目：

| 进程 | 路径 | 技术栈 |
|---|---|---|
| Main process | `electron/` | Node 22、`better-sqlite3`、`electron-builder`、`contextBridge` 走 IPC |
| Renderer | `src/` | Next.js 15（静态导出）、React 19、Tailwind、shadcn/Radix |
| 契约 | `shared/` | 纯 TypeScript 类型和 IPC channel 常量 —— 无任何依赖 |

Renderer 沙盒化：`nodeIntegration: false`、`contextIsolation: true`、严格 CSP、IPC sender 校验。所有文件系统和数据库工作都在 main process。

深入架构看 [**CLAUDE.md**](./CLAUDE.md)。完整产品规格看 [**SPEC.md**](./SPEC.md)。

## 路线图

| 版本 | 主题 | 状态 |
|---|---|---|
| **v0.1** | MVP-A —— 只读库存、场景、Discover、自带 AI | 已发布 |
| v0.2 | MVP-B —— 同步写入（symlink/copy）、按位置启停 | 部分（引擎已落，UI 渐进开放）|
| v0.3+ | 项目/插件级技能扫描、多机感知、Intel DMG | 计划中 |

**不会做的：**
- 应用内技能编辑器 —— 直接在真实路径用 VS Code 改。
- 云同步服务 —— local-first 是特性，不是缺失。
- Windows / Linux 移植 —— 超出 MVP 范围。

## 贡献

欢迎 issue 和 PR。两件需要先了解的事：

1. **非小改动的 PR，请先开 issue。** MVP 范围有意保持窄，架构里有些不太显眼的不变量（技能身份、plan→confirm→execute、IPC 边界）很容易被无意识地破坏。短清单看 [CLAUDE.md](./CLAUDE.md)。

2. **目前没有自动测试。** 别在 PR 里说"测试通过"——除非你先把测试 runner 接进来。验证靠真跑 app。

## 致谢

- [skills.sh](https://skills.sh) —— 这个 app 搜索的目录来源，以及把 SKILL.md 格式规范化、让聚合成为可能的整个社区。
- 构建于 [Electron](https://electronjs.org/)、[Next.js](https://nextjs.org/)、[shadcn/ui](https://ui.shadcn.com/) 和 [Lucide](https://lucide.dev/) 之上。

## License

[MIT](LICENSE) © 2026 Milk Tang.
