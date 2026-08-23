# 全局共享终端设计（所有项目同步）

> 目标版本：随 workspace-bound windows（v0.13.x）之后的下一个功能
> 关联：AGENTS.md §1、`src/client/workspace-windows.ts`、`src/client/state.ts`、`src/client/Sidebar.tsx`、`src/pty-manager.ts`、`src/index.ts`

## 1. 动机

当前终端有三档可见性：

| 档位 | tab id / 键 | PTY 共享范围 | 说明 |
|---|---|---|---|
| 会话终端 | `terminal:<uuid>`，键 `sessionId:tabId` | 仅该会话 | 用户从 + 菜单新建 |
| agent 终端 | `agent:<uuid>` | 仅该会话（agent 拥有生命周期） | 模型用 `terminal_create` 创建 |
| 工作区绑定终端 | `ws:<wsId8>:<n>`，键 `shared:<tabId>` | **同一 workpace 的会话** | 右键「绑定到工作区」，共享同一 PTY |

用户需求：**在某些情况下，某些终端需要所有项目都同步** —— 即有一个终端，它的内容（同一个 PTY 进程、同一块 shell）要在**所有会话/所有项目**里都可见，而不限于某一个 workspace。

关键区分：workspace 是「一组会话的集合」（分组）；这里需要的是「**实例级全局共享**」——不依附任何 workspace，跨所有 workspace/独立会话。

## 2. 设计目标

- **按需开启，不改变默认行为**：只有被用户显式标记为「全局共享」的终端才同步到所有项目，其余终端维持现状。
- **复用现有共享-PTY 机制**：`shared:` 键 + `ws:` stub 渲染 + 每个会话各自 attach 同一个进程的模式，工作量最小、心智模型一致。
- **同一个终端视图，所有会话里都是同一块 shell**：滚动、命令标题、输入行、transcript 天然共享（已在 PTY 层实现，无需复制状态）。

## 3. 设计

### 3.1 共享键：从「workspace」推广到「instance」

`src/pty-manager.ts` 的关键判断（host 半）：

```ts
export function isSharedTabId(tabId: string): boolean {
  return tabId.startsWith('ws:')
}
export function ptyKeyOf(sessionId: string, tabId: string): string {
  return isSharedTabId(tabId) ? `shared:${tabId}` : `${sessionId}:${tabId}`
}
```

全局共享终端引入一个新的保留前缀 `gb:`（global），`isSharedTabId` 扩为同时识别 `ws:` 与 `gb:`，从而键为 `shared:gb:<id>` —— 与 workspace 共享同级、但 id 空间独立、不依附任何 workspace。

```
global tab id:  gb:<uuid>          (客户端)
pty key:        shared:gb:<uuid>   (host；跨所有会话唯一)
```

这样 host 的 `open`（首个连接的 cwd 生效、`shared` 配额豁免、cwd 不重播）、`reparent`、`scheduleClose` 全部免费复用——共享终端已是 first-class。

### 3.2 客户端：把「全局共享」缝进右键菜单

现有 tab 右键菜单（`Sidebar.tsx` 的 `openTabMenu` / 菜单渲染，v0.13.x）只有 workspace 的 bind/unbind。设计上让菜单**按终端类型分档**：

- **普通内容 tab（终端/文件/浏览器/…）**：
  - 「绑定到工作区」（现有，`IconProjectAddOutline16`）
  - **新增：「全局共享」（仅对 `terminal` 类型 tab 显示；绑定后原会话失去该 tab，转成 `gb:` stub，所有会话显示同一个实况实例）**
- **workspace 绑定 stub（`ws:`）**：「从工作区解绑」
- **全局共享 stub（`gb:`）**：「取消全局共享」（在每个会话里都解绑/关闭）

> 约束沿用 workspace 的：**agent 终端（`agent:`）不可共享**（模型创建/关闭，reconcile 会打架），见 `workspace-windows.ts` 的说明。全局共享同理只允许 UI 终端。

### 3.3 持久化与渲染

workspace 绑定窗口存每个 workspace 一个 blob（`localStorage: dsh-sidebar:v1:ws-windows:<wsId>`）。全局共享窗口用**一个实例级 blob**（`dsh-sidebar:v1:global-windows`），内容同构：

