# MySkills — AI Skill Hub 产品规格说明书

> **版本：** 0.1 (Draft)
> **作者：** tangmilk1205@gmail.com
> **创建日期：** 2026-05-19
> **状态：** 规格已对齐，待开发

---

## 0. 文档目的

本文档是 MySkills 桌面应用的**产品规格存档**。它记录了在开发启动前已经对齐的产品愿景、功能边界、技术选型、数据模型与实施路线，作为后续所有开发决策的基准。

本文档不是临时备忘 — 任何与本文档冲突的实现都应当先回到本文档讨论并更新。

---

## 1. 产品愿景

### 1.1 一句话定义

**MySkills 是一个统一管理多 AI 平台 Skill 的本地桌面应用** — 把散落在 Claude、Codex、Cursor 等不同 agent 工具下的 skill 目录聚合为单一可检索、可分类、可同步、可扩展的「Skill 中枢」。

### 1.2 解决的问题

用户当前痛点（基于真实环境观察）：

| # | 痛点 | 现状 |
|---|---|---|
| P1 | Skill 散落在多个目录 | `~/.claude/skills/`、`~/.codex/skills/`、`~/.agents/skills/`、`iCloud/AI/skills/` 等多处 |
| P2 | 跨平台同步靠手动 symlink | 用户已经在 `~/.claude/skills/xxx -> ~/.agents/skills/xxx` 这样手工链接，脆弱、易丢 |
| P3 | 找不到合适技能 | 一个平台几十个 skill，缺少分类、检索、场景化视图 |
| P4 | 不知道有什么新技能 | 公开仓库（GitHub awesome list、Anthropic 官方）需要手动 clone、阅读、判断、安装 |
| P5 | 不知道哪个技能在做什么 | SKILL.md 描述太长不想读，希望 AI 帮我理解和分类 |

### 1.3 目标用户

**第一象限（核心）：** 同时使用多个 AI agent 工具的资深用户。已经在用 Claude Code、Codex、可能还有 Cursor / Aider，自己写或下载了很多 skill。

**第二象限（扩展）：** 团队 Skill 管理员，希望把团队的标准 skill 推送给所有成员。

---

## 2. 核心概念（领域模型）

### 2.1 Skill

最基本的工作单元。一个 Skill 是一个目录，至少包含 `SKILL.md`：

```
{skill-name}/
├── SKILL.md         # 必需：YAML frontmatter + Markdown 内容
├── LICENSE.txt      # 可选
├── scripts/         # 可选：辅助脚本
├── references/      # 可选：参考文档
├── templates/       # 可选：模板文件
└── ...              # 任何其他文件
```

`SKILL.md` 的 frontmatter 标准字段（Claude/Codex 完全兼容）：

```yaml
---
name: skill-name              # 唯一标识，kebab-case
description: |                # 触发描述，AI 用来决定何时调用
  Detailed trigger criteria...
license: MIT                  # 可选
metadata:                     # 可选扩展
  author: vercel
  version: "3.0.0"
  category: deployment
---
```

### 2.2 Platform（平台）

Skill 的宿主。MVP 支持：

| Platform ID | 名称 | 默认 Skill 目录 | 备注 |
|---|---|---|---|
| `claude` | Claude Code | `~/.claude/skills/` | 由 Anthropic 官方 CLI 管理 |
| `codex` | Codex | `~/.codex/skills/` | OpenAI Codex CLI |
| `shared` | 共享池 | `~/.agents/skills/` | 用户自维护的 single source of truth |

每个平台对应：
- 一个 Skill 目录（可配置）
- 可能多个额外目录（如 vendor_imports）
- 一组「平台特性」 — 例如 Claude 支持 namespace（`anthropic-skills:pptx`）

### 2.3 Scenario（场景）

按使用情景对 Skill 进行的**用户视角分类**。一个 Skill 可属于多个场景，一个场景可包含多个 Skill。

默认场景（首次启动自动创建）：

