# Git 数据源槽位（Git Source Slot）

**日期**：2026-09-10
**状态**：已实现（无实施偏差）
**目标版本**：v0.23.x

## 1. 目标

对照 FileTree 的 data-source 槽位（`registerFileTreeProvider`，v0.17+ / `file-tree-source.ts`）与
terminal 的 data-source 槽位（`registerTerminalProvider`，v0.22+ / `terminal-source.ts`），为**所有
git 数据面**开放一个 **git source / provider 槽位**：外部插件（尤其是 dsh-remote）可以注册为一个
git 数据源，接管**它所属会话**的 git 读取与变更操作——GitView 面板、explorer 的 git 状态装饰、
diff 标签页——UI（面板、树装饰、diff 视图）保持原样。

一句话契约：**每个 git 数据面在取数时经注册表解析数据源；有匹配 provider 时，把宿主 `git.*`
路由的调用换成 provider 数据源的同签名方法，否则保持宿主 `git.*` 路由逐字节不变。**

动机（来自用户指认的 `GitView.tsx` git 状态信息）：dsh-remote 会话的 cwd 是**本地镜像**，
宿主 `git.status` 对镜像运行 git——镜像可能缺失/过期（多数 dsh-remote 镜像不含 `.git`），
面板停在「不是仓库」占位（GitView 第 961 行附近），explorer 树装饰也拿不到远端仓库状态。
dsh-remote 需要把**远端主机上的权威 git 状态**（以及历史/分支/变更操作）喂给宿主的 git 表面。

## 2. 背景（已核实，避免重做）

- 宿主 git 数据面的全部取数都经 `api.ts` 的 `git.*` 路由函数（host `/sidebar/api`），
  方法签名统一为 `(scope: SessionScope, worktree?, signal?)` / 变更类 `(scope, …args, worktree?)`：
  - **读取**：`git.status`（`GitStatusResult`）、`git.worktrees`（`GitWorktree[]`）、
    `git.branch`（`{current, names}`）、`git.branch-status`（`GitBranchStatus`）、
    `git.branch-tips`（`{tips}`）、`git.log-graph`（`GitGraphEntry[]`）、
    `git.diff`（`{diff}`）、`git.commit-diff`（`{diff}`）；
  - **变更**：`git.stage` / `git.unstage`（path? + worktree?）、`git.commit`（message）、
    `git.checkout`（branch）、`git.fetch`（prune?）、`git.discard`（path）、
    `git.revert`（hash）、`git.cherry-pick`（hash）；
  - **不纳入**：`git.commit-draft`（AI 草稿 = 宿主 agent 关注点，不是仓库数据；dsh-remote 行
    不通，保持不变）、`git.log`（客户端无调用面，不声明）。
- 消费点（本次接线）：
  - `GitView.tsx`：`refreshTarget` / 2s 静默轮询 / 变更动作共 16 处 `api.git*` 调用；
  - `DiffTab.tsx`（含 `loadReviewPatch`）：`git.status` / `git.diff` / `git.commit-diff`；
  - `TreePanel.tsx`：装饰取数 `git.status`（137-167 行）；provider 会话按
    `fileTreeCapabilityOn(fileSource, 'git')` 门控（上一轮 fileTree-source 的能力降解面：
    「provider 会话的 git 装饰默认关闭」——缺的正是喂数据的地方）。
- 参考范式（terminal-source.ts / file-tree-source.ts 的共同规则）：注册顺序 first-match wins；
  `match` / `createSource` 抛错跳过该 provider（console.error）；`createSource` 显式返回
  `undefined` = 按会话拒绝；无人匹配 → `undefined` = 默认宿主路径；注册表经 `service.subscribe`
  通知，渲染侧 hook 订阅后 live 重解析；重复 id 注册抛错，disposer 注销（HMR-safe）。

## 3. 非目标（v1 边界）

- **不改宿主 git 路由**：provider 契约是**客户端侧**的影子面；host 侧 `git.*` 路由原样保留
  （本地会话、无 provider 会话继续用）。
- **不做本地会话的接管**：槽位只服务 provider 声明 `match` 的会话；`api` 本身可整体视为
  一个默认数据源（结构性同签名），因此无匹配时消费方一行 `source ?? api` 即回退。
