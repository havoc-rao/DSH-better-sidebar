# 委派任务书 · dlg-20260906-f7945dc0

| 字段 | 值 |
| --- | --- |
| 目标 | `/Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar` |
| 工作区 | `/Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar` |
| 父会话 | `session-9236496e-3af4-4ed2-b133-c86154a3adfb` |
| 创建时间 | 2026-09-06T16:43:08.050Z |
| 任务标题 | 背景：DSH-better-sidebar 与 dsh-remote 插件共存场… |
| 超时 | 300000 ms |
| 目标会话 | `session-5cc8bf78-f7d4-4d51-845d-4cf7193e9186` |
| 运行 ID | `session-5cc8bf78-f7d4-4d51-845d-4cf7193e9186` |

## 任务原文

背景：DSH-better-sidebar 与 dsh-remote 插件共存场景。

你的仓库是 DSH-better-sidebar（本工作区）。侧栏文件面板的受控文件树在 src/client/FileTree.tsx（根 #753 是树体渲染起点；组件签名在 #304，数据加载在 #335-#490 区间）：props 含 sessionId/cwd/expanded/ctx/revealed/onToggle/onOpenFile/refreshTick/gitStatus/onUploadRequest/busy 等；内部 data: Record<string, LevelData> 按目录懒加载（LevelData = { entries?: FsEntry[]; error?: string }），每个目录展开时调用一次 api.ts 的 fs.tree（call<{ path, entries, truncated }>('fs.tree', ...)，FsEntry 类型在 src/client/api.ts:26）——即默认数据源是「本地文件系统」。

dsh-remote 插件（另一个工作区 /Users/havoc/Documents/Projects/tools/dsh-plugins/dsh-remote）：SSH 远程工作区插件。远程会话下它用自己的远程 API（GET /dsh-remote/ls 等，路径是远程绝对路径，POSIX /a/b 或 Windows D:\x / /d/Code shell 形式）提供文件树数据与读写删改操作，目前以「注册自定义 tab」的方式集成你的 betterSidebar 模块（bs.registerTab）。它读你的模块通过 ctx.get('betterSidebar')。

目标（本次任务，由你在本工作区完成）：让 better-sidebar 的 FileTree 暴露一个「文件树数据源注入 slot」——默认（无提供者）行为保持现状（本地 fs.tree）；当 dsh-remote 等插件为某会话注册了远程数据源提供者时，该会话的文件树以远程数据为「主体」（树浏览、展开加载全部走远程提供者），本地会话零影响。即：「它默认需要本地获取，只不过那个『需要』站在同层，远程会成为它的主体」。

请实现并交付：

1. 设计并导出数据源提供者接口（TS 类型，放 FileTree.tsx 同目录或独立文件并走既有 barrel/入口导出，让外部插件能 import）：
   - 核心能力 list(dir): Promise<{ entries: FsEntry[]; truncated?: boolean } | { error: string }>（或等价 shape），dir 为绝对路径、保持远端语义不做本地转换；
   - 明确 FsEntry 在远程模式下哪些字段无意义（如 git 相关/本地 inode 类），允许 optional 或提供者声明禁用；
   - 刷新语义：挂接现有 refreshTick 机制（bump 清 level 缓存 → 重新走提供者 list）。
2. 暴露注册/注入 API：外部插件（dsh-remote）能注册「会话 → 提供者」映射（或全局提供者 + 会话判定），FileTree 渲染/加载时探测当前会话是否有远程提供者；有 → 用其 list 替代默认本地 list；无 → 原路径。
3. FileTree 接线：在加载路径上做最小侵入的分流（数据源选择逻辑集中一处），视觉/交互（缩进参考线、行高、上下文菜单、拖拽上传、git 徽标、@-引用、打开文件）尽量不动；对远程模式下不适用的本地专用能力（上传、下载、git 状态、openWith 等）优雅降级（提供者可声明支持面，FileTree 据此隐藏/禁用对应入口），缺省降级规则要明确。
4. 若 betterSidebar 模块有更合适的既有扩展机制（seam/slot/inject 模式），优先复用，但必须把「文件树数据源注入」作为一等公民暴露出来；命名（slot key / 注册函数名 / 类型名）给出精确值。

约束：纯 TS/React，无新运行时依赖；保持向后兼容（无 dsh-remote 时行为逐字节等价）；跑仓库现有 typecheck/lint/test（若有脚本）确认全绿。

完成后回报（结构化）：
- slot key / 注册 API / 提供者接口的精确名称与完整 TS 类型定义原文；
- FileTree 切换判定逻辑与优先级（何时、怎么探测）；
- 远程模式下禁用/降级的本地能力清单与实现方式；
- 给 dsh-remote 侧的适配器实现示例（伪代码或接口签名即可）；
- 改动文件清单、验证方式、typecheck/lint 结果。

## 续跑指引

见 /Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar/.dsh/delegations/dlg-20260906-f7945dc0/resume.md。
