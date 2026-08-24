# 终端体验借鉴 tabby（tabby-terminal）设计

**日期**：2026-08-24
**状态**：分析 / 待实施（本文档为借鉴分析 + 分项实施设计；各项标注优先级，可按阶段单独落地）
**参考对象**：`/Users/havoc/Documents/Projects/tools/tabby/` monorepo

> **说明**：tabby 的 xterm 使用并不在 `tabby-core` 包里——`tabby-core` 只提供 `getCSSFontFamily` / `getWindows10Build` 之类的工具与 tab 框架；真正的 xterm 前端在 **`tabby-terminal`** 扩展包：
> `src/frontends/xtermFrontend.ts`（751 行，xterm 封装）、`src/api/baseTerminalTab.component.ts`（917 行，终端 tab 生命周期）、`src/session.ts`（会话抽象）、`src/middleware/oscProcessing.ts`（OSC 52/1337）、`src/services/multifocus.service.ts` 等。本设计以 `tabby-terminal` 为实现参考，兼引 `tabby-core` 的工具函数。

---

## 1. 结论摘要（TL;DR）

| # | 借鉴点 | 优先级 | DSH 现状缺口 | 改动面 |
|---|---|---|---|---|
| A | 输出背压：慢客户端不丢数据（node-pty `pause()/resume()`） | **P0** | `bufferedAmount ≥ 4MB` 时**直接丢弃**输出（`src/index.ts` 两处） | host：`attachTerminal` / `pumpAgentTerminal` + 新背压控制器 |
| B | resize 节流：最小间隔 + trailing fit（tabby `RESIZE_MIN_INTERVAL=32`） | **P0** | ResizeObserver 每帧 `fit + sendResize` → pty `resize()` 风暴（SIGWINCH 洪水）+ 拖拽闪烁 | client：`TerminalView.tsx` 抽节流 helper |
| C | 可见性恢复：tab 重新可见时 `fit + refresh`（tabby `reactivate()`） | P1 | `visible` prop 未传给 `LazyTerminal`，TerminalView 无可见性感知；`display:none` 挂载后 WebKit 偶发空白 | client：descriptor + `TerminalView` |
| D | 输入时滚到底（tabby `scrollOnInput`）+ 上滚不被写入拉走 | P1 | 无钉底跟踪；上滚后输入不会回到底 | client：wheel capture + onData 时 `scrollToBottom` |
| E | 粘贴处理：换行归一 + bracketed paste + 多行提示（tabby `paste()`） | P1 | `onData` 原样透传，Windows 粘贴 `\n` 行为异常 | client：container 级 paste capture + 纯函数归一 |
| F | 重连后终端模式复位（tabby `resetTerminalModes()`） | P1 | 视图重挂载（会话切换）而 pty 存活时，mouse/bracketed 模式残留 → 乱码序列 | client：onopen 后发复位序列 |
| G | OSC 52 剪贴板 / OSC 7·1337 cwd（tabby `oscProcessing.ts`） | P2 | OSC 全部透传；tab 无真实 cwd（标题靠输入启发式） | host：OSC 扫描器 + 控制帧；client：剪贴板 / cwd meta |
| H | 终端内搜索（SearchAddon + decorations） | P2 | 无 | client + keybindings 协调 |
| I | Ctrl± 缩放（1.1^zoom，tabby `setZoom`） | P2 | 只有全局 `terminalFontSize` pref | client |
| J | 输出进度检测 → tab badge（tabby `detectProgress`） | P2 | 有 badge API 未用 | client |
| K | scrollback 可配置（tabby 默认 25000；DSH 硬编码 4000） | P2 | 硬编码 | client + prefs |
| L | WebGL 渲染器 + context-loss 恢复预算（tabby `recoverRenderer`） | P3 | DOM renderer（无 GPU context 问题） | 仅未来上 WebGL 时借鉴 |

**已覆盖 / 不借鉴**：见 §7、§8。

