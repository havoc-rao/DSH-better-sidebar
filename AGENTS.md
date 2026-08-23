# dsh-better-sidebar 插件接入文档

> 面向**消费插件开发者**：如何让你的插件向 better-sidebar 注册新的侧边栏页面（tab）和文件类型预览器。

better-sidebar 从 v0.4.0 起暴露 `ctx.betterSidebar` 服务（Cordis context 属性），其他插件通过 `registerTab` / `registerFileViewer` 注册扩展点，返回 disposer 由 Cordis fiber 自动管理生命周期（HMR-safe）。

---

## 0. 仓库硬约束（所有本仓库插件必须遵守）

- **禁止修改 DeepSeek Harness (DSH) 源码**：对官方源码 checkout（`~/.dsh/source/current`）零写入——不得改 harness 包、不得把 harness 改动提交到它的分支。
- **代码改动不强制走 PR**：功能 / 修复 / 测试等改动直接提交 / 推送 main；**仅当 user 明确要求 PR（或要求 review）时**，才在分支上开发（`feat/*` / `fix/*`）并用 `gh pr create` 发起，review 合并后才进 main。文档类改动（README / AGENTS.md / docs/ 等）一直允许直接推送到 main。
- **挂载只走 `cordis.patch.yml` + profile 机制**（`~/.dsh/profiles/<profile>/`），插件永远作为独立包被 profile 引用，不反向侵入 DSH。
- 需要 harness 没有的能力时，用 DSH **现成的只读/公开 API** 或插件自有路由实现（参考 §7 的 `jobs.output` 事件回放：读会话事件日志而非动注册表）；如果确实做不到，先向用户说明取舍，而不是直接改 DSH。

### CI 挂载冒烟（`plugin-mount` job / `pnpm test:mount`）

仓库的 CI 有一条「npm 打包 → 真实挂载 → 无头渲染」门禁（`.github/workflows/ci.yml` 的 `plugin-mount` job），证明**打包产物**在真实 DSH 上挂载后无头渲染不会 crash：

1. `pnpm build && pnpm pack` 产出 tarball（与发布产物一致）。
2. `scripts/e2e-mount.sh` 用官方 CLI 把它装进一个**全新 scratch profile**（`dsh plugin --profile web add file:<tarball>`，触发 `dsh.profile.bundles` 协调），然后启动真实 `dsh web`（keyless，`--port 0`）。
3. `tests/e2e/mount.e2e.ts`（Playwright Chromium）加载页面，断言外壳与 `[data-dsh-better-sidebar]` 挂载、无 `dsh-better-sidebar:` 错误条、无 pageerror/插件 console 错误，显式展开面板（`openByDefault` 默认关）后通过「+ 菜单」逐个打开内置 tab（含终端懒加载 chunk）深扫，再经 Files 文件窗口的内嵌树打开 seed 文件强制加载 editor 懒加载 chunk（`client-editor.js`，原地模式：seed 的 home tab 原地切换到文件）——缺失的内置 tab 或 chunk 都会使门禁变红。

本地跑：`pnpm build && pnpm pack && pnpm exec playwright install chromium && pnpm test:mount`（需 PATH 上有 `dsh` 或可经 npx 拉取）。DSH CLI 版本在 CI 钉住 `@deepseek-ai/dsh@0.1.0-rc.7`（与插件 peer 范围同步）。`tests/e2e` 的 spec 命名 `*.e2e.ts` + vitest `exclude` 双保险与 vitest 隔离；**改动 vitest `exclude` 时必须保留默认排除项**（`exclude` 会整体替换默认值）。

### npm 发版（GitHub Release → npm publish）

`.github/workflows/release.yml` 在 GitHub Release 发布（tag `vX.Y.Z`）时自动发版到 npm：

1. **发版前置**：`package.json` 版本号 bump 到 `X.Y.Z`（manifest 一致性守卫会校验其它副本），CI 全绿后打 tag `vX.Y.Z` 并发布 GitHub Release。tag 必须与 package.json 版本一致——workflow 在发布前校验，不匹配直接失败、不发版。
2. **流程**：workflow 依次执行 `pnpm build` / `pnpm typecheck` / `pnpm test`，校验 tag，然后 `pnpm publish --provenance --access public`（`prepublishOnly` 会重建产物；产物带 provenance 签名）。
3. **认证**：走 npm **Trusted Publishing（OIDC）**，不需要也不应配置 `NPM_TOKEN` secret。一次性手动配置（在 npmjs.com 完成）：package `dsh-better-sidebar` → Settings → Publishing access → Trusted Publishers → Add Trusted Publisher，字段为 Provider `GitHub Actions`、Organization `omdsh-dev`、Repository `DSH-better-sidebar`、**Workflow filename `release.yml`**、Environment 留空。未配置前发布会失败（OIDC 交换报错），配置后无需改 workflow。
4. **调试**：`workflow_dispatch` 手动触发 + `dry_run=true` 只打包验证、不发版。

---

## 1. 服务定位

- **服务名**：`betterSidebar`（即 `ctx.betterSidebar`）
- **发布侧**：better-sidebar 的 client half（`src/client/index.tsx`，通过 `ctx.provide('betterSidebar', service)` 发布）
- **消费侧**：你的插件的 client half（`inject = ['betterSidebar', ...]`，然后 `ctx.betterSidebar.registerTab(...)`）
- **类型合并**：`declare module 'cordis' { interface Context { betterSidebar: BetterSidebarService } }` 由 `dsh-better-sidebar` 包导出；消费插件 `import type {} from 'dsh-better-sidebar'` 即触发类型合并

> ⚠️ **host 半不发布此服务**：`ctx.betterSidebar` 只在 client 侧存在。如果你的插件 host 半需要读 better-sidebar 状态，走 better-sidebar 自己的 HTTP/WS 路由（`/sidebar/api/*`），不走服务。

---

## 2. 消费插件的最小骨架

### 2.1 `package.json`

```jsonc
{
  "name": "my-plugin",
  "peerDependencies": {
    "cordis": "^4.0.0-rc.7",
    "dsh-better-sidebar": "workspace:*"
  },
  "peerDependenciesMeta": {
    "dsh-better-sidebar": { "optional": true }
  }
}
```

- `dsh-better-sidebar` 必须声明为 **peerDependency**（不是 dependency，避免重复实例化）
- 标记 `optional: true` 让你的插件在 better-sidebar 未安装时也能加载（注册代码会因为 `ctx.betterSidebar` 为 undefined 而跳过）

### 2.2 client half 入口

