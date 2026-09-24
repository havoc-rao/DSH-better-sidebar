# 2026-09-24 · terminal / git 槽位最小实现（mainslot 分支基线）

> 分支：`feat/terminal-git-slot-mainslot`（自 main `8486b4b` 起，detached worktree
> `dsh-better-sidebar-mainslot`）。版本：`0.23.0-mainslot.1`。

## 背景

历史实现（commit `77ddf5e` 的 terminal source 槽位及同期 git-source 面）只存在于旧的
fork 演进线；官方 main 树的 `service.ts` / `builtins/tabs.tsx` / `TerminalView.tsx` /
`GitLens.tsx` 与旧树差异很大（服务注册表、TabComponentProps、TerminalView 的 close/park
帧协议、GitLens 迁移成 changes tab 的 lens 等）。因此**不做整体 cherry-pick**，按当前
main 代码结构以最小 diff 重新落盘两个槽位：

1. **feature `terminalSource`**（v0.22.0+）：内置 terminal tab 挂载时 first-match 解析
   provider 的 `TerminalTransport` 注入 TerminalView；无匹配/抛错/返回 undefined →
   逐字节保留内置本地 pty WebSocket 行为。
2. **feature `gitSource`**（v0.23.0+）：GitLens 的 git 数据面按 first-match 委托 provider
   的 `GitDataSource`（host `api.git*` 路由面的影子）；无匹配保持 api 直连。

## 契约（两块）

### terminalSource

- 服务面：`registerTerminalProvider({id, match(sessionId,cwd,tabId), createTransport(…)→TerminalTransport|undefined}) → disposer`；`getTerminalProviders()`；重复 id 抛错；disposer 引用比对后再删（与 `registerGitCommitAction` 样板一致）。
- 词汇（`src/client/terminal-transport.ts`，与 dsh-remote `terminalTunnel` 消费侧逐字一致）：
  `TerminalTransport = { kind, open(session) → handle }`；
  `handle = { input(data), resize(cols,rows), close(), park(), dispose(), retry?() }`；
  `session = { term: { write(data), cols, rows }, scope, tabId, cwd?, onOutput(data), onTitle?(title, info?), onConnected?(bool), onFatal?(reason|null), onEndpoint?(url) }`。
  Typed structurally，零 xterm 依赖。
- 解析：`resolveTerminalSource` 纯函数（注册序 first-match，`match`/`createTransport` 抛错与 `undefined` 工厂结果一律跳过）；`useTerminalTransport` 渲染侧 hook（useReducer tick + `service.subscribe`，registry-less stub / 无 sessionId → undefined）。
- 挂载面：`tabs.tsx` 新增 `TerminalTabTransport` 包装（TabComponentProps → `useTerminalTransport` → LazyTerminal `transport` prop）；TerminalView 读 `transport` 一次于挂载。

### gitSource

- 服务面：`registerGitProvider({id, match(sessionId,cwd), createSource(…)→GitDataSource|undefined}) → disposer`；`getGitProviders()`。
- `GitDataSource` = host `git.*` 路由面 12 方法影子（签名与返回形状逐字一致，另有
  `gitCommitDiff`/`gitShow` 不在契约内保持宿主直连）；`GitOkResult = { ok: true }`。
- 解析：`resolveGitSource`（throwing-safe，同 terminal 风格）；`useGitSource(ctx, scope)`
  （memo 依赖 `[service, sessionId, cwd, repoRoot, tick]`）。
- 消费面：`GitLens.tsx` 新增可选 `ctx` prop（ChangesTab 传入），`gitApi = useGitSource(ctx, gitScope) ?? api`，
  文件内全部 16 处 `api.git*(` 调用改 `gitApi.git*(`（`import { api }` 保留作回退）；
  `gitSource` 并入 `refreshTarget` / `refresh` 的 useCallback deps，provider 注册变化能落入轮询刷新路径。

## diff 策略（main 之上、不迁本地逻辑）

