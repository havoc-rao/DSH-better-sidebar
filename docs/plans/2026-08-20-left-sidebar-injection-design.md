# 注入官方左侧栏（Sider）通用 Tab 的设计

> 目标：以**本插件（dsh-better-sidebar）**的形式，向 DSH **官方左侧栏**（`ui-sidebar` 的 Sider）注入一个通用 Tab，便于进入「记录所有全局信息（含全局共享终端）」的页面。
> 关联：AGENTS.md §2（插件骨架）、`docs/plans/2026-08-19-sidebar-injection-unified-host-design.md` §6（路线 B：官方槽位迁移）、DSH 源码（只读）。

## 0. 一句话结论（研究结果）

**官方左侧栏本身就是 slot 化的插件（`ui-sidebar`），并通过 `ctx.slots.register` 暴露了可「加法式」占用的内部座席 `sidebar.footer.action`（list 槽）**。本插件作为独立包，调用 `ctx.slots.register({ name: 'sidebar.footer.action', ... }, 组件)` 即可把「全局信息」入口按钮挂进官方左侧栏的**底部**（Settings 之上），不改 DSH 源码、不替换官方导航列、HMR-safe。这就是「以本插件形式注入 DSH 本体」的最优路径。

## 1. 已核实的官方架构（`deepseek-harness/packages`，只读，2026-08-20 验证）

### 1.1 左侧栏是 slot 化的插件

| 部件 | 证据 |
|---|---|
| 外壳 `#root` 单挂载点；`ui-layout` 的 `AppFrame` 注册进 `'root'` 并声明子槽 | `ui-layout/src/client/index.ts:116-143` |
| `sidebar` 槽 = `single` / `scope:'root'`，occupied by `ui-sidebar` 的 `SidebarRoot`；**注册进 `sidebar` 会整体替换左列而非追加** | `ui-layout/src/client/index.ts:40-49,123` |
| `ui-sidebar` 声明 5 个**内部座席** | `ui-sidebar/src/client/index.ts:41-55` |

### 1.2 `ui-sidebar` 的内部座席（`contract/slots.ts` + `SidebarRoot.tsx`）

| 座席 | kind | 语义 | 渲染位置 |
|---|---|---|---|
| `sidebar.brand.mark` | single | 品牌图标（右上/折叠 rail） | `SidebarRoot.tsx:140,168` |
| `sidebar.brand.name` | single | 品牌名 | `:142` |
| `sidebar.workspaces` | single | 会话/工作区浏览区（ui-workspace 占用） | `:193` |
| `sidebar.settings` | single | 脚下设置触发器+面板（ui-settings 占用） | `:205` |
| **`sidebar.footer.action`** | **list** | **脚下的动作列表，Settings 之上；每项只收 `{ wide }`（列是否展开）** | `:200-203` |

- **`sidebar.footer.action` 是 `list` 槽 = 加法式 / 可并存**：多个插件各注入一项，`renderSlot('sidebar.footer.action', { wide })` 逐项渲染，`renderSlot('..', { wide })` 把列状态传给每一项。
- `sidebar.workspaces` / `sidebar.settings` 是 single，**已被占用**，外部插件不可重复注册（重复声明抛错，见 `ui-slots` 注册期校验）。

### 1.3 注入 API（`runtime/src/client/slots.ts`）

- `ctx.slots.register(options, component)`：注册一个座席条目；`options` 含 `name`（座席键）、`id/key/order/label/priority`、`inject`、`children`（本插件想在脚注动作下再挂子座席时用）、`locale`、`registrant`。
- **disposer 由 `register` 返回**，且实现绕进**调用者 `ctx.effect`**（`slots.ts:465-470`）——插件 fiber 卸载（HMR / 禁用）自动撤注册，HMR-safe（与 AGENTS.md §6 的扩展点契约一致）。
- `list` 槽渲染条目直接是组件；每个组件收到运行时 props（含该槽 `owner` share `{ wide }`）+ 若有 `inject` 则并上 inject 产物。
- 官方把 injected 声明注入也做了 `ctx.slots.inject(key, cb)`（`slots.ts:143-205`）：当目标槽**尚未声明**时静默等待/跳过——本插件可不依赖 ui-sidebar 的加载时序。

### 1.4 本插件的既有能力（可直接复用）

- **`@deepseek-ai/dsh-client-ui-slots` 是 `CLIENT_EXTERNAL`**（`tsdown.config.ts:65`，官方 shell 冻结模块表成员）→ 可 **value-import**，运行时解析到官方实例，不会双实例化。
- `ctx.slots` 已在 `src/context-types.ts` 类型化（`SidebarSlotsService.register/inject`，`:122-131`），`inject = ['betterSidebar', 'slots']` 即可。
- 槽的 `owner` 类型（如 `SidebarFooterActionOwnerProps`）**type-only import** 自 `@deepseek-ai/dsh-client-ui-layout` / `dsh-client-ui-sidebar`（类型擦除，永远过纯度门）。

## 2. 非目标

- 不修改 DSH 官方源码（仓库硬约束），不注册进 `'sidebar'`（那是整体替换左列，属另一档，见 §5 路线 B）。
- 不注册进 `sidebar.workspaces` / `sidebar.settings`（single 已占用）。
- 不重做全局终端本身（上一轮已完成）；此处只把「全局信息页面」的**入口**挂进官方左栏。

## 3. 推荐方案（路线 A：加法式脚注动作）

### 3.1 一条脚注动作

在本插件 client half（`src/client/index.tsx`）里，经 `ctx.slots.register` 注入一个**脚注按钮**：

```ts
// inject = ['betterSidebar', 'slots', ...]
ctx.effect(() => ctx.slots.register({
  name: 'sidebar.footer.action',
  id: 'dsh-sidebar:global-info',
  order: 10,
  locale: 'betterSidebar',
}, GlobalInfoFooterButton), 'better-sidebar: official sidebar footer action')
```

`GlobalInfoFooterButton` 组件：
- 收 `{ wide }` 与运行时 props（英/宽 rail 两种形态：wide 渲染「图标+标签」，rail 只渲染图标，与官方脚注一致）。
- 点击 → 打开「全局信息」页面（宿主任选，见 §4）。
- 用官方 `@deepseek-ai/dsh-client-ui-primitives` 的图标/Tooltip，与左栏观感一致；主题令牌走 `--dsw-alias-*`（皮肤兼容 §8 规则）。

### 3.2 生命周期 / 时序

- 用 `ctx.effect(() => ctx.slots.register(...))` 包住，fiber 卸载自动撤（HMR-safe）。
- 若担心「ui-sidebar 未加载」，用 `ctx.slots.inject('sidebar.footer.action', ...)`（`ctx.slots` 已有该 face）等待声明后再注册；实际 `ui-sidebar` 是其 `apply` 一开始就 register，顺序无碍（`inject` 兜底）。

### 3.3 挂载（profile 层，无需改 DSH）

沿用现有挂载机制：`~/.dsh/profiles/web/cordis.patch.yml` + `package.json` dependency（本插件已 link 挂载）；新增这段注册直接生效，无额外 profile 改动。

## 4. 待定：全局信息页面「宿主任选」

「记录所有全局信息（含全局终端）」的页面需要一个宿主。候选（需你拍板）：

| 方案 | 说明 | 取舍 |
|---|---|---|
| **A1（推荐）better-sidebar 自己的面板 tab** | 新增一个内置/插件 tab（如 `global`，securable），脚注按钮点击 → `betterSidebar.openTab({ type:'global', ... })`；页面在 better-sidebar 右侧/底部面板内渲染，复用现有 store 与会话绑定 | 复用成熟宿主，天然含右侧面板表现与全局共享终端联动；但「官方左侧栏入口 → better-sidebar 面板」跨两个挂载点，需一次消息/服务桥 |
| A2 独立全屏浮层（`shell.overlay`） | 按钮 → 打开一个 `shell.overlay`（list，加法式、click-through）浮层页面，展示全局信息 | 与左侧栏独立，观感像「帮助/仪表盘」；但需自带几何/关闭/主题，工作量大 |
| A3 官方 `details` 右列 | 注册进 `details` 槽 | **当前不可行**：details 唯一占用者是 ui-conversation 的 DetailsPanel，禁用即空置会话列（见 2026-08-19 设计 §6.1） |

> 由于「全局终端」是 better-sidebar 的 tab，**A1 与既有全局共享终端在同一宿主**，能在一页里并列展示「全局终端 + 其它全局信息」，语义最贴合你的需求。

## 5. 路线 B（不推荐，仅记录）：整体接管 `sidebar` 槽

- 注册 `name:'sidebar'` 会**替换整列**（`ui-layout` 注释明示），需 profile 层禁用 `ui-sidebar`；接管者需自实现折叠按钮、宽度持久化、`sidebar.workspaces/settings` 或留空。
- 仅当「需要彻底重排左列」才考虑；对「加一个 Tab 进全局信息页」而言过重，且与官方 `ui-workspace`/`ui-settings` 冲突（它们寄存器在 `sidebar` 座位下，被替换即消失）。

## 6. 实施拆分（待批准后）

1. **PR-左栏-1（注入脚注动作）**：`src/client/index.tsx` 加 `ctx.slots.register({name:'sidebar.footer.action',...})`；新增 `GlobalInfoFooterButton` 组件（wide/rail 两态 + 主题令牌）；`context-types.ts` 确需时补 `SlotMap` 相关 type import；`locales.ts` 加 `officialSidebar.globalInfo` 等文案。
2. **PR-左栏-2（全局信息页宿主，选 §4 A1）**：新增 `global` tab（或独立渲染区），聚合显示：全局共享终端列表（`gb:` 窗口 + 各自连接态）、以及可选其它「全局信息」（实例级共享窗口清单、工作区/会话概要等）；脚注按钮与 tab 打通。
3. 测试：注入注册单测（fake ctx.slots 捕获 register 调用与 disposer）；e2e 挂载冒烟里加断言「官方 footer.action 注入存在」（当前 e2e 只覆盖 better-sidebar 面板，补一条 DOM 断言）。

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 官方槽键改名/删列（`sidebar.footer.action`） | `ctx.slots.inject` 静默跳过未声明槽；DSH 升级时失效即不渲染，不炸树 |
| 双挂载点桥（官方左栏 ↔ better-sidebar 面板） | 服务/事件收口到本插件内部；`features` gate + 版本探测 |
| 皮肤观感 | 完全走 `--dsw-alias-*` 令牌 + 官方 primitives，跟随皮肤 |
| 注入被判定为「插件错误条」 | 组件用 RenderBoundary 兜底，崩溃不外泄（沿用现网模式） |

## 8. 参考来源

- DSH（只读）：`packages/client/ui-layout/src/client/index.ts`、`packages/client/ui-sidebar/src/client/{index.ts,SidebarRoot.tsx,contract/slots.ts}`、`packages/client/runtime/src/client/slots.ts`、`packages/client/ui-slots/src/index.ts`
- 本仓库：`docs/plans/2026-08-19-sidebar-injection-unified-host-design.md` §6、`src/context-types.ts`、`tsdown.config.ts:59-70`、AGENTS.md §2/§6/§8

## 9. 决策记录与实施偏差记录

- 2026-08-20（设计定稿）：研究并核实官方左侧栏注入 seam——`ui-sidebar` 是 slot 化插件，注册进 `'sidebar'` 会整体替换左列，而其内部座席 **`sidebar.footer.action`（list 槽）是加法式入口**（每项只收 `{ wide }`）。
- 2026-08-20（用户批准）：**路线 A**（加法式脚注动作）+ **宿主 A1**（better-sidebar 面板内 tab）。
- 2026-08-20（实施）：落地 `src/client/official-sidebar.tsx`（`ctx.slots.inject('sidebar.footer.action', …)` 注册「全局信息」脚注按钮）+ 新增内置 `global` tab（`GlobalView`，读宿主注入的 `TabComponentProps.globalWindows` 列出 `gb:` 全局共享窗口并可一键激活）。`TabComponentProps` 增加可选 `globalWindows` 字段（宿主侧 extra，外部 tab 忽略）。测试：`tests/official-sidebar.spec.tsx`（注入/按钮/列表）、`tests/builtins.spec.ts`（`global` 描述符）。
- 2026-08-20（用户细化：展开成完整 page）：全局信息从「面板 tab」升级为**完整页面**——新增 `GlobalPage`（fixed 覆盖、z-index 1000、头部标题 + ✕ + Esc + 背板点击关闭，复用 `GlobalInfoList` 主体）与模块级页面控制器 `global-page.ts`（uSES，官方脚注按钮在插件 React 树外也能触发）；官方左栏脚注按钮与 tab 内「展开为完整页面」入口都打开完整页面，`global` tab 保留为面板内紧凑视图。实施偏差：早期加的 `OpenTabSeed.expand` 标志（让类型型打开展开面板）因完整页面接管入口而**回退移除**（无调用方，避免死 API）。
- 2026-08-20（用户二轮细化）：①**非全屏**——页面只覆盖**官方左 Sider 右侧的主区域**：`GlobalPage` 的 `left` 实测 `[data-pane="sidebar"]` 右缘（设计文档 §3.4 验证的稳定锚点），resize/ResizeObserver 实时跟随折叠/拖拽，左 Sider 保持可见可点；列缺失时回退全视口。②**与「icon 设置」UI 同步**——`GlobalInfoList` 改用 **SideCard 设置同款「icon 卡片」栅格**（响应式 auto-fill 卡片：28px 图标 chip + 标题 + 共享徽标 + 点亮态 + 勾选徽标，令牌全部 `--dsw-alias-*`/`--dsw-font-*`），与 DSH 设置页清单一致。
- 2026-08-20（用户三轮细化：chat box 区域原地铺开，非全屏/非浮层）：**弃用 fixed 浮层**，改为**动态接管官方 `conversation` 槽**——插件壳 `Sidebar` 在页面打开时 `ctx.slots.register({ name:'conversation', priority:-1, id:'dsh-better-sidebar:global-info' }, …)`；ui-slots shadowing 规则「single 槽同 cell 最低 priority 渲染」（已核实 `ui-slots/src/index.ts`：同 priority 重复注册抛错、不同 priority 低者 shadow），`ui-conversation` 注册默认 priority 0，故 -1 顶掉它——**chat box 的主区域本身变成全局信息页**（官方布局给它中栏的 box，无需任何测量/z-index）；关闭 dispose 注册 → 官方聊天恢复（会话状态在 store 不受影响）。`GlobalPage` 经 `useSyncExternalStore` 订阅 windows store 实时刷新（uSES getSnapshot 需稳定引用——空列表用模块级常量）。失败兜底：register 抛错则关闭页面（聊天不动）。实施偏差：`[data-pane="sidebar"]` 左缘测量 + ResizeObserver 逻辑全部移除（槽接管天然由布局提供 box）；`globalWindows` prop 透传改为 windows store 订阅。
- 2026-08-20（UI 打磨：参考框架风格优化）：页面按 DSH 框架 recipe 重排——**页面头** = 大标题 `--dsw-font-l-20` + 一行描述（section heading+intro recipe）+ 右侧 ✕ 圆钮；**正文** = **PluginCard 组容器**（l2 hairline、r16、layer-3 填充、18/20 padding）+ **catalogHeading 组标题**（13/600 + tabular-nums 计数徽标）+ 设置同款 icon 卡片栅格；**空态** = 居中图标 chip + 标题 + 引导提示。面板 tab 复用同一栅格（窄版滚动）。
- 2026-08-20（更名）：用户确认统一更名为 **「全局工作区」**（Global Workspace）——页面标题 / 左栏脚注按钮 / tab 标题（locale `globalInfo` / `globalInfoFooter`）、页面描述（`globalInfoDesc`）全部更新；分区标题「全局共享窗口」（`globalInfoSection`）与共享动作「全局共享（所有项目）」保持不变。
- 2026-08-23（会话切换关闭语义，两轮）：用户确认全页视图是**会话绑定**的——它占用的是**当前会话**的 `conversation` 槽，因此在打开/切换到其他会话时必须关闭它（模态语义：官方左栏切会话即回到聊天）。第一轮实施为 `Sidebar.tsx` 的会话守卫 effect（记录打开时的 active session，变化即关），但用户实测「点击**同一**会话（未真正切换）页面也被关」——sessions feed 在重选/掩码间隙会把 `current` 瞬时置空再弹回，按值变化关闭会误判。第二轮按用户指示改为**无会话打开**：新增 `openGlobalPage(ctx)`（`src/client/global-page.ts`）= 先 `ctx.sessions.clear()`（清掉当前 session 激活态，应用落到 hero）再置 open，官方左栏脚注按钮与 tab「展开为完整页面」都走它（`GlobalInfoFooterButton` 增传 ctx，`SidebarSessionsService` 增 `clear?()` 镜像）。页面于是恒在 hero/undefined 之上打开，**从页面视角点任何会话都是「打开一个会话」**，守卫 effect 规则相应收窄为「仅当已定义的会话变为与打开时（hero/undefined）不同的会话才关闭」——同会话误判自然消失，瞬时 `undefined` 与回落 hero 不关。显式关闭同时兜底「卡死打开」状态：会话切换会重挂 conversation 槽占用组件，若重挂崩溃导致条目 abdicate（单槽降级到 ui-conversation）而模块级 open 标志仍为 true，脚注按钮将无法再打开页面直到刷新——守卫保证切换必然复位标志。测试：`tests/global-page-session.spec.tsx`（openGlobalPage 清激活+打开、sessions face 缺失/抛错仍能打开；守卫：hero 下首个会话到达关、无会话保持开、不同会话切换关、同会话经无会话瞬态弹回不关、回落 hero 不关、未打开不误关）+ `tests/official-sidebar.spec.tsx`（按钮/展开点击断言 clear 被调用）。实施偏差：无。
- 2026-08-23（UI：移除头部 ✕）：用户要求移除 `GlobalPage` 头部关闭按钮（含其 `IconCloseFill14` 图标）——关闭路径收敛为 Esc 与「点击任意会话」（页面从无会话 hero 打开，点会话即关闭），头部仅剩标题 + 描述。`.globalPageClose` CSS 一并删除；测试由「关闭按钮关闭页面」改为「断言无关闭按钮」。
- 遗留：全局工作区页目前只聚合「全局共享窗口」；其它实例级信息（工作区/会话概要等）为后续可扩展项。