| 场景 | 描述 | 典型 Skill |
|---|---|---|
| 写作 | 文档、文章、内容创作 | `doc-coauthoring`、`prose-polish`、`flow-check` |
| 编码 | 软件开发、调试 | `claude-api`、`vercel:*`、`webapp-testing` |
| 运维 | 部署、监控、CI/CD | `deploy-to-vercel`、`vercel:deployments-cicd` |
| 创意 | 视觉、品牌、设计 | `canvas-design`、`ckm-design`、`brand-guidelines` |
| 数据 | 表格、PDF、文档处理 | `xlsx`、`pdf`、`docx`、`pptx` |
| 知识 | 笔记、Obsidian、可视化 | `obsidian-markdown`、`concept-map`、`excalidraw-diagram-skill` |

**关键设计：** 场景是用户的认知分组，不是 skill 的固有属性。同一个 skill 可被多人放在不同场景。

### 2.4 Tag（标签）

比场景更细粒度。MVP 不强求，但保留扩展位。例：`#offline`、`#paid`、`#experimental`、`#mine`。

### 2.5 Marketplace（市场，未来）

外部 Skill 源。MVP 不实现，但数据模型预留：

- Anthropic 官方仓库（`anthropic-skills`）
- 社区聚合（如 `awesome-claude-skills`）
- 自建 Git 仓库
- GitHub 任意 repo 的某个子目录

---

## 3. 功能需求

### 3.1 MVP（P0 — 第一个可用版本）

**主题：本地发现 + 场景化管理**

| ID | 功能 | 验收标准 |
|---|---|---|
| F1 | **多平台扫描** | 应用启动时（或手动触发）扫描 `~/.claude/skills`、`~/.codex/skills`、`~/.agents/skills`，自动识别每个 skill 的 `SKILL.md` 并入库 |
| F2 | **Skill 列表视图** | 主界面展示所有 skill，显示名称、描述、平台徽标、所属场景；支持搜索、按平台/场景过滤 |
| F3 | **Skill 详情面板** | 点击 skill 查看 frontmatter + Markdown 渲染，文件树，所在路径，是否 symlink |
| F4 | **场景管理** | 创建/编辑/删除场景；拖拽或勾选把 skill 加入/移出场景；场景列表显示数量 |
| F5 | **去重识别** | 自动识别同一个 skill 在多个平台的 symlink 关系，UI 上合并显示 + 标注「在 X 个平台」 |
| F6 | **跨平台同步（基础）** | 选中一个 skill → 选择目标平台 → 一键复制或建立 symlink |
| F7 | **启用/禁用** | 重命名为 `.disabled` 后缀或移到 `.disabled/` 子目录，UI 反映状态 |
| F8 | **设置页** | 配置各平台的 skill 目录路径（默认值可改）；查看 DB 路径、版本号 |

### 3.2 P1（第二阶段）

**主题：扩展与导入**

| ID | 功能 |
|---|---|
| F9 | **从 Git 仓库导入** | 输入 GitHub URL → 选择子目录 → 预览 → 安装到指定平台 |
| F10 | **AI 分类助手** | 用 LLM 读取 SKILL.md → 推荐场景归属 + 标签 |
| F11 | **版本历史** | 每次同步前快照，可回滚 |
| F12 | **批量操作** | 多选 skill → 批量加入场景 / 批量同步 / 批量删除 |
| F13 | **导出/导入** | 把场景配置（哪些 skill 属于哪些场景）导出为 JSON，便于多设备同步 |

### 3.3 P2（第三阶段）

**主题：市场与协作**

| ID | 功能 |
|---|---|
| F14 | **Skill Marketplace** | 内置浏览器查看官方 + 社区聚合的 skill 仓库 |
| F15 | **AI 推荐** | 「最近做了什么 → 推荐你可能需要的 skill」 |
| F16 | **更新检查** | 检测已安装 skill 在源头是否有新版本 |
| F17 | **团队共享** | 把场景 + skill 集合打包发布，他人扫码/链接安装 |

### 3.4 明确不做（Non-goals）

