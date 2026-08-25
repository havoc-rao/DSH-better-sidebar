# VSCode 插件体系兼容层设计（首例：文件图标主题 — Material Icon Theme 端口）

> 状态：**设计方案（待评审）**
> 范围：L1「贡献点契约兼容」的第一个扩展点 `iconThemes` 全链路——注册 API + 解析引擎 + 渲染层 + 设置 UI + prefs + 官方转换工具 + 参考插件。以用户提供的真实 VSIX（`pkief.material-icon-theme-5.38.1.vsix`）实测数据为设计输入，端到端可验证。
> 不在本轮：Material 主题的 commands / configuration（图标包、颜色、透明度等专属配置）、`languageIds`、`light`/`highContrast` 变体、`hidesExplorerArrows`、Monaco 编辑器（路径 C，正交）。
>
> **设计决策（2026-08-25 评审）**：图标主题选择入口定为 **editor 卡齿轮内的 select 行**（`fileIconTheme`，绑 host pref，与 `sidebarLayout` 同形态）——为此给声明式设置的 select 增补两个向后兼容的小能力：`options` 支持 `(ctx) => SelectOption[]` **动态函数形态**、行级 **`when` 可见性谓词**；废弃独立的「文件图标」设置区方案。见 §2.2 契约增补与 §7.1。
>
> **实施记录（P1，2026-08-25）**：核心引擎 + 注册 API + prefs + 单测已落地（`src/client/icon-theme.ts`、service 5 个新成员、`fileIconTheme` 全链、`tests/icon-theme.spec.ts` + 真实夹具 `tests/fixtures/material-icon-theme.sample.json`；`pnpm test:local` 全绿、`pnpm typecheck` / `pnpm build` / `check:consumer-types` 通过）。实施偏差：
> 1. 服务新增第 5 个成员 **`matchFileIcon(context)`**——把「激活主题 + 索引」封装为渲染就绪查询（含 `monochrome` 分流），`FileIcon` 组件与外部插件都可直接消费，索引不暴露；
> 2. **空 `iconDefinitions` 是合法主题**（仅兜底默认图标）——fail-fast 只针对「定义缺 iconPath/fontCharacter」与「非 data URL 资产」；
> 3. 夹具实为 27 个 def id（设计文档初稿写 28，已按实修订）；`rootFolderNames` 在该主题版本为空 map，测试锁定「空 root 变体 → `rootFolder`/`rootFolderExpanded` 兜底」路径。
>
> 待实施：P2（渲染/集成/设置行）、P3（转换工具 + 参考插件）、P4（e2e 回归 + AGENTS.md）。
>
> **实施记录（P2，2026-08-25）**：渲染与集成已落地——`FileIcon` 组件三形态（彩色 SVG background-image / 单色 SVG mask+currentColor / 字体字形；prop 名 `icon`——React 保留 `ref`）、`useFileIconResolver` 钩子（service.subscribe + subscribeState 双订阅，注册与 prefs 变化实时重算）、FileTree 三类行（根/目录开合/文件）+ 编辑器 tab 条带 path 文件图标（`tabIconOf`）、editor 卡齿轮 `fileIconTheme` select 行（动态 options 函数 + `when` 谓词，无主题插件时整行隐藏=设置弹窗零感知）、字体主题注册期注入 @font-face（disposer 移除）。声明式设置契约增补落地：`SidebarSettingToggle.options` 函数形态 + `when` 行谓词（fail-open：谓词抛错=行可见、options 抛错=空列表），`FeatureSettingsRows` 增 `ctx` prop（`SideCardSectionInjected` 同步扩展，index.tsx 注入）。测试：`tests/file-icon.spec.tsx`（三形态/字体注入/树行实时切换）、`side-card-section-rows.spec.tsx`（when 隐藏 + fail-open、options 函数求值 + 提交、抛错降级）、`builtins.spec.ts`（editor toggles 四行 + when/options 形态断言）。实施偏差：① `FileIcon` 渲染不依赖 CSS Modules（全内联 style，`data-file-icon` 属性供测试/调试）；② 图标尺寸固定 14px（与现有树行/标签图标一致），`FileIcon` 支持 size 覆盖；③ 解析器异常吞掉返回 null（树行永不因主题炸）。
>
> 待实施：P3（转换工具 + 参考插件）、P4（e2e 回归 + AGENTS.md + mount e2e 断言）。
>
> **实施记录（P3+P4，2026-08-25）**：全部落地。
> - **P3 工具链**：`tools/convert-vscode-icon-theme.mjs`（纯 Node，CLI + 可测 API）——真实 material VSIX 端到端验证：**1251 定义 / 12820 映射 / 1.87MB 模块（374KB gzip）**，生成模块直接喂引擎逐行解析通过；`--no-strict` 缺失资产降级为警告+跳过；LICENSE 原文随生成模块逐字保留。参考插件 `samples/material-icon-theme/`（scripts/convert.mjs 一键再生成，完整数据 gitignore 不入库；README 含挂载与启用步骤）。测试 `tests/convert-icon-theme.spec.ts`（6 用例：base64 重写/忽略节丢弃/字体主题/fail-fast/降级/export name）。
> - **P4 收口**：mount e2e 两链路各加回归断言（无主题插件时 `[data-file-icon]` 计数为 0 + 文件行保留内置 outline `<svg>`）；AGENTS.md 新增 **§11 图标主题注册 API**（descriptor/文档子集/注册与解析/转换工具/设置契约增补）；§5 服务清单补 5 个新方法。设计文档本页即实施记录。
>
> 说明：settings 的 `options` 函数形态与 `when` 谓词已随 P2 落地并通过测试（含 fail-open 语义）；「添加插件」目录的 `icon-theme` kind（§7.2）仍为后增量，未实施。

