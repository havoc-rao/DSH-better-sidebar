# 终端视图重连不等于重建 shell

## 范围与安全边界

仅修改 better-sidebar 的传输契约、视图提示、翻译、测试与文档。不改 DSH 源码或 dsh-remote，不部署 profile、不重启宿主、不启动替代 GUI。保留工作区既有文件选择器改动；开发分支 `fix/terminal-view-reconnect-status`，不自动提交或发布。

Dev Tunnel 是 SSH 承载；后台受管 SSH/PTY 的生命周期不依赖前端 TerminalView。切工作区卸载视图并 dispose WebSocket，回来按原 terminalId 附着，不能描述为 shell 重建。单纯断线既不证明实例丢失，也不证明任务仍运行。

## 落地状态模型

`TerminalTransportSession.onState?({phase, intent?})` 是可选增量：phase 为 connecting/connected/disconnected，intent 为 attach-existing/create，无法保证时省略。onState 一旦使用，旧 onConnected 布尔回调不再覆盖当前 mount 的结构化状态；不使用新回调的旧 transport 继续工作。初始有 terminalId 为 attach-existing，其余为中性连接提示。没有按 kind 分支。

- connecting：连接视图；明确 attach-existing 时补充不会新建 shell。
- connected：后端 init/attach ack 确认后收起提示，不增加恢复 toast。
- disconnected：后端状态未知；有 retry 才提供重新连接视图。旧 retry 若不报告 connecting，不凭点击伪造正在连接。
- onClosed(missing/exited/terminated)：后端明确事实优先，禁止后续连接回调冲掉；具备管理绑定时才显示启动新终端。新进程不恢复旧任务。
- onAccessDenied(reason)：明确授权失败，停止重试，无新建动作。保留旧 onFatal 字符串接口但不解析字符串猜权限。

删除旧的可见激活自动替代逻辑：即使后端确认 missing/exited，也必须由用户点击启动新终端。底部面板没有 tab 时的默认获取策略未改变。输入仍由 transport 拒绝未发送数据，绝不缓存重放。卸载后忽略传输回调。

## dsh-remote 配套（只读核实，尚未实施）

核实文件：`lib/client.js` 的 makeNativeWorkspaceSource/createTransport（约5937–6013），`lib/managed-terminal-routes.js` 的 attachManagedTerminal（约82–96）。该仓为零构建手写 lib，已读其 AGENTS 与 scripts/dev-standards。

1. connect 真正开始时 `session.onState?.({phase:'connecting',intent:'attach-existing'})`；只在 init 报 connected；close/error 报 disconnected。可继续向旧宿主报告 onConnected，但新宿主以 onState 为准。
2. 网络、SFTP realpath、SSH 暂时故障不得统一转 fatal FORBIDDEN；后端需返回可恢复错误类别（例如结构化 retryable），只有可靠权限/owner-fence 拒绝才走 onAccessDenied。MISSING/EXITED/TERMINATED 仍走 closed。
3. 临时失败不能 `fatal=true + detach()` 永久封死 handle.retry；dispose/明确拒绝/closed 才结束生命周期，retry 重建同 terminalId 的视图 socket，不创建 PTY。旧 socket 的迟到事件必须按 socket 身份忽略。
4. input 必须在尚未收到 init、已断线或发送失败时返回 false；不能像当前 send 返回 void 让视图误认为离线字节已送达。不得排队重放。
5. 真权限失败新宿主优先 onAccessDenied，旧宿主退回 onFatal 并由源停止自动请求。不能让 UI 根据错误消息内容判断权限。

因此 better-sidebar 单仓完成可提供准确的中间态/手动重连入口与兼容契约，但旧 dsh-remote 的权限误分类与 fatal 后 retry 无效，无法靠 UI 修复；完整联调依赖上述源端改动。

## 验证原则

回归覆盖结构化 connecting/connected/disconnected、旧布尔回调、三类 closed、权限拒绝、重连仍原身份不 create、无 retry 不显示无效按钮、可见激活不自动替代、卸载后回调无效。zh/en/ja 提供完整新文案；其他18种语言显式使用英文 fallback，保持发布词典 key-set 门禁，不声称已经翻译。执行 targeted tests、typecheck、build 与可行的全量单元测试。真实 SSH 联调及 mount lane（需起新宿主）不在本次执行范围，不能以 mock 通过宣称远端端到端完成。

### 本次验证结果

- `pnpm typecheck`、`pnpm build`、`git diff --check` PASS。
- 五个相关 spec（视图/源/错误/工作区管理/底部自动终端）79/79 PASS；视图专项31/31；词典专项20/20。
- targeted ESLint：0 errors，2个既有形态的 effect/ref 依赖 warning，未扩大生命周期依赖以免重挂 transport。
- 全量命令 `pnpm exec vitest run --exclude '**/.pnpm-store/**'`：249个文件、2813用例通过、18跳过；进程 exit 1，因未涉及的 shared-rendering spec 出现一次 CodeMirror/jsdom `textRange(...).getClientRects is not a function` 未捕获异常；随后该 spec 单独复跑 exit 0。不能将该次全量门禁标为完全通过。
- 排除 `.pnpm-store` 是因为当前工作区缓存含旧项目镜像，默认发现会重复执行旧 spec；没有为此改测试配置或缓存文件。
