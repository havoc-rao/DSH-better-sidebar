# 全局工作区：窗口生命周期驻留设计（特殊 session + 专属下方工作区）

> 日期：2026-08-24
> 状态：已实施
> 关联：`docs/plans/2026-08-19-global-shared-terminal-design.md`（原「所有项目同步」设计，本文档将其语义升级为「生命周期驻留全局工作区 + 按需 attach」）、`docs/plans/2026-08-20-left-sidebar-injection-design.md`、`src/client/workspace-windows.ts`、`src/client/state.ts`、`src/client/Sidebar.tsx`、`src/client/GlobalView.tsx`、`src/client/GlobalPage.tsx`、`src/client/global-page.ts`、`src/client/builtins/tabs.tsx`

## 1. 动机

v0.13.x 的全局共享终端（`gb:`，「所有项目同步」）语义是：`bindGlobal` 后把 `gb:` stub **自动合并进每个 session 的 tab 栏**（跨 workspace / 独立会话），全局工作区页只负责「记录/列出」这些窗口。

用户反馈（2026-08-24，两轮）：

1. **「在『全局工作区』这里，会把窗口转移到『全局工作区』，而不是所有 session 的 tabs 中都能看到」**——全局共享窗口的完整生命周期（同一个 xterm 会话 / 同一个 PTY 进程）应当驻留在全局工作区，不再自动出现在每个 session 的 tab 栏。
2. **「点击这个 term 不会在当前 session 中去创一个……而是可以把下方的这个 box 也集成到全局工作区。此时全局工作区就相当于原本 chatbox 的布局位置，它可以拥有属于自己的下方工作区扩展，相当于它是一个特殊的 session」**——全局工作区**本身是一个特殊 session**：占据 chatbox 布局位置，并拥有**自己的下方工作区**；点击卡片把窗口带入**它自己的底部工作区**，而不是任何真实会话。

## 2. 设计目标

- **不改变默认行为**：只有被显式「全局共享」的终端才进入全局工作区；其余终端维持现状。
- **全局工作区 = 特殊 session**：虚拟 `global-workspace` 会话（`GLOBAL_WORKSPACE_SESSION_ID`）拥有独立的 sidebar 状态（含 `bottomSplits`），经 `SidebarStore.getStateOf / subscribeOf / reduceFor` 读写，状态持久化在 `localStorage: dsh-sidebar:v1:global-workspace`。
- **生命周期驻留**：`bindGlobal` 后窗口定义与 PTY 进程都属于全局 blob（`dsh-sidebar:v1:global-windows`）；任何真实 session 都不再自动持有 stub。
- **按需 attach 进专属下方工作区**：点卡片 = `attachGlobal` 把窗口带入**全局工作区自己的底部工作区**（虚拟会话 `bottomSplits` 首个叶子 + `bottomOpen`）——不碰任何真实 session，完整页面保持打开。
- **detach 本地化**：底部工作区 attached stub 的 ✕ 只 detach（窗口与共享 PTY 存活、回卡片列表）；「取消全局共享」（`unbindGlobal(false)`）才是全实例关闭。
- **持久化一致**：attached stub 持久化在虚拟会话布局，reload 对照全局 blob 校验（窗口已取消则剥离，reconcile 剥离会同步持久化）。

## 3. 设计

### 3.1 生命周期转移：`bindGlobal` 不再合并 stub

`src/client/workspace-windows.ts`：

- `bindGlobal` 保留：PTY re-parent 到 `shared:gb:<n>`（best-effort）、窗口 append 到全局 blob、绑定会话从 BOTH trees 移除本地 tab。
- **移除**：把 `gb:` stub 合并进每个 session 的 reconcile feed（`notify()`）与「active 移交到 stub」的 handoff。绑定后任何 session（包括绑定会话本身）都不持有 stub——窗口「转移」进了全局工作区。
- 悬挂 `active`（指向被移除的本地 tab）照旧 null 掉，避免下次 sanitize 见 corrupt pointer。

### 3.2 特殊 session：`GLOBAL_WORKSPACE_SESSION_ID` + per-session 读写

