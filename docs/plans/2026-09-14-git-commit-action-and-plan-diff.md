# Git 提交区接缝 + 计划 diff（外部插件协作）设计

**日期**：2026-09-14
**状态**：已实施（分支 `feat/git-commit-action-seam`）
**作者**：agent + 用户
**当前版本**：v0.20.0（不 bump）
**来源**：跨工作区协作请求 `dsh-git-commit-agent`（`docs/BETTER-SIDEBAR-INTEGRATION.md`）

## 1. 背景

`dsh-git-commit-agent`（独立 Git Commit 专用 Agent 插件，自有业务 API 与持久化）需要
better-sidebar 暴露两个公开接缝，否则其能力无法从外部实现：

1. 在「Git 视角」提交区挂一个自己的按钮，并知道「用户正在看的 repo / worktree / staged 行」；
2. 把计划里每个 commit 的 patch 当 diff 预览。

原请求（对方草案）见 `dsh-git-commit-agent/docs/BETTER-SIDEBAR-INTEGRATION.md`。本设计
在其基础上按本仓库架构做了收敛，**去掉两个宿主用不到的描述符字段**（`title` / `icon`）：
宿主直接渲染注册的组件，控件（图标、文案、disabled）由组件自己拥有，宿主只负责位置与
生命周期——与 `FileIconDescriptor`「工厂自己画」的先例一致。

## 2. 目标

- 两个接缝都**纯增量**：注册即返回 disposer；零注册时提交区与 diff 行为与之前逐字节一致。
- 只改 `src/`；不改 DSH 官方源码、不改 `lib/` 生成产物。
- 走既有渲染栈（`parseUnifiedDiff` / `DiffFiles`）与既有注册表模式（Map + listener set）。
- 不复制消费插件的职责：better-sidebar **不**存业务状态、**不**建会话、**不**跑计划侧 git。

## 3. 非目标（Out of Scope）

- 不暴露 `DiffPane` 内部结构，不为消费插件加 `/sidebar/api` 路由。
- 不做计划审批 UI、不做"回到来源会话"的跳转（消费插件可自行调宿主
  `ctx.sessions.open?.(sessionId)`）。
- 不改 `SidebarDiffRef` 既有两个 variant 的任何字段含义。

## 4. 公开契约

### 4.1 `gitCommitActions`（提交行动作）

新增类型（`src/client/service.ts`）：`GitCommitTarget`、`GitCommitActionProps`、
`GitCommitActionDescriptor`。新增服务方法：

```ts
registerGitCommitAction(descriptor: GitCommitActionDescriptor): () => void
getGitCommitActions(): readonly GitCommitActionDescriptor[]
getGitCommitTarget(scope?: SessionScope): GitCommitTarget | undefined
/** @internal GitLens 发布的写口 */
setGitCommitTarget(ownerId: string, target: GitCommitTarget | null): void
```

- `GitCommitTarget` = 来源 `scope` + `repoRoot?` + `worktree?` + `branch?` + `status` +
  `staged`（与内置 Commit 按钮同一门槛的 index 侧行）。
- 渲染位置：`css.gitCommit` 行内、内置 Commit 按钮之后；`order` 升序（缺省 100）→ 注册序；
  `available === false` 跳过（抛错记 console.error 后跳过）。每个动作套 `RenderBoundary`。
- 注册/注销都走既有 `subscribe()` 通知，挂载后注册即时出现。
- **发布 target 不通知订阅者**：GitLens 自身是订阅者，若发布即通知会形成
  发布→通知→重渲染→再发布 的自环。因此 `getGitCommitTarget` 是**时点读**；渲染在提交行的
  插件直接吃 props，别处读的插件自行 `subscribeState` / 轮询重读。
- target 按 GitLens 实例 ownerId 键控（`Map<ownerId, {seq, target}>`），`getGitCommitTarget`
  取最近发布；卸载即清自己的项，多实例互不踩。

### 4.2 `planDiff`（计划 diff）

`SidebarDiffRef` 增补：

