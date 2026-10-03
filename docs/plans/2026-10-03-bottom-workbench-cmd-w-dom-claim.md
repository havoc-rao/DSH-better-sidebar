# 底部工作台 Cmd+W DOM 认领（关标签而非关应用）

日期：2026-10-03
状态：已实施（当前 dev 树；与 2026-09-12 的桌面包桥设计互补，同一「关标签不关应用」语义的浏览器侧落地）

## 用户复验后的修正

前一轮 DOM 单测通过不代表 Desktop 原生键盘路径通过，前一轮「已完成」结论过早。
用户指出 TabBar 的标签仅切换 active、并未转移实际焦点：现增加可聚焦的 tab 语义
与 click 显式 focus。当前宿主 Desktop 经 dshDesktop.keyboard → shortcuts registry
直接执行 page.close，不产生 DOM keydown；现适配公开 shortcuts.closeWindow 的
回退方法，仅在展开底部面板的实时焦点内关闭该分栏标签，并在 fiber 销毁时恢复。
旧桥也先判断底部焦点再走右侧栏。浏览器保留 Cmd+W 不能靠 DOM 监听保证拦截，
Web 应使用 Cmd+Alt+W。下文为初始设计记录，其中「所有环境」不应视为验证结论。

## 背景

右侧 box（DSH 原生右侧栏）里 Cmd+W 关闭当前 tab（宿主 `page.close` 命令，
`ui-sidebar-right/src/client/shortcuts.ts`）。焦点落在**本插件的底部工作台**时
不是右侧栏的领地：宿主桌面运行时的 `page.close` 回退到 `closeWindow()`（关掉整
个 dsh），纯浏览器里浏览器自己关掉整个标签页——「cmd+W 关掉的是 dsh 本体」。

已有的桌面包桥（`desktop-shortcuts.ts`）只在 deepseek-harness Electron 壳内
存在（主进程 `before-input-event` 吞键后经 `window.dshDesktopShell` 路由），纯浏
览器 / 官方壳无桥时是零行为——这正是用户报告的场景：harness Web GUI（浏览器渲
染）里底部 term 上按 Cmd+W 关的是整个应用。

## 设计

### 认领点（src/client/bottom-close-shortcut.ts，新模块）

`installBottomCloseShortcut(service, collapseBottom)` 注册一个 **window 捕获期
keydown** 监听：

- **捕获期**：先于宿主快捷键的 window 冒泡派发（`dsh-client-shortcuts` 的
  `dom.ts` 在 bubble 监听里 `dispatch`，且 `registry.dispatch` 对
  `defaultPrevented` 直接 `pass`）——`preventDefault()` 让宿主的
  「关整个应用」回退永不运行；`stopPropagation()` 让被认领的按键不再到达
  xterm / 编辑器。
- **和弦**：`primary`+`KeyW`（宿主桌面绑定）与 `primary`+`alt`+`KeyW`（宿主
  web 绑定——纯浏览器保留 Cmd+W，宿主 web 走 alt 变体）。拒绝 Shift；拒绝
  Ctrl+Cmd 混按。
- **范围门**：仅当**焦点可验证地在 `[data-dsh-bottom-panel]` 内**且工作台
  `bottomOpen === true` 时认领；其余一切（输入框、右侧栏、body）原样放行给
  宿主 / 浏览器。焦点判定以 `document.activeElement` 为主、事件 composedPath
  为兜底（xterm textarea、编辑器、树行都会取焦）。
- **终端例外**：纯 `Ctrl`+`KeyW`（Win/Linux，无 Cmd 无 Alt）焦点在 `.xterm`
  内时**不认领**——那是 shell 自己的和弦（readline delete-word），宿主 web
  运行时同样放行；macOS `Cmd`+W 不是 shell 和弦，面板内一律认领。
