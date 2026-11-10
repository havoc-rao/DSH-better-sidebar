# 终端退出后自动准备新 shell

## 行为

- 可见受管终端收到后端确认的自然 exited 后，自动执行一次原绑定源的 create，不重跑代码块或恢复原任务。隐藏视图等待激活。
- 创建中显示进度、不显示退出警告或可重复点击的新建按钮；失败后显示错误并提供手动重试。
- tab.meta.terminalAutoStartAttempted 持久化一次性尝试标记，避免切换会话、重挂载、新 shell 再退出形成循环。新建进程替换当前 xterm；旧命令输出仍在原终端记录保留。
- 普通断线、权限拒绝、missing、明确 terminated 不自动新建。远程受管终端保持原 provider，不回落本地。
- pendingRestarts 以 store/session/tab 共享进行中的创建，重挂载继续展示进度，不重复创建；结果仍检查原绑定，关闭或重绑定后释放多余进程。

## 验证

实现提交：b5e0b595，分支 fix/terminal-exit-auto-start。沿用用户此前选择，保留主题分支，不顺带将未集成的前置功能合入 main。未发版。

- 专项：workspace-terminal-view 36 项 + workspace-terminal-client 26 项，62/62 通过，含自然退出一次新建、失败后手动、隐藏激活、重挂载防循环、pending 重挂载与远程原源。
- typecheck、lint（22 个既有 warning / 0 error）、build、check:consumer-types、pack 通过。
- 最终全量：321 files passed / 1 skipped；3811 tests passed / 19 skipped。首次全量曾出现已知 fs-watch flake，隔离 6/6 通过；最终完整重跑全绿。
- 沙箱内真实挂载 Run 与底部终端报 posix_spawnp failed，主挂载和 native reload 通过。经完整权限审批复跑同一命令，四项全部通过（43.4s）：Run 后真实退出并自动 create 新 terminalId、正确 cwd、新终端 connected、无手动按钮、不重跑代码块、不发送聊天；主挂载、底部终端和 native reload 通过。只运行上述四项挂载选择，不声称本轮执行全部 e2e。
- 独立审查发现 pending 跨 remount 原有组件级锁不能去重，已补共享 promise 和订阅并复核通过。

日志：logs/2026-11-10-terminal-auto-start-shared-final.log、logs/2026-11-10-terminal-auto-start-final-build.log、logs/2026-11-10-terminal-auto-start-final-full.log、logs/2026-11-10-terminal-auto-start-mount-2.log。

本地链接目录产物已重新构建，未验证用户当前已打开 GUI 的 bundle 是否刷新，不承诺 HMR 自动生效。