- ❌ **不做 Skill 编辑器** — 用户用 VS Code 编辑 SKILL.md，我们只管管理
- ❌ **不做 Skill 执行/运行时** — 这是各平台自己的事
- ❌ **不做云端存储** — 一切本地优先，云同步走用户自己的 iCloud / Git
- ❌ **不做权限/沙箱审计** — 用户自己负责审查第三方 skill

---

## 4. 非功能需求

| 维度 | 要求 |
|---|---|
| 性能 | 扫描 200 个 skill < 2 秒；UI 首屏 < 500ms |
| 内存 | 空闲内存 < 200MB |
| 体积 | 安装包 < 100MB（Electron 限制下能压就压） |
| 隐私 | 默认全本地，AI 调用必须走用户自配 key |
| 稳定 | 任何同步操作都可回滚；DB 损坏不影响实际 skill 文件 |
| 可移植 | 数据库可单文件导出 |
| 平台 | MVP 仅 macOS（Apple Silicon + Intel） |

---

## 5. 技术架构

### 5.1 技术栈（已对齐）

| 层 | 选型 | 理由 |
|---|---|---|
| 桌面框架 | **Electron 33** | 用户选定。生态成熟、跨进程 IPC 直观、AI 库齐全 |
| 渲染层 | **Next.js 15 + React 19**（静态导出模式 `output: 'export'`） | App Router 心智、TypeScript 友好、不需要 SSR |
| UI 库 | **shadcn/ui + Tailwind 3** | 控件可定制、设计感强、不绑死供应商 |
| 数据库 | **SQLite (better-sqlite3)** | 同步 API、零依赖、单文件、查询快 |
| Skill 解析 | **gray-matter** | YAML frontmatter 标准库 |
| 包管理 | **pnpm 10** | 用户已装 |
| 打包 | **electron-builder** | DMG / mac 签名 |
| 语言 | **TypeScript** 全栈 | 主进程、渲染进程、共享类型 |

### 5.2 进程模型

```
┌────────────────────────────────────────────────────┐
│                  Electron App                       │
│                                                     │
│  ┌─────────────────┐      ┌──────────────────────┐ │
│  │  Renderer       │ IPC  │  Main Process        │ │
│  │  (Next.js)      │<────>│  (Node.js)           │ │
│  │                 │      │                      │ │
│  │  - React UI     │      │  - SQLite DAL        │ │
│  │  - Tailwind     │      │  - Skill Scanner     │ │
│  │  - shadcn/ui    │      │  - File ops (copy,   │ │
│  │  - State        │      │    symlink, hash)    │ │
│  │                 │      │  - AI client (P1)    │ │
│  └─────────────────┘      └──────────────────────┘ │
│                                  │                  │
│                                  ▼                  │
│                    ┌─────────────────────────┐     │
│                    │  Local FS               │     │
│                    │  ~/.claude/skills/      │     │
│                    │  ~/.codex/skills/       │     │
│                    │  ~/.agents/skills/      │     │
│                    │  ~/Library/.../app.db   │     │
│                    └─────────────────────────┘     │
└────────────────────────────────────────────────────┘
```

### 5.3 关键技术决策

- **D1：** Next.js 用 `output: 'export'` 模式（纯静态），不跑 server。Electron 直接 `loadFile()`。
- **D2：** IPC 走 `contextBridge` + `ipcMain.handle()`，渲染层禁用 `nodeIntegration`，只暴露白名单 API。
- **D3：** 文件操作（同步、复制、symlink）**全部在主进程**，渲染进程只读 DB 缓存。
- **D4：** SQLite DB 存于 `app.getPath('userData')/myskills.db`，独立于 skill 文件本身。
- **D5：** Skill 内容哈希（SHA-256 of SKILL.md）用于去重 + 检测漂移。
- **D6：** **不写入** skill 目录的元数据（不污染原 skill）；所有标签、场景信息只在 DB 里。

### 5.4 目录结构（计划）