- **repeat 语义**：按住不放的后续 keydown **照常认领**（浏览器不能借第二个
  repeat 自己关标签页）但**不重复关**——一次按压关一个 tab，镜像宿主派发
  （`!gesture.repeat` 才 `run()`）。

### 关闭解析（复用 desktop-shortcuts.ts 的 `closeBottomActiveTab`）

- 从焦点元素 `closest('[data-dsh-pane]')` 取**焦点所在 pane**，优先关该 pane
  的活动 tab（分栏工作台里按在哪格就关哪格）；焦点在面板 chrome（resize 条 /
  折叠按钮，pane 之外）时回退 `activePane` → 首叶。
- pane 无 tab → 注入的 `collapseBottom` 回调收起工作台（与桌面桥的「没有更可
  关就收面板」同一语义）。
- 关闭走 `service.closeTab(tab.id)`——与 TabBar × 完全同一条路径（descriptor
  `onClose`、终端 close 帧、pty 释放）。

### 注册（src/client/index.tsx）

与桌面包桥 effect 并列的新 fiber effect；`collapseBottom` 回调与桥路径共享同一
形状（读 `bottomOpen` 后 `sidebarStore.reduce(toggleBottomPanel)`）。两条路径无
法双触：壳吞键的环境只走桥，键到达页面的环境只走 DOM 监听。

## 兼容性

- 桥存在（harness Electron）：主进程吞掉普通 Cmd+W，DOM 监听收不到——互斥安
  全；`Cmd+Alt+W` 在壳内无绑定、本监听照常认领面板内按压。
- 纯浏览器 / 官方壳：焦点在面板内时 Cmd+W 关 tab（不再关浏览器标签页）；焦点
  在外时行为与现状完全一致（不劫持全局 Cmd+W——用户仍可在面板外关闭应用 / 标
  签页）。
- 不新增 i18n key（无新 chrome）；不新增图标 / 颜色（无皮肤契约面）；不改服务
  方法签名；不 bump 版本号。
- dsh-hotkey 契约零影响（`getSnapshot()` 未动）。

## 实施偏差（vs 初稿）

- **初始稿想在 `event.repeat` 时直接 return**——复查时发现这会放走第二个
  repeat 给浏览器 / 宿主（按住 Cmd+W 会先关一个 tab 再关整个应用）：改为**认领
  repeat 但不重跑**，镜像宿主 dispatch。
- 焦点判定含 composedPath 兜底，但 jsdom 不实现 composedPath（返回 `[]`），单
  测完全走 activeElement 分支；真实浏览器两条分支都有覆盖场景（iframe 内 PDF
  预览等）。
- 测试里 `store.reduce(splitPane('row'))` 是错误的部分应用（`splitPane('row')`
  把 'row' 当 state 求值），规范形态是 `s => splitPane(s, 'row')`；另外 service
  的 open 一律落在 firstLeaf（`openTabInBottomPane`），跨 pane 布 tab 用
  `mapLeaf` 直植。
- 顺手修了 `tests/workspace-terminal-client.spec.tsx:153` 的既有 typecheck 错
  误（`Element.disabled` 不存在，HEAD 上 `pnpm typecheck` 已红）——一行
  `as HTMLButtonElement`，否则本特性无法通过 typecheck 门禁。

## 测试

新增 `tests/bottom-close-shortcut.spec.ts`（jsdom，17 例）：焦点 pane 关闭 /
分栏焦点格优先 / chrome 焦点回退 activePane / onClose 同路径；和弦矩阵（Cmd+W、
Cmd+Alt+W、Cmd+Shift+W 放行、非 W 键放行）；范围门（面板外放行、面板关闭不放
行、空 pane 收起并认领）；先于宿主监听且阻止冒泡；Ctrl+W 终端例外（xterm 内放
行 / 面板内认领 / Ctrl+Alt+W 在 xterm 内认领）；repeat 认领不重关；DOM 认领与
桌面桥解析同一 tab。既有 `desktop-shortcuts.spec.ts` / `service.spec.ts` 回归。