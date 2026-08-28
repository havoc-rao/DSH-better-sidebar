# 快捷键系统设计（keybindings）

> 目标版本：v0.14.0（`features.includes('keybindings')` gate）
> 关联：AGENTS.md §5.1、`src/client/keybindings.ts`、`src/client/builtins/keybindings.ts`、`src/client/search-keys.ts`、`src/client/menu-keys.ts`、`src/client/PlusMenu.tsx`、`src/client/hotkeys.ts`

## 1. 动机

侧边栏此前只有 4 个硬编码的面板开关（`hotkeys.ts` 的 ⌘B / ⌘J / ⌘⇧J / ⌘⌥B），没有给插件注入快捷键的扩展点；文件搜索框与 + 菜单完全依赖鼠标。目标（用户需求）：

- 一套**统一的快捷键处理**（类似 VSCode 命令/键位系统，但刻意更简单）；
- 给插件一个**注入点**：`ctx.betterSidebar.registerKeybinding(...)`；
- **键盘优先的用户可见内容**：文件搜索（↑↓ 高亮 / Enter 打开 / Esc 清除）与 + 菜单（1-9 与首字母选择）；
- 在 + 菜单每行名称右侧渲染一个 **「数字/字母」合并 chip**（如 `4/T`），让快捷键肉眼可见。

## 2. 设计

### 2.1 单一分发器（one boss）

`KeybindingRuntime`（`keybindings.ts`）：一个 document-capture keydown 监听；内置快捷键与插件注册共用它。命中即消费（preventDefault + stopPropagation）；`run` 返回 `false` 显式放行给下一个匹配。

- **物理键匹配**：`event.code`（键盘布局无关，延续面板快捷键的做法——US 布局 Option+B 键值为「∫」、非拉丁布局重映射键值）。
- **全局守卫**：IME 组合（复用 `ime-guard.ts` 的 `isImeComposition`）、Windows AltGr（报 ctrl+alt 不得命中 Ctrl+Alt 绑定）、自动连按（`allowRepeat` 可选放开）。
- **仲裁**：`priority` 降序，同优先级按注册顺序（稳定排序）。

### 2.2 键位语法

`+` 连接的 token：修饰符 `Cmd`（= `Command`/`Meta`/`⌘`/`Super`，匹配平台主修饰键——macOS ⌘ 或其它平台 Ctrl，二者皆可）、`Ctrl`（字面物理 Ctrl，meta 必须不存在）、`Alt`（= `Opt`/`Option`/`⌥`）、`Shift`；键部分：字母 / 数字 / F 键 / 方向键 / 命名键 / 标点 / 显式 `KeyboardEvent.code`（`KeyP`/`Digit1`/`Numpad4`，归一化为真实 code 大小写）。`Cmd+1` 这类主修饰键和弦 = 键盘布局无关。

### 2.3 `when` 上下文

`SidebarKeybindingContext` 在每次按键时现算：`state` / `narrow` / `focusInSidebar` / `textEditing` / `plusMenuOpen` / `searchActive` / `activeTab` / `activeTabType` / `activePaneTabs`。组件通过 `keybindings.ts` 的模块级标记（`setPlusMenuOpen` / `setSearchActive` / `setSearchInputElement`）发布瞬态状态——模块级、HMR 重估时自然重置，与 store-window 模式一致。

### 2.4 内置绑定

| key | 作用 | when |
|---|---|---|
| `Cmd+B` / `Cmd+Alt+B` | 宿主左侧栏 / 右侧栏 | 恒真 |
| `Cmd+J` / `Cmd+Shift+J` | 底部面板 / 最大化 | `!narrow` |
| `Cmd+P` | 快速打开：展开面板 → 保证文件窗口 → 聚焦搜索 | `!textEditing && !plusMenuOpen` |
| `Cmd+F` | 聚焦文件搜索 | 活动 tab 是文件窗口，且 `!textEditing && !plusMenuOpen` |
| `Cmd+Tab` / `Cmd+Shift+Tab` / `Cmd+1…9` / `Cmd+W` / `Cmd+Shift+W` | 标签切换 / 跳转 / 关闭 | `focusInSidebar && !plusMenuOpen` |

