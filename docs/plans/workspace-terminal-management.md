# Workspace 终端管理

## 目标

本地终端是 workspace 的独立资源，session 只提供发现和连接入口。在 session A 创建的终端，session B 能按需连接同一个 PTY，保留 shell 状态、正在运行的 CLI 和有界输出。此阶段实现用户侧操作，不默认授权 B 的 Agent 读取或控制其他终端。

## 实施兼容说明

- 新普通终端入口（没有显式 tab ID 或自定义 meta）统一先检测 provider，再异步创建本地 workspace 实例；本地 workspace 视图总落底部工作台。
- 旧持久化 session/tab 终端不自动迁移，旧 Agent 与远程 Provider 保持生命周期语义。
- 保留既有 pin 元数据和纯解析模块，但当前合并基线的 Sidebar 没有实际接线 pinned hook；本次不修复该历史问题，也不把 pin 当作 workspace 发现/保活前提。
- 工作区终端管理作为 `workspace-terminals` 单例 tab，入口位于原生右侧栏指南和底部 TabBar 的 `+` 菜单，列表在 tab 内扩展展示；默认或 `target:'right'` 进入右侧栏，显式 `target:'bottom'` 进入底部，右侧栏不可用时回退到底部；每个承载面内按 session 单例。
- 管理 tab 挂载时加载，可手动刷新，不使用后台轮询。刷新保留当前列表，按钮显示请求反馈；跨 session 切换时清空旧列表并取消请求，避免显示错 workspace。
- 管理页采用紧凑列表：头部标题与数量摘要，行内名称/运行状态为主，路径与来源会话为辅（省略长文本，完整值可悬停查看）；来源优先显示宿主 `displayTitle`，无摘要时用短 ID。
- 视觉改版（参考 dsh-enhanced-workspace 的紧凑侧栏风格）：字体整体收敛——13px 行（标题不加粗放大）、11px 元信息/状态/按钮、11px 600 头部标题、24px 静音图标按钮；行改为 8px 圆角胶囊 + 1px 间距堆叠（去掉行间发丝线），行操作（打开视图/结束进程）静止时隐藏、行悬停/键盘聚焦时显现（触屏与窄面板下常显）；头部吸顶保持数量/运行统计/刷新可见。状态仍由字形上的实心圆点（运行 = 状态成功令牌，退出 = 中性）与右侧状态行传达，退出行标题/状态降级；cwd 等宽字体，数字开表意数字。交互结构与可访问性语义不变（键盘焦点、减少动画、窄面板 `@container` 重排、行内确认区均保留；确认区为错误令牌淡染卡片）。
- 行操作区区分打开视图与结束。结束用独立的行内确认区，并允许取消；已退出记录也能移除。请求期间禁用冲突操作，窄面板自动调整排列，皮肤令牌、键盘焦点和减少动画偏好均保留。打开终端视图不关闭管理 tab。


## 身份与边界

- 终端以稳定 `terminalId` 标识，与某个 session 的页签布局分离。
- 本地 workspace 身份在服务端从真实 session header（运行中或持久化）解析；不使用请求里的 cwd 或宿主进程 cwd 作为授权依据。
- 优先采用公开 `workspaceRegistry` 的 workspace ID 和 session 成员关系；无匹配时，以本地目录 canonicalization 后的当前宿主命名空间身份匹配。不同 workspace 的 session 不得列出、连接或结束对方终端。该实现不是远程 workspace 身份协议。
- 远程 TerminalProvider 与现有 Agent 终端继续走原契约，避免把远程路径误当成本地目录创建 shell。

## 生命周期

| 行为 | Workspace 终端 |
|---|---|
| 新建 | 建立独立终端实例，记录创建来源 session |
| 关闭页签 | 只断开视图 |
| 切换 session / 刷新 / 连接断开 | 保留进程 |
| 在 B 打开已有终端 | 连接原实例，不重新 spawn |
| shell 自行退出 | 保留已退出记录及输出；重新连接不自动重启 |
| 显式结束终端 | 结束进程、撤销实例并向已连接视图通知 `terminal-terminated` |
| 已结束/失效视图点击「重新启动」 | 显式创建新 terminalId，将当前页签重新绑定；其他页签不自动迁移，旧实例不复活 |
| 插件卸载 / DSH 进程重启 | 不保证 PTY 存活；不是 tmux 或独立守护进程 |

Workspace 注册表限制每工作区 3 个活进程、全局 64 个活进程；含退出实例的保留记录每工作区最多 12 条、全局最多 256 条，每实例最多保留 1 MiB 输出。达到上限须显式结束不需要的实例（退出实例也可结束以释放记录）。自然退出后显式重启会新建实例，旧退出记录仍可在管理 tab 清理；已被结束的实例没有保留记录。否则关闭视图不释放进程会形成无界资源占用。

## HTTP 与 WebSocket

走现有插件 trust fence，不新增宿主私有 API。

- `workspace-terminal.create`：`{ sessionId, title? }` → 终端描述。
- `workspace-terminal.list`：`{ sessionId }` → `{ terminals }`。
- `workspace-terminal.terminate`：`{ sessionId, terminalId }` → `{ ok: true }`。
- `/sidebar/ws/terminal?sessionId=<viewer>&terminalId=<id>`：连接已存在的、属于 viewer workspace 的实例。

终端描述含稳定 ID、名称、初始 cwd、创建来源 session、创建时间、退出状态及退出码。不把客户端提供的 terminalId 当作跳过 workspace 校验的凭据。

## Agent 后续接入

本次不注册新的跨会话 Agent 操作工具，不改变已有 Agent 工具权限。后续通过相同 terminalId 接入原始输入输出，而不是仅提供 exec(command)。需要独立控制租约（单写者、多观察者）、用户抢占、读权限、增量输出游标、操作来源记录和取消/等待语义。终端输出是不可信数据，不应作为 Agent 系统指令。输出暂停不等于交互式 CLI 已完成。
