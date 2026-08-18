# 工作区绑定窗口（Workspace-bound Windows）

**日期**：2026-08-17
**状态**：设计中（实施偏差记录见文末）
**目标版本**：v0.13.x

## 1. 目标

给侧边栏 tab 增加「绑定到工作区」能力：

1. **右键菜单**：tab 上右键出现「绑定到工作区」/「解除工作区绑定」。
2. **绑定语义**：绑定后，该窗口成为**工作区级共享窗口**——同一 workspace 下的**所有 session** 都渲染这个窗口（stub 落在被绑定 tab 当时所在的面板：右区 → 右面板第一叶，下区 → 底部 box 第一叶）。
3. **状态同步**：窗口的**定义**（type / path / diff / title / meta）跨 session 同步——在 session A 里把绑定的文件窗口切到另一个文件（原地切换 / 打开新文件），session B 的同名窗口立即跟随。

## 2. 非目标（v1 边界）

- **不做编辑器缓冲级同步**：光标、滚动、未保存草稿不跨 session 共享（同一 workspace 目录下文件内容天然一致，各 session 自行 `fs.read` 加载；文档明示该限制）。
- **agent 终端（`agent:` 前缀）不可绑定**：模型创建/关闭它们，reconcile 会与 pin 冲突；右键菜单对 agent 终端不出现（其余类型全部可绑定）。
- **终端是「窗口 + 进程真正共享」**：绑定一个终端 = 整个 workspace **一个共享 PTY**（host 键 `shared:<tabId>`，不带 sessionId）——长期挂起的进程（服务/监听器）在所有 session 同一画面；首个连接的 cwd 生效、不因其他会话 cwd 不同而重启；共享 PTY 不占 per-session 配额，只随窗口全工作区关闭或插件卸载而消亡。git/subagent/Files 首页是共享窗口、各 session 渲染自己的实例（无进程态）。
- **不做窗口拖拽排序 / 工作区窗口管理器 UI**（绑定顺序 = 绑定时间顺序）。
- **绑定窗口只进底部面板（bottom box）**：stub 渲染在 `bottomSplits` 第一叶；右面板不受影响。绑定操作会**展开当前会话的底部面板**让结果可见；其他会话保持原样（用户自行展开）。
- **关闭二次确认**：pin 窗口是共享窗口（✕ = 全工作区关闭），误触代价大——第一次点 ✕ 进入红色待确认态（2s 超时，点其他 tab/开菜单即解除），第二次点击才真正关闭；普通 tab 仍单击即关。
- **只进右面板**：绑定窗口渲染在右面板 split 树的**第一叶**；底部面板不渲染（v1 保持单一工作台语义，避免"两处不同步"的新困惑）。
- **不做窗口拖拽排序 / 工作区窗口管理器 UI**（绑定顺序 = 绑定时间顺序）。
- **绑定窗口只进底部面板（bottom box）**：stub 渲染在 `bottomSplits` 第一叶；右面板不受影响。绑定操作会**展开当前会话的底部面板**让结果可见；其他会话保持原样（用户自行展开）。
- **关闭二次确认**：pin 窗口是共享窗口（✕ = 全工作区关闭），误触代价大——第一次点 ✕ 进入红色待确认态（2s 超时，点其他 tab/开菜单即解除），第二次点击才真正关闭；普通 tab 仍单击即关。
- **不改 host 半逻辑、不修改 DSH 源码**；不新增 PrefsSchema 字段（无设置项）。
- 不做跨浏览器 tab 的实时同步（localStorage 同源共享，同浏览器多窗口天然同步；跨设备/多窗口实时推送是 host 存储改造，超出插件范围）。

## 3. 现状回顾

- DSH 有成熟的 workspace 概念：host `dsh-workspace` 持久化 `workspace.json`（`path` / `title` / `sessionIds`），client 运行时 `WorkspaceRuntime`（`ctx.workspaces`）暴露 `list: SnapshotStore<WorkspaceListState>`（`items: WorkspaceView[]`，`WorkspaceView = { workspaceId, path, title, sessionIds[], … }`）。插件当前只镜像了 `openPath`（`context-types.ts` 的 `SidebarWorkspacesService`）。
- 侧边栏状态**按 session 隔离**：`SidebarStore.bySession: Map<sessionId, SidebarState>`，localStorage 键 `dsh-sidebar:v1:<sessionId>`，`setSession` / `reduceFor` 惰性加载；右/下面板是两棵独立 split 树（`splits` / `bottomSplits`），tab 永不跨树。
- tab strip 是 `TabBar`（`split-pane.tsx` 的 `LeafView` 内）；右键菜单有现成模式（`FileTree` 的 `Menu + getAnchorRect` 光标定位 + portal）。
- `SidebarTab = { id, type, title, path?, diff?, meta? }`；`sanitizeState` 校验持久化；`maxCounterId` 只认 `pane|tab|split:N` 前缀。

