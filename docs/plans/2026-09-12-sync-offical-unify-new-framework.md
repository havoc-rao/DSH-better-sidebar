# 同步官方 main：统一到 DSH 原生侧边栏新框架

日期：2026-09-12　分支：`main`（本地 fork，`havoc-rao/DSH-better-sidebar`）

## 背景

上次合并 `offical/main`（`5b7bb08`，官方点 `e786d8f`）后，本地工作树混入了官方的新实现，但**旧的自绘框架仍完整保留**：`src/client/Sidebar.tsx` 还有 2600 行自绘右侧面板（toggle cluster / panel resize / vscode header / IDE fullscreen 控件），旧 file-dir 框架（`FileTreeSplitter` / `file-tree-section` / `file-tree-source` / `file-tree-splitter` / `SideBarPane` / `ActivityBar` / `icon-theme` / `FileIcon`）与旧终端框架（`terminal-transport` / `terminal-source` / `terminal-blocks` / `TerminalBlockOverlay` / `terminal-view-loader`）也一并留着，形成"新旧混杂"。

而 DSH 本体（deepseek-harness）已设计并落地的原生侧边栏（0.1.5-rc.x）：

- `ui-sidebar-right`：右侧栏 = dockkit `DockSurface` + `PanelChrome`（全屏/折叠，`SidebarRight.tsx` 潘 `PanelChrome`）+ guide 页 + 两阶段 tab 注册（`ctx.sidebarRightTabs` 注册类型 → `sidebar.right.pane.tab` seat 注册 body）
- `ui-sidebar-files`：新 file-dir tab（`remote.workspaceFiles.list`，`tabActions.openResource` 打开文件）
- `ui-sidebar-documentpreview`：`dsh-resource://file/**` 文本预览 viewer（`fallback` 优先级）
- 终端：本体只有 Host 侧 PTY 子系统（`ctx.terminals`）与聊天内只读 `TerminalBlock`，**没有交互式终端 tab**（终端 tab 由本插件按两阶段路径注册）

**官方仓库 `omdsh-dev/DSH-better-sidebar`（`offical/main`，HEAD `1fcf43c`，v0.19.1 / DSH 0.1.5-rc.2）已经完成了"统一"**：净删 2.5 万行（+2583 / -25584）——退役自绘右面板与旧 chrome、删除旧 file-dir/终端框架与 `GitView`/`FreeWindow`/`GlobalPage`/`workspace-windows`/`keybindings`/`cmd-w` 等，`Sidebar.tsx` 精简为 832 行（文件头明言 "DSH 0.1.5 owns the right column … this shell renders no right panel of its own"），并启用本地曾是死代码的 `sidebar/TabContent.tsx`、`use-center-column.ts`、`use-host-feeds.ts`、`use-pinned-tabs.ts`。

本计划：把本地工作树对齐到官方 `offical/main`（冲突以官方为准），再将本地 3 个私有提交中有价值的功能迁移到官方新架构。

## 决策（用户已确认）

| # | 决策 | 说明 |
|---|---|---|
| 1 | **合并 `offical/main`，冲突以官方为准** | 本地一次性得到官方已完成的统一重构 + DSH 0.1.5-rc.2 基线 |
| 2 | **`aaad824`（git 提交框草稿持久化）迁移到官方 `ChangesTab`** | 官方已删除 `GitView.tsx`，原功能落点改为官方 unified changes tab |
| 3 | **`041815a`（outside-workspace 读取开关）迁移到官方 editor/prefs 路由** | 官方没有此功能；迁移后保持官方架构 |
| 4 | **`338a8d7`（workspace-windows fix）放弃** | 官方已整个删除 `workspace-windows.ts`，功能不复存在 |
| 5 | 不改 DSH 源码 | 仓库硬约束 §1 |

## 当前状态（merge 进行中，未提交）

已执行 `git merge offical/main`（本地 HEAD `338a8d7` ↔ 官方 `1fcf43c`）：

