# MySkills UI/UX 审核报告

> 2026-06-09 · 审核基准 main @ v0.2.3 · 7 维度并行评审(视觉一致性 / 交互流与反馈 / 信息架构 / 文案与 i18n / 可访问性 / 首跑与空状态 / 造技能流程)
> 54 条原始发现 → 去重核实为 34 项(P0×8 / P1×14 / P2×12),另剔除 2 条与既定设计决策冲突项。
> 所有证据均经 Read 逐条核对到 文件:行号。**本报告仅为方案,未做任何代码改动。**

# MySkills UI/UX 评审整合方案

## 总评

整体骨架是健康的:格子即开关、plan→confirm→execute、安全操作即时执行+撤销这套交互模型方向正确,问题基本不在设计而在**收尾和接线**。54 条原始发现去重后归为 34 项,集中在四类:(1) **错误反馈链路系统性缺失**——矩阵/详情/扫描的读写失败几乎全部静默吞掉,这是目前对信任伤害最大的一类;(2) **上一轮主源重构的残留**——Crown/琥珀标识没清干净、中英文术语各自分裂成两套,直接稀释了重构本身的收益;(3) **大量"只说不做"的死胡同**——深链机制、按钮文案都已经写好,就差没接线;(4) **核心矩阵交互对键盘完全不可达**。好消息是 P0 八条里大半是把现成机制接上,而不是新设计。

## P0 — 本批就做(已逐条核对代码)

### P0-1 错误反馈系统性缺失:矩阵/详情/扫描静默吞错,失败信息还被撤销 toast 顶掉
- **问题**(合并交互维度 4 条,1 条 high):所有同步写操作失败时用户看到"什么都没发生";扫描失败后侧栏状态点反而变绿报成功;矩阵首载失败永久卡"加载中";部分失败的汇总 toast 被紧随的撤销 toast 立即覆盖。
- **证据**:`coverage-view.tsx:141-164` applyPlan 的 `await api.sync.execute()` 无 catch(已核实),281-485 八个 handler 全是 try/finally;`skill-detail.tsx:108-128` 同模式;`page.tsx:404-412` runScan try/finally 无 catch(已核实),失败后 `sidebar.tsx:146-151` 状态点变 emerald;`coverage-view.tsx:118-121` `setMatrix(await api.coverage.matrix())` 无 catch(已核实);155-163 onApplied 汇总后撤销 toast 立即覆盖。对照组 undoWrites(176-177)和 sync-confirm 都有 catch,证明是遗漏非约定。
- **改法**:全部写操作 handler 统一加 catch→onToast(管道现成);runScan 失败 showToast;矩阵 refresh 加 error 态+重试按钮;`result.failed.length>0` 时把失败计数并入撤销 toast 文案(toast 栈改造放 P1-4)。
- **影响面**:coverage-view、skill-detail、page、sidebar 四个文件,纯加错误分支,不动正常路径。

### P0-2 主源 Crown/琥珀标识残留,与已完成的"隐藏主源 UI"决策直接冲突
- **问题**(high):任务记录确认"隐藏主源 UI (crown/琥珀列/标签)"已做完,但三处漏网;且琥珀色在同一界面既当警示(stale/conflict)又当健康身份标识。
- **证据**(全部已核实):`coverage-view.tsx:697` 表头仍渲染 `<Crown className="h-3 w-3 text-amber-500">`;`skill-detail.tsx:467-469` canonical 状态 Crown + text-amber-600,而 481-482 的 stale 警示同为 text-amber-600;`discover-view.tsx:1024-1027` 安装预览 bg-amber-100 徽章。
- **改法**:删表头 Crown 与 discover 琥珀徽章(或改 bg-secondary 中性样式);skill-detail 来源状态改 text-muted-foreground,琥珀严格留给警示。
- **影响面**:三个文件各几行,纯样式。