```ts
// my-plugin/src/client/index.ts
import type {} from 'dsh-better-sidebar'  // 触发 ctx.betterSidebar 类型合并

export const inject = ['betterSidebar', 'slots']  // 声明服务依赖

export function apply(ctx: Context): void {
  // 注册一个 sidebar tab
  ctx.effect(() =>
    ctx.betterSidebar.registerTab({
      id: 'my-plugin:db',
      title: () => 'Database',
      icon: <DbIcon />,
      order: 50,
      component: ({ ctx, scope, tab }) => <DbView sessionId={scope.sessionId} />,
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

> ⚠️ **构建期纯度门**：client bundle 禁止 value-import 别的插件代码（`tsdown.config.ts` 的纯度门会挡）。`import type {}` 会被擦除，**不触发门禁**——所以类型可以自由共享，运行时符号不行。所有运行时交互必须走 `ctx.betterSidebar` 的方法调用。

### 2.3 类型导入

```ts
import type { TabDescriptor, FileViewerDescriptor, BetterSidebarService } from 'dsh-better-sidebar'
```

类型定义在 `lib/types/client/service.d.ts`，通过 `package.json` 的 `./client/service`（别名 `./client/api`）exports 子路径暴露。v0.12.0 起服务模块还 re-export 了完整的状态词汇表，消费者可以直接命名（不再只能靠推断）：

```ts
import type {
  SidebarTab, SidebarState, SidebarStore, SidebarSnapshot, SidebarDiffRef, TabType,
  SessionScope, SidebarPrefs, OpenTabSeed, SidebarSettingsRenderProps,
} from 'dsh-better-sidebar/client/service'
```

> 💡 **类型合并触发路径**：`import type {} from 'dsh-better-sidebar/client/service'` 同样会加载 `Context` 的 augmentation（`declare module 'cordis'` 在 context-types.d.ts 中，service 声明会拉入它）——纯浏览器侧插件建议走 `client/service` 路径，避免拉进宿主半的 Node 类型图（主入口 `dsh-better-sidebar` 的声明面含宿主代码，宿主消费者本就处于 Node 环境）。client 可达声明图（`client/*` + context-types + html-route + prefs-shared）自 v0.12.0 起**零 Node 依赖**（`scripts/check-consumer-types.sh` 守护），无 `@types/node`、`skipLibCheck: false` 也能编译。

---

## 3. Tab 注册 API

### 3.1 `TabDescriptor` 完整字段

```ts
interface TabDescriptor {
  /** 唯一 id；也是 SidebarTab.type 的值。建议带包前缀：'my-plugin:db'。 */
  id: string
  /** 标题（i18n 友好：传字符串或返回字符串的函数） */
  title: string | (() => string)
  /** 图标：ReactNode 或 (size: number) => ReactNode */
  icon?: ReactNode | ((size: number) => ReactNode)
  /** + 菜单排序（升序）；默认 100。内置：editor=10, git=20, subagent=30, terminal=40, browser=50 */
  order?: number
  /** 从 + 菜单隐藏（editor/diff 用：由其他流程触发打开，不在菜单里） */
  hidden?: boolean
  /** + 菜单禁用判定（如 terminal 配额满）。三参：ctx、会话 scope、当前状态 */
  available?: (ctx: Context, scope: SessionScope, state: SidebarState) => boolean
  /**
   * 单实例语法糖：`single: true` ≡ `dedupeKey: () => id`（打开时聚焦既有
   * 同类型 tab 而非新开）。显式给出 dedupeKey 时优先于 single。
   */
  single?: boolean
  /**
   * 去重键：openTab 时若已存在 dedupeKey 相同的 tab，则聚焦而非新开。
   * 返回 undefined 表示不去重（每次都新开，但同 id 会被 id 安全网聚焦）。
   * 内置策略：git/subagent 用 single: true；editor 用 tab => tab.path；diff 用 tab => tab.id。
   */
  dedupeKey?: (tab: SidebarTab) => string | undefined  // 必须保持纯函数：每次 open 会求值两次，抛错会向外传播
  /**
   * 自定义 tab 创建（minting SidebarTab + 状态 patch）。
   * 返回 null 拒绝创建。terminal 用它生成 terminal:<n> id 并递增 nextTerminal。
   * 省略时用默认 { id, type, title } + seed 里的 path/diff。
   */
  createTab?: (state: SidebarState) => { tab: SidebarTab; patch?: Partial<SidebarState> } | null
  /**
   * 外链点击目标认领（v0.13.0+）：聊天/界面外链被接管（`browserInterceptLinks`
   * 总闸 + URL 对应协议开关均开）时，第一个 `urlTarget(url)` 命中且未被设置
   * 禁用的注册 tab 类型以 `openTab({ type, url, title: hostname })` 打开——
   * URL 即全部载荷（tab 从 `tab.path` 读取）。注册顺序先到先得；谓词抛错被
   * 吞掉（跳过该类型）。内置 browser 不声明 urlTarget，永远是隐式兜底，不会
   * 遮蔽插件声明。要同时容纳多个 URL 需用 createTab 铸造 per-URL id（browser
   * 同款模式）；否则同类型二次点击被 id 安全网聚焦，新 URL 不会覆写既有 path。
   */
  urlTarget?: (url: URL) => boolean
  /**
   * 声明式设置（v0.4.1+）：每个注册的 tab 都会在 Side card 设置页获得一行
   * 开关（图标 + 标题 + 类型 id），`settings.toggles` 在其行下追加嵌套设置行，
   * 绑定 SidebarPrefs 字段。嵌套设置仅父级启用时显示（v0.11.0 起行控件不限于
   * 布尔开关：`type: 'switch' | 'text' | 'number' | 'select'`，缺省 'switch'；
   * text/number 行 blur/Enter 提交，number 行按 min/max 钳制，unit 渲染单位后缀；
   * select 行是下拉选择：options 声明 `{ value, title, desc?, icon? }`，任一
   * 选项带 icon 时下拉渲染大图标选项卡、收起态同样显示图标，否则单行文本；
   * `multi: true`（缺省 false）多选，存储值为选中 value 的数组，按 options
   * 顺序提交）。
   * v0.12.0 起增加两个插件自有扩展（详见 §5 声明式设置）：
   * `pluginToggles`（插件自有 key，持久化在 pluginSettings[id]，无需宿主 schema 字段）
   * 与 `render`（自定义设置面板，替代行列表）。
   */
  settings?: {
    toggles?: readonly {
      /** SidebarPrefs 字段名（内置键：'autoOpenSubagent' / 'agentTerminalTools' / 'terminalFontFamily' / 'editorExplorer' / 'sidebarLayout' / 'htmlViewerNoSandbox' / 'htmlViewerDefaultUnsafe' / 'browserNoSandbox' / 'browserInterceptLinks' / 'browserInterceptHttp' / 'browserInterceptHttps'） */
      key: string
      title: string | (() => string)
      desc?: string | (() => string)
      /** 行控件类型；缺省 'switch'（向后兼容）。 */
      type?: 'switch' | 'text' | 'number' | 'select'
      /** number 行的提交钳制下限。 */
      min?: number
      /** number 行的提交钳制上限。 */
      max?: number
      /** text 行的输入占位符。 */
      placeholder?: string
      /** 输入框后的单位后缀（如 'px'）。 */
      unit?: string
      /** select 行的选项（value 为提交值：string | number | boolean）。 */
      options?: readonly {
        value: string | number | boolean
        title: string | (() => string)
        desc?: string | (() => string)
        icon?: ReactNode | ((size: number) => ReactNode)
      }[]
      /** select 行是否多选（缺省 false；存储值为 value 数组）。 */
      multi?: boolean
    }[]
    /** 插件自有设置行（v0.12.0+）：形状同 toggles，但 key 是插件局部的，
     *  持久化在 `pluginSettings[<descriptor id>]`——不需要宿主 PrefsSchema 字段。 */
    pluginToggles?: readonly {
      key: string
      title: string | (() => string)
      desc?: string | (() => string)
      type?: 'switch' | 'text' | 'number' | 'select'
      min?: number
      max?: number
      placeholder?: string
      unit?: string
      options?: readonly {
        value: string | number | boolean
        title: string | (() => string)
        desc?: string | (() => string)
        icon?: ReactNode | ((size: number) => ReactNode)
      }[]
      multi?: boolean
    }[]
    /** 自定义设置面板（v0.12.0+）：给出时齿轮弹窗渲染它而非行列表。
     *  props 含 store/service/prefs、本 descriptor 的 pluginSettings blob、
     *  updatePluginSetting(key, value) 与 close()。抛错会被吞掉并显示内联错误。 */
    render?: (props: {
      store: SidebarStore
      service: BetterSidebarService
      prefs: SidebarPrefs
      pluginSettings: Record<string, unknown>
      updatePluginSetting: (key: string, value: unknown) => void
      close: () => void
    }) => ReactNode
  }
  /**
   * tab 角标（v0.12.0+）：tab 图标旁的小圆角 pill。number 渲染计数（99+ 封顶），
   * string 原样文本，null/undefined 不显示。每次 tab 栏渲染都会调用——保持廉价；
   * 抛错会被吞掉（不显示角标，不影响渲染）。
   */
  badge?: (ctx: Context, scope: SessionScope, state: SidebarState) => string | number | null | undefined
  /**
   * 生命周期回调（v0.12.0+），只由 SERVICE 路径触发：
   * - onOpen：openTab 真正**新建** tab 后（dedupe/id 安全网聚焦**不算**打开）；
   * - onActivate：tab 被聚焦时（dedupe 聚焦、id 安全网聚焦、tab 栏点击激活）；
   * - onClose：closeTab 关闭 tab 后。
   * 内置专属流程（diff 拆分放置、agent 终端 reconcile）直接改 state，不触发回调——
   * 但它们只作用于内置类型（diff/terminal），外部插件的 tab 永远走 service 路径。
   * 回调抛错只 console.error，绝不打断打开/关闭流程。openTab 的回调 scope
   * 携带调用者传入的 { sessionId, cwd? }（+ 菜单路径带 cwd；无 scope 的自动
   * 打开路径只有 sessionId）；closeTab/activateTab 的回调 scope 只在显式传入
   * scope 参数时带 cwd。
   */
  onOpen?: (tab: SidebarTab, scope: SessionScope) => void
  onActivate?: (tab: SidebarTab, scope: SessionScope) => void
  onClose?: (tab: SidebarTab, scope: SessionScope) => void
  /** 渲染函数 */
  component: (props: TabComponentProps) => ReactNode
}
```

### 3.2 `TabComponentProps`

```ts
interface TabComponentProps {
  ctx: Context                 // client cordis context
  store: SidebarStore          // better-sidebar 的状态 store（可调 reduce 等）
  scope: SessionScope          // { sessionId, cwd? }
  tab: SidebarTab              // 当前 tab 实例（含 id/type/title/path?/diff?）
  visible: boolean             // 是否是当前激活 tab 且面板打开（不可见时暂停轮询等）
  // 以下由内置 tab 使用，外部 tab 可忽略：
  expanded?: string[]          // 文件树的展开目录集
  onToggleDir?: (path: string) => void
  onReferenceFile?: (path: string) => void
  onOpenFile?: (path: string) => void
  onOpenDiff?: (tab: SidebarTab) => void
  onSubagentJump?: (childSessionId: string) => void
}
```

### 3.3 注册示例

**最简 tab**（单实例、+ 菜单可见）：
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

**多实例 tab**（每次新开、带自定义 id）：
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
// 外部触发打开：
ctx.betterSidebar.openTab({ type: 'my-plugin:doc', title: 'Spec.md', id: 'doc:spec' })
```