- **不给 provider 新增设置项/UI**：纯注册表 + 纯解析，无 Side card 开关、无指示器。
- **provider 不感知 UI**：host 的 GitView/TreePanel/DiffTab 零 UI 改动，只换取数函数。
- **`git.commit-draft` 保持宿主**：AI 草稿走 host 的 one-shot agent（`llm.*` 路由），
  与仓库数据无关。
- **不重写 `buildGitStatusMap` 的纯逻辑**：装饰 overlay 的聚合/着色全部复用 git-status.ts；
  只是 provider 会话把 scope 换为 `status.root`（远端路径语义由 provider 决定）。

## 4. 设计

### 4.1 公开 API（`src/client/git-source.ts` 新模块，核心 bundle 零新依赖）

```ts
// feature: 'gitSource'
interface GitProviderDescriptor {
  /** 唯一 id（建议包前缀，如 'dsh-remote'）；重复注册抛错。 */
  id: string
  /** 会话谓词：这个 provider 是否接管该会话的所有 git 数据面？
   *  first match wins。参数原样透传（无本地路径转换）：
   *  - sessionId：tab/面板所属会话（diff tab 以打开它的会话解析）；
   *  - cwd：会话工作目录（dsh-remote 是本地镜像路径——远端语义由 provider 自己解析）。 */
  match(sessionId: string, cwd: string | undefined): boolean
  /** 一个会话的 live 数据源工厂。返回 undefined = 按会话拒绝（下一个 provider 接棒）；
   *  抛错同样跳过。保持廉价与无副作用——每次解析渲染都会调用。 */
  createSource(sessionId: string, cwd: string | undefined): GitDataSource
}

/** 一个会话的完整 git 数据面。每个方法与宿主 api 的 git.* 路由函数
 *  同签名（参数、返回形状逐字节一致）——消费方 `source.gitX(...)` 与
 *  原 `api.gitX(...)` 可互换，无任何适配层。scope 原样携带 repoRoot
 *  （chooseRepo 选中的子仓库），路径语义由 provider 决定。 */
interface GitDataSource {
  gitStatus(scope: SessionScope, worktree?: string, signal?: AbortSignal): Promise<GitStatusResult>
  gitWorktrees(scope: SessionScope, signal?: AbortSignal): Promise<GitWorktree[]>
  gitBranch(scope: SessionScope, worktree?: string, signal?: AbortSignal): Promise<{ current: string; names: string[] }>
  gitBranchStatus(scope: SessionScope, worktree?: string, signal?: AbortSignal): Promise<GitBranchStatus>
  gitBranchTips(scope: SessionScope, branches: readonly string[], worktree?: string, signal?: AbortSignal): Promise<{ tips: GitBranchTip[] }>
  gitLogGraph(scope: SessionScope, count?: number, skip?: number, worktree?: string, signal?: AbortSignal): Promise<GitGraphEntry[]>
  gitDiff(scope: SessionScope, path: string | undefined, staged: boolean, worktree?: string, signal?: AbortSignal): Promise<{ diff: string }>
  gitCommitDiff(scope: SessionScope, hash: string, worktree?: string, signal?: AbortSignal): Promise<{ diff: string }>
  gitStage(scope: SessionScope, path?: string, worktree?: string): Promise<{ ok: true }>
  gitUnstage(scope: SessionScope, path?: string, worktree?: string): Promise<{ ok: true }>
  gitCommit(scope: SessionScope, message: string, worktree?: string): Promise<{ ok: true }>
  gitCheckout(scope: SessionScope, branch: string, worktree?: string): Promise<{ ok: true }>
  gitFetch(scope: SessionScope, worktree?: string, prune?: boolean, signal?: AbortSignal): Promise<{ ok: true }>
  gitDiscard(scope: SessionScope, path: string, worktree?: string): Promise<{ ok: true }>
  gitRevert(scope: SessionScope, hash: string, worktree?: string): Promise<{ ok: true }>
  gitCherryPick(scope: SessionScope, hash: string, worktree?: string): Promise<{ ok: true }>
  /** 可选 live 变更通道：provider 在远端仓库状态可能变化时 bump（如
   *  外部 rw_exec 改了工作树）。宿主消费方仅在解析到 provider 时订阅
   *  它（与既有 2s 轮询 / 共享变更总线并存）。返回 disposer。 */
  subscribe?(listener: () => void): () => void
}
```