### 1.1 迁移可行性总纲（能否「直接迁移」）

**许可证**：tabby 与 `tabby-terminal` 均为 **MIT**（`tabby/LICENSE`、`tabby-terminal/package.json`），本项目亦为 MIT——**直接复制代码合法**（保留版权注记即可），无 GPL 类传染顾虑。

**架构分层**（决定「直接搬」还是「改写搬」）：

| 层 | 代表 | 迁移方式 | 理由 |
|---|---|---|---|
| 纯逻辑 / 纯数据 / 纯样式 | `generatePalette.ts`（LAB 插值生成 256 色 extendedAnsi）、`colorSchemes.ts` 色板数据、`xterm.css`（滚动条/overview ruler）、addon 官方用法（SearchAddon/Unicode11/Webgl） | **直接搬**（改依赖注入为普通函数/常量；样式颜色 token 化） | 无框架耦合、无 xterm 私有 API |
| 行为模式（xterm 封装） | FlowControl、钉底模型、resize 节流、`reactivate()`、`resetTerminalModes()`、`paste()` 归一、copyOnSelect、OSC 处理 | **改写搬**：搬语义，按 React + 公开 API 重写 | tabby 用 Angular DI / rxjs / **xterm `_core` 私有 API patch**（`_scrollToBottom` no-op、`_renderRows`、`_refresh`、`charMeasure`、`renderer._updateDimensions`）——私有 API 随 xterm 版本变动（本项目 5.5.0），直接搬必碎 |
| 框架组件 / 桌面集成 | `baseTerminalTab.component.ts`（Angular + Pug + SCSS）、`searchPanel.component.*`、`terminalToolbar.component.*`、`session.ts` / middleware（rxjs 流 + SSH 场景）、multifocus | **不搬** | 架构不符（React + CSS Modules + Cordis）；SSH 专属能力本项目无对应场景 |

「渲染展示」里**最值得直接迁移的是 `generatePalette`（extendedAnsi 256 色调色板生成）**：本项目现只有 curated 16 色 ANSI（`TerminalView.tsx` 的 `ANSI_DARK/ANSI_LIGHT`），256 色程序（htop/vim 真彩色渐进）会显示为浏览器默认阶梯色；tabby 的 LAB 空间插值可生成与当前 scheme 和谐的全色域调色板。详见 §9。

---

## 2. 现状回顾（DSH 终端全景）

- **client**：`src/client/TerminalView.tsx`（407 行）——xterm 5.5 + FitAddon over WS。
  - 重连循环（失败 3 次停 + 关码分类）、`PTY_DEPS_MISSING` 降级横幅、`openWhenSized` 延迟 open、主题令牌实时重刷、字体 pref 实时 diff、下行 title 帧拦截（`{type:'title'}`，512 字节限长）。
  - 缺口：无 `visible` 感知、无钉底/滚动策略、`onData` 原样发、ResizeObserver 直连 `fit+sendResize`、无粘贴处理、无 OSC 处理、scrollback 硬编码 4000。
- **host**：`src/pty-manager.ts`（键控 pty + 1MB transcript 环 + 优雅期 + 配额 + 共享窗口）与 `src/index.ts` 的 `attachTerminal` / `pumpAgentTerminal`（transcript 回放、title 广播、resize/close 控制帧、**`bufferedAmount < 4MB` 否则丢包**）。
- 已有专项设计：`docs/plans/2026-08-14-terminal-open-when-sized-design.md`（零尺寸 open 崩溃）、`2026-08-14-terminal-font-design.md`、`2026-08-19-global-shared-terminal-design.md`。

---

## 3. P0 稳定性项

### 3.1 A. 输出背压：慢客户端不丢数据

**借鉴点**：tabby `FlowControl`（`xtermFrontend.ts` L29–63）用 xterm `write()` 回调计数 + 高低水位暂停后续写入——核心意图是**背压而不是丢数据**。DSH 架构不同（WS → node-pty），更贴合的实现是 node-pty 官方背压：`IPty.pause()` / `IPty.resume()`（node-pty ≥1.0，本仓库 `^1.1.0` 已含，见 node-pty.d.ts L189/L194）。xterm.js 官方 demo 对 WS 场景用的就是同一模式。