**条件可见**（仅 git 仓库时显示）：
```ts
ctx.effect(() =>
  ctx.betterSidebar.registerTab({
    id: 'my-plugin:commits',
    title: 'Commits',
    icon: <CommitIcon />,
    order: 70,
    available: (ctx, scope, state) => hasGitRepo(state),  // 三参 (ctx, scope, state)；返回 false 时 + 菜单显示为 disabled
    // 注意：available 只影响 + 菜单的 disabled 状态，不会拒绝 openTab（只有设置页的禁用开关会）。
    dedupeKey: () => 'my-plugin:commits',
    component: ({ scope }) => <CommitsView sessionId={scope.sessionId} />,
  })
)
```

**认领外链点击**（v0.13.0+，`features.includes('urlTarget')` gate）：聊天/界面里被拦截的 HTTP(S) 外链（协议开关开启时）路由到第一个 `urlTarget` 命中的 tab 类型，URL 作为 seed 预填 `tab.path`；内置浏览器是隐式兜底。多 URL 并存需用 `createTab` 铸造 per-URL id（browser 同款模式），否则同类型二次点击聚焦既有 tab、不覆写 path：
```ts
ctx.effect(() => {
  if (!ctx.betterSidebar.features.includes('urlTarget')) return
  return ctx.betterSidebar.registerTab({
    id: 'my-plugin:web-docs',
    title: () => 'Docs',
    order: 80,
    urlTarget: (url) => url.hostname === 'docs.my-site.com',  // 只有该域名被点击时认领
    createTab: (state) => ({
      tab: { id: `my-plugin:web-docs:${state.nextBrowser}`, type: 'my-plugin:web-docs', title: 'Docs' },
      patch: { nextBrowser: state.nextBrowser + 1 },
    }),
    component: ({ tab, scope }) => <WebDocsView url={tab.path} sessionId={scope.sessionId} />,
  })
})
```

### 3.4 内置 tab（不可重复注册）

| id | order | single | hidden | 用途 |
|---|---|---|---|---|
| `editor` | 10 | 否（按 path 去重） | 否 | 唯一的「文件窗口」（文件编辑/预览 + 文件资源管理）：文件 tab（有 path）在两种 `editorExplorer` 模式下 chrome 恒为合并形态——头部路径输入框 + 文本编辑器预览/编辑/保存控件 + 可开关的内嵌文件树面板（含全局文件名搜索，走 host `fs.search` 路由；左缘拖拽调宽；**收起/展开带宽度过渡动画**——首次展开后树常驻挂载，重开不重载），状态存 `tab.meta.treeOpen` / `tab.meta.treeWidth`；pref 控制**打开行为与无路径窗口形态**：开（默认，合并）= 树点击/输入框 Enter 原地切换当前 tab（`updateTab` 重写 path/title，id 与 meta 不变），无路径窗口 = 带 chrome 的空文件窗口（树默认展开）；关（独立）= 走 `openSidebarFile` 按 path 新开，**无路径窗口即独立资源管理器——只渲染文件树面板**（搜索 + FileTree 撑满全窗，无编辑器 chrome）。树右键菜单提供「在新 Tab 中打开」「在侧边打开」（后者在当前 pane 右侧 split 出新 editor tab）。**树行带 VSCode 式 git 状态装饰**（v0.15.0+）：文件/目录**名称按状态着色**（修改琥珀、增/重命名绿、删除红、未跟踪灰）+ 行尾彩色字母徽标（M/A/D/R/C/U/!/T，颜色映射 DSH 语义令牌）、目录聚合子孙最高优先级状态（删除不向父目录传播）、删除文件名称划线、面板底部变更计数条；状态随 Git 面板操作经共享变更总线实时联动（纯逻辑在 `src/client/git-status.ts`，见 `docs/plans/2026-08-19-git-status-decorations-design.md`）。新会话在两种模式下都默认 seed 空文件窗口（`title: 'Files'`，无 path，树面板展开）；持久化的旧 `explorer` tab 经 `sanitizeState` 迁移为该 home tab。**`sidebarLayout: 'vscode'`（v0.15.0+）时**：editor tab 不再内嵌树（树移到独立 Side Bar 列），无 tree toggle 按钮，无路径窗口恒为空提示；文件打开走 Side Bar 的 TreePanel → per-path tab。**`sideBarSide`（v0.15.0+，pref）**：**整体镜像** vscode 布局（默认 `'right'` = 编辑器 | 文件树列 | 活动栏；`'left'` = 活动栏 | 文件树列 | 编辑器——Activity Bar **连同文件树列一起翻到左缘**，`ActivityBar` 的 `flipped` prop 镜像边框/活动指示条/tooltip 方向，`SideBarPane` 的 `flipped` prop 镜像边框与拖拽手柄、拖拽方向反转）；**切换按钮钉在 Activity Bar 图标列底部**（`onToggleSideBarSide`，VSCode 活动栏设置齿轮的位置——乐观更新 + settings 路由持久化） |
| `git` | 20 | 是 | 否 | Git 面板 |
| `subagent` | 30 | 是 | 否 | 子代理拓扑 |
| `terminal` | 40 | 否 | 否 | 终端（nextTerminal 自增） |
| `browser` | 50 | 否（createTab 铸造 browser:`<n>`，nextBrowser 自增） | 否 | 内嵌网页浏览器（沙箱 iframe；可设置关闭沙箱） |
| `global` | 60 | 是 | 否 | 全局工作区页：记录所有**实例级全局状态**——目前是全局共享窗口（`gb:` 前缀的「全局共享」终端）清单。**全局工作区是一个特殊 session**（虚拟 `global-workspace` 会话，`GLOBAL_WORKSPACE_SESSION_ID`，状态存 `localStorage: dsh-sidebar:v1:global-workspace`，经 `SidebarStore.getStateOf/subscribeOf/reduceFor` 读写）：**全局共享窗口的完整生命周期（同一个 xterm 会话/PTY）驻留在此**——`bindGlobal`（终端右键「全局共享（转移到全局工作区）」）把终端转入全局 blob（`dsh-sidebar:v1:global-windows`），**不再自动合并 stub 到任何 session 的 tab 栏**（旧「所有项目同步」语义改为按需 attach）；点击卡片 = **`attachGlobal`** 把窗口带入**全局工作区自己的底部工作区**（虚拟会话的 `bottomSplits` 首个叶子 + `bottomOpen`，attach 到同一个 `shared:gb:<n>` PTY，一处 shell 多处视图）——**不碰任何真实 session**，完整页面保持打开；attached stub **持久化在虚拟会话布局**（reload 对照全局 blob 校验，窗口已取消则剥离，reconcile 剥离会同步持久化）；底部工作区 terminal 的 ✕ 只 **detach**（`detachGlobal(tabId, GLOBAL_WORKSPACE_SESSION_ID)`，窗口与共享 PTY 存活、回卡片列表）；卡片 ✕ = `unbindGlobal(false)`（全实例关闭 + 释放 PTY）。数据来自宿主注入的 `TabComponentProps.globalWindows`（workspace windows store 的实例级 blob），无则显示引导文案。两种形态：**完整页面**（`GlobalPage`：**原地接管官方 `conversation` 槽**——`ctx.slots.register({ name:'conversation', priority:-1 })`，ui-slots shadowing 规则「最低 priority 渲染」顶掉 `ui-conversation`（默认 0），chat box 的主区域本身变成全局工作区页（非浮层/非全屏），关闭 dispose 后聊天恢复（会话状态在 store 不受影响）；页面经 `useSyncExternalStore` 订阅 windows store 与**虚拟会话状态**实时刷新；**关闭路径**：Esc，或点击任意会话（页面从无会话 hero 打开，点会话即「打开一个会话」→ 关闭；头部无 ✕ 关闭按钮）；**会话绑定**：页面是**无会话表面**——打开时清掉当前 session 的激活态（`openGlobalPage(ctx)` = `ctx.sessions.clear()` + 置 open，页面在 hero 之上打开），因此从页面视角**点任何会话都是「打开一个会话」**，`Sidebar.tsx` 的会话守卫 effect 随即显式关闭页面（规则：仅当「已定义的会话」变为与页面打开时（hero/undefined）不同的会话才关闭；瞬时 `undefined` 重选间隙与回落 hero 不关）。显式关闭同时兜底槽条目重挂崩溃 abdicate 后 open 标志卡死的状态。**页面本体** = 卡片列表 + **专属下方工作区**（`globalPageBottom`，无 header——有 attached 终端即直接渲染；复用 Workbench 渲染虚拟会话 `bottomSplits`，terminal stub 经导出的 `LazyTerminal` 渲染；卡片点击 = attach 进该工作区，页面不关闭）。入口：`sidebar.footer.action` 注入的官方左栏「全局工作区」按钮或 tab 内「展开为完整页面」（都走 `openGlobalPage`）+ **面板 tab 紧凑视图**（`GlobalView`，+ 菜单可达；其卡片点击同样 attach 到虚拟会话，不碰当前 session）。内容用 **SideCard 设置同款「icon 卡片」栅格**（响应式 auto-fill 卡片：图标 chip + 标题 + 驻留徽标 + 点亮态 + 悬停 ✕，与 DSH 设置页的「icon 设置」UI 同步）。见 `src/client/official-sidebar.tsx` / `src/client/GlobalPage.tsx` / `src/client/GlobalView.tsx` / `src/client/global-page.ts` / `src/client/workspace-windows.ts` / `tests/global-page-session.spec.tsx` / `docs/plans/2026-08-20-left-sidebar-injection-design.md` / `docs/plans/2026-08-24-global-workspace-window-parking-design.md` |
| `diff` | -1 | 否（按 id 去重） | 是 | 差异查看（由 GitView 触发） |

