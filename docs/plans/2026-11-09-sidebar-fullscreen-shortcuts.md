# 侧栏内部全屏快捷键可达性修复

## 根因与范围

右侧栏全屏由宿主 `pane.fullscreen.toggle` 拥有（Primary+Alt+Enter），允许 page/editable/terminal，依据事件 target 解析当前可见 pane。本插件不注册第二个全屏动作，也不修改宿主源码。

已确认的冲突不是笼统的焦点问题：文件树/Git 行/任务/差异行的 Enter/Space 处理未排除修饰键，调用 preventDefault 或 stopPropagation，宿主 window bubble dispatcher 收不到原始事件；侧聊输入框和 Git 提交框还会误发送/提交。

修复：普通 Enter/Space 仅接受无修饰键；Git 提交和 CSS 确认仅接受自身的 Primary+Enter（排除 Alt/Shift）。路径输入与文件树重命名/新建同样不消费修饰键组合。现有 IME guard 保留，不新增全局键盘 listener。

## 文件快捷键焦点是另一条路径

旧 dsh-hotkey `open.files` 调用 `sidebarRight.openTab('files')`，不转 DOM 焦点。当前宿主 `workspace.files` 使用捕获 target 的 openTabFromTarget 与 openWithFocus；但 shortcuts 公开接口无命令 run，不能从插件调用私有 controller 方法冒充公开命令。由 dsh-hotkey 工作区独立处理该入口，不在 better-sidebar 抢占 open.files。

已在 dsh-hotkey 的 `fix/files-sidebar-focus` 分支落地：公开 ReactDOM.flushSync 提交 openTab 后，读取公开 active tab 与 DOM 标记，仅聚焦同一可见会话、实际选中的 Files pane；没有延迟抢焦点、全局 fallback 或私有 controller 调用。主侧已 review 实现与 DOM 回归。

真实双插件验证连续两轮通过：宿主 CLI 0.2.2-rc.1 / checkout 3c726cefd7 + 本仓库 0.30.1 tarball + 修复 hotkey tarball，MacIntel composer focus → Cmd+Shift+E → Files pane1 DOM focus → Cmd+Option+Enter push/fullscreen/push，pageerror=[]。证据在相邻 dsh-hotkey 工作区 `.scratch/files-focus/result.json`、`browser.log` 与 `browser.cjs`，主侧已读结果和脚本复核。scratch 服务器已停止，当前 GUI profile 未更新。

iframe、portal 与外部插件页面未以本次 Enter guard 修复宣称全覆盖。尤其浏览器原生 PDF 的内部键盘事件不能当作父文档事件处理。

## 验证

- 文件/目录 × Ctrl/Meta+Alt+Enter：事件到达 window，未 defaultPrevented、不打开/展开、不改变选择。
- Git textarea × Ctrl/Meta+Alt+Enter：不提交、不消费，普通 Ctrl+Enter 仍提交。
- 侧聊 textarea × Ctrl/Meta+Alt+Enter：草稿保留、不发送、事件到达 window；普通 Enter 仍发送。
- Diff 行 × Ctrl/Meta+Alt+Enter：不打开行且未 defaultPrevented，普通 Enter 仍打开目标行。追加后四个定向测试文件共 54 tests 通过，typecheck/lint/diff-check 再次通过：`logs/2026-11-09-sidebar-shortcuts-diff.log`。
- 内存变异移除 FileTree/GitLens guard：6 个回归用例失败，正常配置通过；未还原共享工作区源码。
- 真实 mount lane 已通过：聚焦文件行，使用 Primary+Alt+Enter 往返切换全屏。日志明确输出 `SIDEBAR-FULLSCREEN keyboard round trip verified`，不是仅跳过命令检查。证据：`logs/2026-11-09-sidebar-fullscreen-proof.log`。
- `typecheck`、`lint` 与全量单测通过：319 文件通过，3787 tests 通过。证据：`logs/2026-11-09-sidebar-shortcuts-final.log`。
- `build`、`check:consumer-types` 与 pack 通过。完整 mount lane 为 17 passed / 7 skipped / 4 failed，未放行整批合并。
- 隔离复跑两个底部失败项仍失败，trace 精确显示 `/sidebar/api/workspace-terminal.ensure` 与 `.create` 均返回 HTTP 500，响应 `posix_spawnp failed.`，非键盘路径。证据：`logs/2026-11-09-sidebar-mount-bottom-diagnostics.log`；不为通过门禁更改终端执行语义。
- 另两个完整 mount 失败为 tree-scroll 新会话后 seat 未切换，以及 workspace-tool-tabs 的 add-tab 被隐藏后等待超时；不把此轮快捷键修复冒充完整客户端门禁通过。

本工作区开始时已有代码块运行等未提交改动，均保留。修复在 fix/sidebar-modified-enter 分支，门禁失败前不合入 main，不将用户原有改动一起提交。