**现状缺陷**：`attachTerminal` / `pumpAgentTerminal` 的 `onData` 里 `bufferedAmount < 4 * 1024 * 1024` 才 `send`，超限**静默丢弃**。`cat` 大文件 / `make -j` / `npm run build` 长输出时：用户看到截断输出，且丢弃段在 transcript 回放（1MB 环，头丢尾留）与实时流之间产生**不一致**——同一段历史重连后可能「回来」，当下却「没有」。

**设计**：
1. 新模块 `src/backpressure.ts`（纯逻辑，可单测）：`BackpressureController`，管理「阻塞 socket 计数 + pause/resume 回调注入」的状态机：
   - `notifySocketBlocked()` / `notifySocketDrained()`（每个 socket 自己的布尔态，供多 socket 共享 pty 用）；
   - 任一 socket 超高水位 → `pause()`（阻塞全体——共享终端语义下保数据优先，1MB 高水位足够大，误伤罕见）；
   - 所有 socket 都低于低水位（或全部 drained）→ `resume()`。
2. `attachTerminal` / `pumpAgentTerminal`：
   - `wss` 构造时给 `highWaterMark`（ws 选项，如 `1 << 20`），`onData` 里 `ws.bufferedAmount > HIGH_WATERMARK` → `controller.notifySocketBlocked(ws)` + `handle.pty.pause()`；
   - `ws.on('drain')` → `notifySocketDrained`，全清后 `handle.pty.resume()`；
   - 移除 4MB 直接丢弃分支（低水位防抖，如 256KB，避免抖动）。
3. transcript 环照常（`pause()` 期间无 onData，transcript 暂停增长——1MB 上限本就截断历史，可接受）。

**风险与验证**：
- Windows ConPTY 下 `pause()/resume()` 的行为需实测（node-pty 文档未承诺全平台语义）。验证步骤：Windows + 大输出（`Get-Content big -Raw | Out-Host`）→ 确认无截断、无死锁。若 ConPTY 下无效，退化为「提高丢弃水位 + 记 `console.warn` 计数」并在此文档记录偏差。
- `resume()` 后程序可能一次性吐回大量积压——低水位触发时点尽量贴近 drained 即可，xterm 侧 WriteBuffer 兜底。

**测试**：`BackpressureController` 状态机单测（单/多 socket 阻塞、抖动、resume 幂等）；`attachTerminal` 层集成测试可注入假 pty 断言 pause/resume 调用序。

### 3.2 B. resize 节流 + trailing fit

**借鉴点**：tabby `xtermFrontend.ts` L246–274（`RESIZE_MIN_INTERVAL = 32`，窗口 resize + ResizeObserver 都走同一节流器，trailing rAF 执行），并在 fit 后显式 repaint 防拖拽白帧（L238）。

**现状缺陷**：`TerminalView.tsx` 的 ResizeObserver 每次回调同步 `fit.fit() + sendResize()`。面板拖拽调宽 / 窗口 resize 时每帧触发 → pty 侧 `resize()` 风暴（shell 收到 SIGWINCH 洪水，重程序如 vim/less 会抖动）+ 拖拽期间逐帧重排闪烁。

**设计**（client 端即可，host 无需改）：
- 新 helper `src/client/throttled-fit.ts`：`throttledFit({ host, term, fit, sendResize, minInterval = 32, raf, now })` → 返回 `() => void`（cancel）。
  - 调用窗口内只记 pending；到点后 rAF 执行一次 trailing `fit + sendResize`；间隔足够则立即执行。
  - fit 后 `term.refresh(0, term.rows - 1)`（公开 API）强制重绘，闭合 tabby 用私有 `_renderRows` 堵的「拖拽白帧」。
