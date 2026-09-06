# 委派任务书 · dlg-20260906-0fa5db4a

| 字段 | 值 |
| --- | --- |
| 目标 | `/Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar` |
| 工作区 | `/Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar` |
| 父会话 | `session-c03d62d6-b025-4690-95e0-c8d80212d8ec` |
| 创建时间 | 2026-09-06T19:37:47.462Z |
| 任务标题 | 任务：为 dsh-better-sidebar 实现 v0.20 的 fileT… |
| 超时 | 300000 ms |
| 目标会话 | `session-d354487f-23ea-46d4-a089-0f4bde45e8c8` |
| 运行 ID | `session-d354487f-23ea-46d4-a089-0f4bde45e8c8` |

## 任务原文

任务：为 dsh-better-sidebar 实现 v0.20 的 fileTreeSection「source 形态」——Files 面板上模块直接复用宿主自己的 FileTree 组件，插件只提供数据源。代号 SectionSource。

背景：dsh-remote 插件已确定架构方向：remote 只做协议层+数据层，展示/交互（含引导柱折叠等优化）全部由宿主 FileTree 提供，避免维护两份树展示。硬约束：不得注册全局 fileTreeProvider（下模块本地树必须保持纯本地、永不被接管）——这正是新增 source 形态的原因：host 在 section 里渲染自己的 FileTree 并显式绑到插件的数据源实例上。

当前状态：
- 仓库根 /Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar。profile 直接 link 本仓库根，改完 `pnpm build`（tsc + tsdown → lib/）即生效（浏览器硬刷 + 宿主重启后生效）。
- 已有一处改动来自协作方：src/client/file-tree-source.ts 的 `FileTreeEntry` 已加 `meta?: { size?: number; mtime?: number }`（含文档注释）。在此基础上继续，不要重做。
- 开工前先 `git status` 检查工作区是否有未提交改动，避免覆盖他人进行中的工作；不要提交 git（提交由协作方统一处理）。

需要实现的契约增量（全部可选、向后兼容；本地渲染路径在无新字段时必须逐字节不变）：

1) src/client/file-tree-source.ts（继续）：
   - `FileTreeProviderCapabilities` 加 `open?: boolean`（文档：文件行点击经 provider 的 `open(path)` 打开，缺省 off）。
   - `FileTreeDataSource` 加 `open?(path: string): void`（文档：远程路径的打开委托；未声明 open 能力或未提供该函数时，宿主走原 onOpenFile 路径）。
   - `normalizeFileTreeEntries` 把 `entry.meta` 映射进返回的 FsEntry。

2) src/client/api.ts：`FsEntry` 加可选 `meta?: { size?: number; mtime?: number }`（宿主本地 fs.tree 永不设置 → 本地行渲染不变）。

3) src/client/file-tree-section.ts：`FileTreeSectionDescriptor` 扩为两种形态（二选一）：
   - 现有 `render(scope): ReactNode`（v0.19 形态，保留）；
   - 新增 `source?: FileTreeSectionSourceDescriptor`，定义：
     `{ createSource(sessionId, cwd): FileTreeDataSource; roots?(sessionId, cwd): FileTreeProviderRoot[] | Promise<FileTreeProviderRoot[]>; capabilities?: FileTreeProviderCapabilities }`
   - 文件头文档注释补一段：render 形态 = 插件自绘（v0.19，向后兼容）；source 形态（v0.20）= 宿主在上模块渲染自身 FileTree，插件只供数据；roots 决定渲染根（取第一个；缺省/空 → 上模块不渲染）；source 形态不依赖全局 provider 注册，下模块本地树不受影响。

4) src/client/service.ts：
   - `SIDEBAR_FEATURES` 加 `'fileTreeSectionSource'`（v0.20）并补文档注释；
   - `SIDEBAR_SERVICE_VERSION` '0.19.1' → '0.20.0'；
   - `registerFileTreeSection` 加校验：`render` 与 `source` 恰好提供一个，否则 throw 清晰报错；
   - package.json `version` → 0.20.0。