## 4. 设计

### 4.1 核心思路：stub + 单一数据源（不复制状态，不反向同步）

绑定窗口**绝不进入 session 持久化**。每棵 session 树的第一叶里只有**占位 stub**（`{ id: 'ws:<n>', type, title }`，id 稳定、跨 reload 不变）；窗口的**活定义**（path/title/meta）永远只存在工作区窗口 store 里。渲染时 stub 被解析为活定义，因此：

- 同步是**免费的**：任何 session 改定义 → store 变 → 所有 session 重新渲染；
- 没有 per-session 副本漂移问题；
- 持久化自愈：stub 剥离后 reload 时按 store 重新合并。

```
                    ┌──────────────────────────────┐
                    │ WorkspaceWindowsStore        │  ← 单一数据源
                    │  per-workspace: { tabs[] }   │     localStorage 持久化
                    └──────────┬───────────────────┘
            bind/unbind/update▲        │ resolve (render) / merge (load)
                    ┌─────────┴───────────────────┐
                    │ Session A 树     Session B 树 │
                    │ 第一叶: [本地 tabs] [ws stub]  │ ← stub 不进持久化
                    └───────────────────────────────┘
```

### 4.2 数据模型

```ts
// workspace-windows.ts（新模块）
interface WorkspaceWindow {
  id: string            // 'ws:<n>'（per-workspace 单调计数器铸造，稳定跨 reload）
  type: string          // 'editor' | 'browser'（开放集，但仅内容型可绑定）
  title: string
  path?: string
  meta?: unknown        // JSON 可序列化（如浏览器 tab 无需；editor 的 treeOpen 等）
}

interface WorkspaceWindowsBlob {          // localStorage 'dsh-sidebar:v1:ws:<workspaceId>'
  version: 1
  nextId: number
  tabs: WorkspaceWindow[]                 // 绑定顺序
}

class WorkspaceWindowsStore {
  // uSES 面（React 可订阅）
  getSnapshot(): { workspaceId: string | undefined; windows: readonly WorkspaceWindow[] }
  subscribe(listener: () => void): () => void
  // 查询
  windowsOfSession(sessionId: string): readonly WorkspaceWindow[]   // 经 session→workspace 解析
  isBoundTabId(id: string): boolean                                  // 'ws:' 前缀
  // 变更（作用于当前 active session 所属 workspace）
  bind(tab: SidebarTab): void        // 铸造 stub id；删除本 session 树中被绑定 tab 本身 + 同 type+path 的内容重复（见 4.5）
  unbind(tabId: string): void        // 从 store 移除（所有 session 消失）；本 session 转为本地 tab（见 4.6）
  update(tabId: string, patch: { title?: string; path?: string; meta?: unknown }): void
  // 内部
  attachSidebarStore(store: SidebarStore): void   // 订阅：任何变更 → 全量 reconcile 所有缓存 session 状态
}
```

### 4.3 workspace 解析（session → workspace）

- `context-types.ts` 的 `SidebarWorkspacesService` 镜像扩展 `list: { getSnapshot(): SidebarWorkspaceListState; subscribe(fn): () => void }`（结构镜像运行时 `WorkspaceRuntime.list`，保持 Node-free）。
- `WorkspaceWindowsStore` 订阅 `ctx.workspaces.list`：`workspaceOfSession(sessionId)` = 线性扫描 `items[].sessionIds.includes(sessionId)`；不在任何 workspace（未分组 session）→ 无窗口、绑定菜单禁用并提示。
- 每次窗口 store 的 snapshot 携带**当前 active session 解析出的 workspaceId**（undefined = 无）。

### 4.4 reconcile（合并/剥离，幂等）

`reconcileWorkspaceWindows(state, windows): SidebarState`（state.ts 的纯函数）：