```ts
interface GlobalWindowsBlob {
  version: 1
  nextId: number
  tabs: WorkspaceWindow[]   // 复用同形状：{ id:'gb:…', type:'terminal', title, area, … }
}
```

- 渲染：`state.ts` 的 reconcile 把全局 stub 合并进**每个**已缓存会话的 ↑叶（第一个叶子），与 workspace stub 一样的 `stub` 渲染（pinned 分隔条之后）；`resolveTab` 从全局 store 解析实况定义。
- 绑定/解绑/更新：实现在一个 `GlobalWindowsStore`（或把 `WorkspaceWindowsStore` 泛化为「按 key 分 blob」），跨会话即时重渲染——绑定发生在哪个会话都行，所有会话看到同一个 stub。
- 与 workspace 的关系：全局 stub **不属于任何 workspace**，因此在无 workspace 的会话里也存在（这正是「所有项目」的含义）。`isBoundTabId` 在客户端按前缀 `ws:`/`gb:` 均判定 stub。

### 3.4 host 半：与 workspace 绑定的差异

- `api.ptyReparent` 已通用（`sessionId:tab` ⇄ `shared:<id>`），把 `gb:` stub 纳入 `isSharedTabId` 后，reparent/attach/close 全部复用。
- host 需要把 `ws:`/`gb:` 视为 shared 的地方集中在 `pty-manager.ts` 的 `isSharedTabId` 一处，不加分支污染。
- host 的 `/sidebar/ws/terminal` 连接参数：目前 stub 连接走 `?tab=<stubId>`（无 sessionId 前缀的 shared 键）。全局 stub 同样 `?tab=gb:...`。

### 3.5 视角边界（可选增强，本期不做）

是否允许「全局共享的文件/browser」？文件窗口的实况 buffer（未保存草稿/光标）本来就不同步（见 workspace-windows.ts 注释）；全局共享**仅对终端**开放，避免把未同步的编辑器 buffer 造成「看似共享实则不同步」的误导。若未来需要，可作为独立二期。

## 4. 实施偏差与注意

- `isSharedTabId` 语义从「ws:」扩为「ws: 或 gb:」，会影响既有 pty 键；均为新前缀，无存量迁移。
- `state.ts` 的 `isBoundTabId`（客户端 stub 判定）与 host 的 `isSharedTabId` 需保持一致，两处都改。
- 右键菜单「全局共享」仅在 `terminal` 类型且非 `agent:` 时出现；其余类型不展示该项（避免编辑器 buffer 误导）。
- 测试：host 单测 `tests/pty-manager`（`isSharedTabId('gb:…')`、键、reparent）、客户端 reconcile（全局 stub 进入每个会话，`gb:` 前缀不被 strip）、e2e 挂载冒烟不受影响（默认不新增全局 stub）。

## 5. 与「右键菜单加图标」的关系

本次同时把 tab 右键菜单**从纯文本/单 pin 图标**升级为**逐项对应图标**的分档菜单（binding v.s. global-share v.s. unbind 各有专属 glyph），见同批 UI 改动：`Sidebar.tsx` 菜单 `items` 的 `icon` 字段。

---

## 6. 语义升级（2026-08-24）：生命周期驻留全局工作区

本文档的「所有项目同步」（`gb:` stub 自动合并进每个 session 的 tab 栏）已被**按需 attach** 模型取代，见
`docs/plans/2026-08-24-global-workspace-window-parking-design.md`：

- `bindGlobal` 后窗口**驻留全局工作区**（全局 blob 是唯一事实源），不再合并 stub 到任何 session；
- 会话经 `attachGlobal` 把窗口带到自己（`gb:` stub 落进该会话首个叶子，attach 同一个 `shared:gb:<n>` PTY）；attached stub 持久化在会话布局，reload 对照全局 blob 校验；
- attached stub 的 ✕ 只 detach 本会话（窗口与 PTY 存活）；「取消全局共享」才是全实例关闭（`unbindGlobal(false)` 附带显式释放从未 attach 的无头 PTY）；
- `pty-manager.ts` 的 `isSharedTabId` / `shared:gb:<n>` 键与「首连 cwd 生效 / 配额豁免」机制不变——共享-PTY 层完全复用。

右侧菜单项文案同步为「全局共享（转移到全局工作区）」。测试覆盖见 `tests/workspace-windows.spec.ts` 的 global describe（驻留 / attach / detach / 持久化校验 / 共存）。