---

## 0. 背景与目标

上轮讨论的结论：**「兼容 VSCode 风格插件体系」应按契约（contribution 模型）兼容，而非二进制（vscode API/VSIX 运行时）兼容**——与 `2026-08-19-vscode-ide-style-design.md`「只参考布局范式与设计 token，不参考代码」同一哲学。IDE 模式（⌘⌥⇧B 全屏 + `sidebarLayout: 'vscode'`）已把 Activity Bar / Side Bar / Editor Group / Panel 四件套容器具象化，插件体系缺的是**第一个吃透契约的扩展点**来验证这条路。

选择**文件图标主题**做首例的理由：

1. **纯声明式**：`contributes.iconThemes` 只声明 `{id, label, path}`，负载是一份 JSON（图标定义 + 名字/扩展名/目录名映射），无任何命令、无宿主 API 依赖——是 L1 适配层最干净的靶子。
2. **零宿主耦合**：图标解析纯字符串/映射运算，不碰 DSH 的 fs/会话/终端，不触发构建纯度门以外的任何平台约束。
3. **观感收益最直接**：文件树是侧边栏出现频率最高的表面，Material Icon Theme 是 VSCode 生态最流行的图标主题（MV 级下载），用户已有真实 VSIX 待验证。
4. **体量真实**：1251 个图标定义、1.3 万条映射——能逼出体积、性能、工具链的真问题，而不是玩具 demo。

**目标**：插件作者拿到一个解压后的 VSIX，用官方转换工具 + 二十行注册代码，即可让 FileTree 与编辑器 tab 呈现 Material 图标；解析/渲染/设置在 better-sidebar 核心侧完成，主题数据完全驻留在消费插件 bundle 内（构建纯度门零冲突）。

---

## 1. 可行性调研备忘（真实 VSIX 实测）

用户提供的 `pkief.material-icon-theme-5.38.1.vsix`（890KB，1278 文件）实测：

### 1.1 manifest（`extension/package.json`）

```jsonc
"engines": { "vscode": "^1.55.0" },
"extensionKind": ["ui", "workspace"],   // 纯 UI 扩展
"contributes": {
  "iconThemes": [{
    "id": "material-icon-theme",
    "label": "Material Icon Theme",
    "path": "./dist/material-icons.json"
  }],
  "commands": [ /* 11 个 activateIcons/toggleIconPacks/changeFolder*/ /* Color/... */ ],
  "configuration": { /* 20+ 项专属配置：activeIconPack/associations/customClones/color/opacity/saturation... */ }
}
```

- 主题贡献点确实是声明式 `{id, label, path}`；命令/配置都是锦上添花的专属设置，**与本设计无关**。
- 包内含 `extension/dist/extension/web/extension.cjs`——官方已作为 web 扩展分发，证明该主题在纯浏览器环境成立（我们的目标环境）。

### 1.2 主题文档（`extension/dist/material-icons.json`，450KB）

| 键 | 数量 | 说明 |
|---|---|---|
| `iconDefinitions` | 1251 | 全部为 `{ "iconPath": "./../icons/xxx.svg" }` |
| `fileExtensions` | 1377 | 含多级后缀键（`d.ts`、`html_vm` 等），值为 def id |
| `fileNames` | 2135 | 精确文件名（`justfile`、`.pug-lintrc.json`…） |
| `folderNames` / `folderNamesExpanded` | 4654 / 4654 | 两者同键数（展开态专用集） |
| `rootFolderNames` / `rootFolderNamesExpanded` | 有 | 工作区根目录专用 |
| `languageIds` | 200 | 本轮忽略（无语言模型，见 §4.3） |
| `light` / `highContrast` | 有 | 变体覆盖集，本轮忽略（见 §4.3） |
| 默认四件套 | `file:'file'` / `folder:'folder'` / `folderExpanded:'folder-open'` / `rootFolder:'folder-root'` / `rootFolderExpanded:'folder-root-open'` | 兜底 |
| 顶层 `hidesExplorerArrows` | `true` | 主题自带「隐藏树箭头」声明，本轮忽略 |

### 1.3 SVG 形态