- `TerminalView` 的 ResizeObserver 回调与字体 diff 里的 `fit` 都改走该节流器；`openWhenSized` 的 open 回调保持立即 fit（首次打开要准）。

**测试**：注入假时钟/rAF 单测——密集触发只执行 trailing 一次；间隔足够逐次执行；cancel 后不执行；最终尺寸正确。

---

## 4. P1 稳定性 / 体验项

### 4.1 C. 可见性恢复（tabby `reactivate()` 轻量版）

**借鉴点**：tabby `reactivate()`（L676–692）在 tab 重新可见时清陈旧渲染态 + 强制重绘（WebGL 场景还带 context 恢复预算）。

**现状**：terminal 描述符的 `component` 没把 `visible` 传给 `LazyTerminal`（`tabs.tsx` L273），TerminalView 无可见性感知。非激活 tab 靠 `.paneTabHidden { display:none }` 保持挂载、面板折叠靠 `.panelHidden`——`display:none` 期间的画布在 WebKit 重显时偶发空白（与 issue #25 同源的零尺寸/隐藏渲染问题）。

**设计**：
- `TerminalViewProps` 加 `visible: boolean`；descriptor 传入 `visible`。
- TerminalView 内 `useEffect` 监听 `visible` 翻转为 true：`try { fit.fit(); term.refresh(0, term.rows - 1) } catch {}`（复用字体订阅同款 try/catch 模式）。
- 无需触碰 `openWhenSized`：open 只发生一次，visible 恢复只做 refresh。

**测试**：组件测试——`visible` 翻转 true 时 fit/refresh 桩被调；false 时不调；翻转前 open 未完成时安全 no-op。

### 4.2 D. 输入时滚到底 + 上滚不被拉走

**借鉴点**：tabby 的钉底模型（L204–213 注释、L290–297、L451–470）——**不用 `onScroll` 判钉底**（xterm #3864/#3201：`onScroll` 只在内容驱动滚动时触发，快速输出时 `viewportY` 瞬态等于 `baseY` 会假钉底）；用 wheel/keyboard capture 判 unpin，写完后 pinned → 强制到底 / unpinned → 恢复 `viewportY`；`scrollOnInput`（config 默认 true）输入时滚到底。

**现状**：DSH 无任何滚动策略。xterm 5.5 默认行为是「上滚后写入不抢滚」（好消息，基本满足不拉走），但**上滚后输入不会回到底**（用户敲命令看不到回显，只能手动滚）。

**设计**（简化版，不碰 xterm 私有 API）：
1. host 容器 capture `wheel`（passive）：`deltaY < 0` → 标记 `pinned = false`；`deltaY > 0` 且在底部 → rAF 里置 `pinned = true`。
2. `onData`（输入）时若 `!pinned` → `term.scrollToBottom()`（对应 tabby `scrollOnInput`）。
3. 不做 `viewportY` 写入后恢复（xterm 5.5 已稳定保持上滚位置，避免为对齐 tabby 的私有 patch 而引入复杂度）。

**测试**：行为级组件测试（jsdom 桩 wheel/onData，断言 scrollToBottom 调用与否）；钉底状态机抽纯逻辑可单测。

### 4.3 E. 粘贴处理

**借鉴点**：tabby `paste()`（`baseTerminalTab.component.ts` L523–573）：换行归一（Windows `\r\n`→`\r`，其余 `\n`→`\r`）、`trimWhitespaceOnPaste`、`warnOnMultilinePaste`、bracketed paste 包裹（`\x1b[200~…\x1b[201~`，仅当 `bracketedPasteMode` 激活）。

**现状**：`TerminalView` 的 `onData` 原样发 socket。粘贴经 xterm 隐藏 textarea 走 `onData`，多行内容带 `\n`——Windows 下部分 shell 行为异常；无 bracketed paste（`vim` 粘贴缩进乱、括号自动补全干扰）。