5) src/client/FileTree.tsx：
   - 新可选 prop `sourceOverride?: ResolvedFileTreeSource`：非 undefined 时优先于内部 `useFileTreeSource` 解析（hook 照常无条件调用，仅结果被 override 替换）。注意组件内 mode-key（`single:${fileSource.providerId}`）与 `singleSource` 选择逻辑会自动适配 override，无需另改。
   - 文件行打开委托：文件行 onClick 与 onKeyDown（Enter/空格）处——若该行能力面 `capOn(path, 'open')` 为真且所属 source 的 `source.open` 是函数（单源模式 source = fileSource；多根模式 = rootAt(path) 的 source），调用 `source.open(path)`；否则保持原 `onOpenFile(path)`。
   - 行 meta 后缀：renderLevel 条目渲染中，在 name 后、symlink 徽章/行操作前，当 `entry.meta` 存在且至少含 size 或 mtime 时渲染 dimmed 后缀：size 用人类可读短格式（如 1.2 KB / 3.4 MB），mtime 用短时间格式（如 `M-D hh:mm`；风格与仓库现有工具一致即可，可内联实现）。新增 CSS 类 `.explorerMeta`（sidebar.module.css：小型字号、tertiary 色、flex:none、overflow/ellipsis 保护）。
   - 行菜单上下文：`commandItems` 构建处（~line 896-900 的 commandMenuRows 调用）与 onSelect 里 `executeCommand` 的 payload（~line 1257-1262）都带上 `sessionId`。

6) src/client/commands.ts：`CommandMenuContext` 加 `sessionId?: string`（文档：行菜单为触发行所属会话；tab 菜单不填）。`CommandRunPayload` 因继承自动带上。

7) 新建 src/client/section-source-tree.tsx：`SectionSourceTree({ section, scope })`（section 为带 source 的描述符，scope 为 FileTreeSectionScope）：
   - 解析：`createSource(sessionId, cwd)`；若声明 `roots` 则异步求解（pending 期间渲染 null；拒绝或空 → null，绝不崩树）；取第一个 root `{ id, label, dir }` 作为树根。
   - 自带 `expanded: string[]` state，sessionId 或根变化时重置（避免旧路径残留）。
   - 渲染 `<FileTree sessionId={sessionId} cwd={root.dir} sourceOverride={{ providerId: section.id, source, capabilities: section.source.capabilities ?? {} }} expanded={expanded} onToggle={setExpanded 式} onOpenFile={() => {}} onReferenceFile={() => {}} refreshTick={0} />`，并包在能撑满上模块区域、可滚动的容器里（参照 TreePanel 本地树的容器结构/样式）。单源模式下根行显示远程根 basename，所有展开经插件 list()（路径原样透传），相对复制基准 = cwd = 远程根（天然正确）。
   - 组件文件头写清契约与用法注释。

8) src/client/TreePanel.tsx：`ExplorerDual` 的 matched section 渲染处改为：`section.source !== undefined` 时渲染 `<SectionSourceTree section={section} scope={scope} />`，否则保持 `section.render(scope)`。

9) 测试与验证：
   - 补/改 vitest 单测（test/ 目录）：normalizeFileTreeEntries 的 meta 映射；commandMenuRows 的 sessionId 透传（若已有相关测试则扩展）；section 描述符形态相关纯逻辑如可测则加。
   - `pnpm typecheck` 0 错误；`pnpm test` 全绿；`pnpm build` 成功产出 lib/。
   - 不要改 dsh-remote 仓库。契约名（feature 'fileTreeSectionSource'、source 形态字段 createSource/roots/capabilities）是协作方已按其对接的，若与代码现状冲突必须如实报告并给出方案，不得静默改动契约名。

完成后在回复中汇总：改动文件清单、新契约类型定义、typecheck/test/build 结果；如有障碍如实报告。

## 续跑指引

见 /Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar/.dsh/delegations/dlg-20260906-0fa5db4a/resume.md。