解析器与 hook（与 terminal-source 同构）：

```ts
/** 纯解析：注册顺序 first-match wins；match/createSource 抛错或
 *  createSource 返回 undefined 跳过；无匹配 → undefined。 */
function resolveGitSource(providers, sessionId, cwd): GitDataSource | undefined

/** 渲染侧 hook：订阅注册表（service.subscribe）live 重解析；
 *  ctx 缺省 / 服务桩 / 无注册表 → undefined（宿主路径逐字节不变）。 */
function useGitSource(ctx, sessionId, cwd): GitDataSource | undefined
```

消费侧一行式回退：`const git = useGitSource(ctx, sessionId, cwd) ?? api` ——
`api` 与 `GitDataSource` 结构性兼容（同签名），无 provider 时一切与历史逐字节一致。

### 4.2 服务接线（`src/client/service.ts`）

- `registerGitProvider(descriptor): () => void` / `getGitProviders(): readonly GitProviderDescriptor[]`，
  同 `registerTerminalProvider` 的 Map + notify + dup-id-throw 实现；
- `SIDEBAR_FEATURES` 追加 `'gitSource'`（v0.23.0），interface 文档段说明槽位语义。

### 4.3 消费接线

| 面 | 改动 |
|---|---|
| `GitView`（新增 `ctx?: Context` prop，tabs.tsx 传入） | 全部 16 处 `api.git*` → `git.*`（`git = useGitSource(...) ?? api`）；`historyPage` 改收 `git` 参；provider `subscribe` 触发即时 refresh（与 2s 轮询、共享总线并存） |
| `DiffTab`（新增 `ctx?: Context` prop） | `loadReviewPatch` / 面板取数走 `git.*`（status/diff/commit-diff） |
| `TreePanel` 装饰 | `loadGitStatus`：`gitSource !== undefined` 时经 `gitSource.status({sessionId, cwd})` 取数；overlay scope = provider 会话用 `status.root`（远端根语义）、本地沿用 cwd；provider `subscribe` 驱动重取 |
| `file-tree-source.ts` | `capabilities.git` 文档更新：声明 `git: true` 的 provider 会话打开装饰门，**数据**来自 git 数据源槽位（`'gitSource'`） |
| `FileTree.tsx` 等装饰渲染 | 零改动（`gitStatus` map 的形状不变） |

### 4.4 装饰门的组合规则（TreePanel）

```
gitOn = localMode || fileTreeCapabilityOn(fileSource, 'git')
decorations = gitSource !== undefined
  ? (gitOn && gitSource 已解析)   // provider 喂数据（远端根/远端路径 overlay）
  : gitOn                          // 宿主 git.status（现状逐字节）
```

即：**两类 provider 各出一个条件**——git 数据面 provider 负责**数据**，file-tree provider 的
`capabilities.git` 负责**许可**；两者都满足才装饰 provider 会话（与「放开装饰门」的用户决策一致）。

## 5. 测试

- `tests/git-source.spec.ts(x)`：解析语义（空注册表 → undefined、first-match wins、
  抛错/undefined 工厂跳过、参数原样透传）、`api` 结构性兼容、注册表（dup-throw / dispose /
  features 含 `'gitSource'`）、hook 的注册表 tick 重解析（沿用 terminal-source.spec 的录制手法）；
- `tests/tree-git-status.spec.tsx` 扩展：provider 会话（`registerFileTreeProvider` + `git: true` +
  注册 git provider）装饰取数走 provider、bus/订阅刷新；
- 既有 GitView/DiffTab/TreePanel 测试零被迫改动（无 ctx → 宿主路径）。

## 6. 消费侧（dsh-remote）

provider 实现由 dsh-remote 仓库承接（另行委派）：按 `(sessionId, cwd)` 判定镜像会话，
`createSource` 返回一个把所有方法经其 SSH 连接的远端 git 命令实现的 `GitDataSource`，
宿主 `features.includes('gitSource')` 时注册。宿主侧保证：provider 会话的面板/装饰/变更
操作全部落到远端 git，本地会话逐字节不变。