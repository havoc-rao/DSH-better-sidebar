# 会话中央编辑工作台（第一阶段）

## 目标与实现

中央编辑器使用宿主公开 `main.conversation` single/session-maybe 槽，编辑时 priority -100 注册，返回对话时释放。没有宿主源码改动、构建产物补丁、DOM 查找/遮盖聊天或全局面板导航。原生右侧文件树与当前会话保留。

入口：文件树右键「在主区域编辑」；侧栏文件工具栏同名按钮。处于中央编辑时，右侧树普通打开送到中央。普通侧栏打开默认行为不改。聊天 header utilities 提供再次进入已有工作台的按钮。

中央内容：固定多文件标签、绝对路径、保存按钮、行列状态；CodeMirror 搜索/替换、历史、缩进、折叠、括号匹配。编辑组件继续使用现有 editor lazy chunk，不进入核心包。

底部为预留安全带中的浮动状态胶囊，显示真实 session running 状态、返回对话；展开列出运行中的其他会话。首版不是可拖动窗口。审批/提问/计划确认出现时自动释放中央接管，让宿主交互面恢复；工作台草稿保留。

## 状态与安全

- CentralEditorStore 每 session 内存隔离，隐藏与会话切换保留标签/草稿。
- editor chunk 内按 activation + session + path + document generation 缓存 EditorState、撤销、选区、折叠与滚动，关闭和 controller 卸载同步清理，避免 HMR 重用旧撤销栈。
- pending write 放在 controller/store 生命周期，返回对话再进入不重复提交；保存期间不允许关闭对应文档，完成校验 generation，保留保存期间的新输入。
- 保存携带 expectedContent；仅本进程同归一化路径 fs.write 串行，写入前与 rename 前检查完整磁盘文本。不符合基线返回 HTTP409/fs-error，保留草稿；不传 expectedContent 的旧 API 保持兼容。
- 非文本、截断读取不允许中央编辑，防止保存不完整文件。
- dirty 标签关闭需要确认；浏览器 beforeunload 在任何会话有 dirty 草稿时请求浏览器确认。
- 侧栏 dirty 草稿不自动迁移，入口明确要求先保存。

## 明确边界

- 宿主聊天 React 子树在切换时会卸载；宿主按 session 保存内存语义阅读锚点，但不是完整瞬态或零丢像素恢复。
- 草稿与历史仅内存，不保证刷新、HMR、插件卸载或进程退出恢复。beforeunload 由浏览器决定是否弹出，不是持久化保障。
- 文件保存不是文件系统 CAS：外部进程/其他实例/路径别名未受本进程锁保护，检查到 rename 仍有 TOCTOU。
- 无自动覆盖冲突，无默认自动保存；首版显示真实冲突错误，差异解决 UI 后续补。
- 首版没有 Markdown/HTML 中央预览分栏、临时标签、Cmd+P、任意分屏、可拖浮条、LSP。
- 本地 worktree 构建不更新用户已运行 GUI。必须经 profile 正式挂载并刷新/验证后才可宣称在线可用。

## 本轮验证记录

- worktree：`tmp/worktree/DSH-better-sidebar-central-editor`；branch：`feat/central-editor`，未提交/推送/合并。
- build/typecheck、新增代码 ESLint、diff --check 通过；最终产物 manifest/chunk 11 项通过。
- 新增行为测试覆盖 state 10、service 4、surface 8、fs.write conflict 8。
- 全套测试原始运行发现基线 Git More 按钮 5 项断言失败，原工作区重跑同样失败（测试仍读文字，实现为 aria-label 图标按钮），本轮不修改无关代码。
- 最终排除这一已确认既有 spec、`--maxWorkers=4`：172 文件通过，1856 测试通过，9 跳过。此前全并行出现一次未改 fs-watch 的15s超时，最终完整回归该测试通过。
- 未修改用户运行 profile、未挂载到当前 GUI、未进行真机中央编辑/审批/远程文件 E2E；因此构建验证不是在线 UI 验收。

## 宿主后续建议

若要求聊天组件保持挂载，需要宿主新增会话中央 chain/wrapper 槽（fallback 常驻，明确 visibility/滚动测量语义）。这不是首版运行必需。