### P0-3 五处"去设置/去发现"死胡同,深链机制和按钮文案全是现成的
- **问题**(合并信息架构+首跑共 5 条,多维度命中):AI 透视 LlmGate 只有文字无按钮;发现页网络禁用态的「打开设置」文案键(zh.ts:302)写好了但全仓无引用(已核实);发现页 AI 开关未配置时纯 disabled;矩阵空态三张引导卡只有「设置」一张可点(已核实,且只有标题文字可点);矩阵入口进设置不重置 focusSection,会被残留深链滚到错误区块(`page.tsx:586-589` 已核实无 reset,侧栏入口 509-513 有)。
- **证据**:`library-map-view.tsx:558-569`;`discover-view.tsx:590-604、901-917`;`coverage-view.tsx:1546-1584`;对照 `create-skill-view.tsx:172-176` + `page.tsx:610-614` 的 onOpenAiSettings 深链先例。
- **改法**:统一为 create-skill 模式——LlmGate 和网络禁用态各加「打开设置」按钮(传 settingsFocusSection);矩阵空态卡接 onSelectDiscover/onRescan(page 侧函数现成);矩阵 onOpenSettings 里补一行 `setSettingsFocusSection(null)`。
- **影响面**:4 个组件各加一个 prop+按钮,page.tsx 接线;无新机制。

### P0-4 矩阵核心操作对键盘完全不可达
- **问题**(合并可访问性 2 条 high):右键菜单(打开目录/移到主源/停用等全部逐格操作)无任何键盘打开途径,菜单本身无焦点管理、无方向键、无 Esc(全文件无 Escape 处理);打开技能详情绑定在 `<tr onClick>` 上,无 tabIndex 无 keydown——键盘用户在矩阵里永远打不开详情。
- **证据**:`coverage-view.tsx:1193-1198、1228-1231、755-763`(已核实 EmptyGuidance 同文件,菜单确为 role="menu" 的 span+遮罩)。
- **改法**:菜单迁移到 Radix DropdownMenu/ContextMenu(自带焦点/方向键/Esc,内容可直接复用);技能名列改成 `<button>` 触发 onSelectRow,tr 的 onClick 保留作鼠标大命中区。
- **影响面**:Table 组件内部,鼠标行为不变;顺带补图例的键盘说明文案。

### P0-5 造技能三处高伤害小修:编辑被静默丢弃、最长调用像死机、放弃草稿无确认
- **问题**(合并造技能 3 条,1 条 high):① saveOutline 全文件仅定义无调用(已核实只出现一次)——「继续补充澄清」只 setStep,用户手改的轮廓字段随后被后端 spec 整体覆盖,无提示丢弃;② 「生成 SKILL.md」是最长 LLM 调用,busy 时按钮只 disabled、Sparkles 静态(已核实 630-633 无 Loader2),几十秒像死机;③ 「放弃草稿」直接调 discardDraft 删后端草稿+暂存,无确认无撤销(已核实 640-642 直连)。
- **证据**:`create-skill-view.tsx:190-209、634-636、630-633、640-642、358-368`。
- **改法**:①「继续补充澄清」接到现成的 saveOutline('questions');② generate 按钮加 Loader2+「正在生成…」;③ 放弃草稿/重新生成套现成的 confirm-dialog。
- **影响面**:单文件三个点,均为小改。

### P0-6 onboarding:新机器卡死、启用失败静默、输入框里按 Esc 整个向导消失
- **问题**(合并首跑 2 条,1 条 high):没装过 Claude Code/Codex 的新机器上,候选平台全部 exists=false 时不渲染「启用」按钮,第 2 步「下一步」永久禁用;enable() try/finally 无 catch,创建失败界面无任何反馈;window 级 Esc 监听不检查事件来源——在自定义平台表单或 API key 输入框里习惯性按 Esc,整个向导带着已填内容直接消失。
- **证据**:`onboarding.tsx:176-181、415-421、320-328、91-97`(Esc 处理已核实:`if (e.key === 'Escape' && !advancing) onDone()`)。
- **改法**:exists=false 的候选(至少 shared 推荐主源)提供「创建目录并启用」;enable 加 catch 行内报错(复用 customError 样式);Esc 分层——customOpen 先收表单、焦点在 input 先 blur、最后才关向导。
- **影响面**:单文件;mkdir 走主进程现成 create 流程。