- 取 `bottomSplits` 树**第一叶**（pin 窗口放底部 box）：
  1. 移除 id 以 `ws:` 开头、但不在 `windows` 里的 stub（解除绑定的残留）；
  2. 为 store 里缺失的窗口追加 stub（`{ id, type, title }`，title 仅作持久化占位）；
  3. `active` 指向已移除 stub 时置 null。
- 幂等；不触碰其他叶、不触碰底部树。

触发点：

1. **loadState**（`setSession` / `reduceFor` 的加载路径）：sanitize 后按 `windowsOfSession(sessionId)` 合并；
2. **窗口 store 任何变更**（bind/unbind/update）：`SidebarStore.attachWorkspaceWindows(source)` 订阅 → 对 `bySession` 全部缓存状态 + 当前 snapshot 跑 reconcile（代价 O(tabs)，会话数小）；
3. **持久化前**：`stripWorkspaceWindows(state)` 剥离所有 stub，并把指向 stub 的 `active` 置 null（否则下次 sanitize 因 active 悬空判定为结构损坏、整棵树回退默认）。

### 4.5 绑定（bind）

1. 校验：当前 session 有 workspace；非 agent 终端（模型托管，排除）。
2. 铸造 stub id：`ws:<wsId8>:<n>`（per-workspace 计数器，持久化在 blob 里，跨 reload 稳定）。
3. 定义（type/title/path/diff/meta）写入 store → store 变更 → 全量 reconcile。
4. 本 session 树里删除**被绑定的 tab 本身**（两个树）；内容窗口（有 path）同时删同 type+path 的重复——path-less（终端等）**不**删同类型本地 tab（其他本地终端不是重复）。绑定后**展开底部面板**（`bottomOpen: true`）；若被绑定 tab 曾是 active（任意位置），底部第一叶的 active 交给新 stub。
5. 身份规则：内容窗口按 type+path 去重（重复绑定聚焦既有 stub）；path-less 窗口**永不去重**——绑定两个本地终端 = 两个共享终端窗口。

### 4.6 解除绑定（unbind）——两种出口

- **右键菜单「解除工作区绑定」= 分离**：窗口从 store 移除（其他 session 消失）；本 session 的 stub 原地**转为本地 tab**（用活定义物化：id 换成 `mintTabId()`，保留 path/title/meta）——"不再共享，但这个会话我还想看"。
- **关闭按钮（stub 的 ✕）= 关闭**：从 store 移除且本 session 不保留（共享窗口的关闭就是全工作区关闭）。

### 4.7 渲染层（split-pane.tsx / TabBar.tsx / Sidebar.tsx）

- **分区渲染**：`LeafView` / `TabBar` 把 tabs 分成「本地 tabs + stub tabs」两组渲染（stub 永远排最后，独立于数组顺序——无需改任何插入顺序 reducer）。第一叶内容区在本地 active 与 stub active 之间切换（`leaf.active` 是唯一 active 指针，stub 就是普通 tab，点击 stub 置 `leaf.active = stubId`，现有机制零改动）。
- **stub 视觉**：pin 图标 + `css.tabBound` 样式；**可拖拽**（pin 表示共享语义，不表示不可移动——拖动改变该会话内 stub 的位置，reconcile 只归位完全缺失的 stub）；close 按钮 aria-label「解除工作区绑定」。
- **活定义解析**：`renderTab` / `tabIconOf` / `tabBadgeOf` / TabBar 标题对 stub 走 `windowsStore` 查活定义（路径/标题以 store 为准，别的 session 改了立刻跟随）。
- **右键菜单**：`TabBar` tab div 的 `onContextMenu`（preventDefault + 记录光标坐标）→ shell 渲染 `Menu`（portal + `getAnchorRect` 定位），项：
  - 未绑定：「绑定到工作区 “<workspace title>”」（无 workspace → disabled + 提示文案）；
  - 已绑定：「解除工作区绑定」；
  - agent 终端（`agent:` 前缀）：菜单不出现（模型托管）。
- **渲染位置**：stub 渲染在**底部面板**（bottom box）第一叶——reconcile 只碰 `bottomSplits` 第一叶，右面板零变化；两个面板的 TabBar 分区逻辑通用，底部面板的 strip 同样把 stub 分区显示在尾部。

### 4.8 服务路由（service.ts）