你的 `id` 不可与上述重复，否则 `registerTab` 抛 `"tab type \"X\" already registered"`。

---

## 4. FileViewer 注册 API

### 4.1 `FileViewerDescriptor` 完整字段

```ts
interface FileViewerDescriptor {
  /** 唯一 id：'image' / 'pdf' / 'my-plugin:csv' */
  id: string
  /** 设置清单展示名（v0.4.1+，i18n 友好）；缺省回退到 id */
  title?: string | (() => string)
  /** 设置清单图标（v0.4.1+）：ReactNode 或 (size: number) => ReactNode */
  icon?: ReactNode | ((size: number) => ReactNode)
  /** 小写无点的扩展名数组：['png','jpg']。[] = catch-all（仅最低优先级有效） */
  exts: readonly string[]
  /** 优先级（高优先）；默认 0。内置默认 0；catch-all code 用 -100；binary-download 用 -50 */
  priority?: number
  /** 字节获取策略 */
  fetchStrategy: 'none' | 'fsRead' | 'mediaUrl' | 'custom' | 'binary-download'
  /** 内容嗅探（覆盖 exts）：head 字节可用时，第一个 detect 返回 true 的 viewer 命中 */
  detect?: (path: string, head: Uint8Array) => boolean
  /** fetchStrategy='custom' 时的加载函数；v0.12.0+ 第三参 signal 在 viewer
   *  卸载/重匹配时中止（忽略 signal 的 load 也照常工作） */
  load?: (path: string, scope: SessionScope, signal?: AbortSignal) => Promise<unknown>
  /** 声明式设置（v0.4.1+）：形状同 TabDescriptor.settings */
  settings?: { toggles?: readonly { key: string; title: string | (() => string); desc?: string | (() => string) }[] }
  /** 渲染函数 */
  component: (props: FileViewerProps) => ReactNode
}
```

### 4.2 `FileViewerProps`

```ts
interface FileViewerProps {
  ctx: Context
  store: SidebarStore
  scope: SessionScope
  path: string
  title: string
  viewerId: string         // 命中 viewer 的 id（如 'code' / 'my-plugin:csv'）
  content?: string        // fetchStrategy='fsRead' 时
  truncated?: boolean     // fetchStrategy='fsRead' 时
  mediaUrl?: string       // fetchStrategy='mediaUrl' 时
  customData?: unknown    // fetchStrategy='custom' 时（load() 的返回值）
  // 以下三个为内置文本编辑器与 EditorHost 的内部协作字段（合并模式把
  // 预览/编辑/保存工具栏上移到路径输入框行）；外部 viewer 忽略即可：
  toolbar?: 'self' | 'host'
  onToolbarState?: (state: EditorToolbarState) => void
  onToolbarControls?: (controls: EditorToolbarControls | null) => void
}
```

### 4.3 `fetchStrategy` 对照

| 策略 | 字节来源 | 传给 component 的字段 | 适用 |
|---|---|---|---|
| `none` | 不需要字节 | （无） | 自渲染（如纯 UI） |
| `fsRead` | `/sidebar/api` 的 `fs.read` | `content`, `truncated` | 文本类（CSV/JSON/XML） |
| `mediaUrl` | `/sidebar/file` 媒体路由 URL | `mediaUrl` | 图片/PDF（viewer 自己 fetch 字节） |
| `custom` | viewer 的 `load()` 函数 | `customData` | 自定义协议（如远程拉取） |
| `binary-download` | 不预览，显示下载按钮 | （无） | 无客户端渲染器的二进制格式 |

### 4.4 匹配算法

`matchFileViewer(path, head?)` **单趟**按 priority 降序（稳定排序，相同 priority 按注册顺序）遍历每个 descriptor：

1. 若 `head` 字节可用且该 descriptor 有 `detect` → 调 `detect(path, head)`，true 则命中；**miss 且是 catch-all（`exts: []`）则本轮放弃**（纯嗅探型不得盲认领）
2. 否则匹配 `exts`（小写无点；`exts: []` 且无 `detect` 是盲 catch-all，直接命中）

