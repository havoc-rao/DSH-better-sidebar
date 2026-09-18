# 文件树文件夹点击失效修复（2026-09-18）

> 状态：已实现。用户报告：**侧边 filetree 的文件夹有时候会无法点击展开，必须 Cmd+Shift+R 重载页面才能恢复可用**。本文记录排查过程（含真机复现尝试）、根因分析与修复。

## 现象

原生右侧栏的 Files 文件树里，点文件夹偶尔完全无反应（chevron 不翻、子级不出现），且**持续失效**——不是丢一次点击，而是此后所有文件夹点击都死掉，直到整页重载。间歇性出现。

## 排查过程

### 代码审计：点击链路

文件夹行 `onClick` → `onToggleDir` → `records.toggleExpanded(nativeTab.id, path)`（`src/client/native/tab-adapter.tsx`）。全链路中**唯一能让点击静默无效**的是 `toggleExpanded` 的早退：

```ts
const entry = views.get(id)
if (entry === undefined) return   // ← 记录不在 = 点击永久无反应
```

记录被 `drop` 的路径有三条：

1. `NativeTabBody` 卸载清理（旧代码无条件 `records.drop(id)`）；
2. `surface.close`（先 `drop` 再调宿主 close）；
3. 宿主关闭 tab 后 body 卸载（正常路径）。

而宿主侧事实（读 `@deepseek-ai/dsh-client-ui-sidebar-right` 已安装包）：

- **body 卸载 ≠ tab 关闭**：pane 里所有 tab 的 body 常驻挂载，但 seat 重绑（会话切换、布局提交竞态、`useTabInfo` 抛错后的 SlotErrorBoundary 重建）会让 body 卸载/重挂；`TabDomain.sync` **只在 tab 从布局消失时 abort 其信号**（`occurrence.controller.abort()`），tab 切换/重绑定不 abort。
- 旧代码在「body 卸载而 tab 仍在」时把记录丢了；重挂后 `ensure` 会重新 mint 一条**空**记录（展开集丢失），而任何「drop 了但没有重挂」的路径（宿主 close 被拒/忽略）会让挂着的树从此点击全灭——与「只能靠整页重载恢复」完全吻合。

### 真机复现（未能触发，但排除了大批候选）

用 `scripts/e2e-mount.sh` 同款 scratch 流程（真实 `dsh web`、`dsh plugin add` 挂载 tarball、Playwright 无头驱动），构造嵌套工作区（alpha/beta/gamma + zeta），对当前分支 `feat/file-tree-dnd-undo` 打了一整套场景炮：

- 基线展开/折叠；Escape 打断的鼠标拖拽 ×4；
- 树内 Option-复制拖拽 + Cmd+Z 撤销；
- 右键菜单开/关 ×4；
- Files ⇄ Tasks tab 切换后回 Files；关闭 Files tab 从 guide 重开；
- 60 轮随机模糊（拖拽/菜单/撤销/点击），每轮健康检查（点击 must 翻转状态）。

另用**用户真实 profile 的插件阵容**（复制 `~/.dsh/profiles/web` 的 package.json/pnpm-workspace.yaml/cordis.patch.yml 到 scratch，link 指向原 checkout）复跑同一套——全部 PASS。无头 Chromium 下树点击链路本身健康；**Electron 真机输入（OS 级拖拽吞点击等浏览器态问题）无法在无头环境复现**，但代码层面已把「插件自己造成点击全灭」的路径全部封死。

## 根因（代码层可证实的两个洞）

| # | 洞 | 后果 |
|---|---|---|
| 1 | `NativeTabBody` 卸载清理无条件 `records.drop(id)`；`surface.close` 先 drop 再关 | body 卸载而 tab 未关（seat 重绑/布局竞态）→ 记录丢失；宿主 close 被拒/忽略 → 挂着的树记录永久缺失 → `toggleExpanded` 早退 → **文件夹点击永久无反应，只能重载** |
| 2 | `FileTree` 拖拽态只靠 `dragend`/`dragleave` 收尾 | Electron 拖出窗口 / Escape 取消丢 `dragend` 时，源行淡化与 drop overlay 滞留到重载（视觉残留，非点击致死，但同属「只能重载恢复」一类） |

## 修复

### 1. 记录生命周期跟随宿主的 tab 信号（`src/client/native/tab-adapter.tsx`）

- `NativeTabBody` 清理改为**仅在 `nativeTab.signal.aborted === true` 时 drop**（宿主 abort 语义 = tab 从布局消失 = 真关闭；幂等，`drop` 本身安全）。普通卸载保留记录——重挂的树既保展开集又保点击面。副作用：off-screen 会话（body 未挂载）的已关 tab 记录不会经清理 drop，`surface.close` 路径保留了局部兜底，剩余为会话级内存残留（每会话个位数条记录，随页面生命周期释放），可接受。
- `toggleExpanded(id, path, seed?)` 增补**自愈**：记录缺失时经 `seed` 重新 mint 后照常翻转（并 `console.warn` 留痕）——「挂着的树点击永远落空」从此在代码上不可能。

### 2. close 不再先斩记录（`src/client/native/surface.ts`）

- 有 controller（宿主在场）时：**先调宿主 close，不 drop**——宿主成功关闭 → 信号 abort → body 清理 drop；宿主拒绝/抛错 → 记录保留 → 树保持可点。
- 无 controller（popup/无原生栏窗口，不会有人卸载 body）：仍本地 drop，防泄漏。
- 公开契约不变（`close` 仍返回 `{type,title} | undefined`；`onClose` 回调语义不变）。

### 3. 拖拽态 blur 卫生（`src/client/FileTree.tsx`）

- `window` blur（=「拖拽不可能落在本窗口」的权威信号）时清除 `dragSource`/`draggingPath`/drop 深度与 overlay；`resetDrop`/`clearDragSource` 提升为 `useCallback`（只碰 ref 与 setter，稳定身份，监听器只注册一次）。

## 测试

- `tests/native-surface.spec.ts`：
  - `toggleExpanded` 经 seed 自愈（记录缺失 → mint → 翻转、通知、可再翻转）；无 seed 的缺失记录保持 no-op；
  - body 生命周期：普通卸载保留记录与展开集、点击面仍活；信号 abort 后卸载才 drop；
  - `createNativeSurface` close 次序：有 controller 不 drop + 宿主 close 被调用；宿主抛错仍保留记录且点击面可用；无 controller 本地 drop。
- `tests/file-tree-drag-undo.spec.tsx`：window blur 清除拖起行淡化与 drop overlay。

## 验证

- `pnpm typecheck` / `pnpm lint`（仅剩分支既有的 `docs/prototypes/gitgraph-lines/src/layout.ts` OutEdge 未用告警，非本次改动）/ `pnpm test` 全绿。
- 修复前后行为对照：把 `tab-adapter.tsx` 回退到旧清理（无条件 drop）+ 旧 `toggleExpanded` 后，新增生命周期用例全红（证明测的正是这两个洞）。

## 未覆盖（诚实记录）

- 无头 Chromium 未能复现用户原话场景；若真机仍有残留，候选只剩 Electron/Chromium 的 OS 级拖拽后点击吞没（浏览器内部状态，插件无法强制恢复）或其它插件的树（本机 profile 里 `dsh-enhanced-workspace` 的工作区浏览器是另一棵树）。本次修复保证插件自身不再有任何「点击全灭直到重载」的代码路径。
- 树内 OS 文件拖拽的 `dropDepth` 计数在极端丢事件场景仍可能滞留 overlay——overlay 是可见且 pointer-inert 的（不挡点击），blur 兜底已覆盖最常见的「拖出窗口」情形。