```
Myskills/
├── SPEC.md                  # 本文档
├── README.md                # 给开发者
├── package.json
├── tsconfig.json
├── next.config.mjs
├── tailwind.config.ts
├── postcss.config.mjs
├── electron/                # Electron 主进程源码
│   ├── main.ts              # 入口
│   ├── preload.ts           # contextBridge
│   ├── dev.ts               # 开发模式启动器
│   ├── tsconfig.json
│   ├── db/
│   │   ├── index.ts         # SQLite 连接
│   │   ├── schema.sql       # 表定义
│   │   └── migrations.ts
│   ├── scanner/
│   │   ├── index.ts         # 扫描调度
│   │   ├── parser.ts        # SKILL.md 解析
│   │   └── platforms.ts     # 各平台目录配置
│   ├── sync/
│   │   ├── copy.ts          # 复制实现
│   │   └── symlink.ts       # symlink 实现
│   └── ipc/
│       ├── index.ts         # 注册所有 handler
│       ├── skills.ts
│       ├── scenarios.ts
│       └── settings.ts
├── shared/                  # 主+渲染共享
│   └── types.ts             # TypeScript 类型
├── src/                     # Next.js 渲染层
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx         # 主库视图
│   │   ├── scenarios/
│   │   └── settings/
│   ├── components/
│   │   ├── ui/              # shadcn/ui
│   │   ├── skill-card.tsx
│   │   ├── skill-detail.tsx
│   │   ├── sidebar.tsx
│   │   └── scenario-picker.tsx
│   ├── lib/
│   │   ├── api.ts           # IPC 客户端封装
│   │   └── utils.ts
│   └── styles/
│       └── globals.css
├── dist-electron/           # 编译产物（gitignore）
├── out/                     # Next 静态导出（gitignore）
└── release/                 # 打包产物（gitignore）
```

---

## 6. 数据模型

### 6.1 ER 概览

```
platforms ──┐
            │
            ▼
         skill_locations  ──────► skills ◄──────── skill_scenarios ──────► scenarios
                                    │                                            ▲
                                    ▼                                            │
                                 skill_tags                                      │
                                    │                                            │
                                    ▼                                            │
                                  tags                                           │
                                                                                 │
                                                              (一对多，从主到次)
```

**核心思路：** Skill 实体是「逻辑 skill」，按 `name + content_hash` 去重。`skill_locations` 记录它出现在哪些物理路径（多个平台 / symlink）。

### 6.2 SQLite Schema

```sql
-- 平台配置（默认插入 claude / codex / shared）
CREATE TABLE platforms (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  skills_dir    TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0
);

-- 逻辑 Skill（去重后的概念实体）
CREATE TABLE skills (
  id               TEXT PRIMARY KEY,           -- uuid
  name             TEXT NOT NULL,              -- frontmatter.name
  description      TEXT,
  version          TEXT,
  author           TEXT,
  license          TEXT,
  body_excerpt     TEXT,                       -- 前 500 字
  content_hash     TEXT NOT NULL,              -- SHA-256(SKILL.md)
  size_bytes       INTEGER NOT NULL DEFAULT 0,
  file_count       INTEGER NOT NULL DEFAULT 0,
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  last_scanned_at  INTEGER NOT NULL,
  UNIQUE(name, content_hash)
);
CREATE INDEX idx_skills_name ON skills(name);
CREATE INDEX idx_skills_updated ON skills(updated_at);

-- Skill 在某平台的物理位置（一个 skill 可有多个 location）
CREATE TABLE skill_locations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id      TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  platform_id   TEXT NOT NULL REFERENCES platforms(id),
  install_path  TEXT NOT NULL,                 -- 用户看到的路径
  real_path     TEXT NOT NULL,                 -- 解析 symlink 后的真实路径
  is_symlink    INTEGER NOT NULL DEFAULT 0,
  is_disabled   INTEGER NOT NULL DEFAULT 0,
  last_seen_at  INTEGER NOT NULL,
  UNIQUE(platform_id, install_path)
);
CREATE INDEX idx_loc_skill ON skill_locations(skill_id);

-- 场景
CREATE TABLE scenarios (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE,
  description  TEXT,
  color        TEXT,                            -- hex
  icon         TEXT,                            -- lucide icon name
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

-- Skill ↔ 场景（多对多）
CREATE TABLE skill_scenarios (
  skill_id     TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  scenario_id  INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  added_at     INTEGER NOT NULL,
  PRIMARY KEY (skill_id, scenario_id)
);

-- 标签
CREATE TABLE tags (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL UNIQUE,
  color  TEXT
);
CREATE TABLE skill_tags (
  skill_id  TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  tag_id    INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (skill_id, tag_id)
);

-- 同步历史（P1 支持回滚）
CREATE TABLE sync_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id     TEXT NOT NULL,
  action       TEXT NOT NULL,                  -- 'copy' | 'symlink' | 'remove' | 'enable' | 'disable'
  from_path    TEXT,
  to_path      TEXT,
  platform_id  TEXT,
  success      INTEGER NOT NULL,
  message      TEXT,
  created_at   INTEGER NOT NULL
);

-- 用户偏好（KV）
CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
```