- 新增 3 个文件：`terminal-transport.ts`（纯类型）、`terminal-source.ts`、`git-source.ts`。
- `TerminalView.tsx` 只加 transport 分支：mount effect 内 `transportHandle` 生命周期
  （open → resize/input 转发 → unmount 三态 close/park/dispose），本地 WS 路径（sendResize
  兜底、connect/重试、close-code banner、deps banner）零改动；onData 的 transport 分支插在
  `tracker.onData` 之后、socket.send 之前。
- 版本：`package.json` / `dsh.plugin.json` / `SIDEBAR_SERVICE_VERSION` 三处锁步
  → `0.23.0-mainslot.1`（仓库 release 惯例，`tests/service.spec.ts` 与
  `tests/manifest-consistency.spec.ts` 守护锁步）。

## 验证清单

- [x] `pnpm typecheck`：0 错误（含新 spec 与 `consumer-types.ts` 类型演练）。
- [x] `pnpm build`：成功产出 `lib/`（tsc + tsdown）。
- [x] 新 spec：`tests/terminal-source.spec.tsx`（12）+ `tests/git-source.spec.tsx`（7）全绿。
- [x] 受影响既有 spec：`service` / `manifest-consistency` / `builtins` / `lazy-chunk` /
  `changes-tab` / `git-commit-actions` / `git-view-worktree` / `plugin-shape` 全绿。
- [x] 静态证据（`lib/client.js`）：`registerTerminalProvider` / `registerGitProvider` /
  `getTerminalProviders` / `getGitProviders` 计数均为 3，`terminalSource` 3 处、`gitSource` 7 处。
- [x] `git show --stat` 仅限预期文件（见提交）。

## 已知边界

- **gitSource 消费面 = GitLens 的 api 影子方法集**：只覆盖 GitLens 数据面（status /
  worktrees / branch / log / diff / stage / unstage / commit / checkout / discard / revert /
  cherry-pick）；explorer 的 git-status 装饰与其它 `api.git*` 调用点（`gitCommitDiff` /
  `gitShow` 等）不在本次槽位内，保持宿主直连。
- **TerminalView transport 分支不迁移本地 WS 逻辑**：banner 状态机、close-code 1011 的
  deps/shell 特判、自动重连、resize 帧协议全部属于本地路径；provider transport 只复用
  `onConnected/onFatal/onEndpoint` 与 handle 的 retry 面。
- `agent:` / `gb:` tab 由 provider 在 `match` 中自行拒绝，平台不强制拦截。
- `useGitSource` / `useTerminalTransport` 的 registry-less stub 与无 session 挂载一律解析
  undefined（stub 绝不破坏终端/git 面）。

## 实施偏差（2026-09-24，远程 git 通道打通）

上一节的「`gitCommitDiff`/`gitShow` 不在契约内保持宿主直连」在本轮被推翻（远程会话 diff
断的根因）：`GitDataSource` 补齐全部 14 方法（diff 预览与独立 diff tab 的 git 读全量经
source 路由）。偏差记录：

1. **契约扩展**：`GitDataSource` 新增 `gitCommitDiff` / `gitShow`（签名与 host 路由逐字
   一致）；`tests/git-source.spec.tsx` 的 `_hostShadowsContract` 编译期形状守护自动覆盖。
2. **消费面扩展**：DiffPane（ctx prop + `useGitSource`）与 DiffTab（无 ctx，经模块级
   client-ctx 座位 `bindGitSourceSeat` / `useGitSourceSeat`，index.tsx apply 绑定/卸载解绑）
   的 git 读改为**逐方法回退**路由 `(gitSource?.gitX ?? api.gitX)(...)`；GitLens 的
   refreshTarget / loadMoreLog 里 `gitApi.gitLog`（以及同 Promise.all 里的
   gitStatus/gitBranch）包成 `Promise.resolve().then(...)` 先回 Promise 再调用，缺方法的
   同步 TypeError 不再炸掉整次刷新——历史区单独降级为空，status/branch 照常渲染。
3. **vitest 收集**：`vitest.config.ts` exclude 增加 `**/tmp/**`（与 `**/.worktrees/**` 同类：
   agent 任务遗留的完整仓库副本漂移后污染本地测试链）。