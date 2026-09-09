# 终端数据源槽位（Terminal Source Slot）

**日期**：2026-09-09
**状态**：已实现（无实施偏差）
**目标版本**：v0.22.x

## 1. 目标

对照 FileTree 的 data-source 槽位（`registerFileTreeProvider`，v0.17+ / `file-tree-source.ts`），为侧边栏终端开放一个 **terminal source / provider 槽位**：外部插件（尤其是 dsh-remote）可以注册为一个**默认**的 term 数据源，接管**默认终端 tab**（`src/client/builtins/tabs.tsx` 铸造的 `terminal:<uuid>` tab，即 TerminalView 在 `hostRef` div 里渲染的 xterm）的**数据源与数据处理**；UI（xterm 渲染、block overlay、selection popup、info bar、banner 状态机、fit/theme/font、onTitleChange 路由）保持原样。

一句话契约：**默认终端 tab 在虚拟机挂载时，经注册表解析出连接层（transport）；有匹配 provider 时把它注入 TerminalView 既有的 `transport` prop，否则不传（保持走默认 `localTransport` = 本地 pty WS，行为与历史逐字节一致）。**

## 2. 背景（已核实，避免重做）

- TerminalView 已有可注入的 `transport` prop（`TerminalTransport` 契约，`src/client/terminal-transport.ts`；默认 `localTransport` 行为与历史 byte-for-byte 一致）。跨插件复用出口已存在：`src/client/index.tsx` 导出 transport 类型 / `localTransport` / `parseDownlinkFrame` / `loadTerminalView`。
- TerminalView 的生命周期分支（close / park / dispose / retry）已按 transport 契约定义（文件头注释），**本次不动协议**。
- TerminalView 在**挂载时一次性**读取 transport（`transportRef.current ?? localTransport`，主 effect 只跑一次/次挂载）。因此解析点只要保证「挂载那一刻的 transport 正确」；之后 provider 注册/注销只影响**之后挂载**的终端（已打开的终端保持挂载时的连接层，符合既有「Read ONCE at mount」契约，无需热切换）。
- dsh-remote 目前自建「远程终端」tab 类型，注入自己的 transport，端到端已通。缺的是：**默认终端 tab** 也能被默认接管。
- 参考范式 `file-tree-source.ts` 的关键规则：**注册顺序 first-match wins**；`match` / `createSource` 抛错跳过该 provider（console.error）；无人匹配 → `undefined` = 默认本地行为；注册表经 `service.subscribe` 通知，渲染侧 hook 订阅后 live 重解析。

## 3. 非目标（v1 边界）

- **不改 TerminalView / 不发明第二套 wire 协议**：provider 的产出必须是既有 `TerminalTransport`（或它的 factory），复用 resize/close/park/dispose/retry 全生命周期与 frame 语义。
- **不做已挂载终端的热切换**：transport 在挂载时读一次；provider 注册前后已打开的终端不切换（重挂载才生效）——这是 TerminalView 自己的契约，改动它属于另一桩事。
- **`gb:` 全局共享终端（GlobalPage / GlobalView / workspace-windows）不纳入解析**：它们是实例级共享 PTY（host 侧 `shared:<tabId>`），属于「全局工作区」面，与 session 的终端语义不同；保持 localTransport。pinned 虚拟终端（`pinned:<homeSessionId>:<tabId>`）经由内置 terminal descriptor 渲染、携带**home session scope**，自动纳入解析（home 是远程会话 → pinned 终端也走远程 transport，语义正确）。
- **不为 provider 新增设置项/UI**：与 FileTree 槽位一样，纯注册表 + 纯解析，无 Side card 开关、无指示器。
- **不让 TerminalView 感知 provider/注册表**：它只认 `transport` prop（零改动，现有 TerminalView 测试零被迫改动）。

## 4. 设计

### 4.1 公开 API

```ts
// src/client/terminal-source.ts（新模块，核心 bundle，零 xterm 依赖）
interface TerminalProviderDescriptor {
  /** 唯一 id（建议包前缀，如 'dsh-remote'）；重复注册抛错。 */
  id: string
  /** 会话/终端谓词：这个 provider 是否接管该终端 tab？first match wins。
   *  参数原样透传（无本地路径转换）：
   *  - sessionId：tab 所属会话（pinned 虚拟 tab 是 home 会话）；
   *  - cwd：会话工作目录（未知时 undefined）；
   *  - tabId：完整 tab id（'terminal:<uuid>'；agent 终端为 'agent:<uuid>'，
   *    provider 可用它决定是否接管模型拥有的终端——不接管就返回 false）。 */
  match(sessionId: string, cwd: string | undefined, tabId: string): boolean
  /** 连接层 factory：返回该 tab 挂载时注入 TerminalView 的 TerminalTransport。
   *  返回 undefined = 拒绝接管（下一个 provider 继续尝试）；抛错同样跳过
   *  该 provider。多次调用应返回稳定实例（复用内部连接由 transport 自理）。 */
  createTransport(sessionId: string, cwd: string | undefined, tabId: string): TerminalTransport | undefined
}

// 纯解析（无 React / 无注册表依赖，可单测）
function resolveTerminalSource(
  providers: readonly TerminalProviderDescriptor[],
  sessionId: string,
  cwd: string | undefined,
  tabId: string,
): TerminalTransport | undefined

// 渲染侧 hook（订阅注册表 + 会话变化时重解析；registry-less stub 优雅降级）
function useTerminalTransport(
  ctx: Context | undefined,
  sessionId: string,
  cwd: string | undefined,
  tabId: string,
): TerminalTransport | undefined
```

服务方法（`BetterSidebarService`，对照 `registerFileTreeProvider`）：