### 6.3 默认数据（首次启动）

- `platforms`: 插入 claude / codex / shared 三条
- `scenarios`: 插入 6 个默认场景（写作 / 编码 / 运维 / 创意 / 数据 / 知识）
- `settings`: schema_version、theme、auto_scan_on_launch

---

## 7. UI/UX 设计

### 7.1 信息架构

```
App
├── Library (主页，默认)
│   ├── Sidebar
│   │   ├── 全部 Skill
│   │   ├── 场景列表（含数量）
│   │   │   ├── 写作 (12)
│   │   │   ├── 编码 (28)
│   │   │   └── …
│   │   ├── 平台筛选
│   │   │   ├── Claude
│   │   │   ├── Codex
│   │   │   └── Shared
│   │   └── 标签云
│   ├── Main
│   │   ├── 搜索栏 + 排序
│   │   ├── Skill 网格/列表
│   │   └── 分页/虚拟滚动
│   └── Detail Drawer（右侧抽屉）
│       ├── frontmatter 元数据
│       ├── Markdown 渲染
│       ├── 文件树
│       ├── 位置列表
│       └── 操作按钮：同步、加入场景、启用/禁用
├── Scenarios (场景管理页)
│   ├── 场景列表（卡片）
│   ├── 编辑场景：名字、图标、颜色
│   └── 拖拽 skill 入场景
└── Settings
    ├── 平台目录路径
    ├── 扫描设置（启动时自动扫描？）
    ├── 数据库管理（导出/重建索引）
    └── 关于 / 版本
```

### 7.2 关键交互

**主页加载流程：**
1. 显示骨架屏
2. 从 SQLite 读最近一次扫描结果 → 立即渲染（即使是几小时前的）
3. 后台静默重扫 → diff → 增量更新 UI
4. 用户感知：app 永远「秒开」

**新加场景：**
- 点击 sidebar 「+ 新场景」 → 弹 dialog → 命名 + 选图标 + 选颜色 → 保存
- 然后从主列表选 skill → 右键「加入场景」→ 选场景

**跨平台同步：**
- 在 Detail Drawer 看到「当前在 Codex / 不在 Claude」
- 点「同步到 Claude」按钮 → 弹确认对话框（显示文件大小、是否覆盖）→ 选「复制」或「Symlink」→ 执行
- 操作完毕，UI 立刻反映新位置；后台写入 sync_history

**搜索：**
- 全局搜索栏支持：
  - 自由文本（匹配 name + description + body_excerpt）
  - `scenario:写作`
  - `platform:claude`
  - `tag:experimental`

### 7.3 视觉风格

- **主题：** macOS 原生质感，亮色优先，暗色支持
- **配色：** 中性灰阶 + 平台徽标色（Claude 橙、Codex 紫、Shared 绿）
- **字体：** SF Pro Text / SF Mono
- **图标：** lucide-react
- **密度：** 中等偏紧（开发者用户偏好信息密度）

---

## 8. 平台适配细节

### 8.1 Claude

