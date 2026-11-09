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

未 commit/merge，未发版。
