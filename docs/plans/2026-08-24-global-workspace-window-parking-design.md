# 全局工作区：窗口生命周期驻留设计（attach-on-demand）

> 日期：2026-08-24
> 状态：已实施
> 关联：`docs/plans/2026-08-19-global-shared-terminal-design.md`（原「所有项目同步」设计，本文档将其语义升级为「生命周期驻留全局工作区 + 按需 attach」）、`docs/plans/2026-08-20-left-sidebar-injection-design.md`、`src/client/workspace-windows.ts`、`src/client/state.ts`、`src/client/Sidebar.tsx`、`src/client/GlobalView.tsx`、`src/client/GlobalPage.tsx`、`src/client/global-page.ts`

## 1. 动机

v0.13.x 的全局共享终端（`gb:`，「所有项目同步」）语义是：`bindGlobal` 后把 `gb:` stub **自动合并进每个 session 的 tab 栏**（跨 workspace / 独立会话），全局工作区页只负责「记录/列出」这些窗口。

用户反馈（2026-08-24）：**在『全局工作区』这里，会把窗口转移到『全局工作区』，而不是所有 session 的 tabs 中都能看到**——即：

- 全局共享窗口的**完整生命周期**（同一个 xterm 会话 / 同一个 PTY 进程）应当**驻留在全局工作区**；
- 窗口**不再自动出现在每个 session 的 tab 栏**（旧「所有项目同步」的强制合并改为**按需 attach**）；
- 需要时从全局工作区点卡片，把窗口**带到当前 session**（attach 到同一个共享 PTY）。

## 2. 设计目标

- **不改变默认行为**：只有被显式「全局共享」的终端才进入全局工作区；其余终端维持现状。
- **生命周期驻留全局工作区**：`bindGlobal` 后窗口的定义（type/title/area）与 PTY 进程都属于全局 blob（`dsh-sidebar:v1:global-windows`）；任何 session 都不再自动持有 stub。
- **按需 attach**：会话从全局工作区点卡片把窗口带到自己——`gb:` stub 落进**该会话**首个叶子并聚焦；一处 shell（`shared:gb:<n>` PTY），多处视图。
- **detach 本地化**：attached stub 的 ✕ 只移除本会话的 attachment，窗口与共享 PTY 存活；「取消全局共享」（`unbindGlobal`）才是全实例关闭。
- **持久化一致**：attached stub 持久化在会话布局（像普通终端一样 reload 存活），reload 时对照全局 blob 校验（窗口已取消则剥离）。

## 3. 设计

### 3.1 生命周期转移：`bindGlobal` 不再合并 stub

`src/client/workspace-windows.ts`：

- `bindGlobal` 保留：PTY re-parent 到 `shared:gb:<n>`（best-effort）、窗口 append 到全局 blob、绑定会话从 BOTH trees 移除本地 tab。
- **移除**：把 `gb:` stub 合并进每个 session 的 reconcile feed（`notify()`）与「active 移交到 stub」的 handoff。绑定后任何 session（包括绑定会话本身）都不持有 stub——窗口「转移」进了全局工作区。
- 悬挂 `active`（指向被移除的本地 tab）照旧 null 掉，避免下次 sanitize 见 corrupt pointer。

### 3.2 按需 attach：`attachGlobal` / `attachGlobalTo`

新增 store 方法：

- `attachGlobal(tabId, sessionId?)`：把窗口的 `gb:` stub 落进目标 session（缺省 = 当前）的 **area 首个叶子**（right → `splits`，bottom → `bottomSplits`，area 跟随 bind 时的面板）并聚焦，同时展开承载面板（`panelOpen`/`bottomOpen`，mirror 内容型 `openTab` 的「必须落在视野内」规则）；该 session 已持有 stub 则只聚焦（不重复）。
- 显式 `sessionId`（完整页面的「恢复打开前会话」路径）走 `SidebarStore.reduceFor`（定向加载/持久化目标 session 布局，不切换 UI、不 notify）。

attach 后该会话的 TerminalView 以 `gb:<n>` id 连接 → host `shared:gb:<n>` 键 → 与所有其他 attachment 共享同一个 shell。

### 3.3 持久化与 reconcile：attached stub 是会话状态

`src/client/state.ts`：

- `reconcileWorkspaceWindows(state, windows, globalWindows)` 增加第三参：`validIds = workspace ∪ global` 用于剥离 stale bound ids；**auto-merge 只针对 `windows`（workspace 窗口）**——global 窗口永不自动合并，只校验会话已持有的 `gb:` stub。
- `WorkspaceWindowsSource` 增加 `globalWindows()`；`loadState` / `attachWorkspaceWindows` 传入。
- `stripWorkspaceWindows` **保留 `gb:` stub**（attached 视图是刻意的会话状态，reload 存活并校验），只剥离 `ws:`（store 重合并）。
- `windowsOfSession` 只返回 workspace 窗口（不再拼 global）。

### 3.4 detach 不杀 PTY：`tabOpen` 的 live-stub 判定

`SidebarStore.tabOpen` 扩展：一个 bound stub（`ws:`/`gb:`）在**窗口仍定义**时视为「未关闭」——即使该会话已不再持有它。这样 attached stub 被 ✕ detach（`detachGlobal` 只从当前会话移除）后，TerminalView unmount **不发 close frame**（close frame 会 0ms 杀掉共享 PTY）；只有 `unbindGlobal`（先把窗口从 blob 移除 → reconcile 剥离所有 attached stub → 此时窗口已不存在 → close frame 放行）才杀死 PTY。workspace stub 的 ✕ 同理（unbind 先移除 blob 再 strip）。

### 3.5 取消共享：`unbindGlobal`

- `keepInSession=true`（stub 右键「取消全局共享」）：窗口离开全局 blob，当前会话的 attached stub **原地变成本地 terminal**（PTY re-parent 回本地键）。
- `keepInSession=false`（卡片 ✕）：窗口全实例关闭；attached stub 经 reconcile feed 从每个会话剥离，其 unmount close frames 杀 PTY；**未 attach 过的「无头」PTY 由显式 `api.ptyClose` 兜底释放**（payload sessionId 对 `gb:` 键无影响，无会话时用占位串）。

### 3.6 全局工作区面

`TabComponentProps` 新增两个可选 prop：`onAttachGlobal(tabId)` / `onUnbindGlobal(tabId)`（宿主未暴露 windows store 时缺省，卡片点击静默 no-op）。

- **`GlobalView`（面板 tab，会话绑定）**：卡片点击 → `attachGlobal`（带到当前会话）；卡片 ✕（悬停显示）→ `unbindGlobal(false)`。
- **`GlobalPage`（完整页面，无会话表面）**：`openGlobalPage` 在 `ctx.sessions.clear()` 前**捕获 `sessions.list.current`**（模块级 `sessionBeforeOpen`）；卡片点击 = 关闭页面 + `attachGlobalTo(before, id)` + `ctx.sessions.open(before)`（「带着终端回去」）；卡片 ✕ 就地 `unbindGlobal(false)`（列表实时刷新，不离开页面）；从 hero 打开（无捕获会话）时卡片点击 no-op。
- 文案：`bindGlobal` → 「全局共享（转移到全局工作区）」；徽标 → 「驻留全局工作区」；empty 提示更新。

## 4. 实施偏差与注意

- **`bindGlobal` 移除 active handoff**：旧实现把绑定会话的首叶子 active 移交到 stub（保持视野）；新设计无 stub 可移交，active 直接 null。
- **`unbindGlobal(false)` 显式 pty 释放**：旧实现依赖「stub 在每个会话 → unmount close frame 杀 PTY」；新设计窗口可能从未被 attach（无 stub 可 unmount），必须显式 `pty.close`，否则无头 PTY 泄漏。
- **`refreshSnapshot` 注释修正**：旧注释称「global 不进快照比较」，实际代码一直比较 `snapshot.global === global`（global-only 变更本就 notify）；注释已纠正，global 变更方法中的显式 `notify()` 保留为 reconcile feed 的冗余保险。
- **`TabComponentProps` 契约加 prop**：additive，向后兼容；外部插件忽略即可。
- **兼容**：旧构建持久化的会话布局不含 `gb:` stub（旧 `stripWorkspaceWindows` 全剥），无迁移负担。

## 5. 测试

`tests/workspace-windows.spec.ts` 全局 describe 重写 + 新增：

- bindGlobal 驻留（任何 session 无 stub、无 active handoff）；re-parent 到 `shared:gb:` 键；非终端 no-op；无 workspace 会话可用。
- attachGlobal：只进当前会话（聚焦、开面板、重复 attach 不重复）；显式 session 走 reduceFor 不切 UI；bottom-area 进 bottom 面板。
- detachGlobal：只移除当前会话 attachment，窗口与其它会话存活。
- unbindGlobal(false)：全实例剥离 + 显式 `pty.close` 调用；unbindGlobal(keep)：原地本地化 + re-parent。
- 持久化：attached stub 存进会话布局、reload 校验存活；窗口取消后 reload 剥离。
- 共存：workspace stub 与 attached global stub 互不干扰。
