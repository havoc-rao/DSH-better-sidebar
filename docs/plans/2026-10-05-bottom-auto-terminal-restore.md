# 底部面板首展自动终端回归（bottomPanelAutoTerminal 死开关复活）

**日期**：2026-10-05
**状态**：已实现
**关联**：v0.21.x 线（0.1.6 终端让渡）→ 当前 dev 树（终端 tab 回归底部工作台）

## 1. 背景

用户反馈「底部的 box 打开时，默认会打开一个 term」——这正是 v0.19.1 及更早版本里
`bottomPanelAutoTerminal`（默认开）的行为：**每次会话中底部面板首次展开时，尝试在底部
工作台自动打开一个新终端 tab**。该行为在 0.1.6 适配的终端让渡（5912274，`feat: yield the
terminal and browser to DSH 0.1.6's own sidebar types`）中被连同整个插件终端栈一起删除；
之后终端 tab 随 bottom-workbench 回归（`builtins/tabs.tsx` 重新注册 `terminal` 类型），
但首展自动开终端的 effect 没有一起回来——留下了：

- `prefs-shared.ts` 的 `bottomPanelAutoTerminal`（默认 `true`）；
- `config.ts` 的 schema 声明；
- `tabs.tsx` 设置页的开关行 + 20 份词典的 `settingsBottomTerminalTitle/Desc`；
- `smoke.spec.ts` 的设置回写断言。

即一个**永不生效的死开关**：打开底部面板只会看到欢迎卡片。

## 2. 改动

### 2.1 `src/client/state.ts` — 恢复 `bottomOpenedOnce`

- `SidebarState` 恢复 `bottomOpenedOnce: boolean`（首次展开即置位，之后不再重复）；
- `makeDefaultState()` 默认 `false`；
- `sanitizeState()` 恢复 `record.bottomOpenedOnce === true`——旧存档没有该字段 → 默认
  false → **升级后仍有一次首展机会**（与 0.1.6 前注释语义一致）。

### 2.2 `src/client/Sidebar.tsx` — 恢复首展 effect

`bottomWasOpenRef`（false→true 转变检测，面板持久化为开不算展开）+ effect：

1. 转变检测：`wasOpen === undefined || wasOpen || !state.bottomOpen` → 不触发；
2. `bottomOpenedOnce` 已置位 → 不触发；
3. `bottomPanelAutoTerminal === false` → 不触发（门控**先于**置位返回，会话内重新打开
   开关后下一次展开仍有一次机会）；
4. `isTabEnabled('terminal') === false` → 不触发（同上；显式门控避免 `openTab` 的
   warn 噪音）；
5. 原子置位 once 标志 + `openTab({ type: 'terminal', target: 'bottom' })` 落底部工作台
   首 pane；终端配额（`TERMINAL_LIMIT`）由真实描述符的 `createTab` 返回 null 拒绝——
   「尝试」语义：配额满时置位照常进行，**本次会话不再重试**。

### 2.3 `tests/bottom-auto-terminal.spec.tsx` — 恢复 + 适配

按 5912274 删除前的版本恢复（同名文件，plan 文档里的引用继续有效），按现行 harness
适配：

- `setupReactAct()` / `test-utils.ts` 共享助手；
- 去掉已不存在的 `toggleBottomMaximized` 用例（全屏已改为局部 `fullscreen` flag）；
- stub `fetch`（jobs 基线轮询不得打真实网络）；
- 新增配额满置位单测（首次展开被拒后，关闭 tab 再展开也不再触发——把一次机会钉住）。

## 3. 与旧实现的差异（实施偏差记录）

| 维度 | 旧实现（v0.19.1） | 本次恢复 |
|---|---|---|
| `narrow` 守卫 | 有（窄视口两工作台合并为抽屉，无底部面板） | **无**——移动端抽屉布局早已退役，底部工作台所有视口宽度都存在 |
| open 目标 | `openTab({ type: 'terminal' })`（旧服务默认落底部） | `openTab({ type: 'terminal', target: 'bottom' })`——现服务默认落宿主原生右侧栏，显式 bottom 才落底部工作台 |
| 其余门控（pref / 类型禁用 / once / 配额拒绝） | 与本次逐条一致 | 一致 |

## 4. 验证

- `pnpm typecheck` 通过；
- `tests/bottom-auto-terminal.spec.tsx` 5 例全绿；
- 相关回归（state / prefs / service / builtins / desktop-shortcuts / hotkey-contract /
  orphaned-tab / sidebar-auto-activation）全绿；
- 全量 `pnpm test` 结果见会话记录（`market-manifest.spec.ts` 的 `pnpm pack` 用例在本机
  因 corepack 版本门禁（pnpm 11.7 vs 11.8）失败，与本次改动无关，CI 无此问题）。