即：**priority 高的 descriptor 先获得裁决权**（其 detect 或 exts 任一命中即赢），低 priority 的 detect 不会越过高 priority 的 exts 匹配。`exts: []` + `detect` 的组合是"纯嗅探"：无 head 时不认领任何文件（不会吞掉图片/PDF 等真实 viewer 的文件），有 head 时只认领 detect 命中的。全部 miss 返回 `undefined`（编辑器显示下载按钮）。

> **head 字节从哪来**：第一次匹配（纯扩展名）没有 head。`fsRead` 策略读取后若文件为二进制，host 的 `fs.read` 响应会带 `head` 字段（base64，前 4KB），编辑器会用它对 `detect` viewer **重匹配一次**——所以 detect 型 viewer 的实际触发场景是"扩展名匹配落空/二进制文件"。文本文件的 detect 嗅探不在内置流程内（用 `exts` 或 `custom` 策略替代）。

> **内置 viewer**（不可重复注册，全部 6 个）：image(0) / pdf(0) / markdown(0, fsRead) / html(0, fsRead, 沙箱 iframe 预览) / code(-100, catch-all, fsRead) / binary-download(-50, exts doc/xls/ppt + NUL detect)。Office 三件套预览（.docx/.xlsx/.pptx）**不再内置**——已迁至推荐插件（设置页「添加插件」→ 文件预览弹窗里的 Office 预览插件），该插件以相同 id 经 `ctx.betterSidebar.registerFileViewer` 注册。
> code 是兜底 viewer：任何其他 viewer 未认领的文件都会落到 code（CodeMirror 文本编辑）；二进制文件经 head 重匹配被 binary-download 的 NUL detect 认领（下载按钮）。外部 viewer 注册同扩展名 + 更高 priority 即可覆盖。

### 4.5 注册示例

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

**覆盖内置 image viewer**（如想用自定义的 SVG 优化渲染）：
```ts
ctx.effect(() =>
  ctx.betterSidebar.registerFileViewer({
    id: 'my-plugin:svg-pro',
    exts: ['svg'],
    priority: 10,  // 高于内置 image 的 0
    fetchStrategy: 'mediaUrl',
    component: ({ mediaUrl }) => <OptimizedSvg src={mediaUrl} />,
  })
)
```

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

## 5. 服务方法完整清单

```ts
interface BetterSidebarService {
  /** 注册 tab 类型；返回 disposer */
  registerTab(descriptor: TabDescriptor): () => void
  /** 注册文件预览器；返回 disposer */
  registerFileViewer(descriptor: FileViewerDescriptor): () => void
  /** 当前已注册的 tab 描述符快照（同步，供 useSyncExternalStore 用；含被设置页禁用的类型） */
  getTabs(): readonly TabDescriptor[]
  /** 当前已注册的 file viewer 描述符快照（含被设置页禁用的 viewer） */
  getFileViewers(): readonly FileViewerDescriptor[]
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
   * 有 createTab 的 descriptor（terminal）会忽略 title/path/id。
   * url 可选：把**新建** tab 的 path 预填为 URL（侧边栏浏览器导航种子，
   * 通常配合 hostname title；对 createTab 铸造的 tab 同样生效）。聚焦既有
   * tab 时 url 不会覆写其 path。
   * 被设置禁用的类型是 no-op（console.warn 提示）。
   * scope（v0.12.0+）定向到指定 session：给出且非当前 session 时，打开落在
   * 该 session 的侧边栏状态里（没有则按 prefs 新建），不切换 UI 的激活 session；
   * 定向打开**不自动展开**目标 session 的面板（用户看不见，展开无意义）；
   * 缺省或指向当前 session 时行为与之前完全一致。注意：available 不拦截 openTab。
   * 内容型打开（带 path/url seed）必须落在视野内：承载落点 pane 的面板
   * 折叠时自动展开（右侧面板；落点 pane 在底部树则展开底部面板；窄视口
   * 展开合并抽屉）；类型型打开（+ 菜单、agent 终端自动补 tab）不展开。
   */
  openTab(seed: OpenTabSeed, scope?: SessionScope): void
  /** 关闭一个 tab（未知 id 严格 no-op，无状态搅动）；scope（v0.12.0+）
   *  随回调传递（含可选 cwd），缺省为 { sessionId: 当前 } */
  closeTab(tabId: string, scope?: SessionScope): void
  /** 订阅注册表变化（register/dispose 时触发） */
  subscribe(listener: () => void): () => void
  // ── v0.12.0+ ──────────────────────────────────────────────────────────
  /** 插件版本（如 '0.12.0'；与 package.json 同步，测试守护） */
  readonly version: string
  /** 单调能力清单（只增不删）：'badge' | 'tabLifecycle' | 'updateTab' |
   *  'openFile' | 'targetedOpen' | 'stateSubscription' | 'tabMeta' |
   *  'pluginSettings' | 'urlTarget' | 'settingSelect'——消费插件用 `features.includes('xxx')` 按能力 gate。 */
  readonly features: readonly string[]
  /** 当前快照：激活 sessionId + 其状态（面板几何/打开的 tabs/展开集）+ prefs。
   *  session 未激活时 state/sessionId 为 undefined。 */
  getSnapshot(): SidebarSnapshot
  /** 订阅快照变化（会话切换/状态变更/prefs 写入）；返回 disposer */
  subscribeState(listener: () => void): () => void
  /** 更新一个已打开 tab 的显示字段（title/path/meta）；tab 不存在时 no-op */
  updateTab(tabId: string, patch: { title?: string; path?: string; meta?: unknown }): void
  /** 激活一个已打开的 tab（tab 栏点击路径；触发 descriptor.onActivate；
   *  未知 id 严格 no-op）；scope（v0.12.0+）随回调传递，同 closeTab */
  activateTab(tabId: string, scope?: SessionScope): void
  /** 在 scope.sessionId 的侧边栏编辑器打开一个文件（title 缺省为文件名；
   *  id 按路径派生（`editor:` + path），与内置 open-path 拦截一致，不同文件
   *  可并排打开。注意：path 派生 id 只对 openFile/openSidebarFile 的打开成立——
   *  文件窗口的原地切换（editorExplorer 开）经 updateTab 重写 path/title，
   *  tab id 保持稳定、不再与 path 对应） */
  openFile(scope: SessionScope, path: string, title?: string): void
}

/** openTab 的 seed（v0.12.0 起导出命名类型） */
interface OpenTabSeed {
  type: string
  title?: string
  path?: string
  diff?: SidebarTab['diff']
  id?: string
  url?: string
  /** JSON 可序列化的自定义状态，随 tab 持久化（刷新后原样恢复）；
   *  updateTab/seed 传 undefined 表示「不改」，传 null 可显式清除 */
  meta?: unknown
}
```

> **声明式设置（v0.4.1+）**：每个注册的 tab/viewer 自动出现在 DSH 设置页「侧边卡片」分区的清单里——响应式网格中的**小卡片**（图标 + 标题 + 类型 id + **高亮 = 启用**，勾选徽标钉在卡片最右端，viewer 卡片还显示扩展名），开关持久化到 `SidebarPrefs.tabsEnabled / viewersEnabled`（开放 map，缺省 = 启用）。关闭语义：tab 从 `+` 菜单消失、`openTab` 拒绝新开、子代理自动展开 / agent 终端自动补 tab 等派生流程停止，**已打开的 tab 保留**；viewer 被 `matchFileViewer` 跳过，文件落到下一个匹配。`settings.toggles` 声明的相关设置（如子代理的 `autoOpenSubagent`、终端的 `terminalFontFamily`/`terminalFontSize`）通过卡片右下角的齿轮按钮在**原生弹窗**中编辑——`type: 'switch'` 行是复选框，`type: 'text'`/`'number'` 行是输入框（v0.11.0+），`type: 'select'` 行是下拉选择（options 带 icon 时为大图标选项卡，`multi: true` 多选存 value 数组）——父级卡片关闭时齿轮隐藏；`settings.toggles` 的 **key 必须是宿主 PrefsSchema 的字段**（内置键：`autoOpenSubagent` / `agentTerminalTools` / `terminalFontFamily` / `terminalFontSize` / `editorExplorer` / `sidebarLayout` / `htmlViewerNoSandbox` / `htmlViewerDefaultUnsafe` / `browserNoSandbox` / `browserInterceptLinks` / `browserInterceptHttp` / `browserInterceptHttps`）。**v0.12.0 起设置 seam 已开放**：外部插件用 `settings.pluginToggles`（同款行控件，key 插件局部）或 `settings.render`（自定义面板）声明自己的设置，值持久化在 prefs 文档的 `pluginSettings[<descriptor id>]`（开放 map，宿主 schema 已有字段，无需注册）——齿轮弹窗对 tab 与 viewer 都可用（viewer 卡片 v0.12.0 起也有齿轮）。

