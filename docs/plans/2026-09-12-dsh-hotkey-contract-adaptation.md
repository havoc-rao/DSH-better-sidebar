# dsh-hotkey 三方联动适配（新窗口 / 弹窗窗口快捷键可达）

日期：2026-09-12
状态：已实施（v0.20.x 基线，native sidebar 统一基线之上）

## 背景

DSH 0.1.5（任务书称「DSH 2.0.5」）起内核自带右侧边栏（ui-sidebar-right，tab
kind：guide/text/files）。本插件把全部 tab 类型注册成内核原生 tab 类型（见
`src/client/native/`），自身只保留底部工作台。三个工作区同步推进：

1. **deepseek-harness（内核）**：正在做「无会话 / 新窗口下右侧栏可展开」——弹窗
   窗口里挂载 ui-sidebar-right。
2. **dsh-hotkey（快捷键插件）**：`Cmd+Opt+B`（切换右侧栏）、`Cmd+Shift+E`（文件
   树/编辑器）、`Cmd+J`（底部面板）等，按「内核 `sidebarRight` 服务优先 → 内核
   DOM 标记 → 本插件 `betterSidebar` 服务 → 本插件 DOM」的优先级链回退。
3. **本插件**：保证自己的服务与 DOM 契约继续成立，并为「内核右侧栏不可用」的窗
   口（今天的弹窗窗口）提供不依赖内核改动的兜底。

dsh-hotkey 的消费面（`lib/client.js` 逐条核实，本次未改 dsh-hotkey）：

- `ctx.betterSidebar`（或 `ctx.get('betterSidebar')`）
  - `getSnapshot()` 顶层直读字段：`sessionId`、`bottomOpen`、`panelOpen`
  - `getTabs()`：`tab.id` 匹配 `editor`/`git`/`terminal`/`subagent`/`sidechat`
  - `openTab({ type }, { sessionId })`：seed.type + scope.sessionId
- DOM
  - 面板宿主 `[data-dsh-panel-host]`
  - 标签条 `[data-dsh-panel-host] [class*="tab"][title]`（title 关键词匹配点击）
  - 折叠/展开按钮集群 `[data-dsh-toggle-cluster]`（按钮 aria-label/title 关键词：
    底栏「折叠底部面板/展开底部面板/collapse bottom panel/expand bottom panel/
    底栏/底部面板」、侧栏「折叠侧边栏/展开侧边栏/collapse sidebar/expand
    sidebar/侧边栏」）
  - 左侧栏 `[data-side="sidebar"]`（内核 ui-sidebar 的 DOM，本插件不产出）

## 排查结论（弹窗窗口现状）

- 插件客户端（`src/client/index.tsx`）的挂载不依赖「窗口类型」：只要该窗口的
  client runtime 加载了本插件 bundle（与宿主同一套插件组装），服务、store 与
  `[data-dsh-panel-host]` 就存在；`store.setSession` 跟随 `sessions.list` 的
  current，弹窗窗口有会话即有 sessionId。**内核侧需要确保弹窗窗口的 client
  插件组装包含本插件与 dsh-hotkey（deepseek-harness 侧）。**
- **根因（本插件侧，本次修复）**：服务 `openTab` 在安装了 native surface 后，
  一切非 `target:'bottom'` 的打开都交给 `createNativeSurface`；而 surface 在
  `ctx.sidebarRight` 控制器缺失时把打开**无限期排队**（`pending` 队列只在会话
  列表变化时 flush，且 flush 仍要求控制器存在）——弹窗窗口（内核尚未挂
  ui-sidebar-right）里 `openTab('editor')` 静默丢失，dsh-hotkey 只看到
  「openTab 已调用」而实际无效果。
- **快照缺口**：`SidebarSnapshot` 只有 `sessionId`/`state`/`prefs`；`bottomOpen`
  嵌套在 `state.bottomOpen`，`panelOpen` 不存在。dsh-hotkey 的 `actBottomPanel`
  直接读顶层 `bottomOpen` 会得到 `undefined`，走「未知」分支。
- **DOM 缺口**：`[data-dsh-toggle-cluster]` 不存在；底栏开关（header
  `data-dsh-bottom-toggle`）与面板内 `bottomClose` 均无集群容器；没有
  「折叠/展开侧边栏」语义的按钮。

## 设计

### 1. 服务快照补齐（service.ts）

`getSnapshot()` 返回类型扩展为 `SidebarServiceSnapshot extends SidebarSnapshot`，
顶层新增：

- `bottomOpen: boolean` —— `state?.bottomOpen === true`（底部工作台）。
- `panelOpen: boolean | undefined` —— 右侧栏（内核原生栏）展开状态；由构造时注
  入的探测函数给出：优先 `ctx.sidebarRight.isExpanded?.()`，缺失时回落 DOM 标记
  `[data-sidebar-right-open]`（插件与内核同文档，可直接读）。无内核栏的窗口 →
  `false`（= 收起，与 dsh-hotkey `rightPanelIsCollapsed` 的兜底语义一致）。