`src/client/state.ts`：

- `export const GLOBAL_WORKSPACE_SESSION_ID = 'global-workspace'`（保留 id，真实会话 id 是 uuid，永不撞）。
- `SidebarStore` 新增：
  - `getStateOf(sessionId)`：读任一会话状态（按需 loadState + reconcile，**不切换** active snapshot）；
  - `subscribeOf(sessionId, cb)`：**per-session 订阅**——`reduce`/`reduceFor`/`update`/reconcile 对该会话的变更只通知它的订阅者（`reduceFor` 原本不 notify 全局 UI，现在通知该会话自己的订阅者，GlobalPage 据此刷新）；
  - `reduceFor` 的定向修改路径复用（不切 UI、不 notify 全局）。

### 3.3 按需 attach：`attachGlobal`

`attachGlobal(tabId)`：把窗口的 `gb:` stub 落进**虚拟 `global-workspace` 会话的 `bottomSplits` 首个叶子**并聚焦 + `bottomOpen: true`（页面「下方的 box」）；虚拟会话已持有该 stub（无论拖到哪个叶子）则只聚焦（不重复）。经 `reduceFor(GLOBAL_WORKSPACE_SESSION_ID, …)` 执行——不碰真实 session、不切 UI，页面经 per-session 订阅实时刷新。

attach 后底部工作区的 TerminalView 以 `gb:<n>` id 连接 → host `shared:gb:<n>` 键 → 与所有其他 attachment 共享同一个 shell（一处 shell，多处视图）。

### 3.4 持久化与 reconcile：attached stub 是虚拟会话状态

- `reconcileWorkspaceWindows(state, windows, globalWindows)`：`validIds = workspace ∪ global` 用于剥离 stale bound ids；**auto-merge 只针对 `windows`（workspace 窗口）**——global 窗口永不自动合并，只校验虚拟/真实会话已持有的 `gb:` stub。
- `stripWorkspaceWindows` **保留 `gb:` stub**（attached 视图是刻意的会话状态，reload 存活并校验），只剥离 `ws:`。
- `windowsOfSession` 只返回 workspace 窗口（不再拼 global）。
- **reconcile 剥离会同步持久化**：`attachWorkspaceWindows` 的 reconcile-all 对被清理的会话 `schedulePersist`——否则虚拟会话布局会残留已取消窗口的 stub，reload 时「复活」（测试捕获的回归）。

### 3.5 detach 不杀 PTY：`tabOpen` 的 live-stub 判定

`SidebarStore.tabOpen` 扩展：一个 bound stub（`ws:`/`gb:`）在**窗口仍定义**时视为「未关闭」——即使该会话已不再持有它。这样 attached stub 被 ✕ detach（`detachGlobal(tabId, GLOBAL_WORKSPACE_SESSION_ID)` 只从虚拟会话移除）后，TerminalView unmount **不发 close frame**（close frame 会 0ms 杀掉共享 PTY）；只有 `unbindGlobal`（先把窗口从 blob 移除 → reconcile 剥离所有 attached stub → 此时窗口已不存在 → close frame 放行）才杀死 PTY。workspace stub 的 ✕ 同理（unbind 先移除 blob 再 strip）。

### 3.6 取消共享：`unbindGlobal`

- `keepInSession=true`（真实会话里 legacy attached stub 的右键「取消全局共享」）：窗口离开全局 blob，该 stub **原地变成本地 terminal**（PTY re-parent 回本地键）。
- `keepInSession=false`（卡片 ✕）：窗口全实例关闭；attached stub 经 reconcile feed 剥离（含虚拟会话），其 unmount close frames 杀 PTY；**未 attach 过的「无头」PTY 由显式 `api.ptyClose` 兜底释放**（payload sessionId 对 `gb:` 键无影响，无会话时用占位串）。

### 3.7 全局工作区面

`TabComponentProps` 新增两个可选 prop：`onAttachGlobal(tabId)` / `onUnbindGlobal(tabId)`（宿主未暴露 windows store 时缺省，卡片点击静默 no-op）。`builtins/tabs.tsx` 导出 `LazyTerminal`（页面底部工作区复用终端懒加载渲染）。

- **`GlobalView`（面板 tab）**：卡片点击 → `attachGlobal`（带入虚拟会话的底部工作区，不碰当前 session）；卡片 ✕ → `unbindGlobal(false)`。
- **`GlobalPage`（完整页面）**：`registerGlobalPageSurface(ctx, store, windows)`（新增 store 参数）。页面经 `useSyncExternalStore` 同时订阅 windows store 与**虚拟会话状态**；本体 = 卡片列表 + **专属下方工作区**（`globalPageBottom`，**无 header**——有 attached 终端即直接渲染；复用 `Workbench` 渲染虚拟会话 `bottomSplits`，terminal stub 经 `LazyTerminal` 渲染、标题经 `windows.update` 回流）。卡片点击 = `attachGlobal`（页面不关闭）；卡片 ✕ = `unbindGlobal(false)`（列表实时刷新）。`openGlobalPage` 只 `ctx.sessions.clear()` + 置 open（不再捕获/恢复原 session）。
- 文案：`bindGlobal` → 「全局共享（转移到全局工作区）」；徽标 → 「驻留全局工作区」；新增「下方工作区」（`globalInfoBottomWorkbench`）；empty 提示更新。

## 4. 实施偏差与注意

- **`bindGlobal` 移除 active handoff**：旧实现把绑定会话的首叶子 active 移交到 stub（保持视野）；新设计无 stub 可移交，active 直接 null。
- **`unbindGlobal(false)` 显式 pty 释放**：旧实现依赖「stub 在每个会话 → unmount close frame 杀 PTY」；新设计窗口可能从未被 attach（无 stub 可 unmount），必须显式 `pty.close`，否则无头 PTY 泄漏。
- **reconcile 剥离必须持久化**（见 3.4）——这是特殊 session 持久化模型引入的新回归点。
- **`tabOpen` 的 live-stub 判定对 detach 生效**：detach 时窗口仍在 blob → 不发 close frame → PTY 存活；unbind 时窗口已从 blob 移除 → close frame 放行。
- **`reduceFor` 的 per-session 通知**：定向修改（attach/detach/折叠）不再静默——目标会话的订阅者（页面）刷新，全局 UI 仍不打扰。
- **`refreshSnapshot` 注释修正**：global 实际参与快照比较（global-only 变更本就 notify）；global 变更方法中的显式 `notify()` 保留为 reconcile feed 的冗余保险。
- **`TabComponentProps` 契约加 prop**：additive，向后兼容；外部插件忽略即可。
- **兼容**：旧构建持久化的会话布局不含 `gb:` stub（旧 `stripWorkspaceWindows` 全剥），无迁移负担；真实会话里遗留的 legacy `gb:` stub（旧「attach 到会话」产物）仍可 ✕ detach / 右键「取消全局共享」，reconcile 会在窗口消失时剥离。

## 5. 测试

`tests/workspace-windows.spec.ts` 全局 describe 重写 + 新增：

- bindGlobal 驻留（任何真实 session 无 stub、无 active handoff）；re-parent 到 `shared:gb:` 键；非终端 no-op；无 workspace 会话可用。
- attachGlobal：只进**虚拟会话的底部工作区**（聚焦、`bottomOpen`、重复 attach 不重复）；真实会话零触碰；拖到别的叶子后 re-attach 就地聚焦不重复。
- detachGlobal(tabId, GLOBAL_WORKSPACE_SESSION_ID)：只移除虚拟会话 attachment，窗口驻留。
- unbindGlobal(false)：全实例剥离（含虚拟会话）+ 显式 `pty.close` 调用；unbindGlobal(keep)：真实会话 legacy stub 原地本地化 + re-parent。
- 持久化：attached stub 存进**虚拟会话布局**（`dsh-sidebar:v1:global-workspace`）、reload 校验存活；窗口取消后 reload 剥离（reconcile 持久化回归测试）。
- 共存：workspace stub 只进 workspace 会话、global stub 只进虚拟会话，互不干扰。
