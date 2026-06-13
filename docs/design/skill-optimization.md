# 技能优化模块（Skill Optimization）设计

状态：设计定稿（2026-06-12）　范围：P1 新模块　作者：经多轮产品讨论收口

> 灵感来源声明：本模块受社区项目 luban-skill（“鲁班”，一个用于打磨 skill 的
> skill）的启发，但**仅借鉴“技能值得被系统性打磨”这一命题本身**。方法论、
> 流程、评估框架均为 MySkills 自有设计，与鲁班的七步工序、九维评分、出师
> 证书等形态无关，亦不复用其任何文本。

---

## 1. 定位与哲学：三问一刀

目标不是让老技能一步登天，而是**每一轮交付一个修好了的、可验证的具体问题**。

诊断只回答三个问题，每轮只动一刀：

| # | 问题 | 考察点 |
|---|------|--------|
| 一问 | **会被选中吗？** | frontmatter description 的触发性：agent 在正确时机能否想起这个技能 |
| 二问 | **照着能做对吗？** | 指令的可执行具体性；常见失败模式有无对策 |
| 三问 | **比主流差在哪？** | 与同类高安装量技能逐条对照的具体差距 |

三条纪律：

1. **证据先行** — 每个发现必须引用 SKILL.md 原文或真实对标事实，禁止凭感觉的批评。
2. **一次一刀** — 模块从差距清单中推荐“本轮最值得修的一处”，单技能同一时间最多
   一个未决优化轮次；上一刀未验收，不开下一刀。
3. **改完可验** — 每个修复提议必须自带“验收单”（见 §3），承诺可观察的行为改进。

明确不要的（区别于鲁班）：不做评分仪式与长报告、不做生态位叙事与传播包装、
不做 README 重构、不做证书类产出。

## 2. 用户参与模型

整个流程**只有一次必须的人工决策**：落盘前看 diff、点确认。

- 诊断：纯读、零决策，可在技能详情页自动就绪（按 `content_hash` 缓存，技能未变不重复调用 LLM）。
- 选修哪处：模块给默认推荐，其余差距项作为备选可切换，不设强制停顿。
- 落盘：唯一强制确认点。理由：(a) 仓库硬性不变量——所有技能目录写入走
  plan → confirm → execute；(b) SKILL.md 是 agent 实时消费的生产资料，劣化是
  静默的；(c) 本应用无技能运行时（SPEC §3.4），用户是改写效果唯一可用的评估器。
- **不做无人值守自动改写**（明确决策）。批量场景允许把多个技能各自的单点修复
  攒成一个 plan 一次确认。

## 3. 修复提议的“验收单”

`optimize:proposeFix` 输出除改写稿与 diff 外，强制包含：

- **预期改进**（expected_improvement）：一句话，必须是可观察行为的表述
  （“改后当你说『处理这个扫描件』时 agent 应能触发本技能”），禁止“提升质量”类空话。
- **验证提示词**（verification_prompts，1~2 条）：可直接粘贴到 Claude Code / Codex
  运行的测试语句，对应“改前应失败、改后应成功”的场景。

两者随前后 `content_hash` 一并写入优化历史，供回看“承诺了什么、兑现没有”。

## 4. 流程状态机

```
诊断(纯读) → 提议(带验收单) → 用户确认 → 落盘(备份/原子写/rescan)
    ↑                                          ↓
    └────── 重新诊断看变化 ←── 用户实测 ──┬─ 满意：轮次完结
                                           └─ 不满意：一键回滚（复用 sync 回滚）
```

- 轮次状态：`proposed → applied → settled | rolled_back`。
- **新老版本并存试用：不做**（明确决策，2026-06-12）。旧版以备份快照存在，
  回退依赖既有 sync 历史回滚机制；不引入带后缀名的试用副本技能。

## 5. “对标主流”实现（三问之三，价值核心）

完全踩在既有 catalog 能力上，无新基建：

1. **定义主流**：由本地技能 name + description 派生 1~2 个检索词（首版为确定
   性派生：name 转空格 + description 关键词，省一次 LLM 往返；效果不足再升级
   为 LLM 生成），调 `catalog:search`（skills.sh），按返回的 `installs` 排序取
   top 3~5。“主流”由安装量定义，不由主观判断定义。
2. **取全文**：对每个对标对象经既有 preview 路径从 GitHub raw 拉取完整
   SKILL.md，按 `(source, skill_id)` 缓存（新表 `catalog_skill_md`，模式照抄
   `catalog_descriptions`）。
3. **结构化对比**：单次 LLM 调用，输出受 JSON schema 约束：每个对标对象
   `{名称, 仓库 URL, 安装量, 可借鉴的结构模式 + 原文证据, 不适用原因}`。
   提示词硬规则：**只许借鉴模式（结构、触发词写法、失败处理组织方式），
   不许搬运内容。**
4. **防抄袭闸门（代码强制）**：改写稿落盘前与每个对标 SKILL.md 做连续
   n-gram 重叠检测，超阈值直接拒绝该稿。