- `createBetterSidebarService(store, windowsStore?)`：
  - `updateTab(tabId, patch)`：tabId 是 stub → 写窗口 store（`update`），不写 session 树；否则原逻辑。
  - `openTab(seed, scope)`：`seed.path` 命中当前 workspace 某绑定窗口的 type+path → 聚焦该 stub（而非新开本地 tab，防双窗口）；无命中走原逻辑。
- `SidebarStore.attachWorkspaceWindows(source)`：见 4.4。接口在 state.ts 定义（结构最小，避免 state.ts 反向依赖新模块）：
  ```ts
  interface WorkspaceWindowsSource {
    windowsOfSession(sessionId: string): readonly WorkspaceWindow[]
    isBoundTabId(id: string): boolean
    subscribe(listener: () => void): () => void
  }
  ```

### 4.9 持久化

- 窗口 blob：`localStorage['dsh-sidebar:v1:ws:<workspaceId>']`，防抖 200ms（复用 `SidebarStore.schedulePersist` 同款模式）；加载时结构校验（version/nextId/tabs 逐项），损坏回退空集。
- session 状态：**永不包含 stub**（4.4 剥离）。stub id 前缀 `ws:` 与现有 `pane|tab|split|editor|terminal|agent` 均不冲突，`maxCounterId` 正则天然忽略。

## 5. 行为变化

- 绑定后：切到同 workspace 的任意 session，第一叶尾部出现带 pin 的共享窗口；在任一 session 里原地切换其文件（editorExplorer 合并模式经 `updateTab`）或直接改路径，所有 session 跟随。
- 解除绑定（分离）：当前 session 保留为本地 tab，其余 session 消失。
- 关闭绑定窗口：全 workspace 消失。
- 未分组 session（不在任何 workspace）：右键菜单显示禁用态「绑定到工作区」（提示：当前会话不属于任何工作区）。
- 设置页禁用某 tab 类型**不影响**已绑定窗口的渲染（显式 pin 优先；`openTab` 的新开/聚焦路径仍受启用态 gating）。

## 6. 测试

- `tests/workspace-windows.spec.ts`（store 单测，模拟 localStorage）：
  - bind/unbind/update 的 store 状态与持久化 blob；
  - 铸造 id 稳定（`ws:<n>` 单调、reload 后不重复）；
  - sanitize：损坏 blob 回退空集；
  - `windowsOfSession` 解析（含未分组 → undefined）；
  - `isBoundTabId` 前缀判定。
- `tests/workspace-windows.spec.tsx`（jsdom 渲染）：
  - reconcile：合并/移除/active 悬空修复、幂等；
  - 持久化剥离（stub 与悬空 active 不出现在写出的 JSON）；
  - 分区渲染（stub 恒在尾部、pin 标记、不可拖拽）；
  - 右键菜单项（绑定/解除/禁用态）。
- `tests/service.spec.ts` 增补：`updateTab` stub 路由；`openTab` 命中绑定窗口时聚焦 stub 不新开。
- `tests/e2e/mount.e2e.ts` 不动（新功能无默认挂载物，注册面零变化）。

## 7. 兼容性

- 纯增量：`SidebarStore` 新增可选 attach；service 工厂新增可选参；context-types 镜像扩展（只加字段，不破坏现有消费）。
- 旧持久化：session 状态里没有 stub（从来不会有），零迁移。
- 未安装/未就绪 `ctx.workspaces.list`（老运行时）：`windowsOfSession` 返回空，右键菜单绑定项禁用——插件其余功能不受影响。
- 无版本号 bump 决定（发布时定；`SIDEBAR_FEATURES` 可追加 `'workspaceWindows'` 供消费插件 gate，本期先不加）。

## 8. 实施偏差记录

- **stub id 前缀带 workspace 短 id**：`ws:<workspaceId 前 8 位>:<n>`（设计初稿为 `ws:<n>`）。带上 workspace 前缀便于跨工作区调试与 sanitize 校验（`sanitizeBlob` 用正则提取计数并抬高 `nextId` 防手改碰撞）。
- **`attachWorkspaceWindows` 双向往返**：`WorkspaceWindowsStore.attachSidebarStore` 内同时调用 `SidebarStore.attachWorkspaceWindows(this)`——reconcile 订阅在应用层只写一行，测试的 `makePair` 也只需一行。
- **`openTab` 的 bound 聚焦多一步撤消**：`applyDedupe` 已把本地 tab 插入树后，bound 命中时需用新的 `removeTabId` 帮助函数把它再撤掉（否则本地 + 共享双窗口）。该路径归类为激活（`isCreation = false`），生命周期回调与自动展开语义与 dedupe 聚焦一致。
- **bind 的 already-bound 路径也清本地重复**：设计初稿只聚焦；实现中 `stripLocalDuplicates` 在两条路径共用（防御 open 管道未拦截的本地重复）。
- **bind 焦点语义**：仅当被绑定 tab 是激活 tab 时，stub 接替 `leaf.active`（初稿"始终聚焦 stub"改为"跟随原激活"）；判定从"第一叶 active"放宽为"任意位置 active"（path-less 绑定支持后，被绑定 tab 可能不在第一叶）。
- **绑定范围扩展（用户要求）**：初稿仅内容型（path）可绑定 → 实施为**全部 tab 类型可绑定**（agent 终端除外）。终端/git/subagent/Files 首页为「窗口共享、实例每会话独立」：终端 stub 直接走 UI-tab PTY 路由（host 按 `sessionId:tabId` 键控，stub id 即 tabId，零 host 改动）；`WorkspaceWindow` 增 `diff` 字段（diff 窗口绑定携带 diff ref，解除时原样物化）；bind 的删除规则改为「删被绑定 tab 本身 + 内容重复，不删同类型 path-less tab」；path-less 永不去重。
- **终端从「每会话独立 PTY」升级为「工作区共享 PTY」（用户要求）**：初版绑定终端是各会话自己的 shell（窗口共享、进程独立）——用户指出挂起的进程状态并不同步。改为 host 侧共享：`pty-manager` 对 `ws:` stub id 用 `shared:<tabId>` 键（`ptyKeyOf`），所有会话 WS 连接到同一进程；首个连接 cwd 生效且永不因 cwd 差异重启；共享 PTY 不计 per-session 配额（workspace 级）；socket 掉线不再调度关闭（其他会话可能仍连着、窗口仍在），只有 close 帧（窗口全工作区关闭）或 teardown 杀死；`pty.close` HTTP 路由与 WS close frame 都经 `ptyKeyOf` 映射。客户端零改动（tabId 透传），仅 Sidebar 的绑定关闭分支补了 WS 断线时的 `api.ptyClose` HTTP 兜底。测试：`tests/pty-shared.spec.ts` 8 例（键映射/跨会话同进程/首 cwd 生效/配额旁路/exited 重启/kill/超时关闭/keysOf 排除）。
- **终端 tab 标题跟随正在执行的命令（用户要求）**：host 在输入侧做命令行解析（`digestCommandInput`，启发式、无 shell integration）：重建输入行、回车结算、退格/ANSI 序列正确处理、取最后一条命令的第一个 token（`npm run dev` → `npm`）。标题变化经 WS 下行控制帧 `{type:'title', title}` **广播到该 PTY 的所有连接**（共享终端在全会话同时更新标题）；新 attach 时回放当前标题。client 侧 `parseDownlinkFrame` 解析控制帧，终端注册处经 `ctx.betterSidebar.updateTab` 更新标题——stub 走 windows store（全会话 + 持久化），本地终端走 patchTab。边界：多行粘贴取最后一行；密码输入等无回显场景会把明文首词当标题（启发式固有取舍，文档明示）；进程退出后标题保留最后命令。
- **stub 落点改到底部面板（用户要求）**：初稿/首版把 stub 渲染在右面板第一叶 → 用户要求「pin 到底部 box 的就放到底部」，改为 `bottomSplits` 第一叶。连带改动：bind 展开底部面板 + active 移交目标改底部树；unbind 分离物化到底部树；service 的 bound 聚焦路径改查 `bottomSplits`（activateTabReducer 把 activePane 移入底部树，auto-expand 块自动展开底部面板）；store/UI/service 测试全部改树。底部面板首次展开自动终端（`bottomPanelAutoTerminal`）与 pin 窗口共存：展开时既有行为保留。
- **测试发现的真实 bug**：`resolveTab` 最初定义在 Sidebar 的 no-session 早退 return 之后（hook 顺序破坏，首帧渲染即崩溃）——已上移；UI 测试的 uSES 快照稳定性教训（每次调用返回新对象会死循环）按既有 jsdom 模式处理。
- **绑定/解绑不再重置终端（PTY 重亲缘化，用户要求）**：初版绑定终端 = 换 tab id（本地 → `ws:` stub 或 stub → 新铸造的本地 id），而 PTY 进程身份 = `sessionId:tabId` / `shared:tabId` 键——旧键被 unmount close 帧释放、新键 attach 时全新 spawn，**每次 pin 切换都会杀掉正在跑的进程**（`npm run dev` 这类长驻进程当场死亡）。修复：host `PtyManager.reparent(fromKey, toKey, sessionId, shared)` 把**活 handle**（进程 + transcript + 命令标题 + 输入行）原地迁到新键（原地变更而非拷贝——onData/onExit 闭包捕获原对象，拷贝会让新键的 transcript 冻结在迁移瞬间）；新增 `migrated` 标记让迁入的 handle 跳过 authoritative-cwd 重 spawn（进程是故意在别处起的，换 id 不是重启理由）；绑定方向 local→shared（转共享、豁免配额）、解绑方向 shared→local（计入该会话配额）。客户端 `bind`/`unbind` 改为 async，**先 await `pty.reparent` 再换树**——旧视图 unmount 的 close 帧因此打在已空的旧键上（host no-op）；WS attach 处理器的 close 帧/掉线宽限/标题注册表改按**socket 附着时的键快照**（socketKey）而非 handle 的活键，迁移中的旧 socket 永远杀不到新键上的进程。失败降级：reparent 是 best-effort（host 无活进程即 no-op），失败回到旧的"重开新 shell"行为。✕ 关闭（unbind keep=false）不 reparent——窗口全工作区关闭仍杀共享 PTY。测试：`tests/pty-shared.spec.ts` 新增 8 例（双向迁移同进程/配额归属/cwd 差异不重 spawn/宽限取消/exited 迁移/往返单进程），`tests/workspace-windows.spec.ts` 新增 5 例（bind/unbind 的 reparent 载荷断言、非终端零调用、关闭路径零调用、失败降级）。
- **stub 落点跟随绑定时的原始区域（用户要求）**：初版"只进底部 box"再收口——pin 落在**被绑定 tab 当时所在的面板**：右区 tab → 右面板第一叶，下区 tab → 底部 box 第一叶。`WorkspaceWindow` 增 `area: 'right' | 'bottom'`（持久化在 blob；旧 blob 缺省 `'bottom'`）；bind 用 `leafWithTab(state.splits, tab.id)` 判定区域；reconcile 按区域归位缺失 stub；active 移交与 `bottomOpen` 展开只作用于该区域树；service 的 bound 聚焦路径改双树查找（auto-expand 块按 `treeOf` 自动展开宿主面板）。
- **pin 的 tab 可拖拽（用户要求）**：初版 `draggable={false}`（stub 固定第一叶）改为**可拖拽**——pin 表示"窗口是工作区共享的"，不是"不可移动"。拖动把 stub 移到任意叶/任意面板（per-session 布局），reconcile 只做两件事：从两棵树剥掉已解绑/失效的 stale stub；stub 在**任何**位置都不存在时才按 `area` 归位到第一叶（缺省/刷新回退）。不归位已拖动的 stub、不复制。注意：stub 位置不持久化（session 布局剥离 stub），刷新后回到 area 第一叶。
- **实现期抓出的两个真实 bug**：(1) 首版 `reconcileArea` 的 `dropStrays` 用 `filter()` 结果与 `node.tabs` 做数组同一性比较——filter 恒分配新数组 → reconcile 永远"有变化" → store ↔ windows 双向 notify 死循环（栈溢出）；改为 flag 跟踪真实变更。(2) bind 的 active 移交 `mapLeaf(s[targetKey], ...)` 误用**未剥离**的原始树，`[targetKey]` 计算属性把剥离结果覆盖——被绑定 tab 永远留在树里；改为 map 剥离后的树。
- **文档未写明的行为**：设置页禁用某 tab 类型不影响已绑定窗口渲染（显式 pin 优先）；底部面板不渲染 stub（reconcile 只碰右树第一叶）。
- 未做：`SIDEBAR_FEATURES` 未追加 `'workspaceWindows'`（本期无消费插件需要 gate；发布时按需加）。