```ts
| { kind: 'proposed'; id: string; title: string; patch: string; worktree?: string; repoRoot?: string }
```

- `patch` 原样走 `parseUnifiedDiff` / `DiffFiles`；`proposed` **不跑任何 git 调用**。
- 折叠：没有 git revision 可读 → `resolveFold` 传 `undefined`，折叠降级为不可用标记。
- `worktree` / `repoRoot` 仅展示元数据（保持与既有 variant 的可选字段同形，避免消费方
  联合类型收窄成本）。
- 新增 `GitDiffRef = Extract<SidebarDiffRef, {kind:'worktree'|'commit'}>`：Git lens 预览/
  `ChangesPreview` / `diffTabOf` 只处理这两个 kind，`proposed` 只经 `openTab` 进入 diff tab。
- `openTab` seed：`{ type:'diff', id, title, diff:{ kind:'proposed', id, title, patch } }`。
  原生右侧栏的 tab id 由宿主铸造（seed.id 只影响 onOpen 合成 tab），`patch` 随导航 params 下发。

## 5. 改动文件

| 文件 | 改动 |
| --- | --- |
| `src/client/state.ts` | `proposed` variant + `GitDiffRef` |
| `src/client/service.ts` | 三个新类型 + 四个服务方法 + features |
| `src/client/changes/GitLens.tsx` | 发布 live target、订阅注册表、渲染动作 |
| `src/client/changes/ChangesTab.tsx` | 取 `ctx.get('betterSidebar')` 并透传 |
| `src/client/changes/DiffPane.tsx` | `ChangesPreview`/`diffTabOf` 收窄到 `GitDiffRef` |
| `src/client/DiffTab.tsx` | `proposed` 直出 patch + 标题 |
| `src/client/changes/changes.module.css` | `.gitCommitActions` / `.gitCommitActionBoundary` |
| `src/client/locales*.ts` | `gitCommitActions`（zh/en + 19 语言） |
| `docs/external-plugin-guide.md` | §1 / §4.4 / §7 / 新 §7.2 |
| 测试 | `tests/git-commit-actions.spec.tsx`、`tests/diff-tab-proposed.spec.tsx`、`tests/service.spec.ts`、`tests/consumer-types.ts` |

## 6. 与对方草案的差异

| 草案 | 本实现 | 理由 |
| --- | --- | --- |
| descriptor 带 `title` / `icon` | 去掉，`component` 自带控件 | 宿主直接渲染组件，两个字段在宿主侧无消费点（死 API）；参考 `FileIconDescriptor` |
| `setGitCommitStatus(ownerId, targetKey, status)`（可选） | 未实现 | 状态展示归消费插件自己的组件；宿主不存业务状态 |
| 无 target 读取器 | `getGitCommitTarget(scope?)` | 消费插件在自己的 tab 里也需要「正在看的 worktree」 |
| `getGitCommitActions` 语义未定 | 返回注册顺序快照，渲染时排序 | 与 `getTabs()` 先例一致 |

## 7. 测试与验证

- `tests/git-commit-actions.spec.tsx`：渲染位置（Commit 按钮之后）、live target 字段、
  `order`/`available`、挂载后注册与 disposer、无 service 零变化、抛错隔离、卸载清 target。
- `tests/diff-tab-proposed.spec.tsx`：patch 渲染、标题、**零 git 调用**、空 patch。
- `tests/service.spec.ts`：注册/注销通知、重复 id 抛错、owner 键控与最近发布、发布不通知。
- `tests/consumer-types.ts`：公开类型/方法的编译门。
- `pnpm typecheck` / `pnpm lint` / `pnpm test`（见 PR 描述与实际输出）。

## 8. 边界（退回给消费插件）

- 业务状态（计划、审批、执行）与持久化：`dsh-git-commit-agent` 自有 API。
- 专用会话创建与驱动：消费插件（`startDedicatedSession`），better-sidebar 不复制。
- "回到来源会话"：消费插件自行调宿主 `ctx.sessions.open?.()`。
