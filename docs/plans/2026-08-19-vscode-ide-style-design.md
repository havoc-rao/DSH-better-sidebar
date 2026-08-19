# VSCode IDE 风格改造设计（Activity Bar + 独立 Side Bar）

> 状态：**已实施**（v0.15.0 目标）
> 范围：路径 A（Activity Bar 活动栏）+ 路径 B（独立 Side Bar 布局模式，镜像编辑器左）
> 不在本轮：路径 C（编辑器换 Monaco）——正交于布局范式，单独评估（见 §1.5 结论）
>
> **实施记录（2026-08-19）**：用户确认镜像方向后已全部落地——`sidebarLayout: 'docked' | 'vscode'` pref、`ActivityBar.tsx`（图标化 `+` 菜单）、`SideBarPane.tsx`（独立文件树列 + 左缘拖拽）、`EditorHost` vscode 分支（去内嵌树）、`Sidebar.tsx` 布局分支（**tab strip header →** Workbench | SideBarPane | ActivityBar）、编辑器卡 gear 的 select、中英文案、令牌驱动 CSS。**后续视觉微调**：vscode 布局下面板顶部加 header，右上角折叠按钮簇（viewport-fixed）悬浮其上——最初加 40px 标题行（显示工作目录名）替代 `padding-top` hack，用户反馈标题多余 → **header 简化为一条 tab strip**（活动 pane 的 tabs 上移进 header，VSCode editor tab strip 与 title bar 相邻结构；`split-pane.tsx` 的 `Workbench` 加 `hideTabBar` prop，右面板 vscode 模式 pane 内不再渲染 tab 条，`Sidebar.tsx` 的 `HeaderTabStrip` 在 header 渲染右面板活动 pane 的 tabs——用 `treeOf` 限定右面板，点击其他 pane 其 tabs 进入 header；底面板保持自己的 tab strip）。**资源管理器抽屉化**：用户要求"资源管理器 tab 与文件 tab 分离，抽屉经 icon 展开/收起"——state 加 `sideBarOpen`（默认展开、sanitize 兼容旧持久化），ActivityBar 的 editor 图标升级为**资源管理器抽屉开关**（label `Explorer`、高亮跟随 `sideBarOpen`、点击 toggle 而非 openTab），`SideBarPane` 常驻挂载并在 `collapsed` 时宽度 0。**抽屉动画**：width 过渡（`--ds-transition-duration-slow`，0.3s 缓动）——抽屉始终挂载（树不重载）、收起无残留边框、拖拽中禁用过渡（`sideBarPaneDragging`）保证 1:1 跟手。测试：`tests/activity-bar.spec.tsx` / `state.spec.ts` 新字段 / `editor-host.spec.tsx` vscode 分支 / `builtins.spec.ts` select 元数据 / `tests/e2e/mount.e2e.ts` 新增 vscode 模式深扫（真实挂载全绿）。实施偏差（相对原型）：Side Bar 恒为 explorer（git/subagent 仍是 tab，经 Activity Bar 打开），视图切换留作后续增量。

---

## 0. 背景与目标

用户希望 better-sidebar 的文件夹 / 文件内容 / agent 框架呈现 VSCode IDE 风格。现状已有一半 VSCode 血统（`FileTree.tsx` 自述 "lazy VSCode-style tree"；editor tab = 文件窗口；终端 xterm.js；快捷键 `Cmd+P/B/J` 心智已是 VSCode），但缺两件最具标识度的视觉骨架：**Activity Bar**（最左竖条图标列）与**独立 Side Bar**（活动栏选中项的竖向视图容器，与 editor 区解耦）。

目标：在 better-sidebar 的 portal 内（受 AGENTS.md §7 portal 限制，不能全屏替换宿主）呈现完整 VSCode 工作台范式——Activity Bar + Side Bar + Editor Group + Panel，且向后兼容（现有 `editorExplorer` 合并/独立行为默认不变）。

---

## 1. 可行性调研备忘