**设计**（container 级拦截，不依赖 xterm 内部 textarea）：
- 新纯函数 `src/client/terminal-paste.ts`：`normalizePastedText(text, { platform, trimEnd, warnMultiline })`——`\r\n|\n` → `\r`（对齐 tabby），可选尾/首 trim，返回 `{ text, multiline }`。
- TerminalView 在 host 容器挂 capture `paste`：`event.clipboardData.getData('text/plain')` → 归一 → bracketed 包裹（bracketed 开关默认开，包裹条件「shell 支持」的探测：xterm 5.5 的 `bracketedPasteMode` 公共 API 需确认——tabby 用 `xterm.modes.bracketedPasteMode`（5.4 私有）。**兜底**：不做模式探测、默认包裹不可取（不支持的 shell 会显示 `[200~` 垃圾）。若 5.5 无公共探测，方案退化为「仅换行归一 + 多行确认提示」，bracketed 列为后续项）→ `socket.send`（OPEN 时）→ `event.preventDefault()`（阻止 xterm textarea 二次触发 `onData` 造成重复发送）。
- 多行提示：对齐 tabby `warnOnMultilinePaste`，用原生 `confirm` 或 sidebar 内联提示（沿用现有 banner 风格），P1 内可选。

**测试**：`normalizePastedText` 纯函数单测（三平台换行、trim、空串、中文/emoji 保真）；组件测试模拟 paste 事件断言 socket 载荷与 preventDefault。

### 4.4 F. 重连后终端模式复位（tabby `resetTerminalModes()`）

**借鉴点**：tabby `xtermFrontend.ts` L476–483：会话重连时写 `\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l`（关 mouse tracking 三档 + SGR mouse + bracketed paste），防止陈旧模式把转义序列当文本漏进屏幕。

**现状缺口**：TerminalView 的 effect 在 `[scope.sessionId, scope.cwd, tabId, store]` 变化时整体重跑——会话切换回来 = **新 xterm 实例挂到存活 pty**（reconnect grace 保住了进程）。若 pty 侧程序（vim/tmux 开了 mouse）在断开期间持续发 SGR mouse 序列，transcript 回放与实时流都会把 `\x1b[<0;5;10M` 之类渲染成乱码——新 xterm 不知道这些模式开着。

**设计**：TerminalView `socket.onopen` 后（或 effect 内 mount 完成时）把上述复位序列作为**输入**发往 pty（`socket.send('\x1b[?1000l…')`）。新 spawn 的 shell 无这些模式，序列是 no-op；重连场景下清掉残留。干扰面：vim 正在 mouse 模式下时收到 disable——vim 属「模式驱动方」，交互时会重新 setmode，风险低（tabby 同样无条件发）。可加 pref 开关（`terminalResetModesOnAttach`，默认开）。

**测试**：组件测试断言 onopen 后首条输入载荷包含复位序列；pref 关闭时不发。

---

## 5. P2 体验增强项（简列）

### 5.1 G. OSC 52 剪贴板 / OSC 7·1337 cwd
- 借鉴 tabby `oscProcessing.ts`（L66–88）：扫描输出流中的 `\x1b]…\x07|\x1b\\`。
- host 侧新 `src/osc.ts` 纯 parser（注意 **WS 帧可任意切分 OSC**——必须跨帧缓冲，tabby 的 `buffer` 拼接同款）：`OSC 52;c;<base64>` → 控制帧 `{type:'clipboard', text}`（client 用 `writeClipboard`）；`OSC 7;file://<host><path>` / `OSC 1337;CurrentDir=<path>` → 控制帧 `{type:'cwd'}` → client `updateTab(tab.id, { meta: { cwd } })`。非目标 OSC 原样透传且保序。
- 收益：tmux/vim 内复制可用浏览器剪贴板；tab 获得**真实 cwd**（替换输入启发式标题里的猜测成分），为「复制当前路径」「在终端目录打开文件」铺路。
- 安全：OSC 52 仅 `'c'`/`''` 目标、内容 ≤ 1MB；OSC 7 仅 `file://`。
- 测试：parser 跨帧单测（BEL/ST 终止、非目标透传保序、超长截断）。