### 5.1 快捷键注册 API（v0.14.0+，`features.includes('keybindings')` gate）

插件的第三个扩展点：`ctx.betterSidebar.registerKeybinding(descriptor)` 向侧边栏的**共享快捷键分发器**注入一条快捷键。内置快捷键（面板开关 / 快速打开 / 搜索聚焦 / 标签切换）与插件注册走**同一个** document-capture 分发器——一条匹配即**完全消费**（preventDefault + stopPropagation），快捷键属于侧边栏，不落到编辑器 / 终端 / 输入框。

```ts
interface KeybindingDescriptor {
  /** 唯一 id（重复注册抛错，建议包前缀：'my-plugin:open-notes'） */
  id: string
  /** 展示名（i18n 友好：字符串或 () => string） */
  title: string | (() => string)
  /** 一个键位字符串或别名数组：'Cmd+P' / ['Cmd+P', 'Ctrl+Alt+P'] */
  key: string | readonly string[]
  /** 上下文谓词（返回 false 则该键位放行给下一个匹配或页面） */
  when?: (context: SidebarKeybindingContext) => boolean
  /** 同键位多绑定时的仲裁：高者先执行；默认 0 */
  priority?: number
  /** 允许按住连发（滚动类键位用）；默认 false（连按只触发一次） */
  allowRepeat?: boolean
  /** 动作：返回 false 显式放行给下一个匹配绑定（罕见）；缺省即消费 */
  run: (event: KeybindingEventLike, context: SidebarKeybindingContext) => boolean | void
}
```