- **Skill 目录：** `~/.claude/skills/`
- **Plugin Skill 目录：** `~/.claude/plugins/<plugin-name>/skills/`（次要扫描点）
- **Project Skill 目录：** `<project>/.claude/skills/`（MVP 不扫，P1 扩展）
- **触发机制：** Claude Code 启动时自动加载该目录下的 SKILL.md

### 8.2 Codex

- **Skill 目录：** `~/.codex/skills/`
- **Vendor Imports：** `~/.codex/vendor_imports/skills/`（次要扫描点）
- **格式：** 与 Claude 完全一致

### 8.3 共享池（用户当前已采用）

- **目录：** `~/.agents/skills/`
- **同步策略：** 用户用 symlink 把它链接到 `~/.claude/skills/` 和 `~/.codex/skills/`
- **MyKills 角色：** 把这种手工模式正式化为「Shared」平台，UI 提供一键 symlink 工具

### 8.4 Skill 格式规范（统一）

MyKills 内部采用与 Claude/Codex 官方一致的格式。**不发明新格式**。

跨平台差异（已知极小）：
- Claude 支持 namespace 前缀（`vercel:deploy`）— 通过 plugin 实现，MVP 不处理
- 某些 skill 的 `metadata` 字段约定可能略有差异（如 `metadata.author`）— 当作自由字段，原样保留

---

## 9. 同步机制

### 9.1 两种同步模式

| 模式 | 行为 | 适用 |
|---|---|---|
| **Copy** | 完整复制目录 | 跨设备分发、需要独立修改 |
| **Symlink** | 创建符号链接指向源 | 同机多平台共享，节省空间 |

### 9.2 同步算法

```
sync(skill, target_platform, mode):
  source_location = pick best location (优先 shared 池)
  target_path = target_platform.skills_dir / skill.name

  if exists(target_path):
    if symlink && resolves to source: 已同步，跳过
    else: 弹冲突对话框 (overwrite / skip / rename)

  if mode == 'symlink':
    fs.symlink(source.real_path, target_path)
  else:
    fs.cp(source.real_path, target_path, { recursive: true })

  insert into skill_locations
  insert into sync_history
```

### 9.3 冲突处理

- **目标已存在且内容相同**：跳过
- **目标已存在但内容不同**：阻塞 + 提示「覆盖 / 备份后覆盖 / 取消」
- **目标是损坏的 symlink**：自动清理 + 重建
- **权限错误**：报错 + 写入 sync_history 失败记录

### 9.4 启用/禁用

不删除文件，**重命名** `skill-name/` → `skill-name.disabled/` 或移到 `~/.claude/skills/.disabled/` 子目录（用户偏好可配）。

---

## 10. AI 集成（P1 起）

### 10.1 用途

- 读取 SKILL.md → 推荐归属场景
- 用户输入「我想做 X」→ 推荐合适 skill
- 浏览市场时给 skill 写一句话总结

### 10.2 实现策略

- **不绑死供应商：** 用户在 Settings 自填 OpenAI / Anthropic / 本地 Ollama key
- **优先 Vercel AI Gateway：** 用户给一个 key 即可用多家模型
- **完全可选：** 用户不配 key，所有 AI 功能优雅降级（按钮置灰 + 提示）
- **请求最小化：** 只发 frontmatter + 前 500 字，不发整个 body

### 10.3 隐私

- 默认不开
- 调用前显式提示「将把以下内容发送给 X 模型」
- 不持久化任何 AI 响应到外部，仅写入本地 DB

---

## 11. 实施路线图

### Sprint 1（MVP 骨架，约 1 周）

- [x] 需求对齐（本文档）
- [ ] 项目脚手架（package.json、配置）
- [ ] Electron 主进程 + preload + IPC 框架
- [ ] SQLite schema + DAL
- [ ] 基础 UI 骨架（layout、sidebar、空状态）

### Sprint 2（核心功能，约 1 周）

- [ ] Skill 扫描器（Claude + Codex + Shared）
- [ ] SKILL.md frontmatter 解析
- [ ] 列表 + 搜索 + 过滤
- [ ] Skill 详情抽屉
- [ ] 默认场景预设

