# 资源管理器 Git 状态装饰设计（VSCode 契约）

> 状态：**已实施**（v0.15.0 目标）
> 范围：文件树（内嵌 dock / 独立资源管理器 / VSCode Side Bar 三处共用 TreePanel）的 git 状态徽标 + 目录聚合 + 删除态 + 变更计数条 + 与 Git 面板的实时联动
> 不在本轮：文件监听（保持 KISS，与 Git 面板一致的"手动刷新 + 事件联动"）、搜索结果的徽标（VSCode 的 quick-open 也不显示）、submodule 的 `S` 徽标（porcelain 不带 `--submodule` 标记，且本插件的 fs.tree 不展开 .git 目录）
>
> **实施记录（2026-08-19）**：已全部落地——host `git.status` 增 `root` 字段（仓库顶层，客户端据此把 repo-relative 状态路径拼回绝对路径，会话 cwd 在仓库子目录时也能命中树行）；新建 `src/client/git-status.ts`（纯函数：XY→字母、字母→kind、VSCode Resource priority 聚合、cwd 作用域映射、变更通知总线）；`FileTree` 行渲染徽标 + 删除划线置灰；`TreePanel` 拉取状态 + 底部计数条 + 刷新联动（refreshTick + 变更总线双触发）；`GitView` 每次成功 refresh 后 bump 总线（暂存/提交/放弃/切换分支都经 refresh，一处挂钩全覆盖）。测试：`tests/git-status.spec.ts`（纯逻辑 13 例）+ `tests/tree-git-status.spec.tsx`（组件 4 例：徽标/聚合/删除态/计数条/联动/非仓库降级）。**实施偏差（相对设计）**：`letterOf` 对 `'!!'` 单独短路返回 `'I'`（设计里"双字母非空即冲突"的判定会误伤忽略项）；计数条按字母合并排序用显式 `LETTER_ORDER` 决胜（VSCode 的 bucket 末写者胜是顺序依赖的，这里要确定性）；map 键统一小写（Windows / macOS 大小写不敏感卷上 git 与 fs 大小写可能不一致，宁可键合并也不漏标）。

---

## 0. 背景与目标

better-sidebar 的资源管理器（`FileTree`）目前只显示文件/目录行，没有任何"工作区处于什么状态"的信号：用户改了文件、加了新文件、删了文件，树里看不出任何区别，必须切到 Git 面板才知道。VSCode 的 Explorer 在每一行右侧显示 git 状态字母徽标（M/A/D/R/C/U/!/T，按状态着色），目录行聚合子孙状态，删除文件划线置灰——这是"IDE 感"最直观的一环。

目标：把 VSCode 的 git 装饰契约搬进本插件的文件树（内嵌 dock、独立资源管理器、VSCode 布局的 Side Bar 三处 TreePanel 共用一套实现），并让装饰状态与 Git 面板天然联动：在 Git 面板暂存/提交/放弃后，树无需手动刷新即变色。

## 1. VSCode 参考（权威来源）

装饰语义直接取自 VSCode git 扩展源码（`extensions/git/src/repository.ts` 的 `Resource` 类）：

- **字母映射**（`getStatusLetter`）：INDEX_MODIFIED/MODIFIED→`M`，INDEX_ADDED/INTENT_TO_ADD→`A`，INDEX_DELETED/DELETED→`D`，INDEX_RENAMED/INTENT_TO_RENAME→`R`，INDEX_COPIED→`C`，TYPE_CHANGED→`T`，UNTRACKED→`U`，IGNORED→`I`，冲突（DD/AU/UD/UA/DU/AA/UU）→`!`。
- **双侧状态**：porcelain XY 同时有 index 与 worktree 字母时（如 `AM`），**worktree 字母胜出**——装饰 provider 的 bucket 先写 indexGroup 再写 workingTreeGroup（后写覆盖），故 `AM` 显示 `M`。
- **颜色**（`getStatusColor`）：modified/type-changed 琥珀、added 绿、deleted/conflict 红、renamed/copied 绿、untracked 绿、ignored 灰。本项目映射到 DSH 语义令牌：warn / success / error / label-tertiary。（修订：untracked 由灰改为绿，与 added/renamed 同族——未跟踪新文件与「增」同义，统一 success 绿。）
- **优先级**（`get priority()`）：冲突 4 > 忽略 3 > modified/copied/type-changed 2 > 其余（added/deleted/renamed/untracked）1——目录聚合取最高优先级子孙。
- **删除不传播**：`resourceDecoration.propagate = type !== DELETED && type !== INDEX_DELETED`——删除文件的装饰不上传给父目录（只有删除文件的目录在 VSCode 里无徽标）。

## 2. 设计

### 2.1 host：`git.status` 返回仓库顶层

