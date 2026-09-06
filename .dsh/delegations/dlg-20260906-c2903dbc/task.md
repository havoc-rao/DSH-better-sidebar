# 委派任务书 · dlg-20260906-c2903dbc

| 字段 | 值 |
| --- | --- |
| 目标 | `/Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar` |
| 工作区 | `/Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar` |
| 父会话 | `session-f9af055a-f0a8-4ef1-a5bb-0676132de36e` |
| 创建时间 | 2026-09-06T18:32:12.644Z |
| 任务标题 | 任务：给 dsh-remote 插件暴露「终端传输层 slot」，让它能在完全不… |
| 超时 | 300000 ms |
| 目标会话 | `session-c44ce5a2-4f49-43cc-a389-4dbff9ae1fe7` |
| 运行 ID | `session-c44ce5a2-4f49-43cc-a389-4dbff9ae1fe7` |

## 任务原文

任务：给 dsh-remote 插件暴露「终端传输层 slot」，让它能在完全不改 TerminalView UI/交互的前提下替换底层连接逻辑（本地 node-pty WS → 远程 SSH PTY）。

背景：dsh-remote 是另一个 DSH 插件（已通过你们 `betterSidebar` service 的 registerTab 贡献过文件类 tab）。它想复用你们的 TerminalView（xterm + block 分隔线「添加到对话」+ 选区浮窗 + 主题/256 色 + info bar + 断线重连横幅 + openWhenSized + 可见性 re-fit + 字体偏好），但把「连接逻辑层」换成自己的远程 SSH PTY 通道。因此需要在 `src/client/TerminalView.tsx:612`（xterm 挂载宿主 div `<div ref={hostRef} className={css.terminal}>`）处把「谁提供连接」变成可注入的 slot，同时保证默认行为逐字节不变。

具体要求：

1. **抽取传输层接口**。把 TerminalView 里与「本地 pty WS」耦合的部分抽到默认实现 `localTransport` 之后：`wsUrl()`、socket 生命周期、重连循环、close-code 解释（1011 + PTY_DEPS_MISSING 属于 local 专属）、`parseDownlinkFrame` title 帧、上行 `{type:'close'|'park'|'resize'}` 帧、以及卸载时 close/park/bare-drop 三分支语义（这些语义留在 localTransport 内部，远程 transport 自己实现等价语义）。

   建议契约（可微调，但必须覆盖这些能力）：
   ```ts
   export interface TerminalTransport {
     readonly kind: string
     open(session: {
       term: Terminal
       scope: SessionScope
       tabId: string
       cwd?: string
       onOutput: (data: string) => void          // 下行原始输出
       onTitle?: (title: string, info?: { cwd?: string; command?: string }) => void
       onFatal?: (reason: string | null) => void // 不可恢复错误 → 视图显示横幅 + 重试按钮
     }): TerminalTransportHandle
   }
   export interface TerminalTransportHandle {
     input(data: string): void        // 视图 term.onData 转发（block tracker 之后）
     resize(cols: number, rows: number): void
     close(): void                    // 用户关闭 tab → 立即杀会话
     park(): void                     // 切换会话 → 保活
     dispose(): void                  // 视图卸载
     retry?(): void                   // 用户点横幅重试
   }
   ```
   视图保留：connected/fatal 状态机、横幅与重试、block tracker、选区浮窗、info bar、fit/theme/font、onTitleChange 回传。`localTransport` 必须保持现行为完全一致（1011/pty-deps-missing、FAILURE_LIMIT=3、重连宽限）。`PTY_DEPS_MISSING` 横幅是 local 专属（远程 transport 不触发）。

2. **Prop 注入**：TerminalView 增加可选 prop `transport?: TerminalTransport`，缺省 → localTransport（现有行为）。slot 位置即 612 行宿主 div：不换组件、不换 DOM。远程 transport 未注入时缺省行为不变。

3. **导出与跨插件加载路径**（dsh-remote 复用 TerminalView 的前提，务必验证并明确回答）：
   - 你们 client 以 id `dsh-better-sidebar` 注册（`window.__ModuleLoader__.load`）。请确认：另一插件的 client factory 里 `require('dsh-better-sidebar')`（同步）能否解析到你们的 client exports？不行的话 `__DSH_MODULES__.import('dsh-better-sidebar')` 行不行？再不行请提供稳定入口（如你们 client exports 一个 `loadTerminalView(): Promise<{ TerminalView, TerminalTransport }>`，走你们自己的 chunk 体系 lazy 加载 `client-terminal.js`）。
   - 从 client exports 导出：`TerminalTransport`（类型）、默认 local transport、`TerminalView`（含 lazy 加载入口）。`LazyTerminal` 目前取 chunk 的 `mod.TerminalView`——请保证 chunk 里的 TerminalView 也接受 transport prop（或把 slot 组件放 core bundle、chunk 只装 xterm 依赖）。
   - 传输类型建议放独立文件 `src/client/terminal-transport.ts`，core 与 chunk 都能 import。
   - 不要引入对 dsh-remote 的任何依赖（slot 是通用机制）。

4. **title 帧机制对远程同样可用**：dsh-remote 的 host 会按同一帧协议发 `{type:'title', title, command, cwd}`（cwd=远程工作区）。请保证 parseDownlinkFrame 逻辑在 transport 抽取后仍对自定义 transport 生效（或自定义 transport 自行调用 onTitle）。

5. 交付：代码改动 + 简短报告，必须包含：最终 `TerminalTransport` 接口签名、`TerminalView` 新 props、`dsh-better-sidebar` client exports 暴露的符号清单、跨插件加载路径的验证结论（同步 require / import / 自定义 loader，选一，附一句依据）、以及「注册一个使用自定义 transport 的 terminal tab」的用法示例代码。改动后请跑你们的构建/类型检查确认无回归（tsdown build 或 tsc）。

## 续跑指引

见 /Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar/.dsh/delegations/dlg-20260906-c2903dbc/resume.md。