### Sprint 3（管理操作，约 1 周）

- [ ] 场景 CRUD
- [ ] Skill ↔ 场景 关联
- [ ] 启用/禁用
- [ ] 跨平台同步（copy + symlink）
- [ ] 同步历史日志

### Sprint 4（打磨与发布，约 3 天）

- [ ] Settings 页
- [ ] 性能优化（虚拟滚动、增量扫描）
- [ ] macOS 打包 + 图标 + DMG
- [ ] README + 截图

### Sprint 5+（P1 功能）

- Git 仓库导入
- AI 分类助手
- 版本快照
- 导出/导入场景配置

---

## 12. 风险与开放问题

### 12.1 已知风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | **iCloud 路径含空格和特殊字符** (`com~apple~CloudDocs`) | 用 absolute path + 双引号封装；electron-builder 打包测试 |
| R2 | **better-sqlite3 是 native module** | electron-rebuild 处理；CI 跑 macOS arm64 + x64 |
| R3 | **symlink 跨 iCloud 同步不安全** | 在 README 提示用户：共享池放本地 (`~/.agents/`) 而非 iCloud |
| R4 | **Claude/Codex 升级后路径或格式变化** | 设置页允许用户改路径；schema 兼容 frontmatter 任意字段 |
| R5 | **Electron 包体积大** | 第二阶段考虑 Tauri 迁移；MVP 优先功能 |

### 12.2 待决问题

- **Q1：** 是否扫描 plugin 目录？(`~/.claude/plugins/*/skills/`) — MVP 暂不扫
- **Q2：** 是否扫描项目级目录？(`<project>/.claude/skills/`) — MVP 暂不扫
- **Q3：** 场景的图标怎么选？lucide 列表？自由 emoji？— 先用 lucide，P1 加 emoji
- **Q4：** Markdown 渲染用什么库？`react-markdown` vs `marked`？— Sprint 2 时定
- **Q5：** 同步默认模式 copy 还是 symlink？— 默认 symlink（占用小），首次同步弹一次性提示让用户选
- **Q6：** Codex 的 `skills` vs `vendor_imports/skills` 区别？是否合并显示？— 待用户确认，默认合并

### 12.3 未来扩展占位

- 团队空间、订阅、付费 skill — 不在视野内
- 移动端 — 不计划
- Web 版 — 不计划
- 浏览器扩展 / VS Code 扩展 — 不计划，专注桌面

---

## 13. 术语表

| 术语 | 定义 |
|---|---|
| Skill | 单个 AI agent 工作单元，目录 + SKILL.md |
| Platform | 宿主 agent 工具（Claude / Codex / …） |
| Scenario | 用户视角的 skill 分类（写作 / 编码 / …） |
| Location | 一个 skill 在某个平台的物理路径 |
| Shared Pool | 用户自维护的共享池，多平台通过 symlink 引用 |
| Frontmatter | SKILL.md 顶部 YAML 元数据 |
| Sync | 把 skill 从一个 location 复制/链接到另一个 |

---

## 14. 变更记录

| 日期 | 版本 | 变更 | 作者 |
|---|---|---|---|
| 2026-05-19 | 0.1 | 初始版本，需求对齐完成 | Claude + tangmilk1205 |

---

## 附录 A：当前环境快照（2026-05-19）

实际扫描结果（供后续开发对照）：

- `~/.claude/skills/`：约 59 条（多数为 symlink 到 `~/.agents/skills/`）
- `~/.codex/skills/`：约 68 条
- `~/.agents/skills/`：共享池源头
- 个别 skill 链接到 `iCloud/AI/skills/`（如 `citation-audit`）

**说明用户已经在「事实上」维护 shared 池，验证了本设计的正确性。**

Node 23.7.0、pnpm 10.33。工作目录在 iCloud（`com~apple~CloudDocs`）— 建议未来考虑把项目本身搬出 iCloud 以避免编译产物同步抖动。