`GitStatusResult` 新增 `root?: string`（`git rev-parse --show-toplevel`，与 branch/porcelain 并行取）。客户端把 repo-relative 状态路径（`src/a.ts`）拼回绝对路径（`root + '/' + rel`）再与树行匹配——会话 cwd 位于仓库子目录时，只有 cwd 可见范围内的条目被装饰（外部条目直接跳过，它们的祖先聚合也不会出现）。

### 2.2 纯逻辑模块 `src/client/git-status.ts`

- `letterOf(xy)`：`!!`→`I`；冲突组合→`!`；否则 worktree 字母优先，再 index 字母，最后 `U`。
- `kindOfLetter(letter)`：字母 → 状态族（颜色/优先级归类）。
- `mergeRowStatus(a, b)`：VSCode priority 决胜，同级用显式 `LETTER_ORDER`（`! M C T A R D U I`）保证确定性。
- `buildGitStatusMap(result, cwd)` → `{ map, counts }`：
  - `map`：规范化绝对路径 → 行状态。文件行 = 自身状态；每个非删除条目的所有祖先目录（含 cwd）逐级 merge 聚合。
  - 删除条目只写文件行、不写祖先（propagate:false）。
  - `counts`：cwd 内变更文件的字母计数（按 priority 降序、同级按 LETTER_ORDER），喂给底部计数条。
  - 键统一小写 + 正斜杠（`\`→`/`）规范化；包含性判定大小写不敏感（镜像 host `isWithin`）。
- 变更通知总线：`notifyGitStatusChanged()` / `subscribeGitStatusChanged()`——Git 面板 refresh 后 bump，所有挂载的 TreePanel 重新拉取。

### 2.3 组件接线

- `TreePanel`：挂载 / session·cwd 变化 / refreshTick / 总线通知时调 `api.gitStatus`（失败静默降级为空树——错误由 Git 面板负责呈现）；`useMemo` 构建 overlay 传给 `FileTree`；底部渲染计数条（仅仓库且有变更时）。
- `FileTree`：新 `gitStatus?: ReadonlyMap` prop；文件/目录行的**名称文本按状态族着色**（VSCode 的主信号——修改琥珀、增/重命名绿、删除红、未跟踪绿），并在名称与 @ 按钮之间渲染徽标 `<span class=explorerGitBadge + kind 色类>`（title 为状态文案，VSCode 同款 tooltip）；删除文件行加 `explorerDeleted`（名称划线；红色由同一色类承担，不额外置灰——"更明显"优先于 VSCode 的淡化处理）；根行（cwd）不渲染徽标（VSCode 的 workspace root 也无徽标，聚合信息由计数条承载）。
- `GitView`：每次成功 `refresh()`（挂载/聚焦/暂存/提交/放弃/切分支/回滚都走它）后 `notifyGitStatusChanged()`——一处挂钩覆盖全部变更路径。

### 2.4 视觉（令牌驱动，无硬编码色）

| kind | 令牌 | 对应 VSCode 色 |
|---|---|---|
| modified / type | `--dsw-alias-state-warn-primary` | 琥珀 |
| added / renamed / copied / untracked | `--dsw-alias-state-success-primary` | 绿 |
| deleted / conflict | `--dsw-alias-state-error-primary` | 红 |
| ignored | `--dsw-alias-label-tertiary` | 灰 |

徽标为纯色字母（VSCode 风格，无底色 pill；Git 面板自己的 `.gitBadge` 保持原样不受影响）；**名称色 = 同一色类**（`explorerGitWarn/Success/Error/Muted` 同时作用于徽标与名称文本），删除行只保留划线、去掉透明度置灰。

## 3. 测试

- `tests/git-status.spec.ts`：XY→字母全映射（含 `AM`→M、冲突七组合、`!!`→I）；聚合优先级（M 压 A/U、! 压一切、同级决胜确定性）；删除不传播但计数保留；cwd 子目录作用域；分隔符/大小写容错；非仓库/无 cwd 空 overlay。
- `tests/tree-git-status.spec.tsx`：mock `api.fsTree` + `api.gitStatus` 渲染 TreePanel——文件行徽标、目录聚合徽标、删除行划线类、展开后子文件徽标、计数条文本、刷新按钮与变更总线双触发、无 cwd 不拉取、非仓库无徽标无计数条。

## 4. 已知边界

- 无文件监听：编辑器保存文件后需手动刷新或等 Git 面板操作才更新树（与 Git 面板现状一致；VSCode 靠文件 watcher，属后续增量）。
- Windows 大小写不敏感卷：git 与 fs 大小写不一致时键合并可致 `Foo.ts`/`foo.ts` 同键（实际场景罕见，仅影响徽标归属，不影响打开文件）。
- `.git` 目录本身由 fs-tree 的搜索跳过逻辑处理，树不列出，无装饰问题。
