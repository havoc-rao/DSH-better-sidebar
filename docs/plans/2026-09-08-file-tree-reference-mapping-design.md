# 文件树 @-reference 的源映射设计（v0.21.0）

> 背景：dsh-remote 联动。`FileTree.tsx` 行操作的 @-reference pill（`onReferenceFile` → Sidebar 的 `referenceInChat` → `appendToDraft` 插入 `@<相对 cwd 路径>`）在数据源接管（fileTreeSource / fileTreeSection) 的行上不可用：
>
> 1. **死按钮**：v0.20 source-form 段落树（`SectionSourceTree`）把 `onReferenceFile` 硬接成 `() => {}`；
> 2. **死引用**：Provider 行携带**远端绝对路径**（如 `/home/dev/project/src/a.ts`），而会话 cwd 是**本地镜像**（`$DSH_HOME/remote-workspaces/<host>-<user>-<port>/<base>`）。`relativeTo(localCwd, remotePath)` 投影失败 → 原样插入远端绝对路径 → 宿主按 cwd 解析必然 ENOENT。
>
> dsh-remote 自己的 v0.19 渲染树没有此问题：其 pill 用 `localPath(p) = joinRemote(scope.cwd, relPath(p))`（镜像基 + 相对远端根的相对段）插入镜像路径。

## 设计

把「远端行路径 → 会话可读本地路径」的映射放进**数据源契约**——与 `list`/`open` 同构的同步方法：

```ts
interface FileTreeDataSource {
  list(dir: string): Promise<FileTreeListResult>
  search?(…): …
  open?(path: string): void
  /** v0.21.0：行路径 → @-reference 应插入的路径。必须同步、廉价。
   *  缺省 / 抛错 → 原样插入（逐字节保持本地行为）。 */
  reference?(path: string): string
}
```

**为什么是 provider 侧函数而不是 root 数据（如 `localBase`）**：本 seam 的既定哲学是「路径转换永远是 provider 的事」（文件头：no path conversion happens anywhere），函数形式与 `list`/`open` 同构；双向映射（镜像→远端为 list、远端→镜像为 reference）都封在 provider 闭包内；Windows 分隔符 / 大小写等语义由 provider 自行裁决。

## 宿主侧实现

**纯映射器**（`file-tree-source.ts`，可单测）：

```ts
referencablePathOf(path, { cwd, singleSource, roots }): string
```

- **multi-root（`roots` 非空）**：行在某个远端 root 下 → 该 root 的 `source.reference?.(path)`；本地子树（`cwd` 下）**永不映射**（本地 root 永不被接管，与 `rootAt` 同规则）；不在任何 root 下 → 原样。
- **单源（v0.17 接管 / v0.20 section 的 `sourceOverride`）**：一律过 `singleSource.source.reference?.(path)`——provider 自己区分其混合路径形态（镜像路径自然恒等）。

`FileTree.tsx` 在**三个 pill 调用点**（文件行 / 目录行 / 根行）统一 `onReferenceFile(refOf(path))`，`refOf` 的 mode 输入直接镜像组件自身的有效 mode（`fileSource` / `resolvedRoots` / `cwd`），与 `openFileRow` 的 source 归属解析完全同构。

**Section 树接线**：`TreePanel`（已有 `onReferenceFile = referenceInChat`）→ `ExplorerDual` → `SectionSourceTree` 新增可选 prop；缺省仍回落 `() => {}`（测试/直接消费者）。段落树与本地树从此共用同一个 composer draft handler。

调用方（`referenceInChat`）零改动：拿到的是镜像下的路径后，既有 `relativeTo(sessionCwd, …)` 自然产出 `@rel/path`。

## 消费侧（dsh-remote）配合

`makeRemoteTreeSource` 的 source 补 `reference(path)`（与 v0.19 pill 同一套数学）：

- `settledRoot`：source 闭包内把 `remoteRootOf(sessionId)` 的 settle 值镜像成**同步**可读变量（roots() 在树渲染前 settle，点击时通常已就绪；未就绪 → 返回原行路径，退化安全）。
- 命中：`joinRemote(mirrorBase, relPath)`；根行 → 镜像基；不在根下 → 原样。v0.17/0.18 provider 与 v0.20 section 共用同一工厂 → 一处实现全部受益。
- `package.json` 依赖 `dsh-better-sidebar` → `^0.21.0`（宿主发布配套）。

## 兼容性

双向、无需特性门控：

| 宿主 \ dsh-remote | 有 `reference()`（≥0.21） | 无（旧版） |
|---|---|---|
| ≥0.21 | 远端行 pill 插入镜像路径 ✓ | 段落树 pill 已接线但插入远端原路径（退化，不更坏于 v0.20 的死按钮） |
| <0.21 | `reference()` 永不被调用（恒等，逐字节旧行为） | 旧行为 |

## 附：插入后自动聚焦 composer（v0.21.0）

@-引用（及终端块、viewer 选择等插入流）成功写入 draft 后，**自动聚焦宿主 composer**——@-mention 手势：点击后用户的下一击键直接落在输入框，无需再点一下。

**实现**：纯插件侧只读 DOM 操作，**不需要动 deepseek-harness**：
- harness 的 InputBar（`packages/client/ui-conversation` 的 InputBar，源码指向 InputBar.js 根节点）卡片**恒挂** `data-composer-card`（textarea 恒有 `data-phase`）——这是官方组件留给外部扩展的稳定只读钩子；
- `appendToDraft`（`src/client/conversation-draft.ts`）成功后经 `requestAnimationFrame`（post-commit，受控 textarea 已持有新 draft）`focus()` + 光标置尾；
- conversation 服务只暴露 `state/setDraft`、无 focus 通道，因此去 harness 加 service 级 `focus()` 属于改 DSH 源码（仓库硬约束禁止），收益有限，不做；
- 守卫：composer 缺失 / disabled → 严格 no-op；display:none 由浏览器天然忽略；被遮挡的 composer 仍聚焦（击键落在 draft，正是用户所求）。

四个插入流（@-引用 pill、终端 "add to conversation" ×2、viewer 选择）共用 `appendToDraft`，一处生效。e2e 挂载冒烟在**真实 InputBar DOM** 上断言：点击 pill → `[data-composer-card] textarea` 获得焦点 + draft 含 `@<相对路径>`——选择器若与 harness 实际标记漂移，门禁即红。

## 测试

- `tests/file-tree-source.spec.ts`（纯函数）：local 恒等 / 单源映射 / 无 `reference` 恒等 / 抛错退化 / multi-root 远端行映射与根行映射 / 本地子树永不映射（含形似前缀的恶意 root）/ 无 root 命中恒等 / 反斜杠分隔符。
- `tests/file-tree-multiroot.spec.tsx`：遥控根行 pill 收到映射路径、本地行收到原路径。
- `tests/file-tree-section.spec.tsx`：source-form 段落树 pill **已接线**（非 no-op）且经 `reference()` 映射；本地树不受扰动。