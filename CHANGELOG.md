<!-- Developer-facing changelog. Public-facing release notes for users live on
     the World of Windows gateway (/updates). Newest version on top. -->

# Changelog

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