### 5.2 H. 终端内搜索
- SearchAddon + decorations（tabby `getSearchOptions` 的 ruler/背景装饰可直接借鉴样式思路）。
- 键位协调：现有 `Cmd+F` when 为「活动 tab 是文件窗口」；扩展为「文件窗口**或终端**」→ 终端内 `search.findNext`。中等工作量，需与 keybindings 的 `focusInSidebar` 语义对齐。

### 5.3 I. 缩放 / J. 进度 badge / K. scrollback pref
- I：`zoom` 状态叠加 `terminalFontSize`（`fontSize * 1.1^zoom`，tabby `setFontSize`）；键位 `Cmd+=`/`Cmd+-`/`Cmd+0`（`focusInSidebar` gate，避免吞宿主键）。
- J：host 透传输出中匹配 `(\d+)%`（非 alternate screen 时，tabby `writeRaw` L508–518）→ 控制帧 `{type:'progress'}` → `badge` 回调显示百分比（v0.12.0+ badge API 现成）。注意 alternate screen（进度条应用如 curl/wget 常驻 alternate）时清零。
- K：`scrollback: 4000` 硬编码 → `SidebarPrefs.terminalScrollback`（min/max 钳制，如 500–100000，默认 4000 或对齐 tabby 25000）；prefs schema 增加字段 + `settings.pluginToggles` 行（宿主 schema 需同步，参考 terminalFontSize 的处理）。

---

## 6. P3 可选：WebGL 渲染器 + context-loss 恢复

- tabby `xtermFrontend.ts` L694–741 的完整方案：`WebglAddon` + `onContextLoss` → dispose → 恢复预算（`MAX_WEBGL_RECOVERY_ATTEMPTS = 3`）→ `focus`/`reactivate` 时重试 → 预算耗尽回落 DOM renderer。
- **DSH 现状是 DOM renderer（无 GPU context 丢失问题），本项不适用**。仅当未来为性能引入 WebGL 时，把「恢复预算 + 可见/聚焦时重试 + 耗尽回落」整套搬过来；届时 `platformService.displayMetricsChanged$` 清纹理图集（L313–325）也一并借鉴。

---

## 7. 已覆盖 / 不借鉴清单

| tabby 实践 | DSH 现状 | 结论 |
|---|---|---|
| transcript 回放（DSH 1MB 环 + WS replay） | `pty-manager.ts` 已有 | **已覆盖**（WS 架构下优于 tabby 的 SerializeAddon 桌面恢复方案） |
| 重连优雅期 | `reconnectGraceMs`（默认 30s）+ close 帧语义 | **已覆盖** |
| 动态标题（OSC title） | 输入启发式 `digestCommandInput` | 已覆盖（可被 §5.1 的 OSC 7 增强为真实 cwd） |
| 延迟 attach（tabby 桌面时序 hack） | `openWhenSized` 设计（issue #25） | **已覆盖** |
| 降级横幅 / deps 修复命令 | `TerminalDepsBanner`（issue #140） | 已覆盖（DSH 独有） |
| `xtermCore` 私有 API patch（`_scrollToBottom` no-op、`_renderRows`、`_refresh`） | — | **不借鉴**：与 xterm 内部耦合，5.5 升级易碎；§4.2 简化版无需私有 patch |
| SerializeAddon save/restore state | transcript 环 | 不借鉴（架构不同） |
| login scripts / readline 流处理（SSH 场景） | 本地 shell | 不借鉴 |
| multifocus 广播（多窗格同步输入） | 无多窗格终端 | 不借鉴（未来若做 split 终端可回看） |

---

## 8. 分阶段实施建议

- **阶段一（稳定性，改动集中、风险低）**：A（背压不丢数据）、B（resize 节流）、C（visible refresh）、F（模式复位）。
- **阶段二（体验）**：D（滚动策略）、E（粘贴处理）、G（OSC）。
- **阶段三（可选）**：H（搜索）、I（缩放）、J（进度 badge）、K（scrollback pref）、L（WebGL）。

