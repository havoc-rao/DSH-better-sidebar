# VSCode 布局私有改动的维护指南（merge 上游用）

> 面向：本仓库 owner。`sidebarLayout: 'vscode'`（VSCode 风格工作台布局）是**私有功能**，不提交上游 DSH-better-sidebar。上游每次更新后，需要手动 merge/重放本仓库的改动。本文档说明改动形态、冲突风险与推荐流程。

## 0. 设计原则（为什么这样改）

- **默认 `docked`，零行为变化**：`sidebarLayout` 缺省 `'docked'`，不启用时所有新增代码路径不触发——上游代码在"关闭 vscode 布局"时与原生行为完全一致。这是 merge 兼容的基石。
- **追加优先，修改最少**：新文件独立；现有文件的改动尽量是"插入式追加"（加字段、加段落、加块），少改现有逻辑行。
- **EditorHost 自算布局**：vscode 模式由 EditorHost 自己读 `prefs.sidebarLayout` + `useNarrowViewport` 判定（与它读 `editorExplorer` 同款模式），**不**通过 TabComponentProps 传标志——避免侵入 tab 渲染链。

## 1. 改动清单（按冲突风险分级）

### 1.1 纯追加（上游更新自动合并，几乎零冲突）

| 文件 | 改动形态 |
|---|---|
| `src/client/ActivityBar.tsx` | **新文件**（活动栏；`flipped` prop：`sideBarSide: 'left'` 时边框/活动指示条/tooltip 方向镜像；`onToggleSideBarSide` 渲染钉在图标列底部的翻转按钮） |
| `src/client/SideBarPane.tsx` | **新文件**（资源管理器抽屉；`flipped` prop：`sideBarSide: 'left'` 时边框/手柄镜像到右缘、拖拽方向反转） |
| `tests/activity-bar.spec.tsx` | **新文件** |
| `src/prefs-shared.ts` | 追加 `sidebarLayout` 字段 + `SIDEBAR_BAR_WIDTH_*` 常量 + `clampSidebarBarWidth`；**追加 `sideBarSide` 字段**（`'left' | 'right'`，默认 `'right'`） |
| `src/config.ts` | 追加 1 行 schema（`sidebarLayout` union）；**追加 `sideBarSide` union** |
| `src/client/prefs.ts` | 追加 `normalizeSidebarLayout` 函数 + `parsePrefs` 追加 1 行；**追加 `normalizeSideBarSide`** |
| `src/client/state.ts` | `SidebarState` 接口尾部追加 3 字段（`sideBarView/sideBarWidth/sideBarOpen`）；`makeDefaultState`/`sanitizeState` 尾部追加字段；追加 `setSideBarView/setSideBarWidth/setSideBarOpen` 纯函数 |
| `src/client/locales.ts` | 追加文案（zh/en）；**追加 `sideBarSide*` 文案** |
| `src/client/sidebar.module.css` | 追加新类（`.activityBar*` / `.sideBarPane*` / `.vscodeHeader*` / `.sideBarResize` 等）；**追加 `.activityBarFlipped*` / `.activityBarSpacer` / `.sideBarPaneFlipped*`** |

### 1.2 插入式追加（冲突中风险：上游若在同一区域改动会碰）

| 文件 | 改动形态 |
|---|---|
| `src/client/Sidebar.tsx` | ① import 追加；② `vscodeLayout = !narrow && snapshot.prefs.sidebarLayout === 'vscode'`（1 行，加在 cwd 附近）；③ `HeaderTabStrip` 组件（新函数）；④ panelBody **前**插入 `vscodeHeader` 块、**内** Workbench 后插入 `SideBarPane`/`ActivityBar` 块（均为插入，不修改现有 JSX 行）；⑤ 主 Workbench 加 `hideTabBar={vscodeLayout}`（1 行属性）；**⑥ `sideBarLeft` 派生行 + `sideBarSide: 'left'` 时 ActivityBar/SideBarPane 渲染到 Workbench 前（`flipped` props）+ `flipSideBarSide` 回调（乐观写 + settings 路由持久化）传给 ActivityBar 的 `onToggleSideBarSide`** |
| `src/client/builtins/tabs.tsx` | editor 描述符 `settings.toggles` 数组追加 `sidebarLayout` select 项；**再追加 `sideBarSide` select 项** |

### 1.3 修改现有逻辑（冲突高风险，但改动点少且集中）

| 文件 | 改动形态 |
|---|---|
| `src/client/EditorHost.tsx` | ① 追加 `layout` 的 `useSyncExternalStore` + `useNarrowViewport` + `vscode` 计算（约 8 行，插在 `inPlace` 后）；② **3 处条件**加 `&& !vscode`：`treeOnly`、tree-toggle 按钮渲染、docked tree dock 渲染 |
| `src/client/split-pane.tsx` | `hideTabBar?: boolean` prop 三层传递（Workbench→NodeView→LeafView，均为可选 prop + 透传）；LeafView 的 TabBar 渲染条件改为 `!hideTabBar &&` |

### 1.4 测试改动（full-shape 断言，上游加字段时会碰）

| 文件 | 改动形态 |
|---|---|
| `tests/prefs.spec.ts` / `tests/plugin-shape.spec.ts` / `tests/smoke.spec.ts` | 全形状 `toEqual` 期望对象加 `sidebarLayout: 'docked'`（3~4 处内联字面量）；**再补 `sideBarSide: 'right'`** |
| `tests/state.spec.ts` | 追加 vscode Side Bar 字段 describe（含 `sideBarOpen`） |
| `tests/builtins.spec.ts` | editor 卡片 select 元数据断言（`['editorExplorer', 'sidebarLayout', 'sideBarSide']`） |
| `tests/editor-host.spec.tsx` | 追加 `describe('EditorHost — vscode layout')`（2 用例，经 setPrefs 而非 prop） |
| `tests/e2e/mount.e2e.ts` | 新增 vscode 模式深扫 test + onboarding/expand 辅助函数（新增，不动主 test 的断言） |

## 2. merge 上游的推荐流程

```bash
# 上游作为 remote（一次性）
git remote add upstream https://github.com/omdsh-dev/DSH-better-sidebar.git

# 每次上游更新后
git fetch upstream
git merge upstream/main
```

**冲突处理优先级**：

1. **1.1 纯追加**：自动合并，无需处理。
2. **1.2 插入式追加**：上游若改了 `Sidebar.tsx` 的 panelBody/Workbench 区域，冲突定位在插入块——**以"上游版本为基础，把我们的插入块重新贴回去"**（我们的块是自包含的：header 块、SideBarPane/ActivityBar 块、HeaderTabStrip 函数、vscodeLayout 行）。
3. **1.3 修改现有逻辑**：上游若改了 `EditorHost` 的 treeOnly/dock/toggle 或 `split-pane` 的 LeafView/TabBar——冲突时**保留上游逻辑，把 `!vscode` 条件重新加到对应位置**（vscode 计算块本身不冲突）。
4. **1.4 测试**：上游若加了新 pref 字段，full-shape 断言冲突——把上游新增字段也补进期望对象，同时保留我们的 `sidebarLayout: 'docked'`。

**merge 后验证**（门禁，缺一不可）：

```bash
pnpm typecheck          # 0 错误
pnpm build              # 构建通过
pnpm test               # 除 4 个 pre-existing 环境失败（agent-pty/host-sidebar-keeper/side-card-section/smoke pty）外全绿
pnpm build && pnpm pack && pnpm test:mount   # 挂载门禁 4/4（含 vscode 深扫）
```

## 3. 关键不变式（改动它们会破坏 merge 兼容）

- `sidebarLayout` 缺省必须保持 `'docked'`（向后兼容 + 上游用户无感）。
- `sanitizeState`/`parsePrefs` 对**缺失**的新字段必须回退默认（旧持久化 + 上游旧代码共存）。
- vscode 布局的所有新代码路径必须被 `vscodeLayout`（或 `sidebarLayout === 'vscode'`）守卫——上游代码永不触发。
- 不新增对 TabComponentProps / 服务方法签名（`BetterSidebarService`）的**必填**改动——只允许可选/追加。

## 4. 若未来决定回上游

若打算把功能提交上游，建议先 rebase 成"干净的追加"（去掉 1.4 测试的 full-shape 修补、把 vscode 布局做成默认关的可选功能），再开 PR。`docs/plans/2026-08-19-vscode-ide-style-design.md` 有完整设计说明（含实施偏差记录）。