`Cmd+Shift+W` 与 `Alt+W` 是 `Cmd+W` 的 `builtin:tab-close-active-alt` 别名（同一 `closeActiveTab` 动作，键位集合 `['Cmd+Shift+W', 'Alt+W']`）：桌面壳的应用菜单若在**主进程**注册了 `Close Window`（⌘W）accelerator，macOS 菜单 key equivalent / Electron accelerator 会在 keydown 到达页面之前消费掉和弦——渲染层任何监听都收不到，`Cmd+W` 绑定自然无法命中。别名给「焦点在侧边栏时 ⌘W 关闭当前 tab」提供壳不占用的和弦；壳侧去掉该 accelerator（或 `before-input-event` 转发给页面）后 ⌘W 即恢复同一语义，两者共享 `focusInSidebar && !plusMenuOpen` 门与「无活动 tab 时放行」的语义。**⌘⇧W 只覆盖 Electron 壳；`Alt+W`（浏览器端唯一能到页面的成员——Edge/Chrome/Safari 把 ⌘W 与 ⌘⇧W 都保留在浏览器层）已暂停**：桌面 ⌘W 认领通道上线后键位数组中 `'Alt+W'` 被注释（2026-08-28），纯浏览器部署需要关 tab 快捷键时取消注释即可。

**桌面壳的主进程认领路径（v0.17.0+，与绑定互斥共存）**：DSH Desktop 壳侧已交付 `ctx.desktopShortcuts` ShortcutRouter（`window.ts` 拦截 ⌘W 先 `route('cmd-w')`，无人认领才走确认关窗）。插件 host 半经 `registerDesktopShortcutClaim`（`src/desktop-cmdw.ts`）注册认领，经 `/sidebar/ws/cmd-w` 问渲染层：视图用与绑定**同一份** `buildKeybindingContext`（自 `index.tsx` 抽出至 `keybindings.ts`，本设计「单一 context 源」原则的延伸）判定 `focusInSidebar && !plusMenuOpen && 有活动 tab`，另加 `document.hasFocus()` 焦点窗口守卫；认领即按同路径 `sessionScopeOf` + `closeTab` 关当前 tab，窗口不关。壳拦截时渲染层收不到 keydown（只有认领路径生效），壳不拦截时 host 路由从不触发（只有绑定路径生效）——两条路径天然互斥，不会双关。详见 `docs/plans/2026-08-28-desktop-cmdw-shortcut-design.md`。

`focusInSidebar` 门是有意为之：避免在会话编辑区吞掉 Ctrl+Tab / Ctrl+W 等宿主键。面板开关从 `hotkeys.ts` 迁入注册表（`panelToggleBindings` 工厂，`registerPanelHotkeys` 作为兼容包装保留，纯 `matchPanelHotkey` 与既有测试原样）。

### 2.5 键盘优先的界面

- **文件搜索**（`search-keys.ts` 纯决策 + `TreePanel`）：↑↓ 高亮环绕、Enter 打开、Esc 清查询（空查询失焦）、IME 让位；高亮行 `css.editorSearchResultActive` + 导航提示行。`visible` 的 TreePanel 才注册为全局聚焦目标（隐藏 tab 的 dock 面板不得抢 ⌘P/⌘F）。
- **+ 菜单**（`menu-keys.ts` 纯映射 + `TabBar` 键盘层）：1-9（0=第10项，禁用项自动顺延）、字母键选择（字母键取自**稳定 id**：`terminal`→T、`git`→G——与标签语言无关，中文标签同样生效；同字母连按循环）、↑↓ / Home / End 移动高亮、Enter 确认、Esc 关闭。菜单本体保持 primitives `Menu` 的原始观感，每行 label 包一层 flex 注入单个「数字/字母」合并 chip（如 `4/T`；父行拉伸时 space-between 推到行右缘），底部另有提示行。

## 3. 注入点

`ctx.betterSidebar.registerKeybinding(descriptor)` + `getKeybindings()`，能力清单新增 `'keybindings'`。服务工厂第三参接收共享运行时（生产传共享实例；无传入时自建私有运行时，API 仍可全量测试）。

## 4. 实施偏差记录

- 初版把 + 菜单键盘层放在 primitives `Menu` 上（footer 提示行方案）；首版 chip 尝试自绘 `PlusMenu` portal 下拉（其行内 CSS 哈希不可右对齐），用户反馈「整体 UI 风格保持之前那样」后**回退为 primitives `Menu`**：chip 经 label ReactNode 注入行内（`menu-keys.ts` 的 `plusMenuDigit` / `plusMenuLetterOf` + `sidebar.module.css` 的 `.menuOptionLabel` 系列）。
- 首字母 chip 初版取自**标签**首字母——中文标签（终端/任务管理）取不到字母，用户要求「term 就是 4/T」；改为取自**稳定 id**（`plusMenuLetterOf`），类型匹配同步改为按字母键（`menuLetterMatches` 比对 `option.letter` 而非 label 前缀）。
- `run` 回调签名定为 `(event, context)`：运行期分支（如 ⌘F 判定活动 tab 类型）需要 context，`when` 谓词在 run 前算好一次、直接传入，避免重复推导。
- 版本随功能 bump 至 v0.14.0（package.json / dsh.plugin.json / `SIDEBAR_SERVICE_VERSION` 三处 lockstep，测试守护）。