### P0-7 术语第一批:英文"default target"与"source"自相矛盾、中文违反自家词表
- **问题**(合并文案 4 条,纯 locale 文件,多维度命中):① en 设置页叫 `default target`,详情页/确认框/徽章全叫 `source`(en.ts:213/244/335/419,已核实),方向词反义,中文侧已统一「默认来源」;② zh.ts:8 词表明定 symlink→同步副本,实际**6 处**仍用黑话「软链」(核实为 93/130/550/621/807/808,比原发现多 2 处),新手在 onboarding 第一次见到的就是它;③ canonical 在矩阵叫「共享副本」、详情/发现叫「来源」,与「同步副本」一字之差所指相反,词表本身规定 canonical→来源;④ 开发者黑话泄漏:skills_dir(zh:476)、「FS 操作」(zh:517)、cell/mtime(zh:87)、en:747 的 canonical。
- **改法**:en badge 改 'default source'/'Set as default source';6 处软链改「同步副本」措辞;矩阵 canonical 文案改「来源(真实文件)」,en 'Shared copy'→'Source';黑话逐条换人话。
- **影响面**:只动 zh.ts/en.ts,零代码风险,但直接决定主源重构的概念能不能被用户学会。

### P0-8 全局搜索框跨视图残留,切到「发现」自动触发远程/LLM 搜索
- **问题**:单一 search state 横跨本地过滤与 skills.sh 远程搜索;残留词≥2 字符即自动发远程查询,若之前选过 AI 模式还会自动跑完整 LLM 流水线——**无明确意图地消耗用户 API 额度**;造技能装完后 setSearch(name) 预填,下次打开发现会拿自己刚造的技能名去搜目录。
- **证据**:`page.tsx:55、77、619`;`discover-view.tsx:261-289`。
- **改法**:discover 的 query 单独一份 state(library/matrix 可继续共享),或切到 discover 时清掉非本视图输入的残留值,保证默认落热门列表。
- **影响面**:page.tsx 状态拆分 + discover 接线,S 级。

## P1 — 值得做,中等代价

- **P1-1 暗色模式状态色补 dark: 档并抽 statusTone 常量**:矩阵字形/图例/sync-confirm/skill-detail 大量 *-600/700 无 dark: 变体,暗底对比仅 3:1-4:1;同库别处已正确处理,属遗漏。抽共享映射四处共用,防再漂移。(M)
- **P1-2 紫色=AI 语义收口**(合并视觉 3 条):非 AI 功能占用 Sparkles(coverage:578「整理全部」、settings:1021「重新运行引导」、library-map:493 还染琥珀,均已核实),AI 主按钮却各自手拼;sync-confirm 的 copy_to_canonical 用 text-purple-600(已核实)与紧邻的 codex 紫徽章撞色。换图标 + ui/button 加 variant:'ai' + copy_to_canonical 改 blue 系。(M)
- **P1-3 启停操作交互模型统一**:矩阵即时执行+撤销(既定决策),详情面板同一操作却强制弹确认框且无撤销。把 applyPlan 抽成共享 helper,详情面板复用。(M)
- **P1-4 toast 机制升级**(合并交互+可访问性 2 条):单槽位导致连续操作的 6 秒撤销窗口实际不足 1 秒;aria-live 容器随消息条件挂载,首条提示 SR 不播报;倒计时只认 hover 不认键盘焦点。改小型栈(2-3 条)+常驻 live region+onFocus 暂停。(M)
- **P1-5 矩阵/同步历史/场景管理补标题条**:三视图无标题,zh/en 的 header.* 键已存在但全仓无引用(已核实),复用即可;顺带修 scenarios-view 过时注释。(M)
- **P1-6 造技能进度持久化**:切走视图即卸载,已答追问/草案/手改 markdown 全丢,但文案承诺「可以离开此页」;后端草稿仍在(createSkillGet 从不被调用)。挂载时恢复草稿,或先收窄文案。(L,severity 高但代价大)
- **P1-7 审查通过状态不随编辑失效**:改完 SKILL.md 绿色「通过」面板照旧,安装时撞英文报错且新阻塞项不渲染。编辑后降级为「需重新检查」,makePlan 捕获 REVIEW_BLOCKED 回显 detail。(M)
- **P1-8 造技能错误呈现统一**:formatCreateSkillError 只有 start 路径在用,其余 catch 直抛英文原文;installFailed 文案指向从未渲染的「失败项」列表。统一走格式化 + 渲染 executeResult.sync.failed 明细。(M)
- **P1-9 详情面板打开时移焦**:aside 自带 Esc 处理但无人聚焦它,常见路径下 Esc 完全失效、SR 感知不到面板。skillId 变化时 `asideRef.current?.focus()`,一行级修复。(S)
- **P1-10 onboarding 补模态语义**:全屏覆盖层无 role=dialog/焦点陷阱,Tab 可穿透到磨砂下的工作区。换现成 Radix Dialog 外壳。(M)
- **P1-11 SyncConfirm 30s 超时后状态脱节**:超时 reject 但后台仍可能完成,界面不刷新且允许重试已消费 token;iCloud 路径恰好容易超 30s。超时分支补 rescan + 禁重试 + 引导看同步历史。(S)
- **P1-12 库子工具栏过滤态静默消失**:点任一过滤后 列表/看板/AI 透视 切换器无解释地整体消失。改为保留控件、禁用不可用段+hover 提示。(M。注:给 AI 透视加侧栏入口的建议已剔除,见末节)
- **P1-13 看板与场景管理补空状态**:0 技能时看板整页空白,0 场景时管理页只剩按钮;'scenarios.empty' 键已定义无人用。复用 EmptyState 模式。(M)
- **P1-14 StepRail 顺序修正**:rail 是 input→outline→questions,实际流程是 input→questions→outline(已核实),进度条会倒退;done 时 indexOf=-1 只亮第一段。改顺序+done 全亮。(S)

