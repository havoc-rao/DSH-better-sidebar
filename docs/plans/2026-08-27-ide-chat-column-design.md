# IDE 模式侧边对话聊天列设计（SideChatPane）

> 状态：**已实施**（v0.18.0 目标）
> 范围：把「侧边对话（Side Chat）」集成进 IDE 模式（⌘⌥⇧B 全屏）——主会话被全屏面板盖住后，聊天列就是本模式的对话面
>
> **用户确认的方向**：右侧聊天列（Cursor 风格）——IDE 布局变为 `ActivityBar | 资源管理器 | 编辑器 | 聊天列`，聊天常驻可见，编辑器区收窄。
>
> **后续实施记录（快捷键，2026-08）**：用户确认 **⌘⌥⇧B 是进入/退出 IDE 模式的唯一 hotkey，模式内其他快捷键保持各自语义**（映射到 IDE 窗口自己的面板）：IDE 模式下 `⌘B` 从「宿主左侧栏」改为切左缘资源管理器抽屉（`state.sideBarOpen`，宿主侧栏在全屏遮罩后不可见）；`⌘⌥B`（`builtin:toggle-right-panel` 的 IDE 分支）与新增的 `⌘⇧B`（`builtin:toggle-ide-chat`，`when: state.rightMaximized`）都只开关右缘聊天列 `state.chatOpen`——「收起右侧」的肌肉记忆在 IDE 模式下落到聊天列，**不退出模式、不关整块面板**（曾误做成「⌘⌥B 退出全屏」与原始 `togglePanel` 的「面板整体关闭」，用户两轮反馈后最终定为仅聊天列）；`⌘⇧J` 保留底部 box 最大化/还原（IDE 内向上展开）。聊天列收起钮与 Activity Bar 的 Side Chat 图标 tooltip 均带 ⌘⌥B / ⌘⇧B 提示。改动集中在 `src/client/hotkeys.ts`（`panelToggleBindings`，生产路径与 `registerPanelHotkeys` 原生路径共享同一份定义）；回归见 `tests/builtins-keybindings.spec.tsx` 与 `tests/hotkeys.spec.ts` 的 IDE 用例。

## 0. 背景

IDE 模式（`rightMaximized`）此前只把资源管理器钉到左缘、底部面板停靠到文件 tabs 下方；侧边对话仍是工作台里的普通 tab，在全屏下没有自己的位置。用户要求把侧边对话「也集成到 IDE 模式」。

## 1. 设计

### 1.1 布局

- **聊天列**（`SideChatPane`，`[data-dsh-ide-chat]`）渲染在 `.panelBody` 行末（最右缘），只存在于 `ideMode`。
- 列宽 = `state.chatWidth`（新增，240~480 默认 360，`clampChatWidth` 含视口 45% 上限），**左缘拖拽手柄**调宽（向右拖变宽、挤压编辑器），松手提交 store；拖拽中局部宽度、禁用过渡。
- **折叠**：`state.chatOpen`（新增，随会话持久化、sanitize 宽容恢复）为 false 时列宽 0、`visibility: hidden`、过渡动画——**常驻挂载**（运行中的线程继续轮询、转录不丢）。进入 IDE 模式（`toggleRightMaximized`）默认展开（与 `sideBarOpen` 同款语义）。
- **开关注**：Activity Bar 的 Side Chat 图标在 IDE 模式下从「开新 tab」变为「开/关聊天列」（`chatOpen`/`onToggleChat` prop 接通时，`isChat` 分支；高亮跟随展开态，折叠时 tooltip 显示 `sideChatExpand`）；列头另有收起钮。

### 1.2 镜像 vs 独立线程

聊天列**镜像活动 pane 的 sidechat tab**，不另设线程 store：