### 1.1 vscode.dev / github.dev 架构

vscode.dev 是 VS Code 的纯 web 版，跑在浏览器、用 Virtual Workspaces（无本地文件系统，经 Remote Authority 访问远程/GitHub）。它背后是完整的 microsoft/vscode workbench（Monaco + workbench services + extension host web worker），体量巨大、强依赖 VS Code 自有 service infrastructure。

**结论**：不能整体参考嵌入（会撞上 AGENTS.md §7 portal 限制与构建纯度门，且体积/复杂度不可行）。**只参考布局范式与设计 token**：Activity Bar 48px、Side Bar 默认 170px、tab 高 35px、Panel/Status Bar 尺寸约定。

来源：
- [Virtual Workspaces and vscode.dev — vscode-docs](https://deepwiki.com/microsoft/vscode-docs/2.5-virtual-workspaces-and-vscode.dev)
- [Source Code Organization — microsoft/vscode](https://github.com/microsoft/vscode/wiki/Source-Code-Organization)
- [Web Extensions — code.visualstudio.com](https://code.visualstudio.com/api/extension-guides/web-extensions)

### 1.2 Monaco Editor web 嵌入

Monaco 是 VSCode 编辑器内核，`monaco-editor` npm 包可 web 嵌入。关键坑：**web worker 跨域加载**——ESM/webpack-plugin 在 cross-origin 下加载 worker 会失败（microsoft/monaco-editor issue #4741），需 `MonacoEnvironment.getWorkerUrl` 返回 blob proxy 或确保 same-origin。`vite-plugin-monaco-editor` 有 Cross-Origin Worker Loading 处理。

DSH 部署在 `127.0.0.1:3080` same-origin，且插件 chunk 经 `/sidebar/bundle` 同源路由下发——**默认无跨域坑**。但 Monaco 体积大：`editor.main` ~2.4MB minified（~860KB gzip），加 TS/JSON/CSS/HTML 语言 worker 更大；必须独立 chunk 懒加载（已有 chunk 机制可复用）。

来源：
- [Cross-Origin Worker Loading — vite-plugin-monaco-editor](https://deepwiki.com/vdesjs/vite-plugin-monaco-editor/8.1-cross-origin-worker-loading)
- [monaco-editor-webpack-plugin cross-origin issue #4741](https://github.com/microsoft/monaco-editor/issues/4741)
- [Integrating AMD Monaco in cross-domain setup](https://github.com/jonas/monaco-editor/blob/patch-1/docs/integrate-amd-cross.md)

### 1.3 CodeMirror 6 vs Monaco

| 维度 | CodeMirror 6（当前） | Monaco |
|---|---|---|
| 核心体积 | ~130KB minified（~40KB gzip） | ~2.4MB minified（~860KB gzip） |
| Worker 依赖 | 无（纯主线程） | 强依赖（editor/ts/json/css/html worker） |
| 模块化 | 按语言包粒度加载 | 整体 + 各语言 worker |
| VSCode 观感 | 近似但无 minimap/命令面板 | 原汁原味（minimap/多光标/IntelliSense/命令面板） |
| 嵌入成本 | 已落地、已测 | 需 worker 配置 + chunk + theme 映射 |

体积差距 ~15–20×。本插件是**侧边栏编辑器**（非全屏 IDE），CodeMirror 已够用且轻。**结论：本轮不换 Monaco**；Monaco 作为可选增强（单独 chunk + pref 开关）留待路径 C 单独评估，与 A+B 正交。

来源：
- [Monaco Editor vs CodeMirror 6 vs Sandpack 2026 — pkgpulse](https://www.pkgpulse.com/guides/monaco-editor-vs-codemirror-6-vs-sandpack-in-browser-2026)
- [Build a Code Editor: CodeMirror, Monaco, and the Tradeoffs](https://www.techinterview.org/post/3233475355/build-code-editor-codemirror-monaco-tradeoffs/)

### 1.4 vscode-codicons 许可

`vscode-codicons` 是 VSCode 图标字体，许可 **CC-BY 4.0 + MIT**（字体 MIT，图标 CC-BY 4.0），可商用但 CC-BY 需署名。

**结论：不引入 codicon**。本项目已用 `@deepseek-ai/dsh-client-ui-primitives` 的 outline 图标，用其对位 VSCode 活动栏语义即可（Explorer/Git/Subagent/Terminal/Browser 都有合配 outline 图标），避免额外字体 + 署名负担。

来源：
- [vscode-codicons 0.0.14 — MIT and CC-BY 4.0](https://www.cisco.com/c/dam/en_us/about/doing_business/open_source/docs/AppDynamicsEUMOn-Prem-2420-Windows-1743629451.pdf)
- [microsoft/vscode-codicons](https://github.com/microsoft/vscode-codicons)

### 1.5 调研结论汇总

1. **vscode.dev 只参考布局范式**，不参考代码（体量 + portal 限制双重不可行）。
2. **Monaco 不替换 CodeMirror**（体积差 15–20×，侧边栏编辑器场景 CodeMirror 已够用）；留作路径 C 可选增强，本轮不做。
3. **codicon 不引入**，用现有 `dsh-client-ui-primitives` outline 图标对位。
4. **A+B 可独立于 C 推进**，布局范式与编辑器内核正交。
5. **同源部署无 worker 跨域坑**（DSH `127.0.0.1` + chunk 走 `/sidebar/bundle`）。

---

## 2. 设计总览（A+B）

### 2.1 目标布局范式

VSCode 工作台五件套在本插件 portal 内的映射：

| VSCode 区域 | 本插件实现 | 现状 |
|---|---|---|
| Activity Bar（最左竖条 48px） | **新增**（路径 A） | ❌ 无 |
| Side Bar（竖向视图 170px） | **新增**（路径 B，vscode 模式） | ⚠️ 文件树 dock 在 editor tab 内 |
| Editor Group（带 tab 编辑区） | 现有 editor tab + split pane | ✅ 有 |
| Panel（底部：Terminal 等） | 现有底面板 workbench | ✅ 有 |
| Status Bar | DSH 宿主底部栏（不抢） | — |

### 2.2 与现有 editorExplorer 的关系

`editorExplorer`（合并/独立）是**文件打开行为** pref；新增 `sidebarLayout` 是**布局范式** pref。两者正交但协同：

- `sidebarLayout: 'docked'`（缺省，向后兼容）：现状完全不变，`editorExplorer` 照常控制 editor tab 内嵌树。
- `sidebarLayout: 'vscode'`（**镜像，用户选定方向**）：editor tab 不再内嵌树 dock；文件树移到独立 Side Bar 竖向列（编辑器左 | 侧栏中 | 活动栏右），Activity Bar 图标化 `+` 菜单。**编辑器在面板最左（贴近聊天区）、活动栏在面板最右边缘**——因为 better-sidebar 整个面板在 DSH 窗口右侧，镜像朝向让编辑器贴近聊天区（保留现状肌肉记忆），活动栏在远端，是「VSCode 范式 × 右面板」的自然适配。`editorExplorer` 在 vscode 模式下被忽略（editor 区恒为"编辑器 only"，文件打开走 Side Bar 的 TreePanel → per-path editor tab）。

> **朝向取舍（实施记录）**：原型曾提供 `vscode-left`（VSCode 原版：树在编辑器左，编辑器被推到面板右半、离聊天区更远）与 `vscode-right`（镜像）。用户选择镜像并合并为单一 `'vscode'` 值（legacy 持久化的 `'vscode-left'`/`'vscode-right'` 在 `parsePrefs` 中迁移为 `'vscode'`）。原型 `docs/prototypes/vscode-style-mockup.html` 保留三种布局对比。

---

## 3. 路径 A：Activity Bar 活动栏

### 3.1 视觉与尺寸

- 位置：面板内一条 48px 竖条（VSCode 约定），与面板等高。**朝向随 `sidebarLayout`**：`vscode-left` → 面板最左；`vscode-right`（镜像）→ 面板最右边缘。分隔边、激活指示条、拖拽手柄的左右朝向由 `data-arrange="left|right"` CSS 翻转。
- 表面：`var(--dsw-alias-bg-layer-1)`（与面板同层或略低，皮肤令牌驱动，**不碰 `--dsw-alias-sidebar-fill`**，见 §6）。
- 图标尺寸：24px outline，居中，行高 48px。
- 激活指示：当前 pane 已有该类型 tab 时，图标高亮 + 内缘 2px 指示条（VSCode 同款；镜像时指示条在右缘）。
- 底部：设置齿轮（打开 Side card 设置页，复用现有 `SideCardSection` 入口）。

### 3.2 数据与交互

- 图标列 = registry 中所有非 hidden 且 `isTabEnabled` 的 tab 描述符，按 `order` 升序（与 `+` 菜单同序）。
- 单击 = 等价于 `+` 菜单点该项：走 `openTab({ type: d.id })`（复用 `buildNewTabOptions` 派生逻辑，不重复实现）。
- 悬停 tooltip = `d.title()`（i18n 友好，复用现有 Tooltip 组件）。
- 激活高亮 = 派生自当前 state（`activePaneTabsOf` 是否含该 type 的 tab）。
- **无新持久化**：纯派生自 registry + state。

### 3.3 组件结构

新增 `src/client/ActivityBar.tsx`：

```tsx
export function ActivityBar(props: {
  ctx: Context
  store: SidebarStore
  scope: SessionScope
  state: SidebarState
  onOpenTab: (type: string) => void
  onOpenSettings: () => void
  activeView?: string  // vscode 模式下当前 Side Bar 视图，用于指示条
}): ReactNode
```

在 `Sidebar.tsx` 中渲染于面板内最左（docked 与 vscode 模式都渲染——Activity Bar 是两条路径共享的入口）。

### 3.4 与 + 菜单的关系

Activity Bar 是 `+` 菜单的常驻图标化；`+` 菜单保留在 tab strip 右端。两者都调 `buildNewTabOptions` + `openTab`，逻辑不重复。`+` 菜单的 `available` 禁用判定、键盘优先行为（v0.14.0）照旧。

### 3.5 窄视口

抽屉模式（<768px）下：抽屉宽 ≥ 320px 时 Activity Bar 保留（朝向随 arrange，镜像时在抽屉右缘）；过窄则隐藏（48px 占比过大），退化为 `+` 菜单入口。断点常量复用 `breakpoints.ts`。

---

## 4. 路径 B：独立 Side Bar 布局模式

### 4.1 新 pref：`sidebarLayout`

```ts
// src/prefs-shared.ts SidebarPrefs 增字段
sidebarLayout: 'docked' | 'vscode'  // 缺省 'docked'
```

- `src/config.ts` `PrefsSchema`：`sidebarLayout: z.union([z.const('docked'), z.const('vscode')]).default('docked')`
- `src/client/prefs.ts` `parsePrefs`：`normalizeSidebarLayout` 解析，非法值回退 default；**旧持久化的 `'vscode-left'` / `'vscode-right'` 迁移为 `'vscode'`**（镜像，用户选定）
- `SIDEBAR_PREFS_DEFAULTS.sidebarLayout = 'docked'`
- 派生：`isVscode(layout) = layout !== 'docked'`（实际由 `Sidebar.tsx` 计算 `vscodeLayout = !narrow && prefs.sidebarLayout === 'vscode'`，窄视口强制回退 docked）
- 声明式设置：editor 卡片 gear 下新增 `sidebarLayout` select（与 `editorExplorer` 并列），选项 `'docked'` / `'vscode'`，文案 `sidebarLayout` / `sidebarLayoutDocked` / `sidebarLayoutVscode`。

### 4.2 状态模型变更

`src/client/state.ts` `SidebarState` 增字段：

```ts
sideBarView: string       // 当前活动视图 id，缺省 'explorer'；vscode 模式有效
sideBarWidth: number      // Side Bar 宽度，缺省 240（>= SIDEBAR_MIN）；vscode 模式有效
```

- `defaultState`：vscode 模式 seed `sideBarView: 'explorer'`、`sideBarWidth: 240`。
- `loadState` / `sanitizeState`：兼容旧持久化（无字段 → 填 default）；`migrateBottomTabs` 在 vscode 模式下保持 Side Bar 几何。
- 纯函数：`setSideBarView(state, view)`、`setSideBarWidth(state, px)`（镜像 `setWidth`/`setBottomHeight` 的 clamp 风格）。

### 4.3 Side Bar 容器与视图

新增 `src/client/SideBarPane.tsx`：vscode 模式下面板内的竖向容器，宽 `sideBarWidth`。**镜像布局**：位于 Editor Group（Workbench）右侧、Activity Bar 左侧，DOM 顺序即 `[Workbench, SideBarPane, ActivityBar]`（无需 row-reverse——编辑器天然在左）。拖拽手柄在侧栏**左缘**（编辑器|侧栏边界，向左拖变宽，与 docked 树同款）。

**当前实现为 explorer-only**：Side Bar 恒渲染 `<TreePanel full />`（文件树 + 搜索），`sideBarView` 字段已入状态模型但保留给未来视图切换（git/subagent 仍为 tab，经 Activity Bar 打开）。Activity Bar 图标 = registry 非 hidden 已启用 tab，单击走 `openTab`（与 `+` 菜单完全同路）。

> **实施偏差（相对原型）**：原型把 git/subagent 作为 Side Bar 竖向视图切换；为最小化对现有框架的影响，实施版 Activity Bar 是纯图标化启动器（git/subagent 仍是 tab），Side Bar 只放文件树。视图切换留作后续增量。

### 4.4 EditorHost 解耦

`src/client/EditorHost.tsx`：读 `prefs.sidebarLayout`，vscode 模式下跳过 TreePanel dock 渲染，只渲染编辑器 chrome（路径输入框 + 预览/编辑/保存控件）+ 内容。文件打开回调（`onOpenFile`）由 Side Bar 的 TreePanel 提供，走 store 的 `openFile` / `updateTab`（沿用 `editorExplorer` 合并/独立语义，但树在 Side Bar 而非 tab 内）。

### 4.5 窄视口

vscode 模式在窄视口（<768px）回退为 docked 抽屉行为：Side Bar 折叠进抽屉（Activity Bar 隐藏，`+` 菜单入口恢复），保持移动端可用。`useNarrowViewport` 判定后强制按 docked 路径渲染（pref 值不变，仅渲染分支回退）。

---

## 5. 对现有代码的影响清单

| 文件 | 改动 | 风险 |
|---|---|---|
| `src/prefs-shared.ts` | 加 `sidebarLayout` 字段 + default | 低 |
| `src/config.ts` | `PrefsSchema` 加 z.enum | 低 |
| `src/client/prefs.ts` | `parsePrefs` 解析新字段 | 低 |
| `src/client/state.ts` | `SidebarState` 加 `sideBarView/sideBarWidth` + 纯函数 + default/load/sanitize | 中（状态模型） |
| `src/client/Sidebar.tsx` | 布局分支（docked/vscode）+ 挂 ActivityBar + SideBarPane | **高（最大改动点）** |
| `src/client/ActivityBar.tsx` | 新增组件 | 低（新文件） |
| `src/client/SideBarPane.tsx` | 新增组件 | 中（新文件 + 拖拽） |
| `src/client/EditorHost.tsx` | vscode 模式跳过 TreePanel dock | 中 |
| `src/client/builtins/tabs.tsx` | Side card 顶层加 `sidebarLayout` select | 低 |
| `src/client/locales.ts` | 新增 sidebarLayout/select 文案中英 | 低 |
| `src/client/sidebar.module.css` | ActivityBar + SideBarPane 样式（令牌驱动） | 低 |
| `src/client/keybindings.ts` / `builtins/keybindings.ts` | 可选：`Cmd+Shift+E` 切 explorer 视图等活动栏快捷键 | 低（可选） |

**回退保证**：docked 路径零改动（布局分支隔离），回退 = pref 切回 `'docked'`。

---

## 6. 皮肤与令牌（AGENTS.md §8）

- Activity Bar 表面：`var(--dsw-alias-bg-layer-1)`（与面板同层）；若需区分层级，用 `--dsw-alias-bg-layer-2`，**绝不碰 `--dsw-alias-sidebar-fill`**（宿主左导航专属）。
- Side Bar 表面：`var(--dsw-alias-bg-layer-1)`（与面板一致）。
- 激活指示条 / 高亮：消费 `--dsw-alias-fg-accent` 或 `--dsw-alias-border-active`（皮肤已覆盖的语义令牌）。
- 所有颜色经令牌，无硬编码；`tests/theme.spec.ts` 守护 Activity Bar/Side Bar 令牌读取。

---

## 7. 键盘交互

- 复用 v0.14.0 快捷键系统：可选新增 `Cmd+Shift+E`（切 explorer 视图）、`Cmd+Shift+G`（git）、`Cmd+Shift+X`（subagent）等活动栏视图切换，走 `registerKeybinding`，`when` 判 `sidebarLayout === 'vscode'`。
- Activity Bar 图标列本身支持 ↑↓ 导航 + Enter 打开（键盘优先一致性）。
- 本轮可先不加快捷键，仅留入口；快捷键作为后续增量。

---

## 8. 测试计划

- `tests/service.spec.ts`：`sidebarLayout` 默认值 / 解析 / sanitize 兼容旧持久化。
- `tests/builtins.spec.ts`：Side card 顶层 `sidebarLayout` select 元数据。
- `tests/editor-host.spec.tsx`：vscode 模式不渲染 TreePanel dock。
- 新增 `tests/activity-bar.spec.tsx`：图标列派生自 registry、单击 openTab、激活高亮派生自 state。
- `tests/e2e/mount.e2e.ts`：**vscode 模式深扫**——切 `sidebarLayout: 'vscode'`，经 Activity Bar 逐个打开内置 tab（含 terminal 懒加载 chunk），经 Side Bar explorer 打开 seed 文件强制加载 editor 懒加载 chunk；断言无 pageerror、无插件 console 错误、`[data-dsh-better-sidebar]` 挂载。docked 模式回归用例保留。
- `tests/theme.spec.ts`：Activity Bar/Side Bar 令牌读取断言。

---

## 9. 风险与回退

| 风险 | 缓解 |
|---|---|
| Sidebar.tsx 布局分支是最大改动点 | docked 路径零改动隔离；新分支独立；回退 = pref |
| e2e 挂载门禁（`pnpm test:mount`） | vscode 模式必须保证内置 tab + chunk 仍可打开；Activity Bar 点击路径全覆盖 |
| 皮肤令牌误用 | §6 令牌清单 + `tests/theme.spec.ts` 守护 |
| 窄视口回归 | vscode 模式窄视口强制回退 docked 渲染 |
| HMR / 持久化兼容 | sanitizeState 兼容旧持久化（无新字段 → default） |

---

## 10. 实施阶段

1. **路径 A（Activity Bar）**：新增 `ActivityBar.tsx` + CSS + 在 `Sidebar.tsx` 挂载（docked/vscode 共享）。独立、低风险，先落地验证"VSCode 感"。
2. **路径 B（sidebarLayout pref + Side Bar）**：prefs 链 → state 模型 → `SideBarPane.tsx` → `EditorHost` 解耦 → `Sidebar.tsx` 布局分支 → 声明式设置 select → 文案。
3. **测试 + 文档同步**：unit + mount e2e + AGENTS.md/README 新 pref 与布局说明。

每阶段独立可测、可回退；A 完成后即可发布验证，B 不阻塞 A。
