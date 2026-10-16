# 工作区终端：Shell 生命周期与目录事件推送

## 本轮范围

- 新增工作区级元数据 WebSocket `/sidebar/ws/workspace-terminals?sessionId=…`；沿用管理 API 的权威 session→本地 workspace 解析及宿主请求 fence，不接受浏览器 cwd。
- 服务端 `WorkspaceTerminalManager.subscribe(workspace, listener)` 首次同步完整 `{revision, terminals}`，后续在增删、退出、pin、连接变化和 Shell hook 时即时推送。高频输入/输出时间元数据按 100ms 窗口合并。观察目录不附着输出连接，不增加 `attachedViews`，不阻止正常回收。
- 客户端 `WorkspaceTerminalSource.subscribe(onSnapshot, onError?)` 是可选增量能力：有则不周期 list；没有则保留可见期间 10 秒轮询。隐藏释放、恢复重订阅，断线 1/2/4/8/15 秒退避并重取全量。策略拒绝停止重连。显式刷新或管理操作仍可单次 list，但不能覆盖更新的推送快照。
- 完整快照而非增量协议：避免丢事件恢复/删除 tombstone/跨会话游标复杂度；服务端配额限制目录规模。慢连接超过 1MiB 排队即关闭并要求重连。revision 只在当前连接比较，重连接受新的基线。

## Shell 事件

复用实验性 zsh 集成，不修改用户 rc；仍默认关闭，仅 macOS/Linux 无自定义参数的非登录交互式 zsh。Bash/Fish/PowerShell 不在本轮支持范围。

- ZLE line-finish → `accept`：撤销提示符证明，不当作命令执行（空回车不制造生命周期）。
- preexec → `start`：busy，记录 commandStartedAt。
- precmd 首条语句读取 `$?`，仅存在实际 start 时 → `end;<0..255>`：记录 commandFinishedAt、commandExitCode、commandDurationMs，等待提示符期间 unknown。
- 顶层 ZLE line-init → `prompt`：展示 idle；启动提示符不制造完成事件。
- 无法保证兼容的 hook/主题/异步配置 → unsupported/unknown，不能猜测。
- PTY exit → exited，与命令 end 独立。

OSC 标记由服务端在 PTY 字节流解析后剥离，支持任意分片，限定 token 与长度；不是前端 xterm 文本推断，也不是同 UID 恶意进程的安全边界。不发送原始命令行，避免泄漏参数中的凭据。

## 安全边界

展示 idle 不等于安全回收：输入/普通输出撤销回收证明，回收仍要求提示符稳定至少 2 秒、成功进程检查、连续空闲保留期、无连接/无 pin/宽限期结束，删除前再次复查。后台任务、嵌套 SSH/tmux、CLI 内部等待授权不由通用 Shell hook 证明。

## 跨插件联通（后续批次）

- better-sidebar 新增能力 `workspaceTerminalSummarySubscription`，公开 `subscribeWorkspaceTerminalSummary(scope,onSummary,onError?)`，按 session/cwd 授权隔离共享单个源观察；相同读者重放最新摘要，错误清旧值，最后释放及插件销毁完全清理。已归属的 provider 消失或不再匹配时失败关闭，不回退本地或另一 provider。
- enhanced-workspace 优先订阅摘要，页面隐藏/关闭释放；旧版服务兼容10秒轮询，明确权限错误暂停每scope自动请求，普通通知不触发重新授权。保留原工作区会话锚点，不创建会话。
- 两个远程源实现相同可选元数据 subscribe，wire 可不同但不能把各自协议暴露给消费面。错误携带 code/status/retryable，403与临时网络中断分开；元数据观察不得隐式创建PTY或连接全部离线机器。
- 远程输出恢复保留原terminalId；输入断线不缓存、不自动重放，`input()` 可返回false，视图不得为未发送内容建立命令块。
- SSH通道丢失不是进程退出：只能标记uncertain/unknown，不能发exited/missing诱发视图自动重建。保留不确定身份，TTL/配额裁剪不得把不确定变成已确认不存在。远端无常驻代理/tmux时无法承诺SSH本身断开后恢复原进程。
- 输出游标按字节处理，重复裁剪、UTF-8分片、保留窗口缺口显式报告；不假装能恢复保留窗口以外的历史。

## 验证与限制

覆盖 marker 分片与错误退出码、启动/空回车、事件隔离/释放/高频合并、订阅隐藏与重连、旧源轮询及 list/推送竞态；路由覆盖权威工作区解析、拒绝、断连期间解析和背压。

真实 `/bin/zsh -n` 对生成 rc 的语法检查通过。本机真实 PTY 测试因 node-pty `posix_spawnp failed` 跳过，独立 Python `pty.openpty` 也报告 `out of pty devices`；因此不能声称已完成真实交互式 Shell 或当前 GUI 部署验收。须在具备 PTY 的宿主上跑可选真实 zsh 用例并刷新实际挂载页面确认。
