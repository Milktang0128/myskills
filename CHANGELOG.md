<!-- Developer-facing changelog. Public-facing release notes for users live on
     the World of Windows gateway (/updates). Newest version on top. -->

# Changelog

## 0.4.0 — 2026-06-16

MCP 第二轮:让 agent 不只能**管理**已有技能库,还能**修复 + 增长**它。新增 7 个 MCP
工具(都复用 app 已验证的 plan→执行→备份→历史→可回滚引擎,文件改动统一受
`mcp_allow_destructive` + confirm 双重闸门),MCP 现已覆盖技能库完整生命周期:
理解 / 整理 / 获取 / 维护 / 修复 / 清理。

### 新功能
- feat(mcp): **修复(align)** —— `align_plan`(只读预览)→ `align_apply`(confirm)
  把技能 drifted/坏链的副本重新链回主源(逐个备份、记历史),`skills_rollback`
  (confirm)按历史 id 撤销任意改动 (#54)
- feat(mcp): **获取(acquire)** —— `discover_search` 搜 skills.sh 社区目录(公开、
  免鉴权),`discover_install`(confirm)拉取并安装一个技能(复制到主源 + 软链到
  各平台,记历史、可回滚) (#54)
- feat(mcp): **分类法** —— `scenarios_create`(幂等、支持中文 key)让 agent 能建场景
  而不只是归到已有场景;`skills_set_enabled`(confirm)按平台启用/停用技能(进出
  `.disabled/`) (#54)
- feat(mcp): 服务器 `instructions` + 启动提示词改为引导 agent 连上后**主动给出可执行
  的行动菜单**(归类 / 对齐 / 安装补缺 / 清理),而非开放式提问;并澄清"某平台缺失"
  只是信息、broken/drifted 才需处理 (#54)

### 其他
- refactor: 抽出 Tauri-free 的 `align_plan_for_skill` / `catalog_install_plan` /
  `create_scenario_core` / `toggle_disabled_plan` / `rollback_history_by_id`,
  MCP 与 Tauri 命令共用同一套引擎,从不在引擎里重跑 LLM (#54)

## 0.3.0 — 2026-06-15

### 新功能
- feat(mcp): **MCP —— 让 agent 接管技能库**。独立 `myskills-mcp` 服务(stdio
  JSON-RPC,纯 Rust,无 Node 依赖;随包内置为签名+公证的 sidecar,装好即用),
  暴露 7 个工具:`skills_inventory`(每平台健康度 synced/source/drifted/broken/
  disabled + missingOn)、`skills_read`、`scenarios_list`、`skills_set_scenarios`、
  `skills_history`、`skills_rescan`、`skills_delete`。设置页新增「连接你的 agent
  (MCP)」面板:一段通用「给 agent 的话」一键接入(任何 agent 通用),Claude Code /
  .mcp.json / Codex 原始配置收进折叠区。授权闸门 `mcp_enabled` /
  `mcp_allow_destructive`(默认关、共享 DB 即时生效)。设计立场:agent=大脑,
  故意不暴露 app 自身的 LLM 功能;DB 是唯一真相源,从不改 SKILL.md。文档见
  docs/mcp.md (#52)
- feat(delete): 技能详情面板底部新增**「删除技能」**—— 明确警告 + 二次确认,
  文件移入系统回收站(可恢复),删前根校验、DB 单事务清理;过长 SKILL.md 折叠
  以便够到按钮。跨平台(trash crate)(#50)

### 改进
- ux(settings): 移除「允许外部网络请求」开关 —— 本应用需要外网(目录 + LLM),
  默认常开,旧版本若关过会在打开设置时自动恢复 (#52)
- build(mcp): 通过 Tauri `externalBin` 把 sidecar 签名内置进 .app/installer
  (universal macOS 需 per-arch + lipo'd universal 三件,见 tauri#8152);新增
  `default-run = "myskills"`(两个 [[bin]]) (#52)

## 0.2.5 — 2026-06-12

### 新功能
- feat(optimize): 技能优化模块 **[Beta]** —— 技能详情面板新增「优化诊断」:
  LLM 三问体检(触发清晰度 / 可执行性 / 与目录同类对标)→ 针对单条发现生成
  外科式改写(预期改进 + 行级 diff + 验证提示)→ 确认落盘(自动备份、安全门
  拦截)→ 可在同步历史回滚。DB 迁移 v12 新增 skill_audits / skill_optimizations
  / catalog_skill_md 三表(增量)(#47)

### 修复
- fix(optimize): 诊断成功后转圈不停的竞态(轮询 effect 的 setJob 取消-await 赛跑)(#47)
- fix(optimize): 改写应用面板不再展示用户无法操作的整体结构告警,只留真正的安全阻塞项(#47)

## 0.2.4 — 2026-06-10

UI/UX 全面审核批次 1（7 维度多代理评审 → P0×7 + P1×14 全部落地，报告见
docs/design/uiux-audit-2026-06.md）。

### 改进
- improve: 错误反馈全链路 — 矩阵/详情/扫描写失败不再静默（catch→toast），矩阵
  首载失败有错误态+重试，失败计数并入撤销 toast (#43)
- improve: 5 处"去设置/去发现"死胡同接通深链（AI 透视门、发现页断网态、AI 搜索
  标签、矩阵空态三卡），矩阵入口重置过期 focusSection (#43)
- improve: 矩阵键盘可达 — 格子菜单迁 Radix DropdownMenu（方向键/Esc/焦点还原，
  Shift+F10 可开），技能名列改真按钮 (#43)
- improve: 造技能 — 手改轮廓不再被静默丢弃、生成有进度反馈、放弃/重做先确认、
  改完草案旧审查作废、错误统一人话、StepRail 顺序修正、切走页面草稿可恢复 (#43)
- improve: onboarding — 新机器"创建目录并启用"（platforms_create 补 mkdir）、
  启用失败行内报错、Esc 分层不再误杀向导、Radix Dialog 焦点陷阱 (#43)
- improve: 术语第一批 — en default target→source、zh 软链→同步副本、canonical
  统一为"来源"、开发者黑话清理 (#43)
- improve: toast 升级小型栈（撤销窗口不再被顶掉）+ 常驻 aria-live + 焦点暂停 (#43)
- improve: 紫=AI 语义收口（Button variant "ai"），状态色补暗色档（statusTone
  常量），详情面板启停改即时执行+撤销，发现页搜索与库搜索隔离 (#43)
- improve: AI 透视 — 簇/全部按钮显示"已转成 · 同步"状态，点击前即可预判
  创建还是合并 (#43)

### 修复
- fix: 矩阵右键菜单透明背景（popover 色板未注册进 Tailwind 主题）(#43)
- fix: SyncConfirm 超时后状态脱节 — 触发 rescan、禁重试、引导同步历史 (#43)

## 0.2.3 — 2026-06-09

### 新功能
- feat: SKILL.md panel — one-click copy button in skill detail (#40)
- feat: Settings → About — author credit + clickable GitHub repo link, via a
  new `app_open_url` command (https-only) (#40)

### 改进
- improve: the launch "update available" toast now has a "前往更新 / Update now"
  action that jumps to Settings → Updates (#40)

### 移除
- chore: remove the Electron migration feature end to end — UI, backend
  commands, IPC, i18n, and the migration smoke scaffolding (#39)

## 0.2.2 — 2026-06-08

### 新功能
- feat(updater): wire the stable auto-update channel — signed updater artifacts
  + latest.json per release, published to the fixed `stable` endpoint (#36)

### 其他
- chore(release): 0.2.2 — enable signed auto-update artifacts (#37)

## 0.2.1 — 2026-06-08

### 修复
- fix(onboarding): re-check AI availability after onboarding completes, so the
  AI Lens / Create Skill views unlock without an app relaunch (#31)
- fix(sort): order "recently added/modified" by real filesystem times
  (birthtime / mtime) instead of DB scan times (#33)
- fix: cache reqwest::blocking clients to stop the runtime-drop panic in async
  LLM/network commands (#34)

### 改进
- ux: violet emphasis for the AI Lens guidance banner (#32)

## 0.2.0 — 2026-06-08

The Tauri rewrite becomes the mainline, replacing the Electron app.

### 新功能
- feat: Tauri (Rust + Next.js) rewrite promoted to `main`, replacing Electron —
  ~107MB → ~19MB, faster startup, lower memory; macOS universal (arm + Intel,
  signed & notarized); adds Windows (NSIS) and Linux (AppImage / deb / rpm) (#26)
- feat(create-skill): adaptive clarify pipeline — the LLM clarifies until the
  input/output contract is precise, then crystallizes an outline, then generates
  a reviewable SKILL.md (#26)

### CI / 其他
- ci: tag-triggered stable release workflow — 3 platforms + macOS notarization (#28)
- ci: add npm "tauri" script for tauri-action (#29)
- ci: retry npm ci on transient HTTP 504s (#30)
- chore: clear two dead-code warnings (#27)