- 19 个 content 冲突文件已全部 `checkout --theirs` 并 `git add`（unmerged = 0）：`AGENTS.md`、`README.md`、`README_EN.md`、`docs/external-plugin-guide.md`、`dsh.plugin.json`、`package.json`、`pnpm-lock.yaml`、`src/client/EditorHost.tsx`、`FileTree.tsx`、`Sidebar.tsx`、`TerminalView.tsx`、`TreePanel.tsx`、`builtins/tabs.tsx`、`service.ts`、`sidebar.module.css`、`state.ts`、`tests/builtins.spec.ts`、`tests/consumer-types.ts`、`tests/e2e/mount.e2e.ts`
- **异常（必须处理，不能直接 commit）**：官方删除的旧实现文件（`GitView.tsx`、`workspace-windows.ts`、`FreeWindow.tsx`、`ActivityBar.tsx`、`SideBarPane.tsx`、`SideChatPane.tsx`、`icon-theme.ts`、`terminal-transport.ts`、`terminal-source.ts`、`terminal-blocks.ts`、`TerminalBlockOverlay.tsx`、`file-tree-*`、`git-*.ts`、`keybindings.ts`、`hotkeys.ts`、`cmd-w.ts`、`commands.ts`、`GlobalPage.tsx`、`GlobalView.tsx`、`tab-surface.ts`、`section-source-tree.tsx` 等）**未落入删除暂存**：`git status` 无任何 `D` 行，这些文件仍留在 index/工作树。直接 commit 会把"官方已删的旧实现 + 新实现"混杂状态写死。
- 本地私有提交引入的测试文件（`tests/git-view-draft.spec.tsx`、`tests/workspace-windows.spec.ts(x)`）也仍在工作树，官方没有它们，需删除。

## Step 1：完成合并对齐（index == 官方树）

1. `git diff --cached offical/main` 全量对比，找出 index 与官方的所有差异文件
2. 官方已删而 index 仍有的文件 → `git rm`：
   - src 侧残留：`git view` 旧面板体系、`workspace-windows.ts`、`icon-theme.ts`、`terminal-*` 框架层、`keybindings/hotkeys/commands/cmd-w`、`file-tree-*` 分片层、`FreeWindow/ActivityBar/SideBarPane/SideChatPane/GlobalPage/GlobalView/tab-surface/section-source-tree` 等
   - 测试侧残留：`tests/git-view-draft.spec.tsx`、`tests/workspace-windows.spec.ts`、`tests/workspace-windows.spec.tsx`
3. index 缺官方文件 → 从官方补回（理论上不应发生，校验兜底）
4. 验收：`git diff --cached offical/main` 为空（index 与官方 `1fcf43c` 逐字节一致）
5. 提交 merge commit：`merge: sync offical/main (v0.19.1, DSH 0.1.5-rc.2, unify to native sidebar)`；此时**不 push**

## Step 2：合并基线验证（先于一切迁移）

- `pnpm install`（lock 已取官方）
- `pnpm typecheck` / `pnpm lint` / `pnpm check:consumer-types` / `pnpm peers check`
- `pnpm vitest run --exclude '**/*.e2e.ts'` —— 期望与官方基线一致（官方 ~1300 passed，具体数以官方 README/CI 为准）
- 修复合并残留：残留 import 指向已删文件、`pnpm-lock.yaml` 不一致、`vitest.config.ts` 的 excluded 列表（官方已改 `*.e2e.ts` 排除配置，注意保留默认排除项）
- **此步验证通过前不进入 Step 3/4**（迁移在官方基线上做）

## Step 3：迁移私有功能①——git 提交框草稿持久化（`aaad824`）

**目标语义**（迁移自 `aaad824`，官方无此功能）：

- 提交框草稿从 `useState` 改为持久化到 `tab.meta`：挂载时从 meta 恢复、写入 400ms 防抖、unmount / 会话切换时立即 flush、提交成功后清空
- 写入走 `store.reduceFor(sessionId, patchTab)`（绝不走 active-session 的 `updateTab`——flush 可能发生在 store 已切换会话之后，落到错误会话会丢稿）
- tab 的会话 id 与草稿一并捕获

**落点（官方新架构）**：

- 官方 `git` tab 现在渲染 `ChangesTab`（`src/client/changes/ChangesTab.tsx`，含 commit 框与 `opCountOf` badge）。先通读官方 `ChangesTab` / `changes/` 目录（`ChangesTab.tsx`、`DiffPane.tsx`、可能存在的 commit 输入组件）与 `src/agents/git-commit-agent.ts`（官方保留？若删除则跳过）确认 commit 框现状
- 将草稿状态迁移到 `tab.meta`（仿官方 `EditorHost` 的 `treeOpen/treeWidth` meta 模式）：`patchTab` 写 meta，`data-dsh-tab-id` 定位 tab
- 测试：把 `tests/git-view-draft.spec.tsx` 的断言逻辑迁移为 `tests/changes-commit-draft.spec.tsx`（对准官方组件与 `store`/`meta` 语义）；不保留引用旧 `GitView` 的测试
- 词典若需新文案优先复用既有 `changes` 相关键

