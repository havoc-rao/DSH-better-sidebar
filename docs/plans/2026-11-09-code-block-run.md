# 代码块 Run：正式插槽与独立终端

## 范围

宿主提供 `markdown.code.actions`（list / session-maybe）。owner 为原始 `source`、`lang`、`streaming`，会话来自标准 props。插件注册 `better-sidebar.run`，不使用 DOM 扫描或修改宿主构建产物。只有显式点击才执行。

插件调用 `workspace-terminal.run`，每次新的运行意图启动全新的 shell `-c` PTY；cwd 只能从所属会话的 authoritative header 解析。输出走既有终端 WebSocket 和回放，不发送聊天、不使用 Agent PTY。运行完成保留退出状态与输出。默认 shell 获取排除运行中的命令进程。

本轮支持已知 POSIX shell，Windows、远程终端提供方、未知或交互式 shell 参数明确拒绝。完整 shell fence 才显示按钮，非 shell、流式 fence 和提示符记录不显示。

## 网络重试

一次点击携带 `${Date.now()}:${crypto.randomUUID()}`。失败重试沿用同一 ID；成功后下一次运行生成新 ID。服务端按 workspace/session/id 去重，指纹约束 command/title。已完成但保留的终端仍可返回；已删除的有效 token 通过有界 ledger 拒绝重跑；过期且不保留的 token 拒绝，满额不淘汰有效保护。

## 验证记录

- 首次插件全量：319 files / 3758 tests passed，19 skipped。
- 后续全量：3764 passed / 1 failed；失败为已知 fs-watch 满载 flake，隔离 6/6 通过；不为此修改监听实现。
- 去重后最终全量：3777 passed / 1 failed / 19 skipped；唯一失败仍为上述 fs-watch，隔离 6/6 再次通过，消费类型检查通过。
- 最新 Run 客户端 + 后端专项：48/48 passed（含网络失败去重、过期/删除保护、session/workspace 隔离）。
- typecheck、lint（既有 hook warnings）、build、pack、check:consumer-types 通过。
- 宿主最终仅保留 slot，无新增 webTerminals.run API/按钮；定向 200 项，新增 slot 3 项（含未闭合 fence），artifacts 8/8、build:check 2/2 通过。
- 首轮真实挂载：16 passed / 5 failed / 6 skipped。终端截图显示 `posix_spawnp failed`；其余失败涉及 onboarding、Files guide description、会话切换。不可将该挂载结果写成通过。
- 新增 opt-in `CODE_BLOCK_RUN_FIXTURE=1` 专项，scratch-only fixture 使用公开 session append 录入 shell fence，无 LLM。断言真实 Run 请求、cwd、新终端、WS 输出、退出状态、聊天不变。沙箱内专项复现 `posix_spawnp failed`；同一命令经 danger-full-access 审批后真实宿主专项 1/1 通过（4.6s），完整覆盖 slot 按钮、请求、工作区 cwd、新独立终端、真实 WS 输出与 exit 0、聊天不变。日志：logs/2026-11-09-run-code-only-2.log。
- 当前 GUI URL 未认证访问 401，尚未核验其页面效果；不承诺 HMR 或已生效。

以上为首次实现时的记录；实现后来已提交，未发版。

## 2026-11-10：本地 workspace 与 provider 共存修复

- 根因：Run 以全局 provider 注册表非空作为拒绝条件，启用 dsh-remote 即可能误伤本地 workspace。
- 修复提交 `1b5a717b`：按代码块 owner 的 sessionId 与会话列表 cwd 调用 `match(..., 'terminal:workspace-management')`。无关 provider 放行；实际匹配或归属判断抛错时不回落本机。拒绝提示明确说明 provider 暂不支持，失败增加 Console 诊断，不主动记录源码。
- 回归覆盖：本地 A 的代码块在当前选中远程 B 时仍在 A 打开、无关 provider 放行、匹配 provider 拒绝、matcher 抛错 fail closed，以及失败日志。Run 客户端 8 项、后端 42 项、词典 21 项，共 71/71 通过。
- typecheck、lint（22 个既有 warning / 0 error）、build、check:consumer-types、pack 通过。全量 3805 passed / 1 failed / 19 skipped；唯一失败为既有 fs-watch 超时，隔离 6/6 通过。日志在 logs/2026-11-10-run-provider-{focused,static,build,full,fs-watch}.log。
- 沙箱内完整挂载：17 passed / 5 failed / 6 skipped。Run 已发出真实请求，后端报 `posix_spawnp failed`；其他失败涉及底部终端、空会话终端请求和会话切换。此结果不是通过。日志：logs/2026-11-10-run-provider-mount-direct.log。
- 完整权限复跑同一挂载门禁：20 passed / 2 failed / 6 skipped。Run 真实请求、新独立终端、cwd、WS 输出、exit 0、聊天不变均通过；空会话、底部终端、主挂载与 native reload 通过。剩余失败为 tree-scroll 的新会话切换及 workspace-tool-tabs 的不可见按钮等待，完整门禁仍非全绿，不为本次 Run 修复修改这些子系统。日志：logs/2026-11-10-run-provider-mount-direct-2.log。
- 负对照：临时恢复“任意 provider 即拒绝”的行为，本地 workspace 回归用例按预期失败；finally 恢复源码后专项再次 71/71 通过。日志：logs/2026-11-10-run-provider-negative-control.log、logs/2026-11-10-run-provider-final-focused.log。
- 用户明确选择仅保留修复分支，不把其 11 个未合并前置提交一起带入 main。修复分支：fix/code-block-run-provider-scope。未发版，当前 GUI 未认证访问仍为 401，尚未验证浏览器实际加载的新 bundle；不承诺自动生效。