实现：`createBetterSidebarService(store, panelProbe?)`，第二参可选（缺省
`undefined`，测试与旧调用不变）。`getSnapshot()` 每次调用装饰新对象——本仓库内
无消费者依赖快照引用稳定性（唯一调用点在 `index.tsx` 一次性读取），dsh-hotkey
在按键时读取，无需响应式。

`SIDEBAR_FEATURES` 增补 `'panelFlags'`（能力探测，向后兼容；旧消费者不 gate 也
不受影响）。

### 2. openTab 无控制器兜底（service.ts + native/surface.ts）

`SidebarSurface` 新增可选方法 `canPlace?(sessionId): boolean`（缺省 = true，既有
测试桩无需改动）。`createNativeSurface` 实现为 `controller() !== undefined`（内
核 `ctx.sidebarRight` 服务是否存在）。

`service.openTab` 路由规则变为：

- `target: 'bottom'` → 底部工作台（原样）；
- 否则若 surface 存在且 `canPlace` 为 true → 原生栏路径（原样，含跨会话排队）；
- 否则（surface 缺失 **或** 无内核控制器）→ **回落底部工作台**（pre-0.1.5 的落
  点）：创建/聚焦标签并展开工作台。

理由：控制器缺失时排队是死队列（永远不会 flush 成功）；弹窗窗口（内核尚未支
持）下 `Cmd+Shift+E` / `Cmd+Opt+B` 因此能落在可见的底部工作台文件树。内核侧支
持落地后（弹窗窗口也有 `sidebarRight`），同一 openTab 自动回到原生栏路径，无第
二处开关。

边界：主窗口启动早期若短暂无 `sidebarRight`（插件先于内核栏激活），极端时序下
一次打开会落底部工作台——用户可在可感知的时间窗口之后操作，实际影响可忽略；
且随后所有打开都走原生路径。

### 3. DOM 契约补齐（Sidebar.tsx + sidebar.module.css）

- **集群 `[data-dsh-toggle-cluster]`**：
  - header 底栏开关（`BottomDockToggle`，`data-dsh-bottom-toggle`）外包一层
    `[data-dsh-toggle-cluster]`（`display: contents`，不改变布局）；aria-label
    已是「折叠底部面板/展开底部面板」→ 命中 dsh-hotkey bottom 关键词。
  - 底部工作台 tab 条右端：`bottomClose` 与**新增侧栏开关按钮**同包一层
    `[data-dsh-toggle-cluster]`。
- **新增侧栏开关**（`data-dsh-sidebar-toggle`）：位于 `bottomClose` 左侧
  （`right: 40px`），aria-label/title 动态为「展开侧边栏/折叠侧边栏」。
  - 动作：若 `ctx.sidebarRight.toggleExpanded` 存在 → 调用之（主窗口与内核弹窗
    里直接可用）；否则兜底——工作台开且含无路径 editor（文件窗口）→ 收起工作
    台；否则 `service.openTab({ type: 'editor' }, scope)` 展开文件树。
  - 标签状态：`useNativeSidebarOpen(ctx)` 钩子（`sidebar/use-native-column.ts`）：
    `isExpanded?.()` 优先、DOM `[data-sidebar-right-open]` 回落、MutationObserver
    跟随 DOM 变化（内核栏展开状态由内核 DOM 属性表达，插件不持有该状态）。
- 底栏标签条（`[data-dsh-panel-host] [class*="tab"][title]`）契约原样保持：
  TabBar 每个 tab 的 `title={tab.title}` 已满足。

### 4. 左侧栏 `[data-side="sidebar"]`

内核 ui-sidebar 的 DOM（dsh-hotkey 的 `actToggleSidebar`/`actNewSession` 等只在
layout 服务缺失时回退它）。本插件不产出、也不需要——在报告中明确归内核侧。

### 5. 兼容性

- 不改 dsh-hotkey、deepseek-harness。
- 不改服务方法的既有签名与语义；`getTabs()` 五类型 id 原样（builtins 注册）。
- `SidebarSurface` 新方法可选 → 测试桩与外部 mock 不受影响。
- 新增 i18n key（`expandSidebar`/`collapseSidebar`）按仓库规则同步全部 20 本词
  典（`tests/locales.spec.ts` 守护 key-set 相等）。
- 内置快捷键（⌘P / ⌘F / ⌘Tab / ⌘1-9 / ⌘W）在 v0.19 官方同步时已随
  keybindings 系统退役（v0.19.1 合并说明），不在本次范围。

## 实施偏差

（实施时记录，若有。）

## 测试

- 新增 `tests/hotkey-contract.spec.ts`：快照字段（含探测）、openTab 无控制器落
  底部工作台、有控制器走原生、跨会话排队语义保持。
- `tests/locales.spec.ts`（key-set）、`tests/service.spec.ts`、`tests/native-surface.spec.ts`
  回归。
- `scripts/e2e-mount.sh` 真机冒烟：断言 `[data-dsh-toggle-cluster]` 与侧栏开关
  存在（环境允许时）。