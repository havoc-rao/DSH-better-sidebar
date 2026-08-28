# ⌘W 桌面快捷键认领通道设计（desktop-shortcut claim channel）

**日期**：2026-08-28
**状态**：已实施
**作者**：DSH 工程模式会话
**当前版本**：v0.17.0（main）
**关联**：`src/desktop-cmdw.ts`（host）、`src/client/cmd-w.ts`（client）、`src/cmd-w-wire.ts`（共享 wire）、`src/index.ts` / `src/client/index.tsx`（接线）、`src/client/keybindings.ts`（共享 context 构建器）

## 1. 背景与问题

DSH Desktop（Electron 套壳）的应用菜单在主进程注册了 `Close Window`（⌘W）accelerator。macOS 菜单 key equivalent / Electron accelerator 在 **keydown 到达渲染进程之前**消费掉和弦——渲染层任何监听（document-capture 也包含）都收不到这个按键，所以侧边栏内置的 ⌘W 绑定（`builtin:tab-close-active`，`focusInSidebar && !plusMenuOpen` 门控）在桌面壳里永远不会触发，⌘W 总是关掉整个 Electron 窗口。

**壳侧（已完成，另行交付）**：Electron 主进程新增 `ShortcutRouter`（`ctx.desktopShortcuts`，boot 前安装到 electron profile 的 Cordis ctx）——`window.ts` 拦截 ⌘W 后先 `route('cmd-w')`：有人认领 → 窗口不动；无人认领/处理器抛错 → 维持原有确认对话框。`route()` 返回 `Promise<'claimed' | 'unclaimed'>`。壳侧同时确认：**⌘⇧W 从未被拦截**，渲染层今天就能收到。

本设计解决**插件侧消费**：让侧边栏在「⌘W 本应被内置绑定消费」的时机认领这个和弦——窗口不关、改为关闭当前活动 tab。

## 2. 约束与取舍

- **渲染层无法直接拦截 ⌘W**（主进程先消费）——认领必须走壳的 host 服务，不能在渲染层做。
- **认领裁决必须发生在渲染层**：`focusInSidebar` / 活动 tab / + 菜单状态只有渲染层知道（`document.activeElement` + store snapshot），host 半不知道。
- **不能改壳、不能加 preload/IPC**：壳侧已交付的 `ctx.desktopShortcuts` 是主进程 Cordis 服务，插件 host 半同 ctx 可直接消费；host↔渲染层的问答走**插件自有 WS 通道**（`/sidebar/ws/cmd-w`），复用仓库既有的升级路由模式（`/sidebar/ws/agent-opens` 同款），零壳侧改动。
- **无壳服务时行为零变化**：`ctx.desktopShortcuts` 缺失（纯浏览器 / 旧壳 / 其它套壳）→ host 不注册 → 通道闲置不用 → 渲染层自己的 ⌘W 绑定与 ⌘⇧W 别名照旧工作。
- **单实例语义**：⌘W 与桌面认领路径天然互斥——壳拦截时渲染层收不到 keydown（只有认领路径生效）；壳不拦截时 host 路由从不触发（只有绑定路径生效）。两条路径共用同一份 `closeActiveTab` 判定/动作源（`buildKeybindingContext` / `sessionScopeOf` / `closeTab`），不会双关。

## 3. 协议（`src/cmd-w-wire.ts`）

`/sidebar/ws/cmd-w`，JSON 帧：

| 方向 | 帧 | 说明 |
|---|---|---|
| host → 视图 | `{ type: 'cmd-w', id }` | 一轮仲裁广播；`id` 为该轮的 nonce |
| 视图 → host | `{ type: 'cmd-w-reply', id, claimed }` | 视图**总是**应答（认领与否）——host 在首个认领 / 全部否认 / 超时三种情况下结轮 |

- 通道**页面级、与会话无关**：视图收到请求时按**当刻** store snapshot 裁决（切会话无需重连）。
- 视图**总是回帧**：host 的「全部否认才 unclaimed」语义依赖每个视图应答；沉默只会拖到超时。
- 恶意/畸形帧：`parseCmdWFrame` 双侧校验，非本通道帧一律丢弃。

## 4. Host 侧（`src/desktop-cmdw.ts`）

- `CmdWChannel`：视图注册表 + 仲裁器。
  - `attach(ws)`：注册视图（message/close/error 监听一次装好），返回 disposer；close/error 自动摘除。
  - `route()`：无视图 → 立即 `'unclaimed'`（壳走原有确认对话框）；否则广播请求帧，首个 `claimed: true` 获胜，全部否认 → `'unclaimed'`，`CMD_W_REPLY_TIMEOUT_MS`（500ms；本地往返几毫秒，上限只兜渲染层失联）→ `'unclaimed'`。**永不 reject**——route 必须给壳一个裁决。
  - 仲裁中某个视图断开：`dropSocket` 把它从在途轮次剔除，不拖垮结轮。
- `registerDesktopShortcutClaim(ctx, channel)`：`ctx.get?.('desktopShortcuts')` 特性探测；无服务 / register 抛错 → **严格 no-op**（日志 + 返回空 disposer），绝不让壳的异常拖垮插件加载。
- 结构型 `DesktopShortcuts` 接口：只声明消费面（`register(shortcut, handler)`），不 import 壳的类型。