## Step 4：迁移私有功能②——outside-workspace 读取开关（`041815a`）

**目标语义**（迁移自 `041815a`，官方无此功能）：

- `prefs-shared.ts` 增加 `allowOpenOutsideWorkspace`（默认 `false`），`SidebarPrefs` 同步
- 设置行挂到官方 `editor` tab card 的 `settings.toggles`（`src/client/builtins/tabs.tsx`），文案复用本地 041815a 的词典键
- Host 侧读路由跳过 containment：官方对应文件（合并后为基）——`src/fs-tree.ts`、`src/fs-operations.ts`、`src/html-route.ts`、`src/path-security.ts`（041815a 在旧架构动了 `src/config.ts`/`src/index.ts`/`src/path-security.ts`，迁移时映射到官方同位文件）
- **写侧边界不放松**：save / upload / 写路由仍受会话工作区 fence 约束（041815a 原语义）
- 官方已删 `GitView`，原"Git 面板 worktree 行打开"相关改动不再迁移（无落点）
- 测试：`tests/builtins.spec.ts`（设置行断言）、`tests/prefs.spec.ts`（字段默认值）、host 侧读取路由的单测（`fs.` 路由跳过 fence 的用例）

## Step 5：版本号策略与收尾

- **版本号待确认**（写计划之日未决）：
  - 本地 `package.json` = `0.21.0`，官方 = `0.19.1`。先查本地 README changelog / git tag / npm 是否已发布过 `0.21.0`
  - 选项 A：以官方 `0.19.1` 为基，合并后 bump 到官方线下一版（`0.20.0`），本地 0.21.0 历史废弃
  - 选项 B：保留本地线，合并后 bump 到 `0.22.0`（版本高于两侧）
  - 同步 `dsh.plugin.json` 版本号（manifest 一致性守卫）
- 全量门禁复跑：`pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm check:consumer-types` / `pnpm peers check` + `scripts/e2e-mount.sh` 挂载冒烟（PATH 需有 DSH 0.1.5-rc.2 或 `DSH_CMD` 指向钉版，本地 PATH 的 `dsh` 若是 0.1.2-rc.1 会假失败——踩坑记录见 `2026-09-10-auto-activation-native-landing-fix.md` 验证节）
- 提交与推送方式按惯例（直接 main，除非用户要求 PR）；提交信息说明迁移来源

## 验证矩阵

| 项 | 判定 |
|---|---|
| `git diff --cached offical/main` | 空（Step 1 后） |
| `pnpm typecheck` / `lint` / `check:consumer-types` / `peers check` | 全绿 |
| `pnpm vitest run --exclude '**/*.e2e.ts'` | 全绿，数量与官方基线一致（确认无旧 `GitView`/`workspace-windows` 残余测试） |
| `scripts/e2e-mount.sh` | 通过（DSH 0.1.5-rc.2） |
| 真机抽查（可选）：原生 guide 页 | 与新实现的 tab 条目一致；`git` tab 打开 `ChangesTab`；草稿切换会话不丢 |
| 真机抽查（可选）：outside-workspace 开关 | 开 → 可读工作区外绝对路径；关 → 拒绝；写路由始终受限 |

## 不做

- 不恢复任何已退役的自绘右侧面板代码 / 旧 chrome（toggle cluster、panel resize、vscode header、IDE fullscreen、ActivityBar/SideBarPane/SideChatPane）
- 不恢复 `workspace-windows`（全局共享终端窗口）体系（`338a8d7` 一并放弃）
- 不恢复 `terminal-source` / `terminal-transport` / `terminal-blocks` 旧终端框架层；终端 tab 维持官方精简后的 `TerminalView` + `ctx.terminals` 语义
- 不在此次迁移 `subagent/catalog`、全局面板（`main` 槽 / `sidebar.panellist`）等官方明确"未接入"的面
- 不改 DSH 源码（仓库硬约束 §1）