## P2 — 打磨项,先记录

- **P2-1** 矩阵任意格子操作全表 opacity-50 闪烁,busy 收窄到格子/行级。(S)
- **P2-2** missing 格子 tooltip/图例宣称「右键更多操作」但右键被 return,文案与行为对齐。(S)
- **P2-3** 矩阵右键菜单硬编码 bg-white/dark:bg-zinc-900,改 popover token,阴影对齐 dialog。(S)
- **P2-4** 侧栏 neutral-50/80 与向导侧栏 /70 不一致,统一到预留的 --muted 画布 token。(S)
- **P2-5** 造技能向导自成视觉语言(shadow-sm 卡片、rounded-full 药丸输入、tracking-normal 标题、sky 色 Notice),对齐全局直角扁平规范。(M)
- **P2-6** 设置页区块重排为 配置→维护→信息,删 BackupsSection 双 Separator。(S)
- **P2-7** 侧栏资源库组过滤行与视图入口混排重组,平台计数为 0 时显示灰色 0。(M)
- **P2-8** 术语第二批:矩阵「已关闭」vs 侧栏「已禁用」统一名词、en 'Unscenarized' 生造词统一为 'Untagged'、设置页 👑 指代落空(实际是 Target 图标)、中文标点(问号/引号/括号/省略号)统一。(M,全在 locale 文件)
- **P2-9** DiffView 差异行只靠红绿底色,加 +/− 前缀或左边框作第二信号。(S)
- **P2-10** 侧栏扫描状态文本加 role="status" aria-live,圆点 aria-hidden。(S)
- **P2-11** onboarding 完成后按扫描结果分流落点(有技能落 Library 让 Day-0 横幅可见,无技能落矩阵)。(M)
- **P2-12** 追问步加「第 n/m 题」进度计数。(S)

## 已剔除

- **「中途关闭 onboarding 不持久化、每次启动重弹」**:onboarding.tsx:89-90 注释明确写着 Esc 故意不写完成标记、设置页有「重新运行引导」兜底——这是有记录的既定设计决策而非缺陷;若要改属产品决策变更,不进本批(P0-6 的 Esc 分层修复已消除最疼的误触路径)。
- **「给 AI 透视加侧栏常驻入口」**(P1-12 原发现的半条建议):sidebar.tsx:25-26 注释明确 AI Lens 是 Library 子视图、刻意不进侧栏,属既定决策;保留的「切换器静默消失」问题已并入 P1-12。

其余发现经逐条 Read 核对全部站得住(Crown 残留、saveOutline 死代码、词表违反、未接线 locale key、try/finally 无 catch 等均与代码一致,zh「软链」实际 6 处比原发现还多 2 处),无证据不足需剔除项。

---

## 附:逐项清单(供圈选)

| ID | 优先级 | 标题 | 量 |
|---|---|---|---|
| P0-1 | P0 | 错误反馈系统性缺失:矩阵/详情/扫描静默吞错+失败被撤销toast顶掉 | M |
| P0-2 | P0 | 清除主源 Crown/琥珀残留(与已完成的隐藏主源决策冲突) | S |
| P0-3 | P0 | 五处去设置/去发现死胡同接上现成深链+修focusSection残留 | M |
| P0-4 | P0 | 矩阵键盘可达性:右键菜单迁Radix+行详情改按钮 | M |
| P0-5 | P0 | 造技能三小修:saveOutline接线、生成加loading、放弃草稿加确认 | M |
| P0-6 | P0 | onboarding:无目录新机器卡死、enable静默失败、Esc分层 | M |
| P0-7 | P0 | 术语第一批:default target→source、软链→同步副本、共享副本→来源、黑话清理 | M |
| P0-8 | P0 | 搜索作用域按视图隔离,杜绝残留词自动触发远程/LLM搜索 | S |
| P1-1 | P1 | 暗色模式状态色补dark:档并抽statusTone共享常量 | M |
| P1-2 | P1 | 紫色=AI语义收口:Sparkles占用清理、ai按钮variant、copy_to_canonical撞色 | M |
| P1-3 | P1 | 详情面板启停复用矩阵applyPlan(即时执行+撤销),抽共享helper | M |
| P1-4 | P1 | toast升级:小型栈/合并撤销+aria-live常驻+键盘焦点暂停倒计时 | M |
| P1-5 | P1 | 矩阵/同步历史/场景管理补标题条(header.*键现成) | M |
| P1-6 | P1 | 造技能进度持久化:切走视图不丢草稿(createSkillGet恢复) | L |
| P1-7 | P1 | 审查通过状态随markdown编辑失效+REVIEW_BLOCKED回显 | M |
| P1-8 | P1 | 造技能错误统一formatCreateSkillError+渲染安装失败明细 | M |
| P1-9 | P1 | 详情面板打开时移焦aside,修复Esc关闭与SR感知 | S |
| P1-10 | P1 | onboarding换Radix Dialog外壳补模态语义与焦点陷阱 | M |
| P1-11 | P1 | SyncConfirm超时后补rescan+禁重试+引导同步历史 | S |
| P1-12 | P1 | 库子工具栏过滤态改禁用+提示,不再静默消失 | M |
| P1-13 | P1 | 看板与场景管理补空状态(scenarios.empty键现成) | M |
| P1-14 | P1 | StepRail顺序改input→questions→outline,done全亮 | S |
| P2-1 | P2 | 矩阵busy收窄到格子/行级,消除全表闪烁 | S |
| P2-2 | P2 | missing格子tooltip文案与右键行为对齐 | S |
| P2-3 | P2 | 矩阵右键菜单改popover token,阴影对齐dialog | S |
| P2-4 | P2 | 侧栏/向导画布灰阶统一到--muted token | S |
| P2-5 | P2 | 造技能向导视觉对齐全局(去阴影/药丸改直角/tracking统一) | M |
| P2-6 | P2 | 设置页区块重排为配置→维护→信息,删双Separator | S |
| P2-7 | P2 | 侧栏资源库组过滤行/视图入口重组,0计数显示灰色0 | M |
| P2-8 | P2 | 术语第二批:已关闭/已禁用、Unscenarized、👑指代、中文标点 | M |
| P2-9 | P2 | DiffView差异行加+/−或左边框非颜色信号 | S |
| P2-10 | P2 | 侧栏扫描状态加role=status aria-live | S |
| P2-11 | P2 | onboarding完成后按扫描结果分流落点,衔接Day-0引导 | M |
| P2-12 | P2 | 追问步加第n/m题进度计数 | S |