## 5. Client 侧（`src/client/cmd-w.ts`）

- `shouldClaimCmdW(context, hasFocus)`：**纯判定** = `hasFocus && focusInSidebar && !plusMenuOpen && activeTab !== null`。
  - `focusInSidebar && !plusMenuOpen && 有活动 tab` = 内置 ⌘W 绑定的 when 子句——**同一份 context**（`buildKeybindingContext`，从 `index.tsx` 抽出到 `keybindings.ts`），判定永不与绑定漂移。
  - `hasFocus`（`document.hasFocus()`）是桌面路径特有的补充：keydown 路径隐含焦点窗口，路由路径可能问到一个失焦窗口——只有焦点窗口的视图可认领（多窗口壳安全）。
- `claimCmdW(ctx, store, service, id)`：认领即 `sessionScopeOf` + `service.closeTab(active.id, scope)`（与内置绑定**完全相同的关闭路径**，onClose 回调 scope 一致）；总返回应答帧（认领与否）。
- `attachCmdWClaim(ctx, store, service, opts?)`：页面级单 socket（不随 session/面板开合重连），重连策略照 `/sidebar/ws/agent-opens`（2s 退避、4 次上限）。`opts.createSocket` 测试注入点。
- 接线在 `index.tsx` apply（`ctx.effect`，HMR-safe）：`buildKeybindingContext` 同时喂给 `KeybindingRuntime` 与认领判定。

## 6. 接线（`src/index.ts`）

- 新增升级路由 `/sidebar/ws/cmd-w`（trust fence 与其它路由一致；不需要 sessionId——裁决是页面级的）。
- `ctx.effect(() => registerDesktopShortcutClaim(ctx, cmdWChannel))`。
- teardown 关闭 `cmdWss`。

## 7. 与既有键位的分工

| 环境 | ⌘W 路径 | ⌘⇧W（v0.17.0 别名） | ⌥W（v0.17.0+ 浏览器安全别名） |
|---|---|---|---|
| 纯浏览器（Edge/Chrome/Safari） | **浏览器保留键**（关标签页），页面收不到——无解 | **浏览器保留键**（关窗口/退出整个应用），页面收不到——无解 | **已暂停（注释保留）**：唯一能到页面的 W 和弦，桌面 ⌘W 认领上线后停用；取消 `'Alt+W'` 注释即恢复浏览器端的关 tab 快捷键 |
| DSH Desktop（有 `desktopShortcuts`） | **壳拦截 → host 路由 → 视图认领 → 关当前 tab**；侧边栏不认领时壳维持确认对话框 | 渲染层绑定（壳从不拦截） | 渲染层绑定 |
| 其它 Electron/WebView 壳（无服务） | 壳菜单行为（不可控）；若壳不注册 ⌘W accelerator，则同「纯浏览器」 | 视壳而定（多数壳不拦截） | 渲染层绑定 |

> 教训（2026-08-28 修订）：⌘⇧W 并非「浏览器兜底」——Edge/Chrome 把它保留为「关闭所有窗口/退出应用」、Safari 保留为「关闭窗口」，页面同样收不到；`builtin:tab-close-active-alt` 的键位集合由此定为 `['Cmd+Shift+W', 'Alt+W']`：⌘⇧W 覆盖 Electron 壳，⌥W 覆盖浏览器（也同时覆盖壳，双保险）。

## 8. 已知边界

- **多窗口壳**：`route()` 广播给所有已连接视图，首个认领取胜；`document.hasFocus()` 保证只有焦点窗口视图会认领。壳侧 route 目前不携带窗口身份（`route()` 无参），若未来出现多窗口 + 多侧边栏同时可见的场景，需壳侧传入 webContents 身份后再按窗口定向。
- **渲染层未加载/失联**：无视图可答 → 超时/无视图 → `'unclaimed'` → 壳维持确认对话框（行为与未装插件一致）。
- **Global 页面/无会话**：`activeTab` 为空 → 否认。

## 9. 测试

- `tests/desktop-cmdw.spec.ts`（node）：fake socket 驱动仲裁——无视图立即 unclaimed、认领获胜、全否认、首认领胜 + 陈旧回复忽略、超时兜底、中途断连不拖垮、detach 生效；注册器特性探测与异常降级。
- `tests/cmd-w.spec.tsx`（jsdom）：`shouldClaimCmdW` 五向判定；`claimCmdW` 认领即关 tab / 失焦否认无副作用 / + 菜单打开否认 / 无会话否认；`attachCmdWClaim` 链接——端点连接、应答、畸形帧忽略、重连与 dispose 停连。

## 10. 实施偏差记录

- 初稿在 `desktop-cmdw.ts` 里误引了不存在的 `traverseFrames` 导出，即时清理；wire 校验统一由 `parseCmdWFrame` 承担。
- `scopeOf` 从 `builtins/keybindings.ts` 上移到 `keybindings.ts` 并改名 `sessionScopeOf`（keybindings 模块作为两块共享源：context 构建器 + scope 助手，`builtins/` 与 `client/cmd-w.ts` 都从这里取）。
- 通道未做 capability 路由（如 `desktop.cmdw` 查询）：始终连接，闲置开销可忽略，与 `agent-opens` 连接时机策略一致。