5. **诚实空结果**：检索不到足够安装量的同类时，三问之三明确留空并告知
   “无可靠对标”；对标表中每行必须来自真实 API 返回，URL 可点。

## 6. 命令面与数据模型

新命令（Tauri command，沿用 `shared/ipc-channels.ts` 通道注册约定）：

| 通道 | 性质 | 说明 |
|------|------|------|
| `optimize:diagnose` | 读 + LLM | 跑三问，含对标；结果按 content_hash 缓存 |
| `optimize:getReport` | 纯读 | 取缓存的诊断报告 |
| `optimize:proposeFix` | 读 + LLM | 针对选中差距生成改写稿 + diff + 验收单 |
| `optimize:apply` | 写 | 复用 sync 备份/原子写/rescan；记历史 |
| `optimize:history` | 纯读 | 轮次时间线（验收单 + 前后 hash + 状态） |

回滚不新增通道，复用 `sync:rollback`。

```sql
CREATE TABLE skill_audits (
  id INTEGER PRIMARY KEY,
  skill_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,      -- 诊断对应的技能版本
  report_json TEXT NOT NULL,       -- 三问发现 + 证据 + 对标表
  language TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(skill_id, content_hash, language)
);

CREATE TABLE skill_optimizations (
  id INTEGER PRIMARY KEY,
  skill_id TEXT NOT NULL,
  status TEXT NOT NULL,            -- proposed | applied | settled | rolled_back
  finding_json TEXT NOT NULL,      -- 本轮针对的差距项
  expected_improvement TEXT NOT NULL,
  verification_prompts_json TEXT NOT NULL,
  before_hash TEXT,
  after_hash TEXT,
  sync_history_id INTEGER,         -- 关联落盘记录（备份路径在彼处）
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
```

## 7. 写入安全与质量闸门

落盘走既有 plan → confirm → execute（备份、临时目录原子 rename、写后 rescan、
历史可回滚）。改写稿在进入 plan 前须通过四道自动闸门：

1. frontmatter 合规与修复（复用 create-skill 的 review / repair 机制）；
2. 密钥 / token / 私有路径扫描；
3. 防抄袭 n-gram 重叠检测（§5.4）；
4. 文档膨胀检查——无理由的长度大幅增长视为缺陷而非工作量。

## 8. 隐私（SPEC §10.2 的显式例外）

诊断与改写需要发送**本地技能 SKILL.md 全文**（突破“只发 frontmatter +
前 500 字”的通则），对标对象的 SKILL.md 为公开内容。处理方式：

- 调用前显式提示将发送的内容范围（沿用 §10.3 通则）；
- 仍然 fail-closed：无 key、网络关闭、模型输出无法解析时不产生任何写入计划。

## 9. 分期

- **第一期（纯读，零风险）✅ 已建**：`optimize:getReport` / `optimize:diagnoseJob`
  全量三问（含对标）+ 技能详情页报告 UI + `catalog_skill_md` 缓存 + `skill_audits`
  缓存表（迁移 12）。
- **第二期（写入）✅ 已建**：`optimize:proposeFixJob` / `optimize:getProposal` /
  `optimize:apply` / `optimize:discard` / `optimize:history` + 四道闸门 + diff 确认
  UI + 轮次表 `skill_optimizations`（迁移 13）。回滚复用 `sync:rollback`。

### 实现要点（与设计的偏差记录）

- **落盘走 `copy_real` 动作**：apply 把技能真实目录整体暂存（保留非 SKILL.md 资产），
  仅覆写 SKILL.md，再经既有 `execute_sync_items` 的 `copy_real` 分支落盘——自动获得
  备份、临时目录原子 rename、hash 校验、`sync_history` 记录与回滚。写目标永远是技能的
  **真实目录**（非软链位置），软链兄弟自动跟随。
- **TOCTOU 防护**：apply 前比对技能当前 `content_hash` 与提案的 `baseline_hash`，
  不一致即 `SKILL_CHANGED`，要求重新诊断。
- **轮次状态简化为 `proposed | applied`**；`rolled_back` 不落库，由 `sync_history`
  的 `rolled_back_at` 实时派生（始终与真实回滚状态一致）。一技能同一时间至多一个
  `proposed`，新提案自动顶替旧的未决提案。
- **防抄袭闸门**为词级 8-gram 重叠检测：proposed 与任一对标（缓存于 `catalog_skill_md`）
  共享 ≥2 个不同 8-gram 即 `PLAGIARISM_SUSPECTED` 阻断。防膨胀闸门：增幅 >40% 且
  >1500 字符为阻断，>20% 且 >600 字符为告警。前三道（frontmatter/密钥/危险 shell）
  复用 create-skill 的 `create_skill_review_markdown`。

实现说明：后端落在 Tauri（`src-tauri/`）。仓库 CLAUDE.md 仍描述 Electron 架构、
已过时，应另行更新（不在本模块范围内）。