**键位语法**（`+` 连接的 token，顺序无关，大小写不敏感）：修饰符 `Cmd`（= `Command`/`Meta`/`⌘`/`Super`，匹配**平台主修饰键**——macOS 的 ⌘ 或其它平台的 Ctrl，二者皆可）、`Ctrl`（**字面**物理 Ctrl，meta 必须不存在）、`Alt`（= `Opt`/`Option`/`⌥`）、`Shift`；键部分支持字母（`p`）、数字（`1`）、功能键（`F5`）、方向键（`ArrowUp` 等）、命名键（`Space`/`Tab`/`Enter`/`Escape`/`Backspace`/`Delete`/`Home`/`End`/`PageUp`/`PageDown`/`Insert`）、标点键（`/` `.` `,` `;` `'` `` ` `` `-` `=` `[` `]` `\`）或**显式 `KeyboardEvent.code`**（`KeyP`/`Digit1`/`Numpad4`）。带 Shift 的符号（`+`）写作带移位和弦（`Shift+Equal`）。匹配是**物理键**（`event.code`），与面板快捷键一致——US 布局的 Option+B 键值为「∫」、非拉丁布局整体重映射键值，`code` 永远不变。

**全局守卫**（所有绑定自动继承）：IME 组合中（复用 `isImeComposition`，候选窗的箭头/确认/取消属于输入法）、Windows AltGr 和弦（AltGr 报 ctrl+alt，不得命中 `Ctrl+Alt` 绑定）、自动连按（除非 `allowRepeat`）。`when` 上下文在每次按键时现算：

```ts
interface SidebarKeybindingContext {
  state: SidebarState | null          // 当前会话状态（无会话为 null）
  narrow: boolean                     // 窄视口（底部面板不存在）
  focusInSidebar: boolean             // 焦点是否在侧边栏宿主内
  textEditing: boolean                // 是否在侧边栏外的可编辑字段中输入
  plusMenuOpen: boolean               // 某个窗格的 + 菜单是否打开
  searchActive: boolean               // 文件搜索框是否激活（有查询或聚焦）
  activeTab: SidebarTab | null        // 当前窗格的活动 tab
  activeTabType: string               // 其 type（'' = 无）
  activePaneTabs: readonly SidebarTab[] // 当前窗格全部 tab（条带顺序，供切换/跳转）
}
```

**内置快捷键**（全部经 `registerKeybinding` 注册，同一条 API）：

| key | 作用 | when 门 |
|---|---|---|
| `Cmd+B` | 切换宿主左侧栏 | 恒真 |
| `Cmd+Alt+B` | 切换右侧栏 | 恒真 |
| `Cmd+J` | 切换底部面板 | `!narrow` |
| `Cmd+Shift+J` | 最大化/还原底部面板 | `!narrow` |
| `Cmd+P` | 快速打开：展开面板 → 保证文件窗口 → 聚焦其搜索框 | `!textEditing && !plusMenuOpen` |
| `Cmd+Shift+E` | 显示/收起资源管理器（vscode 布局开关 Side Bar 抽屉，面板关闭时视为隐藏、按此键先开面板；**IDE 全屏（⌘⌥⇧B）下同样开关钉在左缘的树列抽屉**；docked 布局：活动 tab 是**带 path 的文件 tab** 时切换其自身 docked 树（`meta.treeOpen`，编辑器头部文件夹按钮的键盘等价，宽度伸缩动画），**无路径的 files home 窗口**正被查看时二次按下关闭它——Activity Bar 图标同款开关语义） | `!plusMenuOpen` |
| `Cmd+Shift+G` | 打开源代码管理（Git 面板，single 去重） | `!plusMenuOpen` |
| `Cmd+Alt+Shift+B` | 进入/退出 IDE 模式（右侧面板占满全屏：宽 100vw、z-index 1000 盖住应用壳、释放布局挤压——类 VSCode 独立窗口；进入自动开面板并把**资源管理器钉在左缘**（无视 `sideBarSide` pref，顺带默认展开 explorer 抽屉）、**底部面板重新停靠到文件 tabs 区域下方**（z-index 1001，左缘对齐活动栏+文件树列），退出恢复停靠宽度；右上角 ✕ 或同键退出） | `!plusMenuOpen` |
| `Cmd+F` | 聚焦文件搜索框 | 活动 tab 是文件窗口，且 `!textEditing && !plusMenuOpen` |
| `Cmd+Tab` / `Cmd+Shift+Tab` | 当前窗格下/上一个 tab | `focusInSidebar && !plusMenuOpen` |
| `Cmd+1…Cmd+9` | 跳到当前窗格第 n 个 tab | `focusInSidebar && !plusMenuOpen` |
| `Cmd+W` | 关闭当前活动 tab | `focusInSidebar && !plusMenuOpen` |

> 标注 `focusInSidebar` 的键位在面板内交互时才生效（⌘B 打开面板后焦点尚在会话区，需点击面板内再按）——**有意为之**：避免在会话编辑区吞掉 Ctrl+Tab / Ctrl+W 等宿主键；`Cmd+P` / `Cmd+F` 在侧边栏外输入（composer / 终端 / 编辑框）时同样放行给页面。插件绑定若要避开 + 菜单打开状态，`when` 里判 `!context.plusMenuOpen`。

**键盘优先的界面**（同版随附，插件可直接复用这套心智模型）：

- **文件搜索框**：↑↓ 移动高亮（环绕）、Enter 打开、Esc 清除查询（空查询失焦）；高亮行 `css.editorSearchResultActive` 按压样式 + 底部导航提示行。
- **+ 菜单**：打开后 `1-9` 按位置选择（禁用项自动顺延）、字母键按选项选择（字母键取自**稳定 id**——`terminal`→T、`git`→G——与标签语言无关，中文标签同样生效；同字母连按循环到下一个匹配）、↑↓ / Home / End 移动高亮、Enter 确认、Esc 关闭。菜单本体保持 primitives `Menu` 的原始观感，**每行名称右侧注入一个「数字/字母」合并 chip**（如 `4/T`；label 包一层 flex：父行拉伸时 space-between 推到行右缘），底部另有提示行（`t('menuKeyboardHint')`）。
- 组件用 `keybindings.ts` 导出的模块级标记发布瞬态状态（`setPlusMenuOpen` / `setSearchActive` / `setSearchInputElement`），分发器的 context 构建器读取——**插件组件不要**直接读写这些标记，那是内置组件与运行时之间的通道。

---

## 6. 生命周期与 HMR

- **disposer 必须返回**：`registerTab` / `registerFileViewer` 返回 `() => void`，Cordis fiber 卸载时自动调用。**务必**用 `ctx.effect(() => register(...))` 包裹，否则 fiber 卸载（HMR / 插件禁用）时不会撤销注册，导致下次激活时 `"already registered"` 错误。
- **注册时机**：better-sidebar 在 `apply()` 开头 `ctx.provide('betterSidebar', service)`，所以你的插件 `inject = ['betterSidebar']` 时，better-sidebar 已经就绪。
- **顺序无关**：Cordis 的 `inject` 保证服务就绪后才激活你的插件；你的插件可在 `apply` 内任意时刻注册。
- **持久化降级**：localStorage 里持久化的 tab 若其 type 未注册（你的插件未加载），渲染为 `<OrphanedTab/>` 占位卡（显示 "插件未加载" + 关闭按钮）；你的插件加载后下次渲染自动恢复。

---

## 7. 平台约束与陷阱

| 陷阱 | 说明 |
|---|---|
| **构建纯度门** | client bundle 禁止 value-import `@dsh-external/*` 或非白名单的 `@deepseek-ai/*`；类型 `import type {}` 会被擦除，不触发门禁 |
| **双 cordis 实例** | 外部插件解析不到 DSH monorepo 的 cordis augmentation；better-sidebar 自己重述了 `interface Context { betterSidebar: ... }`，你 `import type {}` 即拿到类型 |
| **ModuleLoader 不跨插件** | 运行时 `require()` 虽支持跨 bundle，但被构建门挡；所有交互走 `ctx.betterSidebar` 方法调用 |
| **host 半无此服务** | `ctx.betterSidebar` 只在 client 侧存在；host 半需要 better-sidebar 数据走 `/sidebar/api/*` HTTP 路由 |
| **portal 限制** | 整面板 slot 由 ui-layout 独占，外部 tab 只能进入 better-sidebar 的 portal 内部，无法全屏替换 |
| **id 冲突** | `registerTab` / `registerFileViewer` 对重复 id 抛错；建议用包前缀（`my-plugin:xxx`） |
| **家族右面板互斥（v0.13.0+）** | 读取 `aionui-panel` 设置命名空间的 `rightPanel`：解析为 `'aionui-panel'` 时整个侧边栏不挂载（`settings.get` 路由返回 `externalDisable: true`，客户端挂载门 + 各类接管一并停用；`settings/document-updated` 推送实时生效，无 `remote` 服务的部署回退为启动时判定）。未安装 aionui 或提供方为其他值时不受影响 |
| **i18n 跟随** | 侧边栏界面文案跟随 DSH 的 `ctx.locale`（`@deepseek-ai/dsh-client-locale`）：词典注册在 `betterSidebar` 命名空间，语言偏好（Host-backed `locale.preference`）与浏览器语言不一致时以 DSH 为准并实时切换；locale 服务缺失时回退浏览器语言。插件自身的 `t()`（`src/client/locales.ts`）由 `apply()` 挂接服务；消费插件**不要**依赖此内部函数——标题等字段传字符串或 `() => string` 即可（i18n 友好）。⚠️ 渲染 DSH 的 `MarkdownText` 时必须传 `codeLabels={{ copyLabel: t('copy'), copiedLabel: t('copied') }}`——该组件 cordis-free，漏传则代码块复制按钮回退硬编码中文 |
| **懒加载 chunk** | 内置重依赖（xterm/CodeMirror）在独立 bundle（`lib/client-<name>.js`）中，经 `/sidebar/bundle` 路由按需下发；每个脚本把 factory 赋到插件自有全局注册表 `globalThis.__dshChunks__[<name>]`，由 `src/client/chunk-loader.ts` 用自定义 require（externals 经 `__DSH_MODULES__` seed 分支解析）物化——**不经过** `__ModuleLoader__` 注册；**核心 bundle 禁止静态 import `src/client/chunks/*`**（会把库拖回启动路径）；对消费插件透明——懒加载只作用于内置 descriptor，`component` 契约（`(props) => ReactNode` 纯渲染函数）不变 |

---

## 8. 皮肤兼容（令牌驱动）

> 侧边栏的皮肤兼容是**令牌驱动**的：所有视觉值都消费 DSH 的 `--dsw-alias-*` / `--dsw-font-*` / `--ds-*` 令牌（无硬编码颜色），皮肤系统覆盖什么令牌我们就跟随什么——**不做任何每皮肤适配**。当前已与 dsh-web-ui 皮肤中心兼容：其 10 款皮肤全部覆盖 `--dsw-alias-*` 层，换肤后面板自动跟随（测试：`tests/e2e/mount.e2e.ts` 断言布局变量随面板挂载生效；`tests/theme.spec.ts` 守护令牌读取）。

### 8.1 规则

- **面板表面**：右/底面板背景 = `var(--dsw-alias-bg-layer-1)`（通用卡片表面）。**绝不消费 `--dsw-specific-sidebar-fill`**——那是宿主左侧导航列专属令牌，皮肤系统按左导航语义覆盖它（dsh-web-ui 皮肤把它做成半透明玻璃或主题色，Aqua 设成 `transparent`），面板消费它会失去填充或与标签令牌冲突。皮肤要整体换面板表面：覆写 `--dsw-alias-bg-layer-1` 即可（dsh-web-ui 10 款皮肤都已覆盖，无需任何额外工作）。
- **终端/编辑器表面**：经 `effectiveTokenValue` 读取 `--dsw-alias-bg-base`——`transparent` 与 alpha < 0.9 的半透明玻璃值（dsh-web-ui 皮肤用 rgba 0.16–0.7）一律回退不透明底色，文字永不叠在皮肤背景画上滚动（issue #90）；≥ 0.9 的近不透明值（如皮肤作用域内 0.96 的瓷器玻璃）放行，皮肤仍能控制终端表面。
- **根锚点**：宿主 div 带 `data-dsh-better-sidebar` 属性（append 到 `document.body`），面板是其 fixed 直接子级。皮肤若要做作用域覆盖（deep-whale 的做法），限定在 `[data-dsh-better-sidebar]` 内即可，避免全局改写影响宿主。
- **布局变量**（写在 `<html>` 上，面板打开时有效）：`--dsh-sidebar-width` / `--dsh-sidebar-height`（面板几何；拖拽期间逐帧更新）。
- **z-index**：面板 40、折叠按钮簇 45（角手柄在面板内层叠，z-index 2 仅面板内有效）——全部低于 DSH 浮层栈（100/1000+），任何浮层天然盖住侧边栏。**IDE 全屏（⌘⌥⇧B，`rightMaximized`）**：面板升到 **1000** 盖住应用壳与上述层级（布局挤压释放），底部面板在 IDE 模式下重新停靠到文件 tabs 区域下方、升到 **1001**（仍在浮层栈之下）；两者都低于 primitives 的浮层栈（Menu/Tooltip/Modal 实际为 9999），所以菜单/弹窗/审批提示永远浮在 IDE 全屏之上。

### 8.2 注意事项

- 类名是 CSS Modules 哈希（`[hash]_[local]`），**不是契约**——皮肤不要依赖类名寻址；需要精确命中单表面时，用 `[data-dsh-better-sidebar]` 属性选择器配合子串类名（如 `[class*='panel']`）或 DOM 结构。
- 改动本契约（面板表面令牌、透明度阈值、z-index 层级）必须同步更新本文档、设计文档与 `tests/theme.spec.ts`。

---

## 9. 完整最小示例

> 假设插件 `my-plugin` 要加一个"Database 浏览器" tab + `.csv` 文件预览器。

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
    "cordis": "^4.0.0-rc.7",
    "dsh-better-sidebar": "workspace:*",
    "@deepseek-ai/dsh-client-runtime": "^0.0.1",
    "react": "^18.2.0"
  },
  "peerDependenciesMeta": {
    "dsh-better-sidebar": { "optional": true }
  }
}
```

**`my-plugin/src/client/index.tsx`**：
```tsx
import { createElement } from 'react'
import type {} from 'dsh-better-sidebar'  // 触发 ctx.betterSidebar 类型合并
import type { Context } from 'cordis'

export const inject = ['betterSidebar']

export function apply(ctx: Context): void {
  // Database tab
  ctx.effect(() =>
    ctx.betterSidebar.registerTab({
      id: 'my-plugin:db',
      title: () => 'Database',
      order: 50,
      dedupeKey: () => 'my-plugin:db',
      component: ({ scope }) => createElement(DbView, { sessionId: scope.sessionId }),
    })
  )

  // CSV viewer
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

**注册到 profile**：在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 加 `"my-plugin": "link:<你的插件路径>"`，在 `cordis.patch.yml` 加挂载行，`pnpm install`，浏览器硬刷新即可（DSH 对 client 改动热加载，无需重启 `dsh web`；仅 host 半改动需要重启）。

---

## 10. 参考实现

better-sidebar 自己的内置 tab 和 viewer 就是参考实现（"吃狗粮"）：

- **`src/client/builtins/`**：6 个内置 tab（editor/git/subagent/terminal/browser/diff）+ 6 个内置 viewer（image/pdf/markdown/html/code/binary-download）的注册代码（tabs.tsx / viewers.tsx / index.ts；Office 预览已迁至推荐插件，见 plugins-viewers.ts）
- **`src/client/service.ts`**：`BetterSidebarService` 接口 + `createBetterSidebarService` 工厂实现
- **`src/client/SideCardSection.tsx`**：声明式设置页（注册表驱动清单 + `settings.toggles` 嵌套设置行：switch/text/number + 持久化）
- **`tests/service.spec.ts`**：注册表生命周期 / 匹配算法 / dedupe / createTab / 启用态 gating 测试
- **`tests/builtins.spec.ts`**：内置注册清单断言（7 tab + 6 viewer + 声明式元数据）
- **`src/client/plugins-tabs.ts`** / **`src/client/plugins-viewers.ts`**：推荐插件目录（名字/url/简介/安装脚本，分别对应 Tab 注册与文件预览注册），在设置页两个「添加插件」弹窗展示（共享类型在 `plugins-shared.ts`）；插件作者可按扩展点加一条数据（弹窗内「跳转」直达仓库、「复制」把安装命令写入剪贴板，粘贴到 DSH 所在环境的终端执行）——数据完整性由 `tests/plugin-list.spec.ts` 守护
- **`src/client/official-sidebar.tsx`** / **`src/client/GlobalView.tsx`** / **`src/client/GlobalPage.tsx`** / **`src/client/global-page.ts`**：**注入 DSH 官方左侧栏 + 原地接管主区域**的实现——①脚注按钮：经 `ctx.slots.inject('sidebar.footer.action', …)` 挂进官方 `ui-sidebar` 的加法式脚注槽（`list` 槽，每项只收 `{ wide }`；不替换官方导航列、不改 DSH 源码、HMR-safe）；②完整页面（「全局工作区」）：点击经模块级控制器（`global-page.ts`）触发（`ctx.sessions.clear()`——页面是无会话表面），插件壳 `Sidebar` 在页面打开时**动态注册进官方 `conversation` 槽（priority -1）**——ui-slots shadowing「最低 priority 渲染」顶掉 `ui-conversation`（默认 0），**chat box 的主区域本身变成全局工作区页**（非浮层/非全屏；`GlobalPage` 经 `useSyncExternalStore` 订阅 windows store 与**虚拟 `global-workspace` 会话状态**（`SidebarStore.getStateOf/subscribeOf`）实时刷新；Esc / 打开会话关闭；dispose 后聊天恢复、会话状态在 store 不受影响）；`global` tab（`GlobalView`）是面板内紧凑视图 + 「展开为完整页面」入口。**全局工作区是一个特殊 session，全局共享窗口的生命周期驻留在此**：卡片点击 = `attachGlobal`（把窗口带入**全局工作区自己的底部工作区**——虚拟会话 `bottomSplits`，复用 Workbench + 导出的 `LazyTerminal` 渲染，页面不关闭、不碰任何真实 session），卡片 ✕ = `unbindGlobal(false)`（全实例取消共享 + 释放 PTY）；底部工作区 attached `gb:` stub 的 ✕ 只 detach 回卡片列表。页面内容用 **SideCard 设置同款「icon 卡片」栅格**（与 DSH 设置页 UI 同步）。设计见 `docs/plans/2026-08-20-left-sidebar-injection-design.md` / `docs/plans/2026-08-24-global-workspace-window-parking-design.md`，测试 `tests/official-sidebar.spec.tsx`
- **`src/client/FileTree.tsx`** / **`src/client/TreePanel.tsx`** / **`src/fs-search.ts`**：受控文件树组件（纯树体，文件行右键菜单含「在新 Tab 中打开」「在侧边打开」，仅宿主编排提供回调时渲染）/ 树面板（搜索框 + 刷新 + FileTree，文件窗口的内嵌 dock 使用）与 host 侧递归文件名搜索（`fs.search` 路由，预算兜底 + 跳过 `.git`/symlink 目录；测试 `tests/fs-search.spec.ts`、组件测试 `tests/editor-host.spec.tsx`）
- **`src/client/keybindings.ts`** / **`src/client/builtins/keybindings.ts`** / **`src/client/search-keys.ts`** / **`src/client/menu-keys.ts`**：快捷键系统的运行时（spec 解析 / 纯匹配 / 优先级仲裁 / 全局守卫 / 瞬态 UI 标记）与内置绑定（面板开关 / 快速打开 / 搜索聚焦 / 标签切换）和键盘优先的搜索 / + 菜单决策（测试 `tests/keybindings.spec.ts` / `tests/search-keys.spec.ts` / `tests/menu-keys.spec.ts`；`src/client/hotkeys.ts` 保留纯 matcher 并把注册迁到运行时）
- **`docs/plans/2026-08-11-service-registry-design.md`** / **`docs/plans/2026-08-11-declarative-sidebar-settings-design.md`** / **`docs/plans/2026-08-14-add-plugins-modal-design.md`** / **`docs/plans/2026-08-19-keybindings-design.md`**：设计文档（含实施偏差记录）
- **`src/client/git-graph.ts`** / **`src/client/GitGraph.tsx`**：Git 面板历史提交图（lane 图）的纯布局算法（`computeGraphRows`：lane 分配 / 菱形汇入弧 / 分叉弧 / 列回收，输入 host 的 `git.log-graph` 拓扑序数据）与逐行 SVG 渲染（视觉移植自仓库本地参考目录 `docs/prototypes/gitgraph-lines` 的原型 demo，未纳入版本库；lane 色走 `--gg-lane-N` 自定义属性，默认映射 DSH 语义令牌）；host 数据链在 `src/git.ts`（`graphLog`/`parseGraphLines`）、`src/index.ts`（`git.log-graph` 路由）、`src/client/api.ts`（`gitLogGraph`/`GitGraphEntry`）；测试 `tests/git-graph.spec.ts`、`tests/git.spec.ts`
- **`docs/plans/2026-08-11-service-registry-design.md`** / **`docs/plans/2026-08-11-declarative-sidebar-settings-design.md`** / **`docs/plans/2026-08-14-add-plugins-modal-design.md`** / **`docs/plans/2026-08-19-git-graph-lanes-design.md`**：设计文档（含实施偏差记录）

调试时直接读这些文件即可看到所有 API 的真实用法。
