# Cmd+W 关闭右侧栏标签（Electron 快捷键桥 + 便捷关闭）

日期：2026-09-12
状态：已实施（v0.20.x 基线，dsh-hotkey 契约基线之上；与 deepseek-harness 三方联动）

## 背景

deepseek-harness 的 Electron 壳（`apps/electron`）在 `before-input-event` 里拦截
Cmd+W（`event.preventDefault()`，渲染进程永远收不到该键），路由经主进程
`ctx.desktopShortcuts` 路由器（`apps/electron/src/shortcuts.ts`）；无人认领时弹
「Close dsh?」确认框（`window.ts` 的 `confirmClose`）——按下 Cmd+W 关掉的是整个
Electron 窗口，而不是当前正在看的右侧栏标签页。

本插件（v0.19 官方同步后）的所有 tab 类型都注册成内核原生右侧栏 tab 类型，
「右侧工作区 tabs」即原生栏标签条（文件 / 文件变动 / 任务管理 / 侧边对话 /
终端 / 浏览器 / 编辑器）。关闭载体已具备：内核 dockkit 芯片对可关闭 tab 渲染
hover ×（`canCloseTab` 只拒绝「唯一停靠的 guide」）、右键菜单含 Close、插件自己
的底部工作台 TabBar 有 × 与中键关闭。缺口是 **Cmd+W 语义**（关标签而非关应用）
与 **原生芯片的中键关闭**（与插件自带 TabBar 的手势对齐）。

## 三方分工

1. **deepseek-harness（本次并行实施，本仓库不重复）**：
   - `apps/electron` 新增沙箱 preload（`contextBridge.exposeInMainWorld('dshDesktopShell', …)`），
     暴露 `onShortcut(name, handler) => disposer`；主进程侧新 router handler 把
     'cmd-w' 请求发往渲染进程、等认领回执（1.5s 超时兜底，页面无监听必回
     false——主进程永不悬挂）；未认领保持原确认框。
   - `packages/client/ui-dockkit`：芯片/浮窗中键（`auxclick` button===1）关闭，
     中键不启动拖拽、抑制自动滚动。
2. **本插件（本设计）**：消费桥——`window.dshDesktopShell.onShortcut('cmd-w', …)`
   注册认领决策；纯浏览器 / 官方壳无桥时零行为（无新隐私面）。
3. **dsh-hotkey**：不动。

## 设计

### 1. 桥消费（src/client/desktop-shortcuts.ts，新模块）

- `readDesktopShellBridge()`：结构探测 `window.dshDesktopShell`（对象且
  `onShortcut` 是函数），否则 `undefined`。不做 memo（页面 global 一次到位,
  与 desktop-env 的 memo 策略相反：桥可能被壳延迟注入,每次读当前值最稳）。
- `claimCloseActiveTab(ctx, service): boolean` —— Cmd+W 认领决策：

  1. **内核右侧栏**（`ctx.get('sidebarRight')` 结构读取，全程不抛）：
     - `isExpanded() === false`（折叠）→ 跳过原生路径（折叠栏不是用户当前
       活动面，交给工作台）；
     - `active()` 有活动 tab → `close(tab.id)`，**回读 `active()` 验证关闭落
       地**：仍同 id = 内核拒绝（唯一停靠的 guide）→ 不认领、继续回退；变
       了或没了 = 关闭成功 → 认领（`true`）。
  2. **底部工作台**（插件自有面，弹窗/无内核栏窗口的兜底）：`state.bottomOpen
     === true` 且有活动 tab（`activePane` 叶子优先，无则首叶；`leaf.active`
     优先，无则首 tab）→ `service.closeTab(tab.id)` → 认领。
  3. 以上皆无 → `false`（不认领：壳维持「Close dsh?」确认框——插件不削弱
     应用自身的关闭守卫）。

- 同步决策：store 动作与 `sidebarRight.close` 都是同步的，认领无需异步；
  桥契约 `handler: () => boolean | undefined` 一次往返内结算。

### 2. 注册（src/client/index.tsx）

`apply` 内新增 fiber effect：`readDesktopShellBridge()` 拿到桥才注册
`bridge.onShortcut('cmd-w', () => claimCloseActiveTab(...))`（抛错→undefined=
不认领）；disposer 随 fiber 回收（HMR 安全）。

### 3. 便捷关闭的既有面（本次不改，文档固化）

- 原生芯片：dockkit 对可关闭 tab 渲染 hover ×、右键菜单 Close；
  **中键关闭由 harness 侧 ui-dockkit 补**（本仓库不持 dockkit）。
- 插件底部工作台 TabBar：× + 中键关闭（既有实现，见 TabBar.tsx）。

### 4. 契约（写入指南 §7.1）

`window.dshDesktopShell`（deepseek-harness Electron preload）：
`onShortcut(name: 'cmd-w', handler: () => boolean | undefined): () => void`；
页面回 `true` = 认领该次按键（壳不再弹确认框），`false`/`undefined` = 放行。
壳保证：无监听/异常/超时按 false 结算。

## 兼容性

- 桥缺失（纯浏览器、官方壳）→ 模块零行为，行为与现状完全一致。
- 不新增 i18n key（无新 chrome）；不新增图标/颜色（无皮肤契约面）。
- 不改服务方法签名；`getSnapshot()` 不动（hotkey 契约回归不受影响）。
- 内核拒绝关闭（唯一 guide）时正确回退而非误认领。

## 实施偏差

- **外壳「折叠则跳过原生」的语义**定稿为 `isExpanded() === false` 才跳过：
  `undefined`（晚挂载窗口、控制器无该方法）仍尝试原生路径，再回退工作台。
- 认领决策放插件内（`claimCloseActiveTab`），不放在 index.tsx 内联——可单测、
  且未来其他壳（官方壳侧）若提供同类桥可直接复用。
- 未 bump 版本号（发版走 release 流程）；`SIDEBAR_FEATURES` 不增
  （消费方只需探测 `window.dshDesktopShell` 存在性，无需 gate）。

## 测试

- 新增 `tests/desktop-shortcuts.spec.ts`（15 例）：桥探测三态；原生路径
  （关闭认领 / 关闭后无活动 tab / 拒绝关闭不认领 / 折叠跳过 / 控制器抛错）；
  工作台回退（无控制器 / 原生无活动 tab / 皆无可关 / 工作台关闭）；index
  wiring 形状（handler 即认领函数、抛错不认领）。
- `tests/hotkey-contract.spec.ts`、`tests/service.spec.ts` 回归。
- harness 侧（并行）：electron 桥单测 + dockkit 中键用例 + mount 冒烟由
  deepseek-harness 仓库负责。