# 委派任务书 · dlg-20260906-70751a6c

| 字段 | 值 |
| --- | --- |
| 目标 | `/Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar` |
| 工作区 | `/Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar` |
| 父会话 | `session-4eb2b57f-3615-46b4-bc44-370d8ba822d9` |
| 创建时间 | 2026-09-06T18:26:51.820Z |
| 任务标题 | 在 fileTreeSource（v0.17）/ multi-root（v0.1… |
| 超时 | 300000 ms |
| 目标会话 | `session-0a20a0ce-3e03-4b0b-8975-3ce19baa70d3` |
| 运行 ID | `session-0a20a0ce-3e03-4b0b-8975-3ce19baa70d3` |

## 任务原文

在 fileTreeSource（v0.17）/ multi-root（v0.18，均为上一委派交付）基础上，为 Files 面板的 FileTree 增加「上下双模块」结构：**下模块 = 现有树（本地树，含 multi-root 逻辑，保持原样）**；**上模块 = 远程插槽（默认隐藏，外部插件注入自己的远程树组件）**。工作区即 DSH-better-sidebar，先读 src/client/FileTree.tsx（尤其 rootsBody/renderRootRow 区）、TreePanel.tsx、file-tree-source.ts、service.ts 现状。

需求背景（dsh-remote 对接方，其明确构想）：「better-sidebar 在它的文件 tree 里面分两个模块，上面一个下面一个；它正常地把模块放在下面的模块里，并暴露一个 slot；remote 模块就把自己本地（侧）的这套远程树逻辑和组件直接塞到上面那个模块里去」——即布局形态：文件树区域上下两块，下面一直是 better-sidebar 的本地树（现状能力/UI 完全保留），上面是 dsh-remote 注入的远程树（它自己的组件：工具栏/目录树/右键操作/打开远程文件），本地会话上面一块完全不渲染。注意：这与 multi-root（同一树内并列根行）不同，上区是**独立的组件区域**，不是树里的根行。

请实现并交付（建议版本 v0.19.0）：

1. 布局结构（FileTree 或 TreePanel 层，你来定挂载层——需保证上区随 Files 面板/树面板一起出现）：
   - 树体区域顶部留出「上模块插槽」：无匹配 section 时**完全不渲染**（渲染路径与现在逐字节等价，回归零风险）；
   - 匹配时渲染上区 + 分隔（视觉分隔线；上区与下区滚动独立、状态独立；上区高度由注入内容决定，可给最大高度/自适应策略）。上区与下区各自保持自己的滚动上下文（下区滚动语义不变）。
2. 契约（v0.19.0，file-tree-section.ts 新文件或并入 file-tree-source.ts，随服务导出；v0.17/v0.18 契约字段与语义全部保留）：
   - 新 feature：'fileTreeSection'（加入 SIDEBAR_FEATURES，SIDEBAR_SERVICE_VERSION → 0.19.0，package.json/dsh.plugin.json 同步）；
   - `BetterSidebarService` 新增：`registerFileTreeSection(descriptor: FileTreeSectionDescriptor): () => void`（重复 id 抛错、disposer 注销、registry 变更 notify）+ `getFileTreeSections(): readonly FileTreeSectionDescriptor[]`；
   - `FileTreeSectionDescriptor = { id: string; match(sessionId: string, cwd: string | undefined): boolean; render(scope: FileTreeSectionScope): ReactNode }`；`FileTreeSectionScope = { sessionId: string; cwd: string | undefined; ctx: Context }`；
   - 解析语义：渲染层对当前会话取**第一个 match 命中的 section**（注册序，first match wins；match 抛错跳过）；无命中 → 上区不渲染；
   - 渲染层 live 订阅注册表（沿用 useFileTreeSource 的 force/tick 模式）——插件激活/停用时上区即时出现/消失。
3. TreePanel：搜索框/上传/git 等面板级能力继续只属于**下区本地树**（现状语义不变）；上区由注入方组件全权负责，better-sidebar 不做任何能力施加。若你认为需要把 TreePanel 的某部分（如搜索盒）也放进上区插槽范围，请说明取舍——但默认不加。
4. 测试：新增 section spec（无 section 回归、注入后上区渲染、first match wins、live 注册/注销、上区与下区独立展开/滚动、match 抛错跳过），跑 `pnpm typecheck` + 相关测试 + 既有 file-tree-* / multi-root spec 无回归。
5. 给 dsh-remote 的示例（伪代码即可）：如何拿到 service、如何 registerFileTreeSection 注入远程树组件。

约束：纯 TS/React、无新运行时依赖；v0.17/v0.18 契约不回退；无 section 匹配时渲染路径零改动。

完成后结构化回报：契约类型原文、挂载层与布局实现要点（上区容器/分隔/滚动/高度策略）、回归保障、测试与 typecheck 结果、dsh-remote 使用示例。

## 续跑指引

见 /Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar/.dsh/delegations/dlg-20260906-70751a6c/resume.md。