每项落地时：纯逻辑抽模块 + 单测；组件层改动沿用现有 `tests/*.spec.tsx` 模式（jsdom + 桩）；涉及 host 的改动注意 `tests/` 现有 pty 相关测试（`bottom-auto-terminal.spec.tsx`、`agent-terminal-reconcile.spec.ts`）不回归。

---

## 9. 「直接迁移」专项（渲染展示层）

> 针对「把 tabby-core / tabby-terminal 的渲染展示直接迁移过来」的专项清单。许可证已确认无碍（MIT→MIT，保留版权注记）。

### 9.1 M1. `generatePalette` —— extendedAnsi 256 色调色板生成（推荐，直接搬）

- **来源**：`tabby-terminal/src/generatePalette.ts`（146 行，纯函数，零依赖）：把 base16 的 8/16 色 + bg/fg 经 **LAB 空间插值**生成 xterm 256 色（16–231 色彩立方 + 232–255 灰阶），浅色主题自动反相（`harmonious` 可关）。
- **迁移方式**：整文件移植为 `src/client/generate-palette.ts`（保留 MIT 版权头），`ITheme.extendedAnsi` 挂到 `xtermTheme()`——现有 curated 16 色（`ANSI_DARK/ANSI_LIGHT`）保持不变，256 色程序获得和谐渐进色。
- **接线**：`xterm.options.theme.extendedAnsi = generatePalette(16 色, bg, fg, harmonious)`；随 scheme 翻转重算（`applyTheme` 已有订阅点）。可选 pref `terminalPaletteGenerate`（默认开）。
- **测试**：纯函数快照单测（dark/light、harmonious 开关、自定义 16 色）；与现有 `tests/theme.spec.ts` 令牌守卫并行。

### 9.2 M2. `xterm.css` 展示细节（直接搬，token 化）

- 来源：`tabby-terminal/src/frontends/xterm.css`（19 行）：`.xterm-viewport` 滚动条（webkit）与 `.xterm-decoration-overview-ruler`（搜索 overview ruler 不挡交互）。
- 迁移：滚动条颜色改走语义令牌（DSH 皮肤契约 §8 禁止硬编码——tabby 的固定 rgba 换成 `--dsw-alias-*` 派生值或现有 CSS 变量），ruler 定位规则直接搬。放入 `sidebar.module.css` 或独立 `terminal.css`。

### 9.3 M3. addon 官方用法（直接搬，一行级）

- `Unicode11Addon`（`term.unicode.activeVersion = '11'`）：增强宽字符/emoji 宽度处理，`loadAddon` 一行 + 一个依赖。
- `SearchAddon`：官方公开 API，搜索高亮/装饰直接可用；UI（输入框/结果导航）按 React 重写，参考 DSH 文件搜索框的键盘优先模式（`search-keys.ts`）——对应 §5.2 H。
- `WebglAddon`：见 §6 L——需要连带迁移 context-loss 恢复预算模式，非「一行级」，列为可选。

### 9.4 M4. 配色方案选择器（不整套迁移）

- tabby 的 `colorSchemes.ts` / `colorSchemeSelector` / `colorSchemeSettingsForMode` 是**独立于主题的 scheme 系统**（用户可在终端内选任意色板）。DSH 走令牌驱动（AGENTS.md §8：终端表面跟随皮肤，无每皮肤适配）——引入独立 scheme 选择器会**破坏皮肤一致性契约**（用户选的自定义背景会与皮肤玻璃/不透明规则冲突，issue #90 的防护是全局的）。
- 结论：**只迁 M1 的生成算法（在当前令牌 16 色之上扩展 256 色），不迁 scheme 选择 UI**；若未来要「终端专属色板」能力，再单独立项评估与 `--dsw-alias-bg-base` 防护的交互。