```ts
registerTerminalProvider(descriptor: TerminalProviderDescriptor): () => void
getTerminalProviders(): readonly TerminalProviderDescriptor[]
```

能力门：`features.includes('terminalSource')`。

### 4.2 解析规则（与 file-tree-source 逐条对齐）

1. 按**注册顺序**遍历 provider；第一个 `match(...) === true` 的 provider 胜出。
2. `match` 抛错 → console.error + **跳过**该 provider（下一个继续）。
3. `createTransport` 抛错 → console.error + **跳过**（下一个继续）。
4. `createTransport` 返回 `undefined` → 视为该 provider **拒绝**：下一个继续尝试（这是「match 拒绝」的另一半语义——想按 tab 粒度挑单的 provider 可以在 match 拒绝，也可以在 factory 里拒绝）。
5. 无人匹配 / 全部拒绝 / 注册表为空 → 返回 `undefined` → 调用方**不传 transport prop** → TerminalView 走默认 `localTransport`（本地 pty WS，行为与历史逐字节一致，回归安全）。
6. 纯函数、throwing-safe：provider 永远不能弄坏终端渲染。

### 4.3 默认 tab 的接入点

`src/client/builtins/tabs.tsx` 的 terminal descriptor `component`：

```tsx
// 现在的形态（约 363 行）：
component: ({ ctx, tab, scope, store, visible }) => (
  <LazyTerminal ctx={ctx} scope={scope} store={store} tabId={tab.id} visible={visible} onTitleChange={...} />
)

// 改为（薄包装组件，descriptor 的 component 本身仍是纯渲染函数——lazy-chunk.spec
// 钉死了「可直接以普通函数调用不抛错」的契约，hook 放在内层组件里）：
component: (props) => <TerminalTabTransport {...props} />

// TerminalTabTransport：useTerminalTransport(ctx, scope.sessionId, scope.cwd, tab.id)
// → transport={resolved}，其余 props 原样传递。
```

解析覆盖的所有「默认终端」形态（全部经由这个 descriptor 渲染，一处改造全量生效）：
- `+` 菜单 / 快捷键新建的普通终端 tab（`terminal:<uuid>`）；
- agent 终端自动补 tab（`agent:<uuid>`，provider 自己决定是否接管）；
- bottom-panel 自动终端（走同一 openTab 路径）；
- pinned 虚拟终端（Sidebar 以 **home 会话的 scope** 渲染，解析落到 home 会话——home 是远程会话则接管，语义正确）。

### 4.4 公开导出（供 dsh-remote 等外部插件使用）

- 运行时：`ctx.betterSidebar.registerTerminalProvider(...)` / `getTerminalProviders()`（服务方法，无需 import 任何内部路径）。
- 类型：从 `dsh-better-sidebar/client/service` 命名导入 `TerminalProviderDescriptor`（service.ts 会 re-export，与 `FileTreeProviderDescriptor` 同路径）；终端侧已有类型（`TerminalTransport` / `TerminalViewProps` 等）从 `dsh-better-sidebar` 主入口或 `./client/terminal` 子路径导入。
- `src/client/index.tsx` 追加导出 `resolveTerminalSource` / `useTerminalTransport` / `TerminalProviderDescriptor`（type），与既有 terminal 导出同区，供需要以编程方式解析（或复用 hook）的消费者使用。

## 5. 实现清单

| 文件 | 改动 |
| --- | --- |
| `src/client/terminal-source.ts` | 新增：descriptor 类型、`resolveTerminalSource`、`useTerminalTransport` |
| `src/client/service.ts` | 接口 + `terminalProviders` Map + `registerTerminalProvider` / `getTerminalProviders` + feature `'terminalSource'` + 类型 re-export |
| `src/client/builtins/tabs.tsx` | terminal descriptor `component` 经 `TerminalTabTransport` 包装解析 |
| `src/client/index.tsx` | 公开导出 resolver / hook / descriptor 类型 |
| `tests/terminal-source.spec.tsx` | 新增：纯解析规则 + 服务注册表 + descriptor 级集成（chunk Recorder 断言 transport 落到 LazyTerminal） |
| `tests/consumer-types.ts` | 扩展：外部插件视角的 `TerminalProviderDescriptor` 全字段类型演练 |
| `AGENTS.md` / `docs/external-plugin-guide.md` | 文档 |

## 6. 回归安全

- 无 provider / 无匹配 / 全部拒绝 → `transport` prop 为 `undefined` → TerminalView 挂载路径与现在完全一致（`transportRef.current ?? localTransport`，就是原来的代码分支）。
- TerminalView.tsx 零改动；terminal-transport.ts 零改动；terminal-view-loader.ts / chunks/terminal.tsx 零改动。
- 现有测试零被迫改动：descriptor 的 `component` 仍是纯渲染函数（hook 在内层包装组件），lazy-chunk.spec.tsx 的「普通函数调用不抛错」契约保持成立。

## 7. 给 dsh-remote 的对接速写

```ts
import type {} from 'dsh-better-sidebar'                       // 类型合并
import type { TerminalProviderDescriptor } from 'dsh-better-sidebar/client/service'
import type { TerminalTransport } from 'dsh-better-sidebar'    // 或 ./client/terminal

export const inject = ['betterSidebar']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.betterSidebar.registerTerminalProvider({
    id: 'dsh-remote',
    // 只接管 dsh-remote 拥有的会话；agent 终端暂不接管
    match: (sessionId, _cwd, tabId) => !tabId.startsWith('agent:')
      && isRemoteSession(sessionId),
    createTransport: (sessionId, cwd, tabId) => makeRemoteTransport(sessionId, cwd, tabId),
  }))
}
```