实测 `zip.svg` / `git.svg`：`<svg xmlns viewBox="0 0 24 24"><path fill="#afb42b" d="…"/>`——**自带 fill 色的彩色图标**（Material 主题卖点），非透明单色。因此默认按「原色渲染」（img/background-image），VSCode 同样如此（彩色主题原色展示；单色由 CSS mask 的用法只适用于字体主题与自绘图标）。单色化支持（CSS mask + currentColor）作为 descriptor 级 `monochrome` 开关保留给单色主题。

### 1.4 许可

`LICENSE.txt` 1085 字节，MIT（material-icon-theme 仓库为 MIT）。转换工具在生成文件头保留许可声明，参考插件 README 标注署名。

> 结论：**契约兼容完全成立**。主题贡献是「静态 JSON + 静态 SVG」两条腿，没有一条腿依赖 vscode 运行时。转换 = 把 `iconPath` 相对路径重写为 data URL + 预建索引，其余原样搬运。

来源：[File Icon Theme — VSCode 官方指南](https://code.visualstudio.com/api/extension-guides/file-icon-theme)、[icon-theme.json schema（wraith13/vscode-schemas）](https://github.com/wraith13/vscode-schemas/blob/master/en/latest/schemas/icon-theme.json)、[material-extensions/vscode-material-icon-theme（DeepWiki）](https://deepwiki.com/material-extensions/vscode-material-icon-theme/3.1-file-icon-definitions)

---

## 2. 兼容层总体设计（贡献点契约）

### 2.1 五步契约模式

每个 VSCode 贡献点移植到 better-sidebar 都走同一套模式，`iconThemes` 是第一个完整落地者：

```
声明式数据注册（registerXxx）
  → 核心解析/索引（纯函数，无 React 依赖）
  → 渲染层消费（核心 UI 组件经 service 查询，绝不 value-import 插件）
  → prefs 选择（host PrefsSchema 字段，缺省 = 内置行为）
  → 设置 UI（注册表驱动，features gate 守护）
```

### 2.2 扩展点映射表（更新后）

| VSCode 贡献点 | better-sidebar 扩展点 | 状态 |
|---|---|---|
| `customEditors` + `filenamePattern` | `registerFileViewer`（exts/priority/detect，超集） | ✅ 已有 |
| `views` + `viewsContainers` | `registerTab`（Activity Bar / Side Bar / 面板） | ✅ 已有 |
| `keybindings` + `when` | `registerKeybinding`（when 上下文谓词） | ✅ 已有 |
| `configuration` | `settings.toggles` / `pluginToggles` / `settings.render` | ✅ 已有 |
| **`iconThemes`** | **`registerIconTheme`（本设计新增）** | 🆕 本轮 |
| `commands` + `menus` | 命令注册表 | ⏳ 待议（后增量） |

> **契约增补（本设计）**：`settings.toggles` 的 select 行新增两种形态，均为向后兼容加法（静态写法原样工作）：
> 1. `options` 允许函数形态 `(ctx: Context) => readonly SelectOption[]`——弹窗渲染时求值，注册表变化时重算（见 §7.1）；
> 2. 行级 `when?: (ctx: Context) => boolean` 谓词——false 时整行不渲染（供「无主题插件时零感知」用）。
>
> 这是「设置 UI 注册表化」的最小能力补齐：未来任何注册表驱动的选择行（命令绑定、键盘映射等）都复用同一形态，无需再发明新设置拓扑。

### 2.3 服务新增成员（v0.16.0 目标）

```ts
interface BetterSidebarService {
  /** 注册一个文件图标主题；返回 disposer（fiber 卸载自动注销，HMR-safe）。
   *  重复 id 抛错（与其他注册表一致）。 */
  registerIconTheme(descriptor: IconThemeDescriptor): () => void
  /** 已注册主题快照（注册顺序）。 */
  getIconThemes(): readonly IconThemeDescriptor[]
  /** 按 id 查主题（未注册 undefined）。 */
  getIconTheme(id: string): IconThemeDescriptor | undefined
  /** 当前激活主题（受 prefs.fileIconTheme 支配；未设置/已卸载 → undefined）。 */
  getActiveIconTheme(): IconThemeDescriptor | undefined
  // features 增补成员：'iconTheme'（单调，只增不删）
}
```

`features.includes('iconTheme')` 是消费方与内置 UI 的 gate——老版本核心遇到注册调用时静默跳过并 warn，消费插件照常加载。

---

## 3. 扩展点详细设计

### 3.1 `IconThemeDocument`（VSCode 规格子集 + 运行时归一化）

直接采用 [VSCode 官方 icon theme 文档结构](https://code.visualstudio.com/api/extension-guides/file-icon-theme)，**只删不增**：

```ts
interface IconThemeDocument {
  /** 图标定义表：def id → 渲染描述。 */
  iconDefinitions: Record<string, IconDefinition>
  /** 精确文件名 → def id */
  fileNames?: Record<string, string>
  /** 后缀（可含多级点，如 'd.ts'）→ def id */
  fileExtensions?: Record<string, string>
  folderNames?: Record<string, string>          // 收起态
  folderNamesExpanded?: Record<string, string>  // 展开态（缺省回退 folderNames）
  rootFolderNames?: Record<string, string>
  rootFolderNamesExpanded?: Record<string, string>
  /** 兜底 def id */
  file?: string
  folder?: string
  folderExpanded?: string
  rootFolder?: string
  rootFolderExpanded?: string
}

interface IconDefinition {
  /** SVG 路径。运行时必须是 data URL（转换工具保证）；注册校验拒绝其它形态。 */
  iconPath?: string
  /** 字体主题：字形字符（配合 fontPath / fontSize / fontColor）。 */
  fontCharacter?: string
  fontPath?: string   // data URL 字体，注册时注入 @font-face
  fontSize?: string
  fontColor?: string
}
```

**显式删除**：`languageIds`、`light`、`highContrast`、`hidesExplorerArrows`、`_watch`——见 §4.3 与 §10。

**注册期归一化**（`registerIconTheme` 传入前由转换工具完成，核心侧仍做防御校验）：

1. `iconPath` / `fontPath` 非 `data:` 前缀 → 抛错（插件无静态文件服务，相对路径必然 404；错误信息提示用转换工具）。
2. 每个 def 预解析为 `IconRef`（§5.1），构造 `Map<defId, IconRef>` 缓存。
3. 预建查询索引（§4.4）。

### 3.2 `IconThemeDescriptor`

```ts
interface IconThemeDescriptor {
  /** 唯一 id（建议包前缀：'material-icon-theme'）。 */
  id: string
  /** 展示名（i18n 友好：字符串或 () => string）。 */
  title: string | (() => string)
  /** 设置区预览图标（ReactNode 或 size 函数；通常是主题的默认文件图标）。 */
  icon?: ReactNode | ((size: number) => ReactNode)
  /** 归一化后的主题文档（唯一的运行时数据载荷）。 */
  theme: IconThemeDocument
  /** 单色渲染开关：缺省 false（SVG 原色渲染）；true 时 SVG 经 CSS mask + currentColor。 */
  monochrome?: boolean
  /** 设置区排序（升序）；默认 100。 */
  order?: number
}
```

### 3.3 生命周期与校验

- 走 `ctx.effect(() => ctx.betterSidebar.registerIconTheme({...}))`，disposer 由 fiber 管理——与 tab/viewer/keybinding 完全同构，HMR 卸载即注销。
- 重复 id 抛 `"icon theme \"<id>\" already registered"`（与 `registerTab` 同文案风格）。
- 注册即建索引（§4.4）；registry 变化经既有 `subscribe` 通知，内置 UI 用 `useSyncExternalStore` 订阅。

### 3.4 prefs：`fileIconTheme`

`SidebarPrefs` 增 host 字段（与 `sidebarLayout` 同级）：

```ts
// src/prefs-shared.ts
fileIconTheme: string  // 缺省 '' = 内置 outline 图标；值为主题 id
// src/config.ts PrefsSchema
fileIconTheme: z.string().default('')
```

- 语义与 VSCode `workbench.iconTheme` 对齐：**同一时刻一个激活主题**；主题卸载/未注册时回退内置图标（不报错、不弹提示，与 VSCode「theme 缺失回落默认」一致）。
- 解析沿用 `parsePrefs` 模式；非法值（未注册 id）在查询层回退，prefs 文档原样保留（用户重装插件即恢复）。

---

## 4. 解析引擎 `matchFileIcon`

纯函数模块 `src/client/icon-theme.ts`（无 React 依赖，与 `git-status.ts` 同地位）。

### 4.1 查询签名

```ts
interface FileIconContext {
  name: string      // basename（含点）
  isDir: boolean
  expanded?: boolean // 目录展开态
  isRoot?: boolean   // 是否为会话 cwd（工作区根）
}
matchFileIcon(theme: IconThemeDocument, index: IconThemeIndex, ctx: FileIconContext): IconRef | undefined
```

### 4.2 匹配顺序（对标 VSCode，测试锁定）

**文件**（`isDir: false`）：

1. `fileNames[name]` 精确命中；
2. `fileExtensions` **最长后缀优先**：`foo.d.ts` 依次尝试 `d.ts` → `ts`，首个命中即赢；
3. 兜底 `file`。

**目录**（`isDir: true`）：

1. `isRoot` 时：`rootFolderNamesExpanded[name]`（展开）→ `rootFolderNames[name]` → 兜底 `rootFolderExpanded` / `rootFolder`；
2. 非根：`folderNamesExpanded[name]` → `folderNames[name]` → 兜底 `folderExpanded` / `folder`。

> 展开态优先于收起态映射：VSCode 用展开态定义兜底到收起态定义；保持「展开专用集 > 通用集 > 兜底」的层级，任何一层缺失自动下沉。顺序细节以 VSCode 实现行为为准，**由真实数据夹具（§9）锁定**，不凭记忆写死。

### 4.3 显式忽略项与理由

| 忽略 | 理由 | 代价 |
|---|---|---|
| `languageIds`（200 条） | 依赖语言模型/编辑器语言判定，侧边栏无此概念；且 explorer 场景 VSCode 本身也走 fileNames/fileExtensions | material 主题少数语言专属图标不显示，可接受 |
| `light` / `highContrast` | 变体选择依赖 VSCode 主题系统；本插件皮肤令牌驱动、无「亮色模式」概念。**后续可映射**：按 `--dsw-alias-*` 亮度嗅觉选变体（后增量） | 亮色皮肤下个别浅色图标对比度偏弱（§10 缓解） |
| `hidesExplorerArrows` | 树箭头属于树 chrome，不在图标主题职权内 | 无 |
| 主题内 `_watch` 等元键 | 与运行时无关 | 无 |

### 4.4 注册期预建索引（性能）

`registerIconTheme` 时一次性构建：

- `Map<defId, IconRef>`（1251 项）
- `Map<basename, defId>`（fileNames，2135 项）
- 后缀查找结构：`fileExtensions` 键按「点段数降序」排序的数组 + 每键的散列 Map——`foo.d.ts` 查询时按 `d.ts` → `ts` 顺序线性探测（最长 2~3 次命中即止，实测键最大 4 段，最坏 4 次探测）。
- 目录侧同构（4654×2 项 Map）。

查询为 O(1)~O(4) 纯查找，渲染期零分配；索引随 disposer 释放。snapshot 语义：`getIconThemes()` 返回只读快照，索引随描述符对象不可变共存。

---

## 5. 渲染层

### 5.1 `IconRef` 三形态

```ts
type IconRef =
  | { kind: 'svg-image'; url: string }   // 彩色 SVG（Material 默认）：原色渲染
  | { kind: 'svg-mono'; url: string }    // monochrome: true 时：CSS mask + currentColor
  | { kind: 'font'; fontFamily: string; character: string; fontSize?: string; color?: string }
```

- `svg-image`：`<span class="fi" style="background-image: url(data:…)" />`——单元素、无额外请求，data URL 无网络往返；`background-size: contain; background-repeat: no-repeat; background-position: center`。
- `svg-mono`：`mask-image: url(data:…)` + `background-color: currentColor`——图标随前景令牌走（皮肤换色自动跟随），与插件自绘 outline 图标观感统一。
- `font`：注册时把 `fontPath`（data URL 字体）经一次 `@font-face` 注入（family 名 = `dsh-fi-<themeId>-<hash>` 防全局冲突），渲染为 `<span style="font-family: …; color: fontColor ?? 'currentColor'">&#x…;</span>`。

### 5.2 `FileIcon` 组件（核心侧内置）

```tsx
// src/client/FileIcon.tsx — 部件：给定主题 + 上下文，渲染 14px 图标
function FileIcon(props: {
  ctx: Context
  theme: IconThemeDescriptor          // 已激活主题（调用方查好）
  context: FileIconContext
  size?: number                        // 缺省 14（与现有树行/标签图标一致）
}): ReactNode
```

- `aria-hidden`（树行/标签已有文本标签，图标装饰性）；`data-file-icon="<themeId>:<defId>"` 便于测试与皮肤调试。
- 主题数据是插件 bundle 内的纯数据——`FileIcon` 只消费 `ctx.betterSidebar` 提供的注册数据，**零 import**，纯度门天然通过。
- 同理提供便捷查询 `tabFileIcon(ctx, path, isDir?)`（供 §6.2 的 tab 条使用，内部走同一引擎）。

### 5.3 与既有装饰共存

- **Git 状态装饰**（v0.15.0）：状态只作用于名称文本（着色/划线/徽标），图标不动——零冲突，保持。
- **Symlink 覆盖**：FileTree 现有 `IconLinkOutline16` 小角标叠加保留（VSCode 同款「链接箭头叠加」），不受主题控制。
- **无匹配**：`matchFileIcon` 返回 `undefined` → 调用方渲染现有内置 outline 图标（`IconFolderOpen16` 等）——**默认路径零改动、零额外开销**，回退即「无主题」。

---

## 6. 集成点（v1 范围）

| 表面 | 集成方式 | v1 |
|---|---|---|
| FileTree 行（根行 / 目录收起-展开 / 文件行） | 行内图标渲染改走 `themeIcon` 查询，命中 → `FileIcon`；未命中 → 现有 outline 图标 | ✅ |
| 编辑器 tab 条（带 path 的 editor tab） | `Sidebar.tabIconOf` 增分支：激活主题 && `tab.path` 存在 → 文件图标（按 basename 解析）；无 path 的 files home 窗口保持 descriptor 图标 | ✅ |
| diff / git / subagent / terminal / browser tab | 类型图标，与文件无关，不动 | — |
| TreePanel 搜索结果行、chat 引用 chip（`intercept.tsx`）、GitView 行 | 后增量（图标一致性收益低于成本，v1 不动） | ❌ |
| 底部面板终端 stub、GlobalPage 卡片 | 与文件无关，不动 | — |

所有 vscode 布局（docked/vscode/IDE 全屏）共用同一 `FileIcon` 路径——树在 dock 内或 Side Bar 列渲染位置不同，图标逻辑相同。

---

## 7. 设置 UI

### 7.1 editor 卡齿轮内的 `fileIconTheme` select 行（评审确定方案）

- 位置：SideCardSection 的 **editor 卡齿轮弹窗内**，新增一行 `type: 'select'` 设置，与 `editorExplorer` / `sidebarLayout` / `sideBarSide` 并列（同属 editor 卡的 `settings.toggles` 数组），绑定 host 字段 `fileIconTheme`——沿用既有声明式设置行与保存路由，**不新增任何设置区 / UI 拓扑**。
- 选项内容来自注册表（动态）：
  - 「内置图标」：value `''`（= 回退语义，§3.4），title `t('iconThemeBuiltin')`；
  - 每个注册主题：value = `descriptor.id`，icon = `descriptor.icon` 预览（`(size) => …`），title = `descriptor.title`，按 `descriptor.order` 升序。
  - 主题预览 icon 生效后走**大图标选项卡**形态（`hasIcons` 分支），与 `sidebarLayout` 的 iconed select 同观感。
- 为此的声明式设置小增补（§2.2 契约增补）：
  1. **`options` 函数形态**：`options: (ctx) => [{ value: '', title: t('iconThemeBuiltin') }, ...themeOptions]`——弹窗渲染时求值；弹窗打开期间订阅 `service.subscribe`（主题 HMR 装卸即重算列表）；求值抛错被吞掉（沿用设置行容错惯例，显示空列表）;
  2. **`when` 行谓词**：editor 卡该行声明 `when: (ctx) => (ctx.betterSidebar?.getIconThemes().length ?? 0) > 0`——**无主题注册时整行不渲染**，设置页回归零感知（§10 承诺不变）。
- 交互语义：选择主题 = 写 `fileIconTheme`（走既有 prefs 保存路由）；选「内置」= 清空回退；主题被卸载（HMR/禁用）时其选项从列表消失，已存 id 指向未知 → **行内回落「内置」高亮**（§3.4 回退语义，不弹错、不清空用户 prefs）。

### 7.2 添加插件入口（第二阶段）

`plugins-shared.ts` 的 `PluginEntry` 增 `kind: 'tab' | 'viewer' | 'icon-theme'`，「添加插件」弹窗增第三个 filter（图标主题目录）。数据完整性由 `tests/plugin-list.spec.ts` 守护。**本轮只留文档约定，不实现**。

### 7.3 i18n 文案（`src/client/locales.ts` 新键）

`iconTheme`（文件图标）、`iconThemeDesc`、`iconThemeBuiltin`（内置图标）、`iconThemesAdd`（添加主题插件）、设置区描述文案中英各一。

---

## 8. 消费插件开发指南（Material Icon Theme 端到端）

### 8.1 官方转换工具 `tools/convert-vscode-icon-theme.mjs`

仓库内新增 Node 脚本（与 `scripts/e2e-mount.sh` 同地位，零依赖、纯 Node 标准库），输入解压后的 VSIX 目录，输出可直接编译的 TS 模块：

```
node tools/convert-vscode-icon-theme.mjs \
  <extracted-vsix-dir> \          # 解压后含 extension/package.json
  -o samples/material-icon-theme/icons.generated.ts
```

处理管线：

1. 读 `extension/package.json` → 定位 `contributes.iconThemes[0].path`（取第一个；多主题时逐条输出）。
2. 解析主题 JSON；凡 `iconPath`/`fontPath` 为相对路径 → 读文件 → `data:image/svg+xml;base64,…` / `data:font/woff2;base64,…`（参考 SVG 是 XML 文本，base64 与 utf8 两种编码由脚本按体积择优选 utf8 转义，体积报告注明）。
3. 校验：不存在的图标文件 / 非 data 结果 → 失败退出并列出缺失清单（OS 符号链接图标、`_light` 变体等已知缺失项给出 warning 而非 error）。
4. 输出 `icons.generated.ts`：
   - 类型声明引用 `import type { IconThemeDocument } from 'dsh-better-sidebar/client/service'`；
   - 文件头保留 `LICENSE` 全文 + 转换器版本 + 源主题版本（`5.38.1`）+ 生成时间；
   - 末尾导出**归一化 `IconThemeDocument` 常量**（含预解析的 `IconRef` 不在此层——核心索引由注册 API 构建）。
5. 打印体积报告（raw / gzip 估算、defs/映射计数）——门禁友好，作者可据此决定是否走「独立懒加载 chunk」优化（见 §10）。

### 8.2 参考插件骨架（`samples/material-icon-theme/`）

不进 npm 包（`package.json` files 白名单外、不参与构建），作为**参考实现**入库（吃狗粮传统）；完整生成数据**不入库**（~1.5MB），README 记录从本地 VSIX 再生成的命令（用户已持有该 VSIX）：

```ts
// samples/material-icon-theme/src/client/index.tsx
import type {} from 'dsh-better-sidebar'            // 类型合并
import { iconTheme } from './icons.generated.ts'     // 转换工具产物

export const inject = ['betterSidebar']

export function apply(ctx: Context): void {
  if (!ctx.betterSidebar.features.includes('iconTheme')) return  // 老核心降级
  ctx.effect(() =>
    ctx.betterSidebar.registerIconTheme({
      id: 'material-icon-theme',
      title: () => 'Material Icon Theme',
      icon: (size: number) => <FileIconPreview theme={iconTheme} size={size} />,  // 或内置预览图标
      theme: iconTheme,
      order: 10,
    })
  )
}
```

- peerDependencies：`cordis` / `dsh-better-sidebar`（optional）/ `@deepseek-ai/dsh-client-runtime` / `react`——与 AGENTS.md §2.1 完全同构。
- **宝物**：`icons.generated.ts` 是纯数据模块，不 import 任何插件代码，构建纯度门零风险；运行时交互仅 `ctx.betterSidebar.registerIconTheme` 一次调用。

### 8.3 真实体积与性能数据（实测推算）

| 项 | 数值 |
|---|---|
| 图标 SVG 总数 / 总字节 | 1251 个 / ~450KB 原文（每个 150–900B） |
| 生成模块 raw | ~1.3–1.5MB（base64 放大 ~1.33× + 索引表） |
| gzip 后 | ~400–500KB（SVG/JSON 高压缩比） |
| 查询索引项 | ~1.3 万条 Map，注册期构建 < 50ms |
| 行渲染 | 每行一次 O(1)~O(4) 纯查找 + 一个内联 style 元素，无重排放大 |

对 opt-in 插件可接受（独立 bundle，仅安装者付费）；若后续体量门槛触发，已预留两条优化路径（§10：sprite 合并 / 懒加载 chunk），本轮不做。

---

## 9. 测试计划

| 测试 | 覆盖 |
|---|---|
| `tests/icon-theme.spec.ts`（新，核心） | 解析引擎全分支：fileNames 精确 > 后缀最长优先（`foo.d.ts` → `d.ts` > `ts`）；目录展开态 > 收起态 > 兜底；root 变体（`isRoot` 开关）；全 miss → undefined；注册/注销生命周期；重复 id 抛错；非 data URL 资产抛错；`features.includes('iconTheme')`；快照只读；索引释放 |
| `tests/fixtures/material-icon-theme.sample.json`（新） | 从**真实 VSIX 抽取子集入库**（~30 个 def + 代表性映射：`justfile`/`.pug-lintrc.json`/`d.ts`/`tsconfig.json`/`node_modules`/`src`/`.git` + 默认四件套 + 一个 `_light` 变体断言忽略），另附 3 个微型 SVG data URL；刷新流程：README 记录 `unzip` + 抽取命令，换主题大版本时对照 `plugin-list` 式守卫更新 |
| `tests/file-icon.spec.tsx`（新） | `FileIcon` 组件三形态渲染（svg-image 背景 URL / svg-mono mask / font 家族名）、size、`data-file-icon` 属性、aria-hidden |
| `tests/editor-host.spec.tsx` / `tests/fs-tree.spec.tsx`（扩展） | 激活主题下 FileTree 行（根/目录开合/文件/无匹配回退内置图标）与 editor tab 条（带 path 的 file tab 显示文件图标、home 窗口保持 descriptor 图标） |
| `tests/side-card-section.spec.tsx`（扩展） | editor 卡齿轮内 `fileIconTheme` 行：静态 `options` 形态回归不变；`options` 函数形态渲染时求值 + 弹窗内注册表变化重算（HMR 装卸即时反映）；`when` 谓词 false → 整行隐藏（无主题注册时）；有主题 → 大图标选项卡列表、选中态、点击写 prefs；主题卸载后已存 id 回落「内置」高亮 |
| `tests/prefs.spec.ts` / `tests/service.spec.ts` / `tests/builtins.spec.ts`（扩展） | `fileIconTheme` 解析/默认/非法值；service 新方法面；features 清单增成员；金卡内置注册清单不变 |
| `tests/theme.spec.ts`（扩展） | FileIcon 尺寸令牌与树行对齐；svg-mono 路径断言 `currentColor` 依赖（不硬编码颜色） |
| `tests/e2e/mount.e2e.ts`（回归） | **主题全链路不进 mount e2e**（真实挂载只有本插件，无法安装外部插件；与 Office viewer 迁移出内置后的 e2e 覆盖先例一致）。e2e 只加回归断言：默认图标渲染不变、editor 卡齿轮内无主题注册时无图标主题行（齿轮正常开合）、无 `dsh-better-sidebar:` 错误条 |

---

## 10. 风险与回退

| 风险 | 缓解 |
|---|---|
| 生成模块 ~1.5MB（raw） | opt-in 插件独立 bundle，仅安装者付费；体积报告门禁 + 两条预留优化（sprite 合并：1251×24px 单 SVG data URL，CSS background-position 定位，可砍 ~2/3；懒加载 chunk：`/sidebar/bundle` 模式对消费插件开放，后增量） |
| 彩色图标与深色皮肤对比度 | 与 VSCode 同问题；monochrome 开关（descriptor 级）+ `light` 变体映射留作后增量；文档明示主题作者可置 `monochrome: true` |
| data URL 安全 | SVG 仅经 `background-image`/`mask` 渲染，无脚本执行面（不比 iframe 沙箱更危险）；转换工具输出前可加可选的 `sanitize` 钩子（后增量） |
| 解析顺序与 VSCode 细微差异 | 顺序细节不凭记忆实现，用真实数据夹具锁定行为；文档标注「以 VSCode 行为为准」 |
| 版本漂移（主题出新版） | 转换工具版本头 + 夹具刷新流程（§9）；旧夹具失败即提示重跑转换 |
| `@font-face` 全局注入 | family 名 = `dsh-fi-<themeId>-<hash>`，卸载时随 disposer 删除 style 节点；作用域隔离 |
| 设置弹窗内列表随注册表变化 | `options` 函数 + `when` 谓词都容错：注册表订阅重算、求值抛错吞掉；无主题时整行隐藏（§7.1），设置页零感知 |
| 与皮肤兼容契约冲突 | FileIcon 不消费任何 sidebar 专属令牌，原色模式如皮肤冲突可用 monochrome；`tests/theme.spec.ts` 守护新断言 |

---

## 11. 实施阶段

1. **P1 核心（可独立发布）**：`icon-theme.ts` 解析引擎 + 索引 + `registerIconTheme`/`getIconThemes`/`getIconTheme`/`getActiveIconTheme` + `fileIconTheme` prefs 全链 + features gate + 纯函数单测（含真实夹具）。
2. **P2 渲染与集成**：`FileIcon` 组件（三形态）+ FileTree 行 + `tabIconOf` 文件 tab 分支 + 声明式设置增补（select `options` 函数形态 + 行 `when` 谓词）+ editor 卡齿轮 `fileIconTheme` select 行 + i18n + 组件测试。
3. **P3 工具链与参考实现**：`tools/convert-vscode-icon-theme.mjs` + `samples/material-icon-theme/`（转换、注册、README 再生成说明）+ 工具测试（`tests/tools.spec.ts` 模式沿用）。
4. **P4 收口**：mount e2e 回归断言 + `tests/theme.spec.ts` 扩展 + AGENTS.md 新小节 + 本文档实施偏差记录。

每阶段可独立发布、可回退（回退 = `fileIconTheme` 清空），P1 完成即兑现「注册 API 存在」，P3 完成后用户手上的 VSIX 即可端到端跑通。

---

## 12. 受影响文件清单

| 文件 | 改动 |
|---|---|
| `src/prefs-shared.ts` / `src/config.ts` / `src/client/prefs.ts` | `fileIconTheme` 字段 + 解析 |
| `src/client/icon-theme.ts`（新） | 解析引擎 + 索引（纯函数） |
| `src/client/FileIcon.tsx`（新） | 三形态渲染组件 |
| `src/client/service.ts` | 4 个新方法 + features 成员 + 类型导出（`./client/service` 声明面扩 `IconThemeDocument`/`IconThemeDescriptor`/`IconRef`，**零 Node 依赖守护仍有效**） |
| `src/client/Sidebar.tsx` / `FileTree.tsx` | 图标查询分支（未命中零改动路径） |
| `src/client/SideCardSection.tsx` | select 行 `options` 函数形态 + 行 `when` 谓词 + editor 卡注册 `fileIconTheme` select 行（动态列表） |
| `src/client/locales.ts` | 新文案中英 |
| `tools/convert-vscode-icon-theme.mjs`（新） | 转换工具 |
| `samples/material-icon-theme/`（新，不进包） | 参考插件 |
| `tests/*`（§9 清单） | 单测/组件/e2e 回归 |
| `AGENTS.md` | 新增「图标主题注册 API」小节（§3.x 按现有文档结构） |

---

## 13. 参考实现与来源

- 参照：`src/client/builtins/`（吃狗粮范式）、`src/client/service.ts`（注册表工厂）、`src/client/git-status.ts`（纯逻辑模块地位）、`scripts/e2e-mount.sh`（工具脚本地位）、`docs/plans/2026-08-19-vscode-ide-style-design.md`（IDE 模式语境）
- VSCode：[File Icon Theme 扩展指南](https://code.visualstudio.com/api/extension-guides/file-icon-theme)、[icon-theme.json schema](https://github.com/wraith13/vscode-schemas/blob/master/en/latest/schemas/icon-theme.json)
- Material：[material-extensions/vscode-material-icon-theme](https://github.com/material-extensions/vscode-material-icon-theme)（MIT），实测载荷来自用户提供的 `pkief.material-icon-theme-5.38.1.vsix`