### 9.5 M5. 不迁移清单（重申）

- xterm `_core` 私有 API patch、Angular/Pug/SCSS 组件、rxjs 流、SSH 专属 middleware（login scripts / readline / zmodem）、桌面端集成（通知 / hostWindow / 原生剪贴板同步）。

### 9.6 落地顺序

M1（纯函数 + 快照测试，独立可合）→ M2（样式，独立可合）→ M3 SearchAddon（依赖 H 的 UI 重写）→ M4 不实施。

---

## 10. 实施记录（2026-08-24）

已完成：M1（extendedAnsi 调色板）、M2（xterm.css 细节）、阶段一 A/B/C + F（模式复位）。

**M1 generatePalette**：按设计实施，一处偏差——**未加 `terminalPaletteGenerate` pref**（保持常开）。理由：生成的 256 色在构造上就是与当前 scheme 和谐的（LAB 插值自 curated 16 色 + bg/fg），无用户可见的退化场景；pref 会增加宿主 schema 表面（prefs-shared + settings 行），收益不成比例。文件：`src/client/generate-palette.ts`（移植 + MIT 版权注记）、`TerminalView.tsx` 的 `xtermTheme()`、`tests/generate-palette.spec.ts`（黄金值快照）。

**A 输出背压**：实现方式与设计文档 §3.1 的初稿不同——初稿设想用 ws `highWaterMark` + `drain` 事件，**实施时发现 ws 8.x 的 `ServerOptions` 无 `highWaterMark` 类型/运行时支持，且 WebSocket 的 `'drain'` 事件只对应接收方向背压（receiver 缓冲），不反映发送缓冲**。改为**在途字节记账**（`ws.send(data, cb)` 回调计数，高低水位 1MB/256KB），这恰好是 tabby `FlowControl` 的原始形态（写回调计数），语义更精确。文件：`src/backpressure.ts`（`createPtyBackpressure`）、`src/index.ts` 的 `attachTerminal` / `pumpAgentTerminal`（transcript 回放也走记账）、`tests/backpressure.spec.ts`。4MB 直接丢包分支已移除；保留 8MB 硬顶作为 Windows ConPTY pause/resume 失效时的兜底（丢帧 + 每 socket 记一次 warn）。

**B resize 节流**：按设计实施（`src/client/throttled-fit.ts` + `TerminalView` 接线；ResizeObserver 与字体 diff 都走节流器，openWhenSized 首次 open 保持立即 fit）。细节：`last` 初始化为 `-minInterval` 保证冷启动走 rAF 快路径（测试时钟在 0 时同样成立）。fit 后追加 `term.refresh(0, rows-1)` 闭合拖拽白帧。测试 `tests/throttled-fit.spec.ts`。

**C visible 恢复**：按设计实施——descriptor 传 `visible` 给 `LazyTerminal`，`TerminalView` 经 `refreshRef` 发布刷新闭包（fit + refresh + sendResize，`term.element` 守卫），独立 effect 在 `visible` 翻转 true 时调用；不重启主 effect。

**F 模式复位**：按 tabby 原义实施（`term.write` 写进 xterm 实例自身，非 pty 输入）——在 `socket.onopen` 时写 `\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l`。新实例 no-op；复用实例清掉上一程序残留的 mouse/bracketed 模式。分析确认 DSH 的「乱码泄漏」场景比 tabby 弱（模式所有者是客户端 xterm，pty 侧不会主动发 mouse 序列），但该序列在重连路径无害且对齐 tabby 语义，保留。

**验证**：`pnpm typecheck` ✓；`pnpm test:local` 78 文件 / 831 测试 ✓（3 个环境限制文件——`agent-pty`/`smoke` 需真 PTY、`host-sidebar-keeper` 需 MutationObserver 时序——本机不适用，CI 全量跑）；`pnpm build` ✓，`lib/client-terminal.js` 内含 `extendedAnsi`/复位序列/节流逻辑与 token 化 `terminal.css`。