- 选中规则与 `HeaderTabStrip` 同 pane：`state.activePane` 属于右树时用它，否则右树首 leaf；取该 leaf 中 `type === 'sidechat'` 的 tab——**激活的那个**；激活的 tab 不是 sidechat 时取**条带最后一个**（最近打开的，列保持常驻不闪 hero）；完全无 sidechat tab 才显示 hero。
- **工作台单元格抑制**：`renderTab` 对 `placement: 'top'` 的 sidechat tab 在 IDE 模式下返回 null——避免同一 tab 双挂载双建线程（`autoCreate` 在列内单次触发）。底部面板/浮动窗口中的 chat tab 不抑制（各自是独立表面）。
- 生命周期与 tab 完全同路：header 条带点 tab 切换线程、✕ 关 tab 回退、`+` 菜单 / 列内「新建对话」走 `openTab` 铸造真实 tab。列内新线程：hero 用 synthetic unbound tab + `SideChatView` 新增可选 `heroAction` prop——hero 的启动按钮在无真实 tab 时**绝不**直接调 `sidechatStart`（synthetic id 的 `updateTab` 是 no-op），改走 `openTab` 让真实 tab 落地后列自动镜像。

### 1.3 底部面板协同

IDE 模式下底部面板右缘收在聊天列左缘：`right: chatOpen ? chatWidth : 0`（React 内联 + `applyDrag` 直写同步），左缘仍 `48 + sideBarWidth`。聊天列不吃底部 margin（面板不延伸到它下方）。

**⚠️ 直写路径必须同样感知 IDE 模式（2026-08-27 修复）**：`measureCenter`（中心列 ResizeObserver / locate 链的直写出口）原本无条件用**中心列 rect** 写底部面板的 left/right。但进入 IDE 模式会**释放**布局推挤（`--dsh-sidebar-width: 0`，全屏遮罩下无需挤压 app），背后的中心列随之展开 → ResizeObserver 触发 → measureCenter 把面板右缘写成了「几乎全宽」——底部终端（z-index 1001）盖住聊天列（panel z-index 1000）的转录区与输入框；而 React 后续 re-render 的 inline `right: chatWidth` 值不变，style diff 跳过 DOM 写，脏值永久残留。修复：`measureCenter` 增加与 `applyDrag` 同款的 IDE 分支（`ideDockRef` 每渲染镜像当前停靠几何，绕开稳定回调不能闭包 state 的限制），IDE 模式下直写 React inline 同款值（`left = 48 + sideBarWidth`、`right = chatOpen ? chatWidth : 0`）。回归测试 `tests/side-chat-pane.spec.tsx`「the measure chain (ResizeObserver path) keeps the IDE dock」：jsdom 里构造 `#root` + 中心列标记并 stub ResizeObserver，让真实 locate/measure 链跑起来（其余测试不挂 `#root`，measure 链从未运行——这是当初漏测的原因）。

## 2. 改动面

| 文件 | 改动 |
|---|---|
| `src/client/state.ts` | `chatOpen`/`chatWidth` 字段 + `CHAT_WIDTH_*` 契约 + `setChatOpen`/`setChatWidth` + `toggleRightMaximized` 默认展开 + `sanitizeState` 宽容恢复 |
| `src/client/SideChatPane.tsx` | **新增**：列 chrome（header/收起钮/左缘手柄/折叠动画）+ 镜像/hero 宿主 |
| `src/client/SideChatView.tsx` | 可选 `heroAction` prop（hero 启动按钮改道） |
| `src/client/Sidebar.tsx` | `ideChatTab` 派生 + `renderTab` 抑制 + panelBody 挂列 + ActivityBar 开关注 + 底部面板右缘 |
| `src/client/ActivityBar.tsx` | `chatOpen`/`onToggleChat` 接通时 sidechat 图标变列开关 |
| `src/client/sidebar.module.css` | `chatPane`/`chatResize`/`chatHeader`/`chatCollapse`/`chatBody`（令牌驱动） |
| `src/client/locales*.ts` | `sideChatCollapse`/`sideChatExpand`（zh/en/ja + 19 语言同步） |
| 测试 | `tests/state.spec.ts` 字段/迁移/钳制；`tests/side-chat-pane.spec.tsx`（Pane 单测 + 真实 Sidebar IDE 壳集成：右缘列、单挂载、底部面板对齐、切换线程） |

## 3. 边界与取舍

- sidechat tab 拖到**底部面板**：按普通 tab 渲染（列只镜像右树活动 pane）。
- **浮动窗口**中的 chat tab：不抑制、不受列影响（`floatTab` 会把 tab 移出 pane，列自动让位）。
- 插件注册的其他聊天类 tab 不进列（列为内置 Side Chat 专设）。
- 非 IDE 模式零改动（列不渲染、cell 不抑制、字段惰性）。