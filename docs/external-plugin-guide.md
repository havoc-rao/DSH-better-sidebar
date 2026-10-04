# 外部插件接入指南：基于 dsh-better-sidebar 实现新页面

> 面向 **消费插件开发者**：如何让你的插件向 better-sidebar 注册新的侧边栏页面（tab）和文件类型预览器。
>
> 适用版本：**v0.4.0+**（`ctx.betterSidebar` 服务）；声明式设置 **v0.4.1+**；text/number 设置行 **v0.11.0+**；badge/生命周期/定向打开/插件设置/版本探测 **v0.12.0+**；select 设置行（`settingSelect`）与外链认领（`urlTarget`）**v0.13.0+**；统一 `@deepseek-ai/cordis` 类型基底 **v0.15.2+**。当前版本 **v0.24.1**（合并基线：官方 v0.24.1 适配线 + 本地终端/文件/Git 增强；peer 下限 `^0.2.0-rc.1`，仅支持 DSH **0.2.0-rc.1+**）。**v0.19.0 移除了自绘右侧面板与自由窗口**（见 §0、§11）；**自 v0.20.0 开发线起**（**注意：0.20.0 从未发布到 npm**）官方把**浏览器视图与只读文件预览让给宿主**（`ui-sidebar-browser` / `ui-sidebar-documentpreview`，见 §4.4、§5.4）、**收敛了外链接管**（见 §4.1）、**重写了设置接入面**（`SettingsForms`，见 §8.2）、**给文件树加了实时刷新**（见 §10）——本合并基线**恢复插件自研终端**（`TerminalView` + `agent-pty`，见 §4.4），浏览器的让位照旧。
> 权威代码：`src/client/service.ts`（服务实现）、`src/client/builtins/`（内置 tab + viewer 参考实现）、`lib/types/client/service.d.ts`（类型声明）。
> 仓库开发规则（硬约束 / CI / 发版）见 [AGENTS.md](../AGENTS.md)。

---

## 0. 承载面：DSH 原生右侧栏 + 插件底部工作台（v0.19.0-alpha.0 起）

从 v0.19.0-alpha.0 起，**右列完全属于 DSH**：你的 tab 渲染在 **DSH 自己的右侧栏**里（`ctx.sidebarRight` / `ctx.sidebarRightTabs`），插件把每个 `TabDescriptor` 注册成原生 tab 类型（`kind = descriptor.id`）+ 一个原生 tab 体。插件自己只保留**底部工作台**（分栏树、会话内持久化；**本地终端已在本合并基线恢复**，并新增 workspace 级终端管理；宿主右侧栏终端仍是宿主自己的承载面）。对你的接入代码**没有影响**——仍然只调用 `ctx.betterSidebar`：

- `registerTab` / `registerFileViewer` 签名不变；
- `openTab` / `openFile` 默认落到原生右侧栏；新增可选 `OpenTabSeed.target`（`'right'` 默认 / `'bottom'` 落插件的底部工作台 / `'side'` 落**原生栏的第二个格**，见下表「在侧边打开」）；
- `updateTab` / `closeTab` / `activateTab` 认识原生 tab id（插件为每个原生 tab 维护一条合成 `SidebarTab` 记录，`tab.meta` / `tab.path` 的写入照旧生效）。

行为差异（写在这里以免踩坑）：

| 事项 | 说明 |
|---|---|
| 生命周期回调 | 原生面只有「一次打开」，不区分新建/聚焦，因此只触发 `onOpen`（`onActivate` 仅在插件自己的底部工作台里触发） |
| 去重 | 原生按 `(kind, 地址)` 去重：有 `createTab` 的类型每次新开一个 tab（sidechat / diff），其余聚焦已有 tab；`dedupeKey` 的自定义语义不参与原生面 |
| 布局持久化 | 原生栏的布局**只在内存**（刷新后回到折叠默认），插件自己的底部工作台仍然持久化 |
| 跨会话打开 | 目标会话的右侧栏 store 未挂载时，打开会排队到该会话上屏后重放 |
| 弹窗/独立会话窗口（v0.20.x） | 本插件客户端随窗口的 client runtime 一起挂载（服务、`[data-dsh-panel-host]`、底部工作台照常）。**内核未在该窗口挂 ui-sidebar-right 时**（`ctx.sidebarRight` 缺失），「right」打开不再无限排队，而是回落到插件自己的底部工作台（见 §7 / §7.1）；dsh-hotkey 的 `Cmd+Opt+B` / `Cmd+Shift+E` 等快捷键因此无需等内核改动即可打开文件树。**内核侧在弹窗窗口的 client 插件组装里包含本插件与其消费插件**仍由 DSH 负责（不属于本插件可改动范围） |
| 内置类型接管 | 插件的 `editor` 类型以 `extension` 优先级认领 `dsh-resource://file/**`（压过内置 `ui-sidebar-documentpreview` 的 `text` 预览——即 `fallback` 带），并接管内置 `files` 页面 kind（`openTab('files')` 打开插件的文件树）；插件卸载/禁用时内置实现自动复位。**但认领是有选择的**：宿主自己的文档预览已经覆盖的格式（表格 / PDF / 图片 / Office，清单见 §5.4）由 `editor.canOpen` 主动**拒绝**，地址交回内置 `text` 档 |
| 文件树实时刷新（v0.21.1+） | 插件接管了内置 `files` 页，所以宿主自己的按目录 watch 覆盖不到这棵树——插件自带一条 `/sidebar/ws/fs-watch` socket：客户端上报**已展开**的目录集，宿主侧按目录 `fs.watch`（150ms 去抖、每连接上限 64 个句柄），变动后只让那一层缓存失效并重列；目录折叠即退订。路径仍走 `fs.tree` 同一套词法解析 |
| 链接接管（v0.21.1+） | DOM 层只接管**有类型通过 `urlTarget` 声明认领**的外链（Ctrl/Cmd/Shift/Alt 点击一律放行）；一个都没认领到时**不阻止默认行为**，交回宿主。见 §4.1 的 `urlTarget` |
| path 种子的去向（v0.19.2+） | `path` seed 的含义**跟随类型**：只有 `editor`（唯一认领 `dsh-resource://file/**` 的类型）把 path 转成资源地址打开（文件落在编辑器）；**其余类型保留页面型打开**，path 随导航 params 落到合成记录的 `tab.path` 供组件消费——组件型 tab 的 path seed 不会被改道到文件编辑器（v0.19.0/0.19.1 上一切 path seed 都被改道，组件从未挂载，#632） |
| 终端（本合并基线恢复） | 插件底部工作台恢复自研终端与 Agent 终端。新本地 UI 终端由 workspace 管理，关闭视图不结束进程，可跨 session 按需连接，进程有 workspace/global 配额；旧终端与 Provider 保持原契约。宿主右侧栏终端仍由宿主管理，不能将两套实例当作同一注册表 |
| 底部工作台的开合 | 落到底部工作台的打开一律展开它（新建与聚焦都算），因此 `openTab` 的落点永远可见；开合按钮注册在 DSH 会话头的 utilities 槽（`conversation.session.header.utilities`），不在插件自己的宿主里 |
| 在侧边打开（`target: 'side'`，v0.22.0+） | 原生栏里的 tab **不在插件底部工作台的分栏树里**，所以「在侧边打开」不能写 `bottomSplits`（那样会落到用户没展开的底部工作台 = 点了没反应）。服务改为把这一步交给宿主：带 path 的 `editor` seed 走 `openResource(address, { preferNewPane: true, revealIfOpened: false })`——宿主先按自己的两格上限与空间规则尝试分栏，分不了才回退到当前格；`revealIfOpened: false` 允许与已打开的同名资源并存，因此对同一个文件再点一次也会新开一格。其余类型若传 `target: 'side'`，同样以 `preferNewPane` 落原生栏（组件型 tab 的 path 仍是组件种子）。path-less 的 `editor`（文件页）与 `'bottom'` 行为不变 |
| 新建标签页列表 | 每个 tab 类型在原生 guide 里占一行：标题取 `title` + 图标取 `icon`（缺图标时宿主补一个方块占位），说明取可选的 `description`——**宿主只在 guide 列出的条目 ≤ 4 条时渲染说明**（上游 `MAX_DESCRIBED_ENTRIES = 4`），更长的列表整列丢掉所有说明；未声明 `description` 的条目渲染成单行「图标 + 标题」（rc.1 起 `description` 回到宿主契约，但**宿主与插件都没有兜底句**，所以插件恢复字段而不恢复旧的通用句）；`hidden: true` 的类型不占行。插件的 `editor` 类型不再单独占行（它认领的文件资源由 `files` 接管页承载同一视图）。**本插件默认贡献 4 个 guide 条目**（文件 / 文件变动 / 任务管理 / 侧边对话，恰好在上限内），**但宿主的终端条目也占一行**——装了宿主终端即是 5 条，说明整列不渲染；要让说明回来，需在插件设置页关掉足够多的 tab 类型把总数压到 ≤ 4 条 |
| 新建面板的种子（alpha.2） | 在新会话打开原生新面板时，宿主从已注册的 guide 条目里播种：恰好 1 个条目 → 直接打开那一页；0 或 ≥2 个条目 → 打开指南。`revealIfOpened` 打开的「页面」在**同一 pane 内**强制去重（已在该 pane 就不再新建）；由已有 tab 地址驱动的打开不受该去重影响 |
| alpha.2 全局面板（不接入） | 插件**不采用** alpha.2 引入的全局主面板模型——根级 keyed `main` 槽（预留 key `conversation`，由 ui-conversation 注册为 `main.conversation`）、根级 `sidebar.panellist` 列表槽（`SidebarPanelMetadata` / `SidebarPanelIconOwnerProps`）、`ctx.layout.selectPanel(MainPanelId|null)` / `beginNavigation()` / `dispose()`、全局标准 prop `usePanelInfo`，以及改根级并新增会话级 `rightbar.session` 子槽的 `rightbar`——这些只作兼容保留，不向其迁移 |
| 已移除 | 插件自绘右侧面板（含宽度拖拽 / 新会话默认宽度）与**自由窗口**（`features` 里的 `'floatWindows'` 已删除，v0.18.x 及更早版本的消费者请勿再 gate 该能力）；`openByDefault` / `defaultWidthPercent` / `changesDiffFloat` 三个设置项同步删除（旧文档里的键会被忽略）；**浏览器 tab 类型**与**只读文件预览**（image / pdf / Office / 表格，宿主 0.1.7 的 `ui-sidebar-documentpreview` 接手）同样不再内置；终端在本合并基线已恢复，不属于当前移除清单，详见 §4.4 与 §5.4 |

---

### 0.1 根级资源 Inspector（feature `inspectors`）

与会话 tab 不同，Inspector 不需要激活 session，不读取/伪造 `SessionScope`。它在宿主根级右栏承载面显示，并与原生会话右栏共享一列几何；切换会话不会改变 Inspector 的资源身份。消费插件只调用 better-sidebar API，不直接碰宿主槽。

```ts
if (ctx.betterSidebar.features.includes('inspectors')) {
  ctx.effect(() => ctx.betterSidebar.registerInspector({
    id: 'dsh-gca-plan', // 稳定类型：每次激活都注册，支持冷恢复
    title: 'Plan',
    component: ({ resource, location, visible, close }) =>
      <PlanDetail resource={resource} location={location} visible={visible} onClose={close} />,
  }))
  ctx.effect(() => ctx.betterSidebar.registerInspector({
    id: 'dsh-gca-plans', title: 'Recent plans', entry: true,
    component: RecentPlans,
  }))
  const shown = ctx.betterSidebar.openInspector({
    type: 'dsh-gca-plan', id: planId, title: 'Implementation plan',
    resource: { sourceSessionId, taskId, planId, revision, digest },
    location: { section: 'commits', commitId, view: 'diff' },
  })
  // false：类型尚未注册、宿主根级承载面不存在/拒绝，或 payload 非 JSON 对象。
  // 必须留原有详情页 fallback，不得把 false 当作“已经展示”。
}
```

**公开协议**：
- `registerInspector({ id, title, component, entry? }) -> disposer`：重复 id 抛错；`title` 是 string 或 `() => string`。`entry:true` 仅在 Inspector 面板内添加固定入口，不向左栏页脚添加按钮。点击打开 `{type:id,id,resource:{}}`，因此 RecentPlans 必须支持空资源对象。
- `component` props 为 `{resource: InspectorObject, location: InspectorObject|undefined, visible:boolean, close():void}`。没有隐式当前 session；业务服务由消费插件自己的闭包注入。`visible:false` 时应暂停昂贵实时订阅。
- `openInspector({type,id,title?,resource,location?}) -> boolean`：相同 `(type,id)` 去重，同时替换 resource/location（省略 location 即清除旧定位）；成功才选择/展开根级右栏，不会切换会话。
- `getInspectors()`、`getInspectorSnapshot()` / `subscribeInspectors()` 供观察；`closeInspector(type,id)` 删除指定资源，关闭 active 时回到宿主会话右栏。未知 id 是 no-op。
- 资源与定位必须为严格 JSON 对象（嵌套数组允许；undefined、函数、循环引用、Date、NaN 等拒绝）；边界复制，最多保留最近 32 项。类型与资源/定位在浏览器 localStorage 独立保存，无激活 session 也能保存。存储不可用时内存工作仍有效。
- 冷恢复不持久化组件：等稳定类型重新注册后才恢复展示。类型卸载/HMR 保留资源但不调用旧组件；不要只在某个按钮点击时临时注册类型。旧宿主没有根级公开承载能力时返回 false，绝不造一个 fake session 兜底。

**宿主集成契约**：适配器等待可选 `sidebarRightRoot` 服务与 `rightbar.root` keyed 槽同时存在。实际公开 controller 为 `{active,register(key):disposer,open(key):void,close(key):void}`；view id/key 为 `dsh-better-sidebar:inspectors`。先注册 key 和槽，再开放 Inspector surface；部分注册失败回滚 key，卸载释放槽和 key。宿主只挂载选中的 root，owner props 为 `width/viewportWidth/canShow/close()`，**没有 visible 或 Session 绑定**，所以适配器为已挂载正文注入 `visible:true`，关闭/切换 root 时正文卸载。宿主负责有效高度、宽度、展开/收起、窄视口覆盖，以及与 `rightbar.session` 互斥。固定入口只在 Inspector 面板内渲染，不注册 `sidebar.footer.action`，也不会假冒 main panel。消费插件不得依赖这层协议，应只调用上述 service API。

### 0.2 中央会话编辑器（feature `centralEditor`）

中央编辑器是**当前窗口内、按会话隔离的主槽承载面**，不是自由窗口，也不是根级全局 main panel。客户端入口负责安装主槽 controller 并在卸载/HMR 时调用 `setCentralEditor(undefined)`；是否存在可接入的会话主槽、是否能在目标会话打开，以及缺能力时的用户提示由 controller 负责。消费插件不要自行安装 controller 或修改宿主 DOM/源码。

- 显式调用 `openCentralFile(scope, path): boolean` 打开文件；`false` 表示没有 controller 或 controller 拒绝。**不静默降级**到右栏、底部工作台或新窗口。方法存在（或 feature 声明）不等于当前宿主主槽一定可用，调用者必须检查返回值。
- `isCentralEditorActive(sessionId): boolean` 是即时查询，无 controller 时为 `false`。当前会话中央编辑器激活后，EditorHost 的普通树点击/搜索/路径输入优先走中央打开；显式「新标签页」「在侧边打开」及旧 `openTab` / `openFile` 默认行为不变。
- 文件树右键的中央打开入口**仅对文件**显示（按 service 方法存在探测）；编辑器工具栏有同名文字按钮。已有编辑器 `dirty` 时该按钮拒绝打开并提示先保存。
- 这里只重开**已保存的文件路径**，不传输 CodeMirror 实例、光标/撤销栈或未保存草稿，**不是跨窗口迁移草稿**。窗口之间没有隐式状态同步；原编辑器也不会因这次打开自动关闭。

当前实现通过 `main.conversation` 的 single 优先级注册（`-100`，不声明宿主 children）在编辑时接管，返回时注销；当前会话与原生右栏不变。宿主聊天显示子树会卸载/重挂载，宿主内存阅读锚点帮助恢复，但不承诺完整瞬态或跨刷新恢复。

中央固定多文件标签按会话保存内存草稿；CodeMirror 缓存按 activation + session + document generation 隔离，关闭/卸载清理。返回对话后 header utilities 可重新进入工作台。保存传 `expectedContent`，磁盘完整文本变化则 HTTP409 并保留草稿；内部同路径写入串行，不是跨进程原子 CAS。截断/二进制禁止编辑。底部状态胶囊展示真实运行状态，出现审批/问题/计划确认自动回到宿主对话；未保存文档提供关闭确认与浏览器卸载提示，仍不保证 HMR/刷新后恢复。第一阶段不含中央预览分栏、拖动浮条或完整 IDE 能力。

## 1. 总览：你能扩展什么

better-sidebar 从 v0.4.0 起把自己改造成一个**注册表服务**：

- **新页面（tab）**：注册一种新的侧边栏 tab 类型，出现在侧边栏 `+` 菜单里，用户点击后在自己的分栏里打开你的 React 页面；
- **文件预览器（file viewer）**：注册一种文件类型预览器，让用户在侧边栏打开文件时走你的渲染组件（覆盖或补充内置的 markdown/html/code）。**宿主自己也有文档预览**——DSH 0.1.7 的 `ui-sidebar-documentpreview` 拿走了表格 / PDF / 图片 / Office 等只读格式，本插件因此**拒绝**认领那些扩展名，你的 viewer 也接不到它们（清单与原因见 §5.4）；
- **提交行动作（git commit action，v0.20.x）**：在「Git 视角」提交行内置 Commit 按钮旁挂自己的动作，并读到「来源 session + 当前选中 repo/worktree + staged 列表」（§7.2.1）；
- **gitGraph 服务消费（v0.20.x）**：让 Git 视角的历史区通过另一个插件（dsh-git-graph）的通用 GraphTree 框架渲染（泳道/虚拟滚动/键盘），行内容仍是本插件原有的提交行（§7.2.3）；
- **计划 diff 预览（v0.20.x）**：把任意原始 unified diff 文本当 diff tab 打开（§7.2.2）。

内置的 7 个 tab（editor / git——「文件变动」统一 tab（Git 视角 + 本轮文件视角）/ subagent / sidechat / terminal / workspace-terminals / diff）和 3 个 viewer（markdown / html / code）**自己也是通过同一套 API 注册的**（吃自己的狗粮），所以外部插件的能力与内置功能完全对等。**不再内置 browser 类型，terminal 在本合并基线已恢复**：DSH 0.1.6 自带右列终端（`ui-sidebar-terminal`、kind `terminal`），与插件底部终端是不同的资源体系；浏览器是 0.1.6 的 `ui-sidebar-browser`（kind `browser`，**0.1.7 起只在 desktop profile 挂载**，Web profile 没有这个 kind）。同理，0.1.7 的 `ui-sidebar-documentpreview` 让插件的 image / pdf / Office / 表格预览失去意义，那三个 viewer 描述符（image / pdf / binary-download）已删除。

关键机制一句话：better-sidebar 的 client half 在 `apply()` 开头执行 `ctx.provide('betterSidebar', service)`（`src/client/index.tsx`），消费插件在 `inject` 里声明 `'betterSidebar'`，Cordis 保证服务就绪后才激活你的插件，然后你调用 `ctx.betterSidebar.registerTab(...)` / `registerFileViewer(...)` 完成注册，返回的 disposer 由 Cordis fiber 在卸载（HMR / 禁用）时自动调用。

> ⚠️ **服务只在 client half**：`ctx.betterSidebar` 只存在于浏览器侧。你的插件 **host 半没有这个服务**；host 半需要读 better-sidebar 状态时，走它自己的 HTTP/WS 路由（`/sidebar/api/*`、`/sidebar/file`、`/sidebar/ws/*`），不走服务。
>
> ⚠️ **桌面 shell 的 WS 基址**：页面运行在 `dsh-app://app`（deepseek-harness Electron 桌面壳）时，`location.origin` 是 shell 的协议——壳的 `protocol.handle` 会转发该 origin 的 HTTP 到宿主（`/sidebar/api`、`/sidebar/file`、`/sidebar/html`、`/sidebar/bundle` 照常使用 document-relative 地址），但**自定义协议没有 WebSocket 载体**，`ws://app/sidebar/ws/*` 必然失败。宿主把物理 loopback 基址放进 `globalThis.__DSH_TRANSPORT__.streamBaseUrl`（产品自己的 client 也用它解析 `api/remote.mux`，壳侧会对这些 socket 注入会话 cookie）；消费插件构造 `/sidebar/ws/*` 的 WebSocket 地址时应把路径解析到该基址（`new URL(path, streamBaseUrl)` + 协议换成 `ws:`）。纯浏览器部署没有这个全局，`location.origin` 即正确基址。HTTP 请求**不要**改成绝对 loopback 地址：插件侧 trust fence 要求请求 Origin 与 Host 同名，页面直接 fetch `http://127.0.0.1:port/...` 会携带 `Origin: dsh-app://app` 而被 403 拒绝。

---

## 2. 前置：类型合并与依赖声明

### 2.1 类型合并（统一 `@deepseek-ai/cordis`）

DSH 运行时和生态的类型正主是 vendored `@deepseek-ai/cordis`。你的插件解析到它的 `Context` 时，`ctx.betterSidebar` 不会自动出现——由 better-sidebar 用 `declare module '@deepseek-ai/cordis'` 补上：

```ts
import type {} from 'dsh-better-sidebar'  // 触发 declare module '@deepseek-ai/cordis' 类型合并
```

这个 **type-only import** 在编译时被擦除，不产生任何运行时依赖，也不会触发构建纯度门（见 §10）。

### 2.2 package.json 声明

```jsonc
{
  "name": "my-plugin",
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "dsh-better-sidebar": "workspace:*"
  },
  "peerDependenciesMeta": {
    "dsh-better-sidebar": { "optional": true }
  }
}
```

- `dsh-better-sidebar` 必须是 **peerDependency**（不是 dependency），避免两份实例；
- `optional: true`：better-sidebar 未安装时你的插件照常加载，注册代码因为 `ctx.betterSidebar` 为 undefined 而安全跳过。

> ⚠️ **计划上架 DSH 插件市场**的插件还须遵守市场 manifest 约束（`dependencies`/`peerDependencies`/`optionalDependencies` 一律不得出现 `cordis`、`scripts` 不得含 install 类钩子），详见 [AGENTS.md](../AGENTS.md) 硬约束一节。

### 2.3 类型导入路径

```ts
// 方式一：主入口（推荐，src/index.ts 已 re-export 全部描述符类型）
import type {
  BetterSidebarService,
  TabDescriptor,
  TabComponentProps,
  FileViewerDescriptor,
  FileViewerProps,
  FileFetchStrategy,
} from 'dsh-better-sidebar'

// 方式二：子路径（与主入口等价）
import type { TabDescriptor } from 'dsh-better-sidebar/client/service'  // 别名 ./client/api
```

v0.12.0 起，服务模块还 re-export 了完整的状态词汇表，消费者可以直接命名（不再只能靠推断）：

```ts
import type {
  SidebarTab, SidebarState, SidebarStore, SidebarSnapshot, SidebarDiffRef, TabType,
  SessionScope, SidebarPrefs, OpenTabSeed, SidebarSettingsRenderProps,
} from 'dsh-better-sidebar/client/service'
```

> 💡 **类型合并触发路径**：`import type {} from 'dsh-better-sidebar/client/service'` 同样会加载 `Context` 的 augmentation（`declare module '@deepseek-ai/cordis'` 在 context-types.d.ts 中）——**纯浏览器侧插件建议走 `client/service` 路径**，避免拉进宿主半的 Node 类型图（主入口 `dsh-better-sidebar` 的声明面含宿主代码；宿主消费者本就处于 Node 环境则无所谓）。client 可达声明图（`client/*` + context-types + html-route + prefs-shared）自 v0.12.0 起**零 Node 依赖**（`scripts/check-consumer-types.sh` 守护），没有 `@types/node`、`skipLibCheck: false` 也能编译。

---

## 3. 最小骨架（client half）

```ts
// my-plugin/src/client/index.ts
import type {} from 'dsh-better-sidebar'          // 触发 ctx.betterSidebar 类型合并
import type { Context } from '@deepseek-ai/cordis'

export const inject = ['betterSidebar', 'slots']   // 声明服务依赖（slots 可选，按需）

export function apply(ctx: Context): void {
  // 注册一个 sidebar tab：ctx.effect 包裹 → 卸载时自动撤销注册（HMR-safe）
  ctx.effect(() =>
    ctx.betterSidebar.registerTab({
      id: 'my-plugin:db',
      title: () => 'Database',
      icon: <DbIcon />,
      order: 50,
      component: ({ scope }) => <DbView sessionId={scope.sessionId} />,
    })
  )

  // 注册一个文件预览器
  ctx.effect(() =>
    ctx.betterSidebar.registerFileViewer({
      id: 'my-plugin:csv',
      exts: ['csv'],
      fetchStrategy: 'custom',
      load: async (path, scope) => parseCsv(await fetchCsvBytes(scope, path)),
      component: ({ customData, path }) => <CsvGrid data={customData} path={path} />,
    })
  )
}
```

要点：

- **注册必须包在 `ctx.effect(...)` 里**。`registerTab` / `registerFileViewer` 返回 `() => void` disposer，Cordis fiber 卸载时自动调用；不包 effect，HMR / 插件禁用后注册残留，下次激活会抛 `"already registered"`。
- `inject = ['betterSidebar']` 让 Cordis 在 better-sidebar 激活后才激活你的插件，注册时机无忧（顺序无关）。
- 注册在 `apply` 内任意时刻都行；服务在 better-sidebar 的 `apply()` 开头就绪。

---

## 4. 新页面（Tab）注册 API

### 4.1 `TabDescriptor` 完整字段

```ts
// 设置行控件形状（settings.toggles / settings.pluginToggles 共用；text/number v0.11.0+，select v0.13.0+）：
interface SettingRow {
  key: string                              // toggles: SidebarPrefs 字段名；pluginToggles: 插件局部 key
  title: string | (() => string)
  desc?: string | (() => string)
  type?: 'switch' | 'text' | 'number' | 'select'  // 缺省 'switch'
  min?: number; max?: number               // number 行提交钳制
  placeholder?: string; unit?: string      // text 行占位符 / 单位后缀（如 'px'）
  options?: readonly {                     // select 行选项
    value: string | number | boolean
    title: string | (() => string)
    desc?: string | (() => string)
    icon?: ReactNode | ((size: number) => ReactNode)
  }[]
  multi?: boolean                          // select 多选（缺省 false；存 value 数组，按 options 顺序提交）
}
// text/number 行 blur/Enter 提交；select 任一项带 icon 时渲染大图标选项卡，否则单行文本。

interface TabDescriptor {
  /** 唯一 id；也是 SidebarTab.type 的值。建议带包前缀：'my-plugin:db'。 */
  id: string
  /** 标题（i18n 友好：传字符串或返回字符串的函数） */
  title: string | (() => string)
  /**
   * 一行说明，渲染在标题下方（DSH 原生右侧栏的新建标签页 / guide 列表）。
   * **宿主只在 guide 列出的条目 ≤ 4 条时渲染它**（上游 `MAX_DESCRIBED_ENTRIES = 4`），
   * 更长的列表整列丢掉所有说明——也就是说这是一行「锦上添花」，别把关键信息只放这里。
   * 不声明就不发 `description` 字段：宿主没有兜底句，插件也不补（通用句在所有页面上
   * 长得一样，纯噪音），条目就渲染成单行「图标 + 标题」。函数形式在渲染时求值，跟随语言。
   */
  description?: string | (() => string)
  /** 图标：ReactNode 或 (size: number) => ReactNode（不声明时宿主补一个方块占位） */
  icon?: ReactNode | ((size: number) => ReactNode)
  /** + 菜单排序（升序）；默认 100。内置：editor=10, git=20, subagent=30, sidechat=35 */
  order?: number
  /** 从 + 菜单隐藏（editor/diff 用：由其他流程触发打开，不在菜单里） */
  hidden?: boolean
  /** + 菜单禁用判定（用量配额一类）。返回 false 只影响菜单 disabled，不拦截 openTab（只有设置页禁用开关会）。 */
  available?: (ctx: Context, scope: SessionScope, state: SidebarState) => boolean
  /**
   * 单实例语法糖：`single: true` ≡ `dedupeKey: () => id`（打开时聚焦既有
   * 同类型 tab 而非新开）。显式给出 dedupeKey 时优先于 single。
   */
  single?: boolean
  /**
   * 去重键：openTab 时若已存在 dedupeKey 相同的 tab，则聚焦而非新开。
   * 返回 undefined 表示不去重（每次都新开，但同 id 会被 id 安全网聚焦）。
   * 内置策略：git/subagent 用 single；editor 用 tab.path；diff 用 tab.id。
   * 必须纯函数：每次 open 求值两次，抛错向外传播。
   */
  dedupeKey?: (tab: SidebarTab) => string | undefined
  /**
   * 自定义 tab 创建（minting SidebarTab + 状态 patch）。
   * 返回 null 拒绝创建。sidechat 用它实现「一个线程一个 tab」。
   * 省略时用默认 { id, type, title } + seed 里的 path/diff。
   */
  createTab?: (state: SidebarState) => { tab: SidebarTab; patch?: Partial<SidebarState> } | null
  /**
   * 外链认领（v0.13.0+，`features.includes('urlTarget')` gate）：声明后，DOM 层
   * 捕获到的外链点击里**只有被某个启用类型认领的那些**会被接管——第一个
   * urlTarget 返回 true 的类型以 openTab({ type, url, title: hostname }) 打开，
   * URL 预填 tab.path。先到先得；谓词抛错被吞。
   *
   * **没被认领的链接一律放行**（插件不 preventDefault）：DSH 0.1.7 起正文链接的
   * 去向由宿主的用户设置 `linkOpening` 决定（进侧栏还是新标签页），插件自绘
   * markdown 里则走 `<a>` 自己的默认行为。**v0.21.1 起那三个「按协议分流」
   * 的旧设置项已删除**（旧文档里的键会被忽略），本插件不再有任何接管总闸——
   * 认领与否完全由你的 urlTarget 决定；Ctrl/Cmd/Shift/Alt 点击永远绕过接管。
   * 认领成功但目标类型在打开那一刻已不可用（插件卸载 / 被设置关闭）时，点击
   * 兜底为 `window.open(url, '_blank', 'noopener,noreferrer')`，不会变成静默无反应。
   *
   * 多 URL 并存需 createTab 铸造 per-URL id，否则二次点击被 id 安全网聚焦、不覆写 path。
   */
  urlTarget?: (url: URL) => boolean
  /**
   * 声明式设置（v0.4.1+）：见 §8。v0.12.0 起增加 `pluginToggles`（插件自有
   * 设置行，key 无需宿主 schema 字段）与 `render`（自定义设置面板）。
   */
  settings?: SidebarSettingsDeclaration
  /**
   * tab 角标（v0.12.0+）：tab 图标旁的小圆角 pill。number 渲染计数（99+ 封顶），
   * string 原样文本，null/undefined 不显示。每次 tab 栏渲染都会调用——保持廉价；
   * 抛错会被吞掉（不显示角标，不影响渲染）。
   */
  badge?: (ctx: Context, scope: SessionScope, state: SidebarState) => string | number | null | undefined
  /**
   * 生命周期回调（v0.12.0+），只由 SERVICE 路径触发：
   * - onOpen：openTab 真正**新建** tab 后（dedupe/id 安全网聚焦不算打开）；
   * - onActivate：tab 被聚焦时（dedupe 聚焦、id 安全网聚焦、tab 栏点击激活）；
   * - onClose：closeTab 关闭 tab 后。
   * 内置专属流程（diff 拆分放置、sidechat 线程重开）直接改 state，不触发
   * 回调——但它们只作用于内置类型（diff / sidechat），外部插件的 tab 永远走
   * service 路径。回调抛错只 console.error，绝不打断打开/关闭流程。
   * openTab 回调 scope 携带调用者传入的 { sessionId, cwd? }；
   * closeTab/activateTab 仅显式传 scope 时带 cwd。
   */
  onOpen?: (tab: SidebarTab, scope: SessionScope) => void
  onActivate?: (tab: SidebarTab, scope: SessionScope) => void
  onClose?: (tab: SidebarTab, scope: SessionScope) => void
  /** 渲染函数 */
  component: (props: TabComponentProps) => ReactNode
}

/** 声明式设置声明（行控件形状见上方 SettingRow）。 */
interface SidebarSettingsDeclaration {
  /** 偏好字段行（key 必须落在本插件的 `PrefsSchema` 里——它已并入本插件 Loader 行的 `Config`，内置键清单见 §8）。 */
  toggles?: readonly SettingRow[]
  /** 插件自有设置行（v0.12.0+）：key 插件局部，
   *  持久化在 pluginSettings[<descriptor id>]，无需宿主 schema 字段。 */
  pluginToggles?: readonly SettingRow[]
  /** 自定义设置面板（v0.12.0+）：追加渲染在行列表之后，可单独存在；
   *  抛错被吞并显示内联错误。 */
  render?: (props: SidebarSettingsRenderProps) => ReactNode
}

/** settings.render 收到的 props（v0.12.0+）。 */
interface SidebarSettingsRenderProps {
  store: SidebarStore
  service: BetterSidebarService
  prefs: SidebarPrefs
  /** 本 descriptor 自己的持久化设置 blob（pluginSettings[id]）。 */
  pluginSettings: Record<string, unknown>
  /** 持久化一条本 descriptor 的插件设置（值须 JSON 可序列化）。 */
  updatePluginSetting(key: string, value: unknown): void
  /** 关闭设置弹窗。 */
  close(): void
}
```

### 4.2 `TabComponentProps`（你的页面组件收到的 props）

```ts
interface TabComponentProps {
  ctx: Context                 // client cordis context
  store: SidebarStore          // better-sidebar 的状态 store（可调 reduce 等）
  scope: SessionScope          // { sessionId, cwd? } —— 会话标识，调用 /sidebar API 必带
  tab: SidebarTab              // 当前 tab 实例（含 id/type/title/path?/diff?/meta?）
  visible: boolean             // 是否当前激活 tab 且面板打开（不可见时暂停轮询等）
  // 以下由内置 tab 使用，外部 tab 可忽略：
  expanded?: string[]          // 文件树的展开目录集
  onToggleDir?: (path: string) => void
  // 在会话 composer 插入一条 @ 引用。isDir=true 为目录：纯文本 `@dir/`，
  // 保留宿主文件夹装饰与补全；false 为文件：走宿主结构化引用 chip
  // （显示 @basename、序列化为完整 @path），宿主拒绝时回退纯文本。
  onReferenceFile?: (path: string, isDir: boolean) => void
  onOpenFile?: (path: string) => void
  onOpenDiff?: (tab: SidebarTab) => void
  onSubagentJump?: (childSessionId: string) => void
}
```

实践建议：

- **用 `visible` 做性能门**：subagent 内置页在 `visible === false` 时暂停轮询；你的页面若有轮询/订阅，同样处理。
- **用 `scope.sessionId`（+ `scope.cwd`）访问会话数据**：所有 `/sidebar/api/*` 请求都要带这两个字段（见 §6）。

### 4.3 注册示例

**最简单实例 tab**（+ 菜单可见）：

```ts
ctx.effect(() =>
  ctx.betterSidebar.registerTab({
    id: 'my-plugin:notes',
    title: 'Notes',
    icon: <NoteIcon />,
    order: 50,
    single: true,  // ≡ dedupeKey: () => 'my-plugin:notes'
    component: ({ scope }) => <NotesView sessionId={scope.sessionId} />,
  })
)
```

**多实例 tab + 外部触发打开**（每次新开，带自定义 id）：

```ts
ctx.effect(() =>
  ctx.betterSidebar.registerTab({
    id: 'my-plugin:doc',
    title: 'Doc',
    icon: <DocIcon />,
    order: 60,
    // 不设 dedupeKey：每次 openTab 都新开
    component: ({ tab, scope }) => <DocView docId={tab.id} sessionId={scope.sessionId} />,
  })
)
// 外部触发打开（你的插件其他流程、甚至用户操作）：
ctx.betterSidebar.openTab({ type: 'my-plugin:doc', title: 'Spec.md', id: 'doc:spec' })
```

**条件可见**（仅满足条件时 + 菜单可用；返回 false 显示为 disabled 行而非隐藏）：

```ts
ctx.effect(() =>
  ctx.betterSidebar.registerTab({
    id: 'my-plugin:commits',
    title: 'Commits',
    icon: <CommitIcon />,
    order: 70,
    available: (ctx, scope, state) => hasGitRepo(state),
    dedupeKey: () => 'my-plugin:commits',
    component: ({ scope }) => <CommitsView sessionId={scope.sessionId} />,
  })
)
```

**自定义创建**（mint 自增 id）：

```ts
ctx.effect(() =>
  ctx.betterSidebar.registerTab({
    id: 'my-plugin:console',
    title: 'Console',
    order: 80,
    createTab: (state) => ({
      tab: { id: `console:${state.nextBrowser}`, type: 'my-plugin:console', title: `Console ${state.nextBrowser}` },
      patch: { nextBrowser: state.nextBrowser + 1 },  // 借内置计数器；也可自建 state 字段
    }),
    component: ({ tab, scope }) => <ConsoleView tabId={tab.id} sessionId={scope.sessionId} />,
  })
)
```

**认领外链点击**（v0.13.0+，`urlTarget` + `createTab` 组合）：

```ts
ctx.effect(() => {
  if (!ctx.betterSidebar.features.includes('urlTarget')) return  // 老版本优雅降级
  return ctx.betterSidebar.registerTab({
    id: 'my-plugin:web-docs',
    title: () => 'Docs',
    order: 80,
    urlTarget: (url) => url.hostname === 'docs.my-site.com',
    createTab: (state) => ({  // per-URL id，多 URL 并存
      tab: { id: `my-plugin:web-docs:${state.nextBrowser}`, type: 'my-plugin:web-docs', title: 'Docs' },
      patch: { nextBrowser: state.nextBrowser + 1 },
    }),
    component: ({ tab, scope }) => <WebDocsView url={tab.path} sessionId={scope.sessionId} />,
  })
})
```

### 4.4 内置 tab 清单（不可重复注册）

| id | order | single | hidden | 用途 |
|---|---|---|---|---|
| `editor` | 10 | 否（按 path 去重） | 否 | 唯一「文件窗口」（编辑/预览 + 资源管理）。chrome 恒合并形态：路径输入框 + 编辑器控件 + 可开关内嵌文件树（全局搜索 `fs.search`；状态存 `tab.meta.treeOpen/treeWidth`）。`editorExplorer`：关（默认）= 按 path 新开，无路径窗口 = 纯资源管理器；开 = 树点击/Enter 经 `updateTab` 原地切换（id/meta 不变），无路径窗口 = 带 chrome 空窗口。树右键「在新 Tab 中打开」「在侧边打开」（pane 右侧 split）。新会话 seed 空文件窗口（`title:'Files'`）；旧 `explorer` tab 经 `sanitizeState` 迁移 |
| `git` | 20 | 是 | 是（本轮文件操作数） | 「文件变动」统一 tab（id 保留 `git` 以兼容持久化布局）：**Git 视角**（原 Git 面板：staged/unstaged / 提交 / 历史 / worktree·子仓库选择）+ **本轮文件视角**（原 file-trace：模型读/写/编辑实时折叠，按文件分组、类型筛选）；会话事件经插件自有宿主路由 `changes.ops` 供给（live 日志优先、冷会话回放持久化记录，`afterSeq` 增量），badge 读 tab 轮询写入的同步缓存。两视角共用底部可拖拽预览面板（`tab.meta.lens/previewH` 持久化）；**提交信息草稿随 tab 持久化**：草稿归 tab 拥有（视角切换不丢——Git 视角卸载不影响 ChangesTab 自身状态），写入按 400ms 防抖、卸载/换会话立即 flush、提交成功即清空；镜像落点随承载面分流——底部工作台 tab 写自身 `tab.meta.commitMsg`（走 `store.reduceFor(会话, patchTab)` 定向写回草稿归属的会话），原生右侧栏 tab 的记录是内存态，改写 git 卡片 `pluginSettings` blob 的 `commitDrafts`（按会话键、上限 16，切换会话/重载后重开 tab 可恢复），diff 渲染统一走 `src/client/diff/`（`DiffRows`/`DiffFiles`：mod 配对 + 行内高亮 + 语法着色 + 上下文折叠）；Git 目标可展开为独立 diff tab（落进工作台的 diff 分栏） |
| `subagent` | 30 | 是 | 否 | 任务管理（工作流图/树、团队任务板、后台任务抽屉） |
| `sidechat` | 35 | 否（`sidechat:<uuid>`，按 `meta.threadId` 去重） | 否 | 侧边对话（每对话一 Tab）：打开即建空线程（首条消息赢得标签并同步标题）；线程 = 插件自建子会话（种子继承父会话上下文，进行中回合以 `interrupted` 闭合；种子带合法 `subagent/descriptor`，SubagentView 按 `Side: ` 前缀过滤），`origin:'subagent'` 隐藏于主列表；走 `/sidebar/api/sidechat.*` 路由；头部菜单切换/重开（`parkSidechatReopen` + 确定性 id），关 Tab 释放 live agent；重开经 `collectOwnEvents` 回源到种子边界；「保存为新会话」= `session.fork`（`this` 敏感）。[设计文档](plans/2026-08-20-sidechat-tab-design.md) |
| `terminal` | 40 | 否（`terminal:<n>`） | 否 | 终端。v0.17.0+ 右键「固定到工作区/全局」：跨会话不消失，TabBar 内联虚拟 Tab（`pinned:<homeSessionId>:<tabId>`），就地按 home scope 连 PTY；global 全会话可见、workspace 仅同 cwd；`tab.pin = { scope, homeCwd? }` 随会话持久化，渲染期解析（`collectPinnedTabs` → `createPinnedVirtualTab` → `injectPinnedIntoTree`）。**打开进底部工作台即自动聚焦**：tab 在底部工作台里成为可见激活 tab（`visible` 变真）或随面板打开挂载时，xterm 直接接管键盘输入（无需再点进终端）；仅限插件底部工作台，原生右侧栏的终端 tab 不抢焦点 |
| `workspace-terminals` | 41 | 是 | 否 | 工作区终端管理：右侧栏指南与底部 `+` 菜单均提供入口，内联展示列表、状态、连接与二次确认结束。默认或 `target:'right'` 进入右侧栏，`target:'bottom'` 进入底部；右侧栏不可用时回退到底部 |
| `diff` | -1 | 否（按 id 去重） | 是 | 差异查看（changes tab 的预览面板「展开为独立页签」触发，同一渲染栈）；v0.20.x 起 `SidebarTab.diff` 另收 `{ kind: 'proposed', id, title, patch }` 任意 patch 种子（features 含 `planDiff`，见 §7.2.2）；v0.21.0 起该 variant 追加可选 `truncated` / `sourceRef` 展示元数据、文件头「打开文件」按钮与行点击定位（`OpenTabSeed.line`，仅 proposed） |

你的 `id` 不可与上述重复，否则 `registerTab` 抛 `"tab type \"X\" already registered"`。

**自 v0.20.0 开发线起删除的类型（迁移提示；0.20.0 从未发布，变更落在 v0.21.1）**：

| 原 id | 现状 | 你该怎么做 |
|---|---|---|
| `terminal` | 历史官方适配线曾让出宿主；**本合并基线恢复插件终端** | 不要再向 betterSidebar 注册同名类型。插件终端 API、Agent 工具和固定元数据及解析模块仍保留（当前 Sidebar 的 pinned hook 未接线，本次不恢复旧固定 UI）；新本地实例使用 workspace 管理，既有 session/tab 与远程 Provider 兼容保留。宿主终端不是 workspace 注册表成员 |
| `browser` | 宿主自带 `kind: 'browser'`（`@deepseek-ai/dsh-client-ui-sidebar-browser`），**但 DSH 0.1.7 起只在 desktop profile 挂载**（`web-app` 的 patch 里 `disabled: ctx.get('profileContext')?.name !== 'desktop'`）——Web profile 上**没有这个 kind**，`openTab('browser', …)` 必然失败 | 不要再注册同名 kind。要打开网页：desktop profile 走 `ctx.sidebarRight.openTab('browser', { params: { url } })`（务必 try/catch 兜底，宿主未装该包时 `openTab` 会抛）；Web profile 只能自己提供页面，或把链接交回宿主（正文链接由宿主的 `linkOpening` 设置决定去向）。插件侧的 `api.browserProbe` / `SidebarPrefs.browserNoSandbox` / `browserAllowedLoopback` **以及三个「按协议分流」的外链接管偏好键全部已删除**；`urlTarget` 机制保留，但不再有接管总闸（见 §4.1） |

**同时删除的还有**：轮尾产物行接管。DSH 0.1.6 把 `conversation.chat.turnTail` 从 `chain` 改成 `list`（list 槽要求 `options.id`，且只能**追加**，不能替换宿主的产物行），插件因此整体移除了 `registerTurnTailInterception` 与 `selectProducedFiles`。要往那个位置加东西，按 list 契约注册 `{ name: 'conversation.chat.turnTail', id: '<你的 id>', order }`；`openSidebarFile` 作为通用打开工具留在 `dsh-better-sidebar/src/client/sidebar-file.ts`（`resolveSidebarPath` 移到 `src/client/paths.ts`）。

---

## 5. 文件预览器（FileViewer）注册 API

### 5.1 `FileViewerDescriptor` 完整字段

```ts
interface FileViewerDescriptor {
  /** 唯一 id：'image' / 'pdf' / 'my-plugin:csv' */
  id: string
  /** 设置清单展示名（v0.4.1+，i18n 友好）；缺省回退到 id */
  title?: string | (() => string)
  /** 设置清单图标（v0.4.1+）：ReactNode 或 (size: number) => ReactNode */
  icon?: ReactNode | ((size: number) => ReactNode)
  /** 小写无点的扩展名数组：['png','jpg']。[] = catch-all（仅最低优先级盲命中有效） */
  exts: readonly string[]
  /** 优先级（高优先）；默认 0。内置：markdown/html=0，code=-100 */
  priority?: number
  /** 字节获取策略 */
  fetchStrategy: 'none' | 'fsRead' | 'mediaUrl' | 'custom' | 'binary-download'
  /** 内容嗅探（覆盖 exts）：head 字节可用时，第一个 detect 返回 true 的 viewer 命中 */
  detect?: (path: string, head: Uint8Array) => boolean
  /** fetchStrategy='custom' 时的加载函数；v0.12.0+ 第三参 signal 在 viewer
   *  卸载/重匹配时中止（忽略 signal 的 load 也照常工作） */
  load?: (path: string, scope: SessionScope, signal?: AbortSignal) => Promise<unknown>
  /** 声明式设置（v0.4.1+）：形状同 TabDescriptor.settings（§4.1 的
   *  toggles/pluginToggles/render；v0.12.0 起 viewer 卡片也有齿轮按钮） */
  settings?: SidebarSettingsDeclaration
  /** 渲染函数 */
  component: (props: FileViewerProps) => ReactNode
}
```

### 5.2 `FileViewerProps`

```ts
interface FileViewerProps {
  ctx: Context
  store: SidebarStore
  scope: SessionScope
  path: string
  title: string
  viewerId: string         // 命中 viewer 的 id（如 'code' / 'my-plugin:csv'）
  content?: string         // fetchStrategy='fsRead' 时
  truncated?: boolean      // fetchStrategy='fsRead' 时
  mediaUrl?: string        // fetchStrategy='mediaUrl' 时
  customData?: unknown     // fetchStrategy='custom' 时（load() 的返回值）
  // 以下为内置文本编辑器与 EditorHost 内部协作字段，外部 viewer 忽略：
  toolbar?: 'self' | 'host'
  onToolbarState?: (state: EditorToolbarState) => void
  onToolbarControls?: (controls: EditorToolbarControls | null) => void
}
```

### 5.3 `fetchStrategy` 对照

| 策略 | 字节来源 | 传给 component 的字段 | 适用 |
|---|---|---|---|
| `none` | 不需要字节 | （无） | 自渲染（如纯 UI） |
| `fsRead` | `/sidebar/api` 的 `fs.read` | `content`, `truncated` | 文本类（CSV/JSON/XML） |
| `mediaUrl` | `/sidebar/file` 媒体路由 URL | `mediaUrl` | 图片/PDF（viewer 自己 fetch 字节） |
| `custom` | viewer 的 `load()` 函数 | `customData` | 自定义协议（如远程拉取） |
| `binary-download` | 不预览，显示下载按钮 | （无） | 无客户端渲染器的二进制格式。**本插件现在没有任何内置 viewer 用这条策略**（`binary-download` viewer 已让给宿主）；策略本身仍在契约里，你的 viewer 可以照用 |

### 5.4 匹配算法（`matchFileViewer`）

`matchFileViewer(path, head?)` **单趟**按 priority 降序（稳定排序，相同 priority 按注册顺序）遍历每个 descriptor：

1. 若 `head` 字节可用且该 descriptor 有 `detect` → 调 `detect(path, head)`，true 则命中；**miss 且是 catch-all（`exts: []`）则本轮放弃**（纯嗅探型不得盲认领）；
2. 否则匹配 `exts`（小写无点；`exts: []` 且无 `detect` 是盲 catch-all，直接命中）。

即：**priority 高的 descriptor 先获得裁决权**（其 detect 或 exts 任一命中即赢），低 priority 的 detect 不会越过高 priority 的 exts 匹配。`exts: []` + `detect` 的组合是"纯嗅探"：无 head 时不认领任何文件（不会吞掉图片/PDF 等真实 viewer 的文件），有 head 时只认领 detect 命中的。全部 miss 返回 `undefined`（编辑器显示下载按钮）。

> **head 字节从哪来**：第一次匹配（纯扩展名）没有 head。`fsRead` 策略读取后若文件为二进制，host 的 `fs.read` 响应会带 `head` 字段（base64，前 4KB，`src/index.ts` 的 `READ_HEAD_LIMIT`），编辑器会用它对 `detect` viewer **重匹配一次**——所以 detect 型 viewer 的实际触发场景是"扩展名匹配落空/二进制文件"。文本文件的 detect 嗅探不在内置流程内（用 `exts` 或 `custom` 策略替代）。

> **内置 viewer**（不可重复注册，全部 3 个）：markdown(0, fsRead；内嵌 HTML 支持：DOMPurify 白名单消毒、`<details>` 跨段嵌套、本地媒体 src 重写走 `/sidebar/file`；≥3 标题时浮动目录大纲。实现 `markdown-html.ts` / `MarkdownHtml.tsx` / `md-toc.tsx`，[设计文档](plans/2026-08-24-markdown-html-toc-design.md)) / html(0, fsRead, 沙箱 iframe 预览 + `htmlViewerNoSandbox` / `htmlViewerDefaultUnsafe` 两个宿主没有的逃生门) / code(-100, catch-all, fsRead, **可编辑** CodeMirror + 保存)。
> code 是兜底 viewer：任何其他 viewer 未认领的文件都会落到 code（CodeMirror 文本编辑）；二进制文件经 head 重匹配找不到 sniffer，落到编辑器的下载面板。外部 viewer 注册同扩展名 + 更高 priority 即可覆盖内置的那三个。
>
> ⚠️ **让给宿主的格式（重要，影响你的 viewer 能不能被调用）**：DSH 0.1.7 的 `ui-sidebar-documentpreview` 自带 code / excel(xlsx,xls,csv,tsv) / office（宿主侧转 PDF）/ pdf / image / html / markdown / text 预览，并带缩放与**按目录自动刷新**——本插件原有的 image / pdf / binary-download 三个 viewer 描述符因此删除。更重要的是**路由**：插件的 `editor` 类型在 `canOpen` 里对下列扩展名一律返回 false（`src/client/native/index.ts` 的 `HOST_OWNED_EXTS`），把地址让给内置 `text` 档，**根本不会进入本插件的 `matchFileViewer`**：
>
> `xlsx xls csv tsv fods pdf png jpg jpeg gif webp svg bmp ico doc docx ppt pptx`
>
> **这份清单现在是「宿主渲染器实际覆盖的集合」，不多不少**：`v0.21.1` 收回了 9 个宿主其实**没有渲染器**的扩展名（`xlsb` / `xlt` / `xltx` / `xltm` / `ots` / `dot` / `dotx` / `avif` / `ods`——前两个落在宿主的 `document/unviewable.ts`「已知二进制、无渲染器」表里，其余落回 text 兜底后按二进制判定失败，一律只有「暂不支持预览」），它们重新由插件的 `code` catch-all 认领并落到下载面板。`fods` 保留让出：宿主会用纯文本显示那段扁平 XML，比下载面板有用。`tests/native-surface.spec.ts` 双向钉住这条边界（宿主能渲染的必须拒绝、宿主不能渲染的必须认领）。
>
> 后果：**你注册这些扩展名的 viewer 仍然合法（注册表不冻结 id，`matchFileViewer` 也会命中），但通过聊天 / 文件树 / 编辑器的正常文件打开路径拿不到它们**——那是宿主的文档预览。要在这些格式上做文章，只能自己在页面里渲染（或像 [Office 预览插件](https://github.com/HuanLinOTO/dsh-plugin-better-sidebar-plugin-office) 那样在宿主接管前的旧版本上生效）。**可用的是 md/markdown / html/htm 与 code catch-all 三类**（外加任何不在上表里的扩展名）。未知二进制（`.zip` / `.wasm`）仍走 code 认领 → `fs.read` 判 binary → head 重匹配无 sniffer → 编辑器渲染下载面板，功能不回归。

### 5.5 注册示例

**CSV 预览器**（自定义加载 + 渲染）：

```ts
ctx.effect(() =>
  ctx.betterSidebar.registerFileViewer({
    id: 'my-plugin:csv',
    exts: ['csv'],
    fetchStrategy: 'custom',
    load: async (path, scope) => {
      const text = await fetchText(scope, path)
      return parseCsv(text)
    },
    component: ({ customData, path }) => <CsvGrid rows={customData as string[][]} path={path} />,
  })
)
```

**覆盖内置 markdown viewer**（如自家渲染管线的只读预览）：

```ts
ctx.effect(() =>
  ctx.betterSidebar.registerFileViewer({
    id: 'my-plugin:md-pro',
    exts: ['md', 'markdown'],
    priority: 10,  // 高于内置 markdown 的 0
    fetchStrategy: 'fsRead',
    component: ({ content }) => <MyMarkdown source={content ?? ''} />,
  })
)
```

> ⚠️ 只有内置仍认领的格式能被这样覆盖（md/markdown、html/htm，以及 code catch-all 接的其它扩展名）。`.svg` / `.png` / `.pdf` / `.docx` 之类**不要**照这个例子注册——地址在 `canOpen` 就被让给宿主的文档预览了，你的 viewer 永远不会被调用（原因与完整清单见 §5.4）。

**内容嗅探**（按 magic bytes 路由，忽略扩展名）：

```ts
ctx.effect(() =>
  ctx.betterSidebar.registerFileViewer({
    id: 'my-plugin:magic-parquet',
    exts: [],  // catch-all，但 priority 高 + detect 精确命中
    priority: 100,
    fetchStrategy: 'custom',
    detect: (_path, head) => head.length >= 4
      && head[0] === 0x50 && head[1] === 0x41
      && head[2] === 0x52 && head[3] === 0x31,  // 'PAR1'
    load: async (path, scope) => parseParquet(await fetchBytes(scope, path)),
    component: ({ customData }) => <ParquetTable data={customData} />,
  })
)
```

---

## 6. 页面内如何访问数据（/sidebar API）

你的 tab / viewer 组件运行在浏览器里，与内置视图同源同权。访问文件/会话数据直接 `fetch` better-sidebar 的 JSON API（内置 `src/client/api.ts` 的封装就是干这个的，你可以在自己插件里复制这个 fetch 模式）：

```ts
// POST /sidebar/api/<method>，body 带 sessionId + cwd（可选）
const res = await fetch('/sidebar/api/fs.read', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: scope.sessionId, path }),
})
const { value } = await res.json()   // 错误时 { ok: false, error: { code, message } }
```

常用方法（完整清单见 `src/client/api.ts`）：

| 方法 | 说明 |
|---|---|
| `session.cwd` | 会话权威 cwd（`{ cwd, root, parent }`） |
| `fs.tree` | 目录列表（`{ path, entries: FsEntry[], truncated }`；FsEntry 含 `isSymlink`/`broken`，目录软链接的 `isDir` 按目标类型） |
| `fs.trees` | **批量**目录列表（v0.23.0+）：入参 `{ sessionId, cwd?, paths: string[] }`（最多 64 条，绝对或会话相对），一次请求返回 `{ levels: [{ path, entries, truncated, error? }] }`。每层与 `fs.tree` 同解析、同缓存；**某一层失败只在该层带 `error`**（`entries: []`），整个批次仍是成功响应——树的一次挂载/刷新因此是 1 个请求而不是 N 个 |
| `fs.read` | 读文件：文本返回 `{ kind: 'text', content, truncated }`；二进制返回 `{ kind: 'binary', size, truncated, head }`（head = base64 前 4KB） |
| `fs.write` | 原子写文件 |
| `git.status` / `git.diff` / `git.log` 等 | 全套 Git 只读 + 写操作 |
| `pty.close` / `agent-pty.close` | **已删除**（插件自带的 PTY 栈随终端一起移除；宿主 `ui-sidebar-terminal` 不通过本插件的路由暴露控制面） |
| `settings.get` / `settings.update` | 侧边栏偏好读写（revision 守卫，冲突回 wire 错误码 `settings-conflict`）；后端在 0.1.7 上就是宿主的 `SettingsForms`，见 §8.2 |

> **文件路径语义（v0.23.0 起：无包含检查）**：`fs.tree`、`fs.trees`、`fs.read`、`fs.write`、`fs.rename`、`fs.remove`、`fs.mkdir`、`/sidebar/file`、`/sidebar/html`、`/sidebar/upload` 和 `archive.build` 仍以请求对应 session 的权威 `cwd` 作为**相对路径的基准**，但**不再把 `cwd` 当边界**：绝对路径原样使用，`..` 只做词法折叠，符号链接跟随，越界不再是 403。安全影响见 §8.1 的醒目声明。

### 6.1 打包下载（`archive.build` / `archive.status` / `/sidebar/archive`，v0.22.0+）

把若干文件/目录打成 ZIP 下载，并且**有进度可看**：选择项在 `archive.build` 里一次性收集（与 `fs.tree` 同一套词法解析——**无包含检查**，目录递归、符号链接跳过、同名条目用父目录消歧），打包在后台进行，客户端轮询进度、完成后取字节。

```ts
// 1) 启动：paths 是会话命名空间里的绝对路径（与 fs.tree 的行 path 同形）
const build = await fetch('/sidebar/api/archive.build', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId, cwd, paths: ['/w/src', '/w/notes.md'], name: '报告.zip' }),
}).then(r => r.json())
// → { ok: true, value: { id: 'ar-…', entries: 5 } }

// 2) 轮询：state 为 building | ready | error；done/total 是条目进度，bytes 是已读未压缩字节
const status = await fetch('/sidebar/api/archive.status', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: build.value.id, sessionId }),
}).then(r => r.json())

// 3) 下载（仅 ready 时）：同一 id 只能取一次，取完即释放
const url = `/sidebar/archive?${new URLSearchParams({ sessionId, id: build.value.id })}`
```

约束与状态码：任务表最多 **4 个并发构建**（超出时 `archive.build` 回 `bad-request`，HTTP 409），完成/失败后保留 **5 分钟**（过期即消失）；`id` 只对**创建它的 session** 可用（其他 session 读是 `forbidden` 403）；`/sidebar/archive` 在构建中回 **409**、构建失败回 **410**（消息即失败原因）、未知/过期/已下载回 **404**。响应头为 `content-type: application/zip` + `content-disposition: attachment; filename="<ASCII 回退>"; filename*=UTF-8''<百分号编码>`（非 latin1 文件名走 RFC 5987，ASCII 档位对旧客户端生效）。上限沿用 `src/zip.ts` 的 `ZIP_MAX_ENTRIES = 10_000` 与 `ZIP_MAX_BYTES = 256 MiB`（未压缩总量）。

媒体/下载字节走 `/sidebar/file` 路由（`?sessionId=&path=&cwd=&download=1`）：

```ts
// 媒体 URL（图片等直接 <img src>）：/sidebar/file?sessionId=...&path=...
const url = `/sidebar/file?${new URLSearchParams({ sessionId: scope.sessionId, path })}`
```

> 注：内置的 `api.ts` 是 better-sidebar 内部模块，外部插件 **不要** value-import 它（构建纯度门会挡）；按上表模式自己 fetch 即可。所有路由带与 `/api` 相同的 Host 头信任围栏，浏览器同源访问天然通过。

---

## 7. 服务方法完整清单

```ts
interface BetterSidebarService {
  /** 注册 tab 类型；返回 disposer */
  registerTab(descriptor: TabDescriptor): () => void
  /** 注册文件预览器；返回 disposer */
  registerFileViewer(descriptor: FileViewerDescriptor): () => void
  /** 注册自定义文件树/文件 tab 图标（v0.19.0+，features 含 'fileIcons'）；返回 disposer */
  registerFileIcon(descriptor: FileIconDescriptor): () => void
  /** 注册「Git 视角」提交行里的动作（v0.20.x，features 含 'gitCommitActions'）；
   *  返回 disposer；重复 id 抛错。缺省零注册 = 提交行与之前逐字节一致。详见 §7.2.1 */
  registerGitCommitAction(descriptor: GitCommitActionDescriptor): () => void
  /** 已注册提交行动作的注册顺序快照（渲染按 order 再排） */
  getGitCommitActions(): readonly GitCommitActionDescriptor[]
  /** GitLens 当前所看的 Git 目标（来源 session / 选中 repo·worktree / branch /
   *  staged 行）；scope 按 sessionId 过滤，缺省取最近发布。**时点读**：发布 target
   *  不触发 subscribe（详见 §7.2.1）。未挂载 Git 视角或未 resolve 时为 undefined */
  getGitCommitTarget(scope?: SessionScope): GitCommitTarget | undefined
  /** 当前已注册的 tab 描述符快照（同步，供 useSyncExternalStore 用；含被设置页禁用的类型） */
  getTabs(): readonly TabDescriptor[]
  /** 当前已注册的 file viewer 描述符快照（含被设置页禁用的 viewer） */
  getFileViewers(): readonly FileViewerDescriptor[]
  /** 当前已注册的文件图标描述符快照（v0.19.0+） */
  getFileIcons(): readonly FileIconDescriptor[]
  /** 按 path 匹配**具体**注册（priority 降序、注册序）：先 names 文件名，再
   *  具体扩展名；不查 catch-all 与 folder 保留值。消费方一般直接用
   *  fileIcon/folderIcon 全链解析器。 */
  matchFileIcon(path: string): FileIconDescriptor | undefined
  /** 匹配目录行注册：先按 folderNames 匹配目录名（name 传 basename，可省），
   *  再按 'folder'/'folder-open' 保留扩展名；priority 降序、注册序；
   *  返回 undefined = 回退内置 VscFolder/VscFolderOpened */
  matchFolderIcon(open: boolean, name?: string): FileIconDescriptor | undefined
  /** 文件图标权威解析器（v0.19.0+），完整回退链：
   *  ① 具体 names/扩展名注册 → ② 内置 glyph（md/媒体/pdf/json/代码/配置/数据库/lock/压缩包）
   *  → ③ 最优 catch-all 注册（exts: []，即全局默认）→ ④ 通用 VscFile。
   *  任一注册工厂抛错都会被吞（console.error 后跳下一级），永远返回有效 ReactNode。 */
  fileIcon(path: string, size: number): ReactNode
  /** 目录图标解析器：注册的 folderNames/'folder'（闭合）/'folder-open'（展开）图标 →
   *  内置 VscFolder/VscFolderOpened；path 为目录自身路径（主题可按目录变化），
   *  open 会传给工厂，一条注册即可渲染开/合两态。 */
  folderIcon(path: string, open: boolean, size: number): ReactNode
  /** 按 id 查 tab 描述符 */
  getTab(id: string): TabDescriptor | undefined
  /** 某个 tab 类型是否在 Side card 设置中启用（v0.4.1+；缺省 = 启用） */
  isTabEnabled(id: string): boolean
  /** 某个 file viewer 是否在 Side card 设置中启用（v0.4.1+；缺省 = 启用） */
  isViewerEnabled(id: string): boolean
  /** 按 path 匹配 file viewer（priority 降序单趟：detect → exts；跳过硬禁用 viewer） */
  matchFileViewer(path: string, head?: Uint8Array): FileViewerDescriptor | undefined
  /**
   * 打开一个 tab（+ 菜单和外部触发都用它；走 descriptor.dedupeKey 去重）。
   * title 可选：给出时优先于 descriptor.title（editor 显示文件名）；
   * 有 createTab 的 descriptor 分落点：底部工作台（target: 'bottom'）由 createTab
   * 整体铸造 tab，忽略 seed 的 title/path/id（url 种子仍预填新建 tab 的 path）；
   * 原生右侧栏只忽略 id（原生 tab id 由宿主铸造，seed.id 仅影响 onOpen 收到的
   * 合成 tab），createTab 铸造的 title/meta 作缺省、seed 字段优先（v0.19.2+ 起
   * path 也随导航 params 下发，见下）。
   * path 可选：含义跟随类型——editor（唯一认领 dsh-resource://file/** 的
   * 类型，但会拒绝宿主的文档预览格式，见 §5.4）把 path 转成资源地址打开（文件落在
   * 编辑器）；其余类型 path 是组件种子，随导航 params 落到 tab.path（v0.19.2+；
   * 0.19.0/0.19.1 把一切 path seed 都改道文件资源打开，组件型 tab 的组件不会挂载，#632）。
   * url 可选：把**新建** tab 的 path 预填为 URL（网页类 tab 的导航种子）；
   * 聚焦既有 tab 时 url 不会覆写其 path。
   * 被设置禁用的类型是 no-op（console.warn 提示）。注意：available 不拦截 openTab。
   * scope（v0.12.0+）定向到指定 session：给出且非当前 session 时，打开落在
   * 该 session 的侧边栏状态里（没有则按 prefs 新建），不切换 UI 的激活 session；
   * 定向打开不自动展开目标 session 的面板；缺省或指向当前 session 时行为
   * 与之前完全一致。
   * 内容型打开（带 path/url seed）在落点面板折叠时自动展开，保证落点可见；
   * 类型型打开（+ 菜单等）不展开。
   * 落点（v0.20.x，features 含 'panelFlags'）：非 `target: 'bottom'` 的打开默认
   * 走原生右侧栏 surface；若该窗口没有内核 `sidebarRight` 控制器（弹窗/独立
   * 会话窗口、未挂 ui-sidebar-right 的运行时），打开**回落到底部工作台**
   * （创建/聚焦标签并展开），而不是无限期排队——保证 dsh-hotkey 等外部触发
   * 在弹窗窗口里也能打开文件树。内核控制器出现后同一调用自动回到原生路径。
   */
  openTab(seed: OpenTabSeed, scope?: SessionScope): void
  /** 关闭一个 tab（未知 id 严格 no-op，无状态搅动）；scope（v0.12.0+）
   *  随回调传递（含可选 cwd），缺省为 { sessionId: 当前 } */
  closeTab(tabId: string, scope?: SessionScope): void
  /** 订阅注册表变化（register/dispose 时触发） */
  subscribe(listener: () => void): () => void
  // ── v0.12.0+ ──────────────────────────────────────────────────────────
  /** 插件版本（如 '0.17.1'；与 package.json 同步，测试守护） */
  readonly version: string
  /** 能力清单（只增不删，唯一例外：v0.19.0 删除了 'floatWindows'）：
   *  'badge' | 'tabLifecycle' | 'updateTab' | 'openFile' | 'targetedOpen' |
   *  'stateSubscription' | 'tabMeta' | 'pluginSettings' | 'urlTarget' |
   *  'settingSelect' | 'fileIcons' | 'panelFlags' | 'gitCommitActions' | 'planDiff' | 'centralEditor'
   *  ——用 `features.includes('xxx')` 按能力 gate。
   *  'panelFlags'（v0.20.x，本节「7.1 dsh-hotkey 对接契约」）：
   *  getSnapshot() 携带顶层 bottomOpen/panelOpen，且「right」打开在内核
   *  sidebarRight 控制器缺失时回落到插件自己的底部工作台。
   *  'gitCommitActions' / 'planDiff'（v0.20.x，见 §7.2）：提交行动作接缝与
   *  `{ kind: 'proposed' }` 计划 diff 预览。 */
  readonly features: readonly string[]
  /** 当前快照：激活 sessionId + 其状态（面板几何/打开的 tabs/展开集）+ prefs；
   *  v0.20.x 起另带顶层 `bottomOpen`/`panelOpen` 布尔（见 7.1）。
   *  session 未激活时 state/sessionId 为 undefined。 */
  getSnapshot(): SidebarServiceSnapshot
  /** 订阅快照变化（会话切换/状态变更/prefs 写入）；返回 disposer */
  subscribeState(listener: () => void): () => void
  /** 更新一个已打开 tab 的显示字段（title/path/meta）；tab 不存在时 no-op */
  updateTab(tabId: string, patch: { title?: string; path?: string; meta?: unknown }): void
  /** 激活一个已打开的 tab（tab 栏点击路径；触发 descriptor.onActivate；
   *  未知 id 严格 no-op）；scope（v0.12.0+）随回调传递，同 closeTab */
  activateTab(tabId: string, scope?: SessionScope): void
  /** 在 scope.sessionId 的侧边栏编辑器打开一个文件（title 缺省为文件名；
   *  id 按路径派生（`editor:` + path），与内置 open-path 拦截一致，不同文件可并排打开）。
   *  注意：path 派生 id 只对 openFile/openSidebarFile 成立；editorExplorer 合并模式的
   *  原地切换经 updateTab 重写 path/title，tab id 保持稳定、不再对应 path。 */
  openFile(scope: SessionScope, path: string, title?: string): void
  /** 显式在会话中央主槽打开已保存文件；无 controller/拒绝时 false，绝不静默降级。 */
  openCentralFile(scope: SessionScope, path: string): boolean
  /** 查询该会话是否正在显示中央编辑器；无 controller 时 false。 */
  isCentralEditorActive(sessionId: string): boolean
  /** 内部生命周期接缝：仅客户端入口安装/卸载，消费插件不得调用。 */
  setCentralEditor(controller: {
    openFile(scope: SessionScope, path: string): boolean
    isActive(sessionId: string): boolean
  } | undefined): void
}

/** openTab 的 seed（v0.12.0 起导出命名类型）。 */
interface OpenTabSeed {
  type: string
  title?: string
  /** 文件路径：editor = 打开文件资源；其余类型 = 组件种子（落在 tab.path，v0.19.2+） */
  path?: string
  /** 仅 editor 种子（v0.21.0）：打开文件资源的行号——原生右侧栏的 resource open
   *  携带它，编辑器打开后是否滚动到该行由宿主编辑器决定；其余类型忽略 */
  line?: number
  /** diff tab 的内容种子：worktree / commit / **proposed**（任意 patch 文本，
   *  v0.20.x，features 含 'planDiff'；见 §7.2.2） */
  diff?: SidebarTab['diff']
  id?: string
  url?: string
  /** JSON 可序列化的自定义状态，随 tab 持久化（刷新后原样恢复）；
   *  undefined = 不改，null = 显式清除 */
  meta?: unknown
  /** 落点。省略 / 'right' = 原生右侧栏当前停靠格（默认）；'bottom' = 插件的
   *  底部工作台；**'side' = 原生右侧栏的第二个格**——原生承载面提供
   *  `openResource(address, { preferNewPane: true, revealIfOpened: false })`：
   *  先按宿主的两格上限与空间规则尝试分栏，分不了才回退到当前格；允许与
   *  已打开的同名资源并存，所以「在侧边打开同一个文件」真的会新开一格。
   *  path-less 的 editor seed 是文件页（files），'side' 只影响带 path 的打开。*/
  target?: 'right' | 'bottom' | 'side'
}

/** 文件图标注册描述符（v0.19.0+，features 含 'fileIcons'）。 */
interface FileIconDescriptor {
  /** 唯一 id（如 'my-plugin:icons'） */
  id: string
  /** 小写扩展名、不带前导点（如 ['csv','tsv']）。两个**保留值**认领目录行
   *  而非文件扩展名：'folder'（闭合目录）、'folder-open'（展开目录）——
   *  它们不会匹配真实文件（名为 x.folder 的文件不受影响）。
   *  [] = catch-all 全局默认：只兜内置 glyph 没认领的扩展名（注册的具体
   *  names/扩展名与内置 glyph 永远优先于它）。
   *  **省略** = 完全没有扩展名规则（只有 names 的注册不是 catch-all）。 */
  exts?: readonly string[]
  /** 精确**文件名**（basename，大小写不敏感，如 ['package.json','Dockerfile']）——
   *  图标主题的 fileNames 半边；命中优先于扩展名。省略/[] = 无文件名规则。 */
  names?: readonly string[]
  /** 精确**目录名**（basename，大小写不敏感，如 ['node_modules','src']）——
   *  图标主题的 folderNames 半边；命中优先于保留扩展名，且**只认领列出的
   *  目录**（要接管所有目录请用 'folder'/'folder-open'）。省略/[] = 无规则。 */
  folderNames?: readonly string[]
  /** priority 高者胜，缺省 0（同级按注册先后） */
  priority?: number
  /** 尺寸感知的图标工厂（文件树/文件 tab 当前以 size=14 渲染）。
   *  与内置图标（currentColor 单色，遵循皮肤契约）不同，注册图标可以是
   *  任意 ReactNode——包括彩色图标；颜色在皮肤间的表现由注册方自行负责。
   *  open：目录行的展开态（文件行为 undefined），一条注册即可渲染开/合两态。 */
  icon: (path: string, size: number, open?: boolean) => ReactNode
}
```

**图标注册示例**（v0.19.0+；一次注册可同时覆盖具体扩展名、目录与全局默认）：

```ts
if (ctx.betterSidebar.features.includes('fileIcons')) {
  ctx.effect(() =>
    ctx.betterSidebar.registerFileIcon({
      id: 'my-plugin:icons',
      exts: ['csv', 'tsv'],
      icon: (path, size) => <MyCsvIcon size={size} />, // 彩色也可以
    })
  )
  ctx.effect(() =>
    ctx.betterSidebar.registerFileIcon({
      id: 'my-plugin:names', // 精确文件名：package.json 与别的 .json 区分开
      names: ['package.json', 'Dockerfile'],
      icon: (path, size) => <MyBrandIcon size={size} />,
    })
  )
  ctx.effect(() =>
    ctx.betterSidebar.registerFileIcon({
      id: 'my-plugin:folders', // 只认领列出的目录名
      folderNames: ['node_modules', 'src'],
      icon: (path, size, open) => open === true ? <MyOpenFolderIcon size={size} /> : <MyFolderIcon size={size} />,
    })
  )
  ctx.effect(() =>
    ctx.betterSidebar.registerFileIcon({
      id: 'my-plugin:all-folders', // 接管所有目录行（保留扩展名）
      exts: ['folder', 'folder-open'],
      icon: (path, size, open) => open === true ? <MyOpenFolderIcon size={size} /> : <MyFolderIcon size={size} />,
    })
  )
  ctx.effect(() =>
    ctx.betterSidebar.registerFileIcon({
      id: 'my-plugin:default', // 全局默认：只兜内置 glyph 没认领的文件
      exts: [],
      icon: (path, size) => <MyGenericFileIcon size={size} />,
    })
  )
}
```

**消费表面与回退链**（由本插件内置消费，插件无需自己接线）：

- 文件树文件行 / 编辑器文件 tab（每个文件独立窗口）：`fileIcon(path, size)`
  ——具体 `names`/扩展名注册 → catch-all 全局默认（`exts: []`）→ **DSH 官方图标**。
- 文件树目录行（含根行）：`folderIcon(path, open, size)`——`folderNames` 命中
  → `'folder'`/`'folder-open'` 保留扩展名 → DSH 官方的文件夹图形。

注册/注销即时生效（文件树与 tab 栏订阅注册表变化自动重渲染）；图标工厂抛错会被吞掉
（console.error 后跳到回退链下一级），不会空白行。

**内置图标 = DSH 官方图形**（v0.19.0+，插件不含任何图标数据）：

- 回退链末端是 `FileTypeIcon` / `CodeFileIcon`（`@deepseek-ai/dsh-client-ui-primitives`，
  DSH 0.1.5-rc.2+）：48 个代码/配置类目的官方全彩图形 + markdown / 图片 / PDF / Word /
  Excel / PPT / 视频 / 文件夹 / 通用文档的类目色板图形，分类器是宿主的
  `classifyFileType`（精确文件名 → 前缀/后缀 → 项目上下文 → 扩展名）。本插件因此**没有**
  自己的扩展名表、**没有**图标 chunk、**没有**图标主题开关——彩色是唯一形态。
- **语义后果（重要）**：宿主分类器覆盖任意路径，所以「插件自己已经能画这个扩展名」不再是
  拦住 catch-all 的理由——**注册了 `exts: []` 的插件会接管全部未具体命中的行**（优先级降序、
  同优先级按注册序）。只想补几个扩展名就照常用 `exts`/`names`，别用 catch-all 兜底。
- 插件自己注册的图标颜色由注册方负责（见 §12）：品牌色是内容标识而非 chrome。

**版本与能力探测**（v0.12.0+）：消费插件先查能力再使用新 API，老版本（或旧 DSH）下优雅降级：

```ts
if (ctx.betterSidebar.features.includes('badge')) {
  // 使用 TabDescriptor.badge
}
if (ctx.betterSidebar.version >= '0.12.0') { /* 字符串比较即可：minor 只增 */ }
```

**生命周期示例**（v0.12.0+）：打开时启动资源、关闭时释放——组件卸载 ≠ tab 关闭（会话切换也会卸载），所以释放资源要用 `onClose`：

```ts
ctx.effect(() =>
  ctx.betterSidebar.registerTab({
    id: 'my-plugin:db',
    title: 'Database',
    single: true,
    badge: (_ctx, _scope, state) => /* 比如打开的连接数，每次 tab 栏渲染调用，保持廉价 */,
    onOpen: (tab, scope) => { startWatcher(scope.sessionId) },
    onClose: (tab, scope) => { stopWatcher(scope.sessionId) },
    component: ({ scope }) => <DbView sessionId={scope.sessionId} />,
  })
)
```

---

### 7.1 键盘快捷键插件对接契约（dsh-hotkey，v0.20.x）

dsh-hotkey 等键盘优先插件按「内核 `sidebarRight` 优先、本插件兜底」的链路工作。
本插件承诺的服务与 DOM 契约（改动必须同步 dsh-hotkey 的 `lib/client.js` 消费面）：

**服务 `ctx.betterSidebar`：**

- `getSnapshot()` 返回对象**顶层**携带：
  - `sessionId: string | undefined`
  - `bottomOpen: boolean` —— 插件底部工作台展开状态（= `state.bottomOpen`）；
  - `panelOpen: boolean | undefined` —— 内核右侧栏展开状态：`sidebarRight
    .isExpanded()`（有控制器时）或内核 DOM 标记 `[data-sidebar-right-open]`
    兜底；**`undefined` = 本窗口根本没有内核右侧栏**（弹窗/独立会话窗口、未
    挂 ui-sidebar-right 的运行时），消费方可据此启用插件自身面作为兜底。
- `getTabs()` 返回 `{ id, ... }[]`；内置 id 稳定为 `terminal` / `editor`（文件）/
  `git`（源代码管理）/ `subagent`（任务管理）/ `sidechat`（侧边对话）/ `browser`。
- `openTab({ type }, { sessionId })` 按类型打开/聚焦；无内核控制器的窗口里
  「right」打开自动落插件底部工作台（见 §7 openTab 落点说明）。

**DOM（插件宿主树）：**

- 面板宿主：`[data-dsh-panel-host]`（始终挂载于 `#root` 内——见 §10 平台陷阱的 `body > :not(#root)` 契约——无会话时为空宿主）。
- 标签条：`[data-dsh-panel-host] [class*="tab"][title]`——每个 tab 的
  `title` 即标签标题（如「文件」「Terminal 1」），关键词匹配可点击。
- 折叠/展开按钮集群：`[data-dsh-toggle-cluster]`（两处：会话头部底栏开关
  `data-dsh-bottom-toggle` 的包裹层；底部工作台 tab 条右端的按钮组）。按钮
  aria-label/title 关键词：底栏「折叠底部面板/展开底部面板/collapse bottom
  panel/expand bottom panel」；侧栏「折叠侧边栏/展开侧边栏/collapse sidebar/
  expand sidebar」（`data-dsh-sidebar-toggle`，内核无控制器时行为 = 打开/收起
  底部工作台的文件窗口）。
- 左侧栏 `[data-side="sidebar"]` 属内核 ui-sidebar 的 DOM，本插件不产出。

#### 7.1.1 桌面壳快捷键认领（Cmd+W 关闭标签，v0.20.x，deepseek-harness Electron）

deepseek-harness 的 Electron 壳（`apps/electron`）在主进程拦截 Cmd+W 并通过
preload 桥把认领权交给页面：`window.dshDesktopShell`（contextBridge 暴露，
沙箱渲染进程）：

```ts
interface DesktopShellBridge {
  /** 注册一个快捷键的认领 handler；返回 disposer（仅当自己仍是当前注册时生效）。 */
  onShortcut(name: 'cmd-w', handler: () => boolean | undefined): () => void
}
```

- 页面 handler **同步**返回 `true` = 认领该次按键（壳不弹「Close dsh?」确认框）；
  `false` / `undefined` = 放行，壳维持默认行为（窗口关闭确认）。壳保证：页面
  无监听、handler 抛错或超时（1.5s）一律按「未认领」结算，主进程永不悬挂。
- 本插件注册后，Cmd+W 的行为是**只在标签与面板之间游走，永不关闭应用**（语义
  A）：内核右侧栏展开 → 关闭其活动 tab（关闭后**不**回读验证——内核
  `active()` 随 React render 滞后，回读会把成功关闭误判成拒绝并误折叠整个侧
  栏；内核唯一拒绝的场景是「唯一停靠的 guide」，此时为无操作认领）；展开栏
  **没有活动 tab**（空 pane）时折叠右侧栏作为「没有更多可关」的反馈；无内核
  栏的弹窗窗口 → 底部工作台：关其活动 tab，空工作台则收起；**任何状态下都认
  领**——插件挂载时 Cmd+W 不会触发壳的窗口关闭确认，关应用走 `Cmd+Q` / 红绿
  灯 / 壳菜单。纯浏览器 / 官方壳无该桥 → 本插件零行为。
- 消费方按「`typeof window.dshDesktopShell?.onShortcut === 'function'`」探测，
  不依赖 `dsh-desktop-mode` / UA；桥的实现在 deepseek-harness
  （`apps/electron/src/preload.ts` 契约面），本指南只是消费侧承诺。
- 便捷关闭的另一半：内核原生标签芯片的中键（鼠标中键）关闭由 harness 侧
  ui-dockkit 提供；插件底部工作台 TabBar 的 × 与中键关闭为插件自有实现。

#### 7.1.2 底部工作台焦点与关闭（DOM / Desktop 原生输入）

点击底部标签会显式聚焦其 `role="tab"` 元素（仅切换 store 的 active 不算键盘聚焦）。
当前 Desktop 原生输入不发 DOM keydown：宿主 `page.close` 的关窗回退经公开的
`shortcuts.closeWindow()` 调用。插件对该方法做 fiber 生命周期内的可释放适配，
仅当实时焦点在展开的底部面板内时改为关闭焦点分栏的活动标签；否则调用原方法。
旧 `dshDesktopShell` 桥也优先尊重底部焦点，不再让展开的右侧栏抢走底部关闭。
不修改 DSH 源码、不抢注宿主的 `page.close` 命令。

桥只存在于 deepseek-harness Electron 壳（主进程吞键）；**键能到达页面的环境**
（纯浏览器、官方壳、任何无桥壳）由插件自己的 window 捕获期 keydown 监听认领：

- **和弦**：`Cmd/Ctrl + W`（宿主桌面绑定）与 `Cmd/Ctrl + Alt + W`（宿主 web
  绑定）；拒绝 Shift。`preventDefault()` 让宿主快捷键派发直接 `pass`
  （`registry.dispatch` 对 defaultPrevented 手势跳过），`stopPropagation()` 不
  再把按键交给 xterm / 编辑器；浏览器「关标签页」默认同样被拦下。
- **范围门（关键）**：仅当 `document.activeElement`（或事件 composedPath）位于
  插件底部工作台 `[data-dsh-bottom-panel]` 内、且工作台 `bottomOpen === true`
  时认领。**焦点在面板外时完全放行**——右侧栏内的 Cmd+W 仍是宿主 `page.close`
  （关其 tab），输入框 / 页面其它区域的 Cmd+W 行为与安装插件前一致（可正常关
  应用 / 标签页）。本插件不劫持全局 Cmd+W。
- **动作**：关闭焦点所在 `[data-dsh-pane]` 的活动标签（分栏工作台按格关闭；
  焦点在面板 chrome 时回退 `activePane`）；该 pane 无可关 tab → 收起工作台；
  一次按压关一个 tab（按住不放的 repeat 被认领但不重跑，镜像宿主派发）。
- **终端例外**：纯 `Ctrl+W`（无 Cmd、无 Alt）焦点在 `.xterm` 内时放行给 shell
  （readline delete-word，宿主 web 运行时同款放行）；`Cmd+W`（macOS）与
  `Ctrl+Alt+W` 不是 shell 和弦，面板内一律认领。
- DOM 契约（消费方只读）：`[data-dsh-bottom-panel]`（工作台面板）、
  `[data-dsh-pane]`（分栏格，`data-dsh-pane` 值即格 id）、`.xterm`（终端内容，
  宿主同款类名）。关闭路径与 TabBar × 完全一致（`service.closeTab` →
  descriptor `onClose`、终端 close 帧与 pty 释放）。
- 与 §7.1.1 桥互斥不双触：壳吞键的环境键到不了页面；键到页面的环境走本监听。
  两条路径共用同一关闭解析（`closeBottomActiveTab`，pane 优先 → activePane →
  首叶 → 收起）。

### 7.2 Git 提交区接缝 + gitGraph 服务消费 + 计划 diff 预览（v0.20.x，features 含 `gitCommitActions` / `planDiff`）

外部插件（例如专用提交 Agent）在「Git 视角」提交区加自己的按钮、并把任意 patch 当 diff
预览，走这两个扩展接缝。Git 操作区默认仅展示 Commit / More，Push 收在 More 内，diff 行为不变。

#### 7.2.1 提交区动作（feature `gitCommitActions`）

```ts
interface GitCommitTarget {
  scope: SessionScope                 // 来源会话（sessionId + cwd）
  repoRoot?: string                   // 当前选中的子仓库根（undefined = 会话仓库）
  worktree?: string                   // 当前选中的 linked worktree（undefined = 主 checkout）
  branch?: string                     // 当前分支（detached / 未解析时 undefined）
  status: GitStatusResult             // GitLens 刚加载的状态快照（恒 isRepo: true）
  staged: readonly GitStatusEntry[]   // 与内置 Commit 按钮同一门槛的 index 侧行
}

interface GitCommitActionProps extends GitCommitTarget {
  service: BetterSidebarService
  refresh(): Promise<void>            // 跑一次 GitLens 的 status/branch/log 刷新
}

interface GitCommitActionDescriptor {
  id: string
  order?: number                      // 升序，缺省 100；同序按注册顺序
  available?: (target: GitCommitTarget) => boolean   // false = 该目标下不渲染
  component: (props: GitCommitActionProps) => ReactNode
}

// BetterSidebarService 新增：
registerGitCommitAction(descriptor: GitCommitActionDescriptor): () => void
getGitCommitActions(): readonly GitCommitActionDescriptor[]              // 注册顺序快照
getGitCommitTarget(scope?: SessionScope): GitCommitTarget | undefined   // 时点读
```

- **渲染位置**：Git 视角消息输入框独占一行，下方默认**仅 Commit / More 两个按钮**。
  Push、所有 `registerGitCommitAction` 扩展和 DSH slot 动作全部放在 More 菜单内，
  不根据数量额外露出按钮；不解析插件 DOM 或代点按钮。组件自带控件（图标 / 文案 / disabled）。
  More 使用宿主 portaled Menu，避免滚动区域裁剪；窄屏操作行允许换行。
- **内置操作**：Commit 只提交已暂存内容，空消息 / 无暂存 / busy 下按钮和 Ctrl/Cmd+Enter
  同样不可用。Push 仅普通 `git push`，不 force、不自动设 upstream；错误在操作栏显示。
  More 提供「推送」「提交并推送」「全部暂存」「全部取消暂存」。提交并推送中 commit 成功立即清草稿，
  后续 push 失败不会重做提交。所有内置操作复用当前 session / repoRoot / worktree 与互斥锁。
  `GitDataSource.gitPush?` 是可选能力；匹配的远程 provider 未提供时禁用 Push，**不回退本地**。
- **顺序与门槛**：`order` 升序、同序注册序；`available(target) === false` 跳过，`available`
  抛错记 console.error 并跳过。每个动作各自套 `RenderBoundary`——组件渲染抛错只显示一条
  内联错误条，提交行与兄弟动作照常。
- **生命周期**：注册即通知 `subscribe` 订阅者（挂载后注册也会即时出现）；disposer 摘除并
  再次通知。重复 `id` 抛错。`setGitCommitTarget(ownerId, target | null)` 是**内部**发布口
  （GitLens 调用），按实例 owner 键控，`getGitCommitTarget` 取「最近发布」；**发布不触发
  subscribe**（避免 发布→通知→重渲染→再发布 的自环）。因此 `getGitCommitTarget` 是时点读：
  渲染在提交行的插件直接吃 props；在别处读的插件自行在 `subscribeState` / 自己的轮询里重读。
  GitLens 卸载即清掉自己的 target。
- **边界**：better-sidebar 只提供接缝与「用户正在看的 worktree」这一事实，**不**存业务状态、
  **不**建会话、**不**跑计划侧 git；这些都归消费插件。

##### DSH 原生 action slot（推荐新插件使用）

`betterSidebar.git.actions` 是 **list / root** 槽，扩展显示在 More 菜单内。
槽由 better-sidebar 的 header entry 声明一次，授权 renderer 通过 portal 支持原生侧栏和
独立 React root 的底部工作台。不要每个 GitLens 自行声明、不要从 DOM 获取当前目标。
root scope 是刻意的：真实会话来自 `props.scope`，不能借 header 的 sessionId 推断。

```tsx
import type { GitActionSlotProps } from 'dsh-better-sidebar/client/service'
import { MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'

// type-only import 也载入 SlotMap 的声明增强；运行时跨插件不 import。
ctx.slots.inject('betterSidebar.git.actions', () => ctx.slots.register({
  name: 'betterSidebar.git.actions',
  id: 'my-plugin:git-action',
  order: 100,
}, (props: GitActionSlotProps) => (
  <MenuItemButton disabled={props.busy} onSelect={() => {
    props.close()
    void props.runAction(() => myGitAction(props.scope, props.repoRoot, props.worktree))
  }}>
    <span data-better-sidebar-git-action-label="">
      <span data-better-sidebar-git-action-title="">My action</span>
      <span data-better-sidebar-git-action-subtitle="">agent</span>
    </span>
  </MenuItemButton>
)))
```

`GitActionSlotProps` 包含全部 `GitCommitTarget` 字段，以及 `service?`、`commitMessage`、
`setCommitMessage(value)`、`busy`、`runAction(action)`、`refresh()`、`close()`。
`runAction` 与内置按钮共享互斥、错误行和成功后刷新；失败会被捕获并显示，Promise 不抛回插件。
**可选右侧 subtitle/tag**：菜单项 children 使用上例的公共 `data-better-sidebar-git-action-label`
容器，其中 `data-better-sidebar-git-action-title` 是左侧主标题、
`data-better-sidebar-git-action-subtitle` 是右侧非交互标签（例如 `agent`）。
宿主提供满宽 flex、长标题省略和主题令牌 badge 样式，插件无需导入 CSS；不需要 tag 时
省略 subtitle span 即可。subtitle 是身份提示，不使用 `shortcut`（它只表示真实快捷键），
也不要嵌套可点击按钮；标签文本保留在可访问名中。

消费组件用 `MenuItemButton` 或遵循 `role="menuitem"` 的按钮，保持宿主菜单键盘导航；
门槛不符可 return null，自带异步逻辑须尊重 busy，动作执行时使用当次 props 的 scope/worktree。
插件 id 必须唯一、order 决定槽内顺序；`ctx.slots.inject` 的生命周期返回 disposer，
父槽卸载后注销、重载后重注册。槽内动作与旧 registry 不应重复注册同一业务操作。
旧 registry 与新 slot 动作统一在 More（均不占常用按钮位）。
菜单关闭时扩展组件会卸载：打开对话框等持续 UI 时，须把 UI 状态及其渲染放在独立、
持久的宿主组件中，而不能把 Dialog 放在该菜单 action 组件内。

#### 7.2.2 计划 diff（feature `planDiff`）

`SidebarDiffRef` 增补一个 additive variant（v0.21.0 起追加截断 / 来源展示元数据）：

```ts
{ kind: 'proposed'; id: string; title: string; patch: string; worktree?: string; repoRoot?: string; truncated?: boolean; sourceRef?: string }
```

- `patch` 是**原始 unified diff 文本**，经既有 `parseUnifiedDiff` / `DiffFiles` 渲染栈原样渲染；
  该 variant **不跑任何 git 调用**（没有 git revision 可读，上下文折叠降级为不可用标记；
  语法着色 / 行内高亮 / 统计与 worktree·commit 完全一致）。
- `id` / `title` 是调用方自己的 patch 身份与标签；`worktree` / `repoRoot` 仅为展示元数据；
  `truncated` / `sourceRef`（v0.21.0）是**调用方声明的完整性元数据，仅展示用，绝不用于
  git 调用**——`truncated: true` 标记该 patch 是调用方截断后的部分预览，`sourceRef` 是补丁
  来源标签（如 `plan <id> rev 3`）。
- **快照提示条**：DiffTab 对 proposed 在 header 与内容之间渲染「计划快照」提示条（i18n 键
  `diffProposedNote`）；`sourceRef` 非空时同一提示条追加 ` · <sourceRef>`，`truncated` 时追加
  ` · diffProposedTruncated`。
- **不可解析显式提示**：`patch` 非空但 `parseUnifiedDiff` 解析出 0 个文件时（DiffFiles 对 0
  文件返回 null）显示显式提示（`diffUnparseable`），不空白。
- **文件定位**：每个文件头在 proposed 下提供「打开文件」按钮（i18n 键 `diffOpenFile`），经
  `openSidebarFile` 在**当前会话**侧栏编辑器打开**实时文件**——patch 本身始终是只读快照，
  打开的是当前工作区文件，路径相对会话 cwd 解析；worktree / commit ref 不提供该按钮。
- **行定位（v0.21.0）**：proposed 下的 diff 行也可点击（i18n 键 `diffOpenFileAt`，文案带行号
  插值），在**当前会话**侧栏编辑器打开实时文件并**定位到行**。行回调
  `onOpenRow(path, newLine)` 的 `path` 是该文件的展示路径（相对会话 cwd 解析），`newLine` 是
  该行的 **NEW 侧行号**；行点击经 `openSidebarFileAt` 走 `OpenTabSeed.line`（**仅 editor 种子
  有效**，其余类型忽略）→ 原生右侧栏 `openResource` 携带行号下发；删除行没有 new-side 行号，
  回调为 `null`（仅打开文件）。**行定位到资源打开，是否滚动由宿主编辑器决定**；patch 仍是只读
  快照，不因行点击而变；worktree / commit ref 不提供行点击。
- 打开方式（现有 seed API，无新方法）：

```ts
service.openTab({
  type: 'diff',
  id: `plan:${planId}:${commitIndex}`,   // 底部工作台的去重身份（见下方说明）
  title: `计划第 ${commitIndex + 1} 个提交`,
  diff: { kind: 'proposed', id: `plan:${planId}:${commitIndex}`, title: '…', patch: unifiedPatch, sourceRef: `plan ${planId} rev ${rev}`, truncated: isPartial },
})
```

  注意：原生右侧栏的 tab id 由宿主铸造，seed 的 `id` 只影响 onOpen 收到的合成 tab；diff 页
  按宿主的多实例规则打开，`patch` 随导航 params 下发到组件。

#### 7.2.3 gitGraph 服务消费（v0.20.x，软 join，provider：dsh-git-graph）

「Git 视角」的历史区（内置列表）可以经由另一个插件 **dsh-git-graph** 提供的**通用 GraphTree
框架**渲染：框架负责泳道/连线、虚拟滚动、键盘焦点与选择语义，**没有任何 Git 业务知识**；
行内容（hash / refs 药丸 / subject / author·time）仍是本插件原有的两行提交行，预览 / 右键
菜单 / 加载更多等全部业务留在 GitLens。服务缺失 / 协议不符 / 渲染异常 → 历史区**原样回到
内置列表**（与无框架时逐字节一致）。这是与 fileTreeUi v2 同款的**软 join**（§15 的
dsh-sentinel 展示了同样的软依赖写法）：

- 服务名 `'gitGraph'`、协议版本 `1`（文档化字符串协议，provider 与消费方各自持有字面量）；
  provider 在 client apply 里 `ctx.provide('gitGraph', service)`，卸载自动解除。
- 消费方**不把 provider 放进 dependencies**：只在 devDependencies 以
  `"dsh-git-graph": "link:../DSH-git-graph"` 引用其类型，运行时用 `ctx.get('gitGraph')`
  **每次调用现取**（不缓存句柄）+ 手写 shape 检查（`protocolVersion === 1 && typeof
  GraphTree === 'function'`）；跨包只 `import type … from 'dsh-git-graph/client-contract'`
  （无运行时 value-import，不触发 client bundle 纯度门）。
- 本插件内部实现：`src/client/git-lens-graph.ts`（软 join seat：bind/unbind +
  useSyncExternalStore 快照，`internal/service` 订阅驱动提供/卸载即时切换）。GitLens 历史
  区在服务可用且仓库有效时渲染 `<GraphTree …>`，否则渲染原列表。

```ts
// dsh-git-graph/client-contract 导出的 v1 契约（摘要）：
interface GraphTreeRow {
  id: string                  // 稳定唯一 id（GitLens 用完整 object id）
  parents: readonly string[]  // 真实父 id；框架只用于拓扑，不认识其含义
}
interface GraphTreeProps<R extends GraphTreeRow> {
  rows: readonly R[]                          // 子在前、父在后的拓扑行（追加页沿用布局缓存）
  renderRow: (row: R, ctx: GraphTreeRowContext) => ReactNode   // 整行内容 slot，消费方全权
  selectedId?: string
  onSelect?: (id: string) => void        // 单击 / Enter / Space
  onActivate?: (id: string) => void      // 双击
  onContextMenu?: (id: string, event: GraphTreePointerEvent) => void
  hasMore?: boolean; onLoadMore?: () => void; loading?: boolean
  rowAttributes?: (row: R) => Record<string, string>
  ariaLabel?: string; emptyText?: string; loadingText?: string; loadMoreText?: string
  height?: number; rowHeight?: number; overscan?: number; className?: string
}
interface GitGraphServiceV1 { protocolVersion: 1; GraphTree: <R extends GraphTreeRow>(props: GraphTreeProps<R>) => ReactNode }
```

- **数据要求**：框架只吃 `id + parents`，因此 `api.gitLog` 的行现在携带真实 `parents`
  （`%P`），且 GitLens 的分页走**固定 roots + 游标**模式（首页 `roots: []` = 服务端
  解析并钉住自己的 HEAD tip；后续页只传响应里的 `cursor`，游标随机绑定 offset 并绑定
  会话/仓库）——翻页期间新提交 / force-reset 不会让行位移或串台，图的泳道布局保持稳定。
- **事件路由**：行点击 / Enter / Space → `onSelect` / `onActivate` → GitLens 预览该提交
  （`onPreview(commitRefOf(…))`）；右键 → `onContextMenu` → GitLens 共享的历史右键菜单
  （查看 diff / 复制短/全 hash / 复制 subject / revert / cherry-pick）；加载更多 →
  `onLoadMore` → GitLens 现有的 loadMore 逻辑（`hasMore` / `onLoadMore` 直通）。框架内
  **不放任何业务操作**。
- **回退边界**：服务缺失 / 版本不符 / 卸载 → 内置列表；渲染抛错 → 宿主边界捕获、
  `console.error` 后回退列表；图形故障对当前 checkout **保持一次（本次会话）粘性**，
  切换 checkout 或服务重新提供（重挂）即重试。
- **空 / 加载 / 加载更多文案**复用本插件词典：`noHistory` / `loading` / `loadMore`
  （20 份语言文件已同步）。
- **独立 Tab**：dsh-git-graph 自带的历史 Tab（`dsh-git-graph:history`）是框架的**演示与
  独立用途**，与本接缝无关——它用同一框架组件加自己的只读数据层，不是集成通道。

---

## 8. 声明式设置（v0.4.1+）

每个注册的 tab / viewer **自动**出现在 DSH 设置页「侧边卡片」分区（`SideCardSection` 按注册表驱动渲染，无硬编码）：

- 展示：小卡片网格（图标 + 标题 + 类型 id），**高亮 = 启用**，勾选徽标钉在卡片最右端；viewer 卡片额外显示扩展名。
- 持久化：开关写入 `SidebarPrefs.tabsEnabled / viewersEnabled`（开放 map，**缺省 = 启用**，显式 `false` 才禁用）。
- 关闭语义：tab 从 `+` 菜单消失、`openTab` 拒绝新开（`console.warn`）、派生流程（子代理自动展开、agent 终端自动补 tab）停止，**已打开的 tab 保留**；viewer 被 `matchFileViewer` 跳过，文件落到下一个匹配。
- `settings.toggles`（可选）：在卡片行下追加**嵌套设置行**（仅父级启用时显示），绑定 `SidebarPrefs` 字段；通过卡片底部「功能设置」条在原生弹窗中编辑。行控件形状见 §4.1 的 `SettingRow`：`type: 'switch' | 'text' | 'number'`（v0.11.0+；text/number 行 blur/Enter 提交，number 行按 min/max 钳制，unit 渲染单位后缀）与 `type: 'select'`（v0.13.0+；`options` 支持 value/title/desc/icon，`multi` 多选存数组并按 options 顺序提交；任一项带 icon 时渲染大图标选项卡）。内置示例：subagent tab 的 `autoOpenSubagent`、editor tab 的 `editorExplorer` 图标化下拉（工作区路径围栏与它的开关已移除，见 §8.1）。
- `settings.pluginToggles`（可选，v0.12.0+）：**插件自有设置行**，行控件与 toggles 相同，但 key 是插件局部的——持久化在 prefs 文档的 `pluginSettings[<descriptor id>]`（开放 map，无需宿主 schema 字段）。tab 与 viewer 都可用（v0.12.0 起 viewer 卡片也有设置条）。
- `settings.render`（可选，v0.12.0+）：**自定义设置面板**——追加渲染在行列表之后，可单独存在。props 含 store/service/prefs、本 descriptor 的 `pluginSettings` blob、`updatePluginSetting(key, value)` 与 `close()`；抛错会被吞掉并显示内联错误。

```ts
ctx.effect(() =>
  ctx.betterSidebar.registerTab({
    id: 'my-plugin:db',
    title: 'Database',
    order: 50,
    settings: {
      // 宿主 prefs 字段行：key 必须是宿主 PrefsSchema 的字段（仅此限制）
      toggles: [{
        key: 'autoOpenSubagent',   // 宿主内置键
        title: 'Auto-open',
        desc: 'Open when a subagent appears',
      }],
      // 插件自有设置行：key 插件局部，持久化在 pluginSettings['my-plugin:db']
      pluginToggles: [{
        key: 'pageSize',
        title: 'Page size',
        type: 'number',
        min: 1,
        max: 100,
        unit: 'rows',
      }],
      // 或完全自定义面板（追加在行列表之后）
      render: ({ store, service, prefs, pluginSettings, updatePluginSetting, close }) => (
        <MySettingsPanel
          values={pluginSettings}
          onChange={(key, value) => { updatePluginSetting(key, value) }}
          onDone={close}
        />
      ),
    },
    component: ({ scope }) => <DbView sessionId={scope.sessionId} />,
  })
)
```

> ⚠️ **`toggles` 的 key 必须是本插件 `PrefsSchema` 的字段**（`PrefsSchema` 已并入本插件 Loader 行的 `Config`；内置键：`autoOpenSubagent` / `autoOpenJobs` / `tasksViewMode` / `mobileNoAutoOpen` / `mobileDefaultTree` / `agentTerminalTools` / `agentOpenTools` / `bottomPanelAutoTerminal` / `terminalShell` / `terminalShellArgs` / `terminalFontFamily` / `terminalFontSize` / `editorExplorer` / `titleBarScheme` / `titleBarPresetId` / `customCss` / `titleBarCompat` / `titleBarStripPx` / `htmlViewerNoSandbox` / `htmlViewerDefaultUnsafe` / `tabsEnabled` / `viewersEnabled` / `pluginSettings`；**已删除**：`browserNoSandbox` / `browserAllowedLoopback` / 三个按协议分流的旧外链接管键）。**v0.12.0 起设置 seam 已开放**：你自己的设置走 `pluginToggles`（声明式行）或 `render`（自定义面板），值持久化在 `pluginSettings[id]`——不再需要本插件的 schema 字段，也不再被 seam 丢弃。值须 JSON 可序列化（行控件只产出 string/number/boolean；自定义面板自行负责）。

### 8.2 宿主设置表单（DSH 0.1.7+：`SettingsForms`）

**0.1.7 把可注册的设置命名空间整体删除了。** `ctx.settings.register(ns, schema)` 与它返回的 `get` / `watch` / `update` / `replace` 都已不存在，取而代之的是 `SettingsForms`——一套**按 profile 条目寻址**的表单服务：

```ts
interface SettingsForms {
  /** 只列出「导出了 Config 且 fiber 处于 ACTIVE」的条目；ns 就是 Loader 行的 entry id。 */
  describe(options?: { redactSecrets?: boolean }): SettingsDescriptor[]
  /** 把 patch 合并进该条目的 config（revision 不符时抛 SettingsConflictError）。 */
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
  /** 重置全部 live 字段后再写入给定字段（普通 config 保留）。 */
  replace(ns: string, section: object, expectedRevision?: number): Promise<void>
  /** 按路径逐字段改（持不完整视图——例如被脱敏的秘密字段——时用它，别用 replace 重述整节）。 */
  mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
  /** 声明本插件实例的页面策略（自带设置页的插件写 auto: false）；返回 disposer。 */
  configure(presentation: { auto?: boolean }, owner?: Fiber): () => void
  get writable(): boolean
  get documentPath(): string
  prepareDocument(): Promise<string>
}

interface SettingsDescriptor {
  ns: string          // profile 条目 id —— 不是插件自选的命名空间
  autoGenerate: boolean
  schema: unknown
  value: unknown      // 已解析（defaults → composition base → 用户层）
  revision: number
  base?: unknown
  user?: unknown      // 只读的 profile 覆盖层；为空 = 该条目还没被用户写过
  applies: 'live'
  secrets?: RedactedSecret[]
}
```

四条必须记住的新规则：

1. **命名空间 = 插件 Loader 行的 `entry.options.id`**，不是插件自选的字符串。聚合包会用别的 id 挂同一个包，所以**运行时自发现**（本插件 `src/index.ts` 的 `ownEntryId(ctx)`：按 `entry.options.name === '<包名>'` + `entry.fiber === ctx.fiber` 匹配，回退到第一个启用的同名行），**不要硬编码** id。
2. **schema 来自插件模块导出的 `Config`**（`entry.fiber.runtime.Config`）。用户可见的字段必须**并进这个 `Config`**——本插件把 `PrefsSchema` 合并进 `Config`（`src/config.ts`），并把每个偏好字段标 `meta.volatile = true`；**这一个标记就是「改设置实时生效、不重挂插件」的全部机制**（Loader 的 `equalExceptVolatile` 跳过 volatile 字段，纯 volatile 变更提交进运行中的引用并发 `loader/volatile-update`，普通字段仍是重挂语义）。
3. **自带设置页的插件要主动退出自动表单**：`ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber))`，否则 Settings 会把同一批字段渲染两遍（策略不影响读写）。
4. **`settings/document-updated` 你监听不到，别写**：事件签名是 `'settings/document-updated'(ns, revision)`（语义是「该条目的表单值 / 可用性 / 页面策略变了，表单客户端重新读取 schema、解析值与 revision」），但它在 **settings 服务自己的 context 上 `emit`**，而 cordis 事件只向该 ctx 的**祖先**冒泡——插件 fiber 是兄弟，`ctx.on(...)` 永远不会触发。**替代做法：每次重新读取表单时重新求值**（本插件的 `settingsFace.get()` 在返回当前值前跑一遍门控同步；客户端侧另经 `remote` 服务的 `$on('settings/document-updated')` 镜像触发重新拉取）。**旧文档里的 `settings/updated` 事件在 0.1.7 已不存在**。


### 8.1 工作区包含检查已移除（v0.23.0，权限放开）

**`workspaceFence` 这个键已经不存在了，也没有替代开关。** 侧栏的文件系统路由（`fs.tree` / `fs.trees` / `fs.read` / `fs.write` / `fs.rename` / `fs.remove` / `fs.mkdir` / `/sidebar/file` 媒体 / `/sidebar/html` 预览 / `/sidebar/upload` / `archive.build`）**不再做任何工作区包含检查**：路径只做词法解析（会话相对路径拼到会话 cwd 下、`resolve()` 折叠 `..`），不再 realpath、不再比对前缀、**不再有 403 `forbidden` 分支**。符号链接被照常跟随。

> ## ⚠️ 安全声明（必读）
>
> 这是一次**权限放开**：插件侧边栏的 fs 路由现在能读写**宿主用户能访问的任意路径**，只受 OS 权限约束。也就是说，一个能访问到本插件 `/sidebar/*` 路由的同源页面/脚本（**包括你写的第三方消费插件**）可以借这些路由读取、改写、删除该用户权限内的任何文件——例如 `~/.ssh/`、`~/.dsh/`、其他项目的源码。
>
> 缓解手段只有两块，别指望有第三块：① 每条路由都过同一个**浏览器信任栅栏**（Host 头 loopback / `trustedHosts`，见 §0 与 §10），所以前提是攻击面已经能发同源请求；② 宿主用户的 OS 权限本身的边界。**不要**再把「工作区围栏」当成安全边界来设计你的插件——它已经不在了。

历史背景（`< v0.23.0`）：旧的实现用 realpath 解析后比对工作区前缀，越界回 403，并有一个 `workspaceFence` 开关（默认开）可临时关闭；开启时编辑器/文件树错误面会显示原因 + 一键关闭按钮（`FenceErrorNotice`）。用户要求删除该检查，上述代码路径随之删除（`src/path-security.ts` 现在是纯词法解析）。旧 profile 里遗留的 `workspaceFence` 键只是**未知键**——schemastery 的 object schema 对未知键是容忍的，既不报错也不再有任何效果。

### 8.2 历史只读越界开关

`allowOpenOutsideWorkspace` 随工作区包含检查一并移除；旧配置中的该字段不再生效。当前读写权限均遵循 §8.1。

### 12.1 规则

- **面板表面**：右/底面板背景 = `var(--dsw-alias-bg-layer-1)`。**绝不消费 `--dsw-specific-sidebar-fill`**（宿主左导航专属，皮肤按左导航语义覆盖它，面板消费会失去填充）。换面板表面 = 覆写 `--dsw-alias-bg-layer-1`。
- **终端/编辑器表面**：`effectiveTokenValue` 读 `--dsw-alias-bg-base`——`transparent` 与 alpha < 0.9 的半透明值回退不透明底色（文字不叠背景画，issue #90）；≥ 0.9 放行。
- **根锚点**：宿主 div 带 `data-dsh-better-sidebar`（append 到 `#root`，**绝不 append 为 `body` 直子**：`ui-web base.css` 给 `body > :not(#root)` 声明 `-webkit-app-region: no-drag`（模态覆盖层约定），而 Chromium 把该计算值沿祖先链传播——常驻全窗宿主挂在 `body` 下会把 macOS 隐藏标题栏壳的整块拖拽面（侧边栏条 / 对话 header 等 `data-window-drag` 行）全部减去，窗口任何位置都拖不动）；其内**面板宿主层** `[data-dsh-panel-host]`（`fixed; inset:0; z-25; pointer-events:none; overflow:hidden+clip`，v0.13.1+），面板/开关簇 absolute 定位，免疫中间层 transform 劫持；页面级 transform 触发 `data-dsh-panel-host-degraded` 降级。`overflow` 级联是**契约**（`hidden` 兜底 + `clip` 收尾，`tests/panel-host-css.spec.ts` 守护）：`hidden` 盒子仍是滚动容器，脚本滚动或浏览器 scroll-into-view 修正（焦点移入视口外区域、嵌套 iframe/工作台加载时抢焦点、面板滑出动画中 focus() 落点）会沿最近可滚祖先滚走整层——面板与开关簇集体偏离视口角（computed left/right 仍"正确"，偏移藏在盒子自身 scroll offset 里）；`clip` 裁剪语义相同但不产生滚动盒，任何路径都滚不动这层。皮肤作用域覆盖限定在 `[data-dsh-better-sidebar]` 内。
- **布局变量**（`<html>` 上，面板打开时有效）：`--dsh-sidebar-width` / `--dsh-sidebar-height`。右面板宽度 = AppFrame 的 `padding-right` 预留（新版 `#root [data-dsh-frame]` / rc.8 `#root > [data-slot="root"] > div` 双锚点），AppFrame border box 保持完整桌面视口宽度（Harness 以此判定桌面/窄屏布局，避免插件面板展开误入窄屏）；AppFrame 的 details 拖拽手柄按同一变量向左平移贴合列边缘。底部面板仍走 centerCol `margin-bottom`；centerCol 锚点 = **JS 标注**（禁止 `nth-child`）：侧栏 shell 的定位器给测得的 centerCol 节点打 `[data-dsh-center-col]` 标签（`Sidebar.tsx` locate，节点更换/HMR 时随 ref 迁移），`layout.css` 用 `#root [data-dsh-center-col]` 选中（`drag-layout.e2e.ts` 断言恰一节点且为对话槽宿主的父级——alpha.2 起 shell 把 `#root [data-slot="main.conversation"]` 解析进列并跳过 `display: contents` 祖先（`center-column.ts` 的 `CENTER_COLUMN_SELECTOR` 同时认 `main.conversation` 与 alpha.1 的 `conversation`），定位器从槽宿主向上取第一个非 `contents` 的祖先；frame 宽度与桌面 Session Log 由 `desktop-layout.e2e.ts` 断言）。
- **桌面信号与标题栏**（v0.14.1+ 四方案模型 `SidebarPrefs.titleBarScheme`，唯一决策点 `src/client/titlebar-strip.ts` 纯函数）：
  - 壳信号（只读，不自动触发修改）：URL `dsh-desktop-mode` / `dsh-desktop-platform` / 可选 `dsh-desktop-titlebar-inset`（0–120 clamp）。
  - **strip 取值链**：⓪ `web` 方案强制 0；① `navigator.windowControlsOverlay` 真实几何（`wco.ts` 订阅 `geometrychange`，**为 0 也权威**，`visible=false` 幽灵 API 视为缺失）；② URL inset；③ 壳预设 `stripFor`（仅 `preset`）；④ 手动 `titleBarStripPx`（仅 `custom`）；⑤ 0。驱动 `body[data-dsh-title-bar-compat]` + `--dsh-title-bar-strip`。
  - **四方案**：`auto`（默认，只信 WCO——"为某壳做的兼容在另一个壳会再坏"，核心不做壳专属分支）/ `web`（强制 0）/ `preset`（`src/client/shell-presets.ts`，准入：issue/PR 提及且 GitHub ⭐>100；命中环境显示「已检测」后缀，绝不自动启用）/ `custom`（用户 CSS + 手动 px，齿轮弹窗）。
  - **迁移**：`titleBarScheme` 无默认值；旧文档已有值（`titleBarCompat === true` 或 `titleBarStripPx` 非 40）→ 迁 `custom`；干净文档 → `auto`。
  - **用户空间 CSS**：预设/自定义 css 注入 `<style data-dsh-preset-css|data-dsh-custom-css>` 到 head 末尾（后写胜出；覆盖 JS 内联需 `!important`），fiber 卸载即移除。稳定寻址面：`[data-dsh-toggle-cluster]` / `[data-dsh-panel]` / `[data-dsh-bottom-panel]`。
  - **拖拽区退出**：交互 chrome（`.toggleCluster` / `.toggleButton` / `.tabBar`）统一 `-webkit-app-region: no-drag`（无边框壳拖拽带吞点击，#103/#111）。
  - **拖拽区退出（视口层）**：宿主把每个**直挂 body 的子元素**都设成 `no-drag`（`html[data-platform=darwin] body > :not(#root)`，选择器含 id，只能靠 `!important` 压过），而 app-region **无视 `pointer-events`**——插件宿主就是这样一个 body 子元素，在 Electron 里该值还会传到它内部的**铺满视口的面板层**（#772 的 CDP 实测；挂载 lane 用的浏览器引擎不传播该属性，所以面板层自己也声明了同一条规则），于是它把下面每条 `[data-window-drag]` 拖拽带一起抵消（窗口拖一次就失效，同时丢掉 macOS 双击标题栏缩放，issue #772）。契约：装饰性的视口层用**中性值** `-webkit-app-region: initial !important` 退出计算（`initial` 的计算值 `none` 不扣减拖拽区；注意**字面量 `none` 不是中性值**——它计算成 `no-drag`，是扣减值），层内的面板/控件再声明 `no-drag` 保住点击；当前覆盖 `[data-dsh-better-sidebar]`、`[data-dsh-panel-host]`（`> *` 保持 `no-drag`）与 `.mermaidModal`（放大视图是第二个**持久**铺满视口的 body 直挂层）。**交互弹层不要加 `initial`**（`.selectionPopup` 是 `<button>`，`FloatingWindow` / `AnchoredPopover` 自带指针拖拽、不是遮罩层）：宿主 `:is(button, a, input, …)` 已给它们 `no-drag`，反过来声明 `initial !important` 会让按下变成拖窗（重演 #103/#111）。放大视图是**遮罩层例外**——它是模态，只有其中的控件必须保持 `no-drag`；代价是它覆盖在顶部拖拽带上时，点背景会变成拖窗而不是关闭（为「放大图时窗口仍可拖」付的账）。**未纳入**：`FileTree` 的 `.uploadDropChatHint` 同样是 body 直挂的装饰层，但它只在 OS 文件拖拽悬停期间存在且 `pointer-events: none`，收益极小、暂不处理（`FloatingWindow` / `AnchoredPopover` 是交互层，按上面的判据本就该保持 `no-drag`）。形状由 `tests/panel-host-css.spec.ts` 在 Linux 的 `pnpm test` 里守护（无 macOS runner；`tests/theme.spec.ts` 只守颜色，故本轮不涉及），真实级联由挂载 lane 的探针按宿主规则断言计算值（面板宿主探针复现宿主两条 darwin 规则，放大视图探针直接用页面里宿主自己的规则）。
- **z-index**：面板宿主层 25、按钮簇 45——低于 DSH ui-cordis 插件面板（30）与浮层栈（100/1000+），浮层天然盖住侧边栏。

### 12.2 注意事项

- 类名是 CSS Modules 哈希，**不是契约**；精确命中用 `[data-dsh-better-sidebar]` + 子串类名（`[class*='panel']`）或 DOM 结构。
- 改动本契约必须同步本文档、设计文档与 `tests/theme.spec.ts`。

---

## 13. 完整最小示例

假设插件 `my-plugin` 要加一个 "Database 浏览器" tab + `.csv` 文件预览器。

**`my-plugin/package.json`**：

```jsonc
{
  "name": "my-plugin",
  "version": "0.1.0",
  "main": "lib/index.js",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "dsh-better-sidebar": "workspace:*",
    "react": "^18.2.0"
  },
  "peerDependenciesMeta": {
    "dsh-better-sidebar": { "optional": true }
  }
}
```

**`my-plugin/src/client/index.tsx`**（CSV viewer 的 `custom` load 直取 `/sidebar/api/fs.read`，注意响应 envelope 是 `{ value }`）：

```tsx
import { createElement } from 'react'
import type {} from 'dsh-better-sidebar'  // 触发 ctx.betterSidebar 类型合并
import type { Context } from '@deepseek-ai/cordis'

export const inject = ['betterSidebar']

export function apply(ctx: Context): void {
  // Database tab（单实例，+ 菜单可见）
  ctx.effect(() =>
    ctx.betterSidebar.registerTab({
      id: 'my-plugin:db',
      title: () => 'Database',
      order: 50,
      dedupeKey: () => 'my-plugin:db',
      component: ({ scope }) => createElement(DbView, { sessionId: scope.sessionId }),
    })
  )

  // CSV viewer（custom 策略：自己拉字节 + 解析）
  ctx.effect(() =>
    ctx.betterSidebar.registerFileViewer({
      id: 'my-plugin:csv',
      exts: ['csv'],
      fetchStrategy: 'custom',
      load: async (path, scope) => {
        const res = await fetch('/sidebar/api/fs.read', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: scope.sessionId, path }),
        })
        const { value } = await res.json()
        return parseCsv(value.content)
      },
      component: ({ customData, path }) =>
        createElement(CsvGrid, { rows: customData as string[][], path }),
    })
  )
}

function DbView(props: { sessionId: string }): React.ReactNode { /* ... */ }
function CsvGrid(props: { rows: string[][]; path: string }): React.ReactNode { /* ... */ }
function parseCsv(text: string): string[][] { /* ... */ }
```

**注册到 profile**：

1. `~/.dsh/profiles/web/package.json` 的 `dependencies` 加 `"my-plugin": "link:<你的插件路径>"`；
2. `~/.dsh/profiles/web/cordis.patch.yml` 追加挂载行（`- insert: - id: my-plugin / name: 'my-plugin'`）；
3. 在 profile 目录 `pnpm install`；
4. 浏览器硬刷新（Cmd/Ctrl+Shift+R）即可看到效果（DSH 对 client 改动热加载，无需重启 `dsh web`；仅 host 半改动需要重启）。

---

## 14. 参考实现与调试

better-sidebar 的内置 tab 和 viewer 就是参考实现（"吃狗粮"），调试时直接读：

- **`src/client/builtins/`**：5 个内置 tab（tabs.tsx）+ 3 个内置 viewer（viewers.tsx）的注册代码 + 聚合与 disposer 生命周期（index.ts）；Office / 表格 / 图片 / PDF 预览**不在插件里**（宿主的 `ui-sidebar-documentpreview` 负责，见 §5.4）
- **`src/client/service.ts`**：`BetterSidebarService` 接口 + `createBetterSidebarService` 工厂实现（含匹配算法、dedupe、createTab、启用态 gating）
- **`src/client/Sidebar.tsx`**：底部工作台外壳 + `TabContent` 分发（查 `getTab` → 调 descriptor.component；未注册 → `<OrphanedTab/>`）、`+` 菜单构建（order 排序 + available disabled + 禁用过滤）
- **`src/client/native/`**：原生右侧栏接入（tab 类型注册、合成 `SidebarTab` 适配、资源地址、跨会话打开排队）
- **`src/client/sidebar/bottom-toggle.tsx`**：底部工作台开合按钮（注册进 DSH 会话头 utilities 槽）
- **`src/client/SideCardSection.tsx`**：声明式设置页（注册表驱动清单 + 嵌套设置行 + 开关持久化）
- **`src/client/api.ts`**：`/sidebar` API 的封装（复制其 fetch 模式到你的插件）
- **`src/client/plugins-tabs.ts`** / **`plugins-viewers.ts`**：推荐插件目录（「添加插件」弹窗数据源；加一条数据即上架，`tests/plugin-list.spec.ts` 守护）
- **`src/client/FileTree.tsx`** / **`TreePanel.tsx`** / **`src/fs-search.ts`**：文件树 / 树面板 / host 文件名搜索（`fs.search`；`tests/fs-search.spec.ts`）
- **`src/client/markdown-html.ts`** / **`MarkdownHtml.tsx`** / **`md-toc.tsx`**：markdown 内嵌 HTML 管线与目录大纲（注意 `md-toc.tsx` 头注释的「子组件读父 ref 为 null」时序陷阱）
- **`src/agent-opens.ts`** / **`/sidebar/ws/agent-opens`**：模型主动打开（`sidebar_open` 工具 + `agentOpenTools` 设置，默认关闭）；文件夹窗口 = `meta.dir: true` 的 editor tab（[设计文档](plans/2026-08-23-agent-open-tools-design.md)）
- **`tests/service.spec.ts`** / **`tests/builtins.spec.ts`**：注册表生命周期 / 匹配算法 / dedupe / createTab / 启用态 gating；内置清单断言（5 tab + 3 viewer + 声明式元数据，并显式断言 image / pdf / binary-download **不在**内置清单里、但作为公开契约仍可被第三方注册）
- **`src/fs-watch.ts`** / **`src/client/use-dir-watch.ts`**：文件树实时刷新（按展开目录 watch，150ms 去抖、每连接 64 个句柄上限；`tests/fs-watch.spec.ts` 守护）
- **`docs/plans/`**：逐特性设计文档（含实施偏差记录，以现状为准）；入口如 `2026-08-11-service-registry-design.md` / `2026-08-11-declarative-sidebar-settings-design.md`

---

## 15. 真实接入案例

第一个通过 `ctx.betterSidebar` 接入的三方插件：[dsh-sentinel](https://github.com/fuhefei/dsh-sentinel) —— 条件驱动的 agent 唤醒系统（文件/进程/端口/HTTP/命令/webhook 传感器，条件达成自动唤醒休眠会话）。

- **接入方式**：可选软依赖——client half 本地重述最小服务契约（`registerTab`），未安装 better-sidebar 时注册静默跳过，插件原有表面不受影响；
- **注册内容**：`dsh-sentinel:watches` tab（order 60，单实例）：全服务器监控表 + 最近触发历史；
- **类型处理**：未 value-import `dsh-better-sidebar`，构建零耦合；与 §2 的 `import type {}` 方案可互换；
- **实测**：v0.3.0 起，真实 web profile 验证通过。

通过 `ctx.betterSidebar` 的三方插件 [dsh-sidebar-qa](https://github.com/ChenRuoT/dsh-sidebar-qa) —— 基于 better-sidebar 的划选提问：对话划选 → 右侧面板提问 → 同工作区独立追问会话（❓追问·主题）；快速无思考模型压缩主对话上下文后与引文一起注入，不打断主对话；追问可嵌套、可继续、可归档。

更多插件接入后欢迎在此登记（一句话 + 链接）。

---

## Terminal source 槽位（feature 'terminalSource'）

终端 tab 的连接层注入槽位（v0.22.0+，本构建 `0.23.0-mainslot.1`）：允许外部插件接管**默认终端 tab**（内置 descriptor 铸造的 `terminal:<uuid>` tab）的 connection layer，而视图自身（xterm 渲染、块覆盖层、选择、fit/theme/font、banner 状态机）原样保留。

- **注册方法**（`ctx.betterSidebar`，返回 disposer，Cordis `ctx.effect` HMR-safe；重复 id 抛错）：

  ```ts
  registerTerminalProvider(provider: {
    id: string
    match(sessionId: string, cwd: string | undefined, tabId: string): boolean
    createTransport(sessionId: string, cwd: string | undefined, tabId: string): TerminalTransport | undefined
    createWorkspaceSource?(sessionId: string, cwd: string | undefined): WorkspaceTerminalSource | undefined
  }): () => void
  getTerminalProviders(): readonly TerminalProviderDescriptor[]
  ```

- **features 门**：`features` 含 `'terminalSource'`（`SIDEBAR_FEATURES` 数组）；消费插件注册前先 `features.includes('terminalSource')` 探测。
- **解析语义**：注册顺序 first-match——终端 tab 挂载时按注册顺序求值 `match(sessionId, cwd, tabId)`（三参数逐字透传，不做任何路径/会话转换），第一个命中者的 `createTransport` 提供 `TerminalTransport`（即视图已有的 transport 语义，不是第二套 wire 协议）；`match` 抛错跳过（console.error），`createTransport` 抛错或返回 `undefined`（按 tab 拒接）同样跳过并轮到下一个 provider。解析是纯函数（`resolveTerminalSource`），渲染侧经 `useTerminalTransport` hook 订阅注册表，provider 晚注册只影响之后挂载的 tab，不热切换已打开的终端。
- **本地回退与 workspace 终端**：新普通终端无 provider 认领时，服务异步创建 workspace 终端，以 `meta.workspaceTerminalId` 标识资源；视图使用本地 workspace WS 协议，绕过 provider 解析（不能将已有本地 PTY 因晚注册 provider 改接到远程机器）。既有未带该元数据的持久化终端仍使用历史 session/tab 本地路径。`agent:` tab（模型自有终端）与 `gb:`（全局共享终端窗口）由 provider 在 `match` 里自行拒绝——平台终端绝不允许被接管。普通 provider 终端继续通过 `src/client/builtins/tabs.tsx` 的 `TerminalTabTransport` 包装走同一解析面。
- **消费方引导**：参考实现在 [dsh-remote](https://github.com/omdsh-dev/dsh-remote) 的 `terminalTunnel`（`lib/client.js`：`{ id, apiVersion, match(sessionId,cwd,tabId), createTransport(sessionId,cwd,tabId)→transport|null }` 注册点 + `makeRemoteTransport`）。`TerminalTransport` 词汇（`src/client/terminal-transport.ts`）：`{ kind, open(session) → handle }`；`handle = { input(data), resize(cols,rows), close(), park(), dispose(), retry?() }`；`session = { term: { write(data), cols, rows }, scope, tabId, cwd?, onOutput(data), onTitle?(title, info?), onConnected?(bool), onFatal?(reason|null), onEndpoint?(url) }`。类型与解析器从 `dsh-better-sidebar/client/index` 可导入（`TerminalProviderDescriptor` / `resolveTerminalSource` / `useTerminalTransport` / `TerminalTransport*`）。

## Workspace 终端管理（本地与 Provider）

### 远程管理槽位（feature `workspaceTerminalSource`）

`TerminalProviderDescriptor` 可选声明同步工厂 `createWorkspaceSource(sessionId, cwd)`。消费方应先检查 `features.includes('workspaceTerminalSource')`。工厂返回：

```ts
interface WorkspaceTerminalSource {
  create(title?: string): Promise<WorkspaceTerminalInfo>
  list(signal?: AbortSignal): Promise<{ terminals: WorkspaceTerminalInfo[] }>
  terminate(terminalId: string): Promise<unknown>
  createTransport(terminalId: string): TerminalTransport
}
```

- 管理页以 `terminal:workspace-management` 探测 `match`，首个命中的 provider 负责整个管理面；同步工厂抛错或能力缺失显示错误，**不回退本地镜像**。Provider 的 `match` 须同步识别已知绑定，缓存更新后通知注册表，不能用尚未预取到的缓存把已知远端会话判为本地。
- 新建普通终端命中带该工厂的 provider 后，先 `source.create()`，再打开持有实例 ID 的视图；旧 provider 不带工厂时仍走原 transport，不自动迁移。
- 页签持久化 `meta.workspaceTerminalProviderId` + `meta.workspaceTerminalId`。ID 是不透明非空字符串（允许 `term-*`），按 provider + ID 去重。已保存的远程身份只通过**同一 provider**复连；provider 缺席或不再授权时显示不可用，不能改接本地或另一 provider。既有本地实例仍绕过 provider。
- `createTransport(existingId)` 只连接已存在进程，不创建 shell。managed transport 的 `close/park/dispose` 都只分离视图；只有 `terminate()` 明确结束进程。后台须自行保证 workspace/target 隔离、授权、配额、有界输出及卸载清理。
- `TerminalTransportSession.onClosed?('exited'|'terminated'|'missing')` 用于结束/实例丢失状态，停止自动重连并提供重新启动；重启经同一 source 创建新 ID，只替换当前视图。`onFatal` 保留网络或权限错误，不可将越权当作重启许可。
- source 与 binding 类型从 `dsh-better-sidebar/client` 导出。dsh-remote 的 tunnel 可透传此工厂，workbench 同时支持 tunnel 与 direct provider；不必 value-import 其他插件。
- **能力诊断与部署**：`Workspace terminal management unavailable: <provider>` 表示已命中 provider，但同步工厂没有返回 source；它不是本地 PTY 依赖错误。请核对 profile 实际引用的发行副本是否包含该工厂，以及被委托后端是否有对应会话绑定。源码目录测试通过不代表 profile 的 `deploy-pkg` 已更新；新增 host 管理路由需要重载宿主，单刷新浏览器不能加载新后端。`rw_connect/rw_pick_workspace` 与独立 workbench target/binding 不等价；不得复制凭据或伪造绑定来掩盖缺能力。Provider 加载新能力并通知注册表后，已打开的管理页会重新解析 source、清除旧错误并加载列表，无需删除本地或远程实例引用。

### 本地后端

新建本地终端独立于 session 的页签生命周期。右侧栏指南与底部工作台 `+` 新建菜单均提供「工作区终端」管理 tab（类型 ID `workspace-terminals`，每个承载面内按 session 单例），列表直接在 tab 内扩展展示。`openTab({type:'workspace-terminals'})` 或指定 `target:'right'` 时进入原生右侧栏；指定 `target:'bottom'` 时进入底部工作台，右侧栏不可用时也回退到底部。管理页内的「打开」仍将终端视图打开到底部工作台。同一 workspace 的 session B 可按需打开 A 创建的同一进程；关闭页签、切会话和刷新只断开视图，**只有明确的「结束终端」操作结束进程**。终端自行退出后可重新连接读取保留输出，不自动 spawn 新 shell。插件卸载和宿主重启不保证进程存活。

- 管理页为自适应紧凑列表：标题/状态与辅助路径/来源分层，来源读宿主 `displayTitle`（未知时短 ID）。刷新保留现有列表，初次加载/空状态单独呈现；结束动作使用行内确认，可取消，窄面板自动换行，键盘焦点可见。视图隐藏或切 session 取消请求，不新增后台轮询。
- `meta.workspaceTerminalId` 是本地终端资源引用，不是授权凭据；各 session 的页签可引用同一个稳定 ID。来源 session 仅作为创建记录，不拥有生命周期。
- 新普通 `openTab({type:'terminal'})` 先检测 TerminalProvider；带管理工厂的 provider 使用其 workspace 生命周期；旧 provider 保留原生命周期，均不调用本地 create。无人认领才异步建立本地资源，**workspace 终端总落插件底部工作台**（即使 seed 请求 `target:'right'`，不占宿主终端指南条目）。调用方不能假设打开后 PTY 已同步就绪，创建失败会在来源 session 的工作台显示。带显式 tab ID 或自定义 meta 的旧入口保持兼容，不自动迁移。
- 管理 HTTP 路由均为 `POST /sidebar/api/<method>`：`workspace-terminal.create`（`{sessionId,title?}`）、`workspace-terminal.list`（`{sessionId}` → `{terminals}`）、`workspace-terminal.terminate`（`{sessionId,terminalId}` → `{ok:true}`）。终端描述为 `{terminalId,title,cwd,createdBySessionId,createdAt,exited,exitCode?}`。
- 连接：`/sidebar/ws/terminal?sessionId=<viewer>&terminalId=<id>`，仅附着已存在实例，不能借此创建。`terminal-exited` / `terminal-terminated`（1000）和拒绝连接（1008）都停止自动重连。视图区分自然退出与「被工作区终端管理结束」，提供显式「重新启动」：创建**新 terminalId** 并重新绑定当前页签，不复活旧进程，也不迁移其他视图；离线页签连接时发现 `terminal-not-found` 同样可新建。跨工作区拒绝不能当作重启许可。网络故障仍使用「重试连接」而不是新建进程。
- 所有管理与连接请求经过既有 trust fence，并在服务端从真实 session header 解析 workspace；不信任请求 cwd。优先使用公开 workspace registry 的身份，缺失时使用当前宿主的 canonical 本地 root。**这不是远程 workspace 身份协议**，不会按远程路径偷偷创建本地 shell。
- 终端进程、保留记录和输出均有界：每 workspace 最多 3 个活进程、12 条保留记录，全局最多 64 个活进程、256 条记录，每条最多 1 MiB 输出；退出实例也可显式结束以移除记录并释放配额。旧 session/tab 终端、Agent 终端及远程 Provider 仍保留旧契约，不自动迁移或改变 `close/park/dispose` 的含义。
- 本次不增加 Agent 跨会话读写权限或 CLI 操作工具。后续 Agent 接入需要同一 stable ID、单写者控制租约、多观察者、用户接管、增量输出游标和来源记录；不能将终端输出当作可信指令。

## Git data source 槽位（feature 'gitSource'）

git 数据面注入槽位（v0.23.0+，本构建 `0.23.0-mainslot.1`）：允许外部插件**整体接管**所匹配会话的 git 读与写——changes tab 的 Git lens（`src/client/changes/GitLens.tsx`）、changes 区的 diff 预览（`src/client/changes/DiffPane.tsx`）、独立 diff tab（`src/client/DiffTab.tsx`）以及两者的 hunk 折叠展开，把每一次 `api.git*` 调用都改经 provider 的 `GitDataSource` 路由；「changes 区列表、历史、diff 预览、独立 diff tab、装饰等所有 git 数据面」都只消费解析出的 `GitDataSource`。

- **注册方法**（`ctx.betterSidebar`，返回 disposer，Cordis `ctx.effect` HMR-safe；重复 id 抛错）：

  ```ts
  registerGitProvider(provider: {
    id: string
    match(sessionId: string, cwd: string | undefined): boolean
    createSource(sessionId: string, cwd: string | undefined): GitDataSource | undefined
  }): () => void
  getGitProviders(): readonly GitProviderDescriptor[]
  ```

- **features 门**：`features` 含 `'gitSource'`；消费插件注册前先 `features.includes('gitSource')` 探测。
- **解析语义**：注册顺序 first-match——`match(sessionId, cwd)` 逐字透传；`createSource` 返回 `undefined`（按会话拒接）或抛错 → 跳过并轮到下一个 provider（`resolveGitSource`，throwing-safe）；渲染侧 `useGitSource(ctx, scope)` hook 订阅注册表并随 `scope.sessionId / cwd / repoRoot` 变化重解析，无匹配 → `gitApi = api`（本地 host 路由逐字节不变）。独立 diff tab 的 seed 形态没有 ctx prop，经模块级 client-ctx 座位（`bindGitSourceSeat` / `useGitSourceSeat`，`src/client/index.tsx` apply 处绑定、卸载解绑——与 gitGraph 座位同一纪律）读取同一注册表后按自己的 scope 重新解析，语义与 `useGitSource` 完全一致。
- **契约形状**：`GitDataSource` 是 host `api.git*` 路由面的**影子**（签名与返回形状逐字一致，`src/client/git-source.ts`），完整方法面：`gitStatus / gitWorktrees / gitBranch / gitLog(+options roots/cursor → GitLogPage) / gitDiff / gitCommitDiff / gitShow / gitStage / gitUnstage / gitCommit / gitPush? / gitCheckout / gitDiscard / gitRevert / gitCherryPick`；变更类操作返回 `{ ok: true }`。`tests/git-source.spec.tsx` 以 `const _hostShadowsContract: GitDataSource = api` 在编译期守护形状（api.ts 漂移即 typecheck 失败）。
- **路由语义**：**无 provider（或无匹配）时所有 git 读与写逐字节落回宿主路由**；**有 provider 时按面整块接管**——Git lens 把 source 当作原子影子（`gitApi = gitSource ?? api`），缺方法只降级该面（如缺 `gitLog` → 历史区空、status/branch 照常，读调用先回 Promise 再执行，缺方法的同步 TypeError 不会炸掉整次刷新）；**diff 预览与独立 diff tab 则逐方法回退**（`(gitSource?.gitCommitDiff ?? api.gitCommitDiff)(...)` 等）——provider 面缺单个方法时仅该方法落回宿主，绝不因缺方法炸掉预览。
- **本地回退**：无 provider 匹配（或无注册）、`ctx` 缺失（独立/测试组合）、座位未绑定 → 全部 git 调用保持 host 路由，逐字节原行为。
- **消费方引导**：参考实现在 [dsh-remote-workbench](https://github.com/omdsh-dev/dsh-remote-workbench) 的 `buildGitSource`（`lib/client.js`：按 `(sessionId, cwd)` 记忆化构建 14 方法 source，`/git/read` + `/git/mutate` 远程 RPC；未覆盖操作显式 reject）。类型与解析器从 `dsh-better-sidebar/client/index` 可导入（`GitProviderDescriptor` / `GitDataSource` / `GitOkResult` / `resolveGitSource` / `useGitSource`）。
