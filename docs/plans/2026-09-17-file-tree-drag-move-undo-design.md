# 文件树行拖拽移动/复制 + Cmd+Z 撤销设计（2026-09-17）

> 状态：已实现。本文档记录功能设计、关键取舍与已知限制。
> 用户决策：删除**保持永久**（不引入暂存/回收站机制），撤销只覆盖重命名/移动/复制；包含 **Option/Alt+拖动 = 复制**（VS Code 对齐）。

## 背景

文件树此前只有两套拖动语义：OS 文件拖入 = 上传（`isFileDrag` 只认 `dataTransfer.types` 里的 `Files`）；树内行之间的拖动**不存在**（行无 `draggable`，内部拖会被 `isFileDrag` 门闩放行成浏览器默认行为）。重命名/删除均即时落盘、不可逆；服务端只有 `fs.rename`（刻意设计为「单段改名，不是移动」）与 `fs.remove`（永久）。

本次补全 VS Code 资源管理器的两个核心能力：

1. **行拖拽移动/复制**：拖起树内行，落到目录行 = 移入该目录，落到文件行 = 移入其父目录（与上传的「文件行 = 父目录」语义一致；本树为固定排序（目录优先 + 名字），无 VS Code 的插入线排序，故不实现 before/after 落点），落到空白处 = 移入工作区根；**Option/Alt 按住拖动 = 复制**（macOS Option / Win+Linux Alt，与 VS Code 一致）。文件夹不可移入自身或子孙（客户端预检 + 服务端 real-path 双保险）。
2. **Cmd+Z / Cmd+Shift+Z（Ctrl+Z / Ctrl+Y）撤销/重做**：树内焦点（行或树体）时生效，覆盖重命名/移动/复制三类操作；输入框聚焦时不劫持（原生文本撤销优先，含行内重命名编辑器的文本撤销）；编辑器 tab 的 CodeMirror 撤销天然隔离（物理焦点不同）。**删除不撤销**（宿主无回收站，用户决策保持永久）。

## 服务端

`src/fs-operations.ts` 新增两个入口，与 `renameWorkspaceEntry` 同层同风格（link-aware、fence、Destination 存在 409、根拒绝）：

- `moveWorkspaceEntry({cwd, path, dir, fence})`：
  - `resolveEntry` 解析源行（fence 检查解析后的目标；symlink 行移动**链接本身**，不动目标——与 rename 的 link-aware 语义一致）。
  - 根拒绝（`real === realCwd`）。
  - 目的目录 `ensureWorkspaceWritePath(cwd, dir)`（fence 检查），必须**存在且为目录**（lstat），否则 fs-error。
  - **同父目录 = no-op**（`dirname(absolute) === destDir` → 直接成功返回，不 409，对齐 rename 的「同名 no-op 不触发 409」）。
  - **自身/子孙拒绝**：`isWithin(real, realDest)`（源与目的都用 realpath 解析后的路径比较，symlink 行也正确）→ `'cannot move an entry into itself'`。
  - 目标 = `join(destDir, basename(absolute))`；`ensureWorkspaceWritePath` + `pathExists` → 存在 409（POSIX rename 会静默覆盖，必须拒绝）。
  - `rename(absolute, safeDestination)`；返回规范新路径（tab 改址用）。
- `copyWorkspaceEntry({cwd, path, dir, fence})`：同一组校验（根拒绝、自身/子孙拒绝、fence、409），执行 `cp(absolute, safeDestination, { recursive: true, force: false, errorOnExist: true })`（node fs/promises；symlink 默认按链接复制不穿透）。同目录复制 = 目标已存在 → 409（本实现不做 VS Code 的自动 ` copy` 后缀，报错条如实展示原因）。

`src/index.ts` 新增路由 `'fs.move'`（`{path, dir}`）/ `'fs.copy'`（`{path, dir}`），走 `cwdOf` + `fenceEnabledOf(getSettings)`；`src/client/api.ts` 新增 `fsMove` / `fsCopy`。

## 客户端（FileTree）

### 行拖拽（move/copy）

- 行 div 加 `draggable`（文件行与目录行；**根行不可拖**——根是会话本身；重命名编辑器行无 draggable）。`onDragStart`：`dataTransfer.setData('application/x-dsh-tree-drag', path)`（自定义 MIME，与 OS 文件拖的 `Files` 互不干扰）、`effectAllowed = 'copyMove'`；`dragSource` ref 记录 `{path, isDir}`；拖起行加 `.explorerRowDragging`（令牌色淡化），`onDragEnd` 清空。
- 现有五处拖拽门闩从「仅 OS 文件拖」扩展为三态（OS 文件拖 → 上传原样；树内行拖 → 移动/复制）：
  - 上传蒙层（portal drop zone）只在 OS 文件拖时出现（现有 `dropOver`/`dropRect` 状态不变）。
  - `handleRowDragOver`：树内行拖时校验 `canDrop(source, dir)`：`source.path === dir`、目录拖入自身子孙（客户端 `isWithinWorkspace` 词法预检）、移动到同父目录（no-op）→ `dropEffect = 'none'` 且不高亮；否则 `dropEffect = altKey ? 'copy' : 'move'`、高亮 `.explorerRowDropTarget`（复用现有样式）。
  - `handleDirDrop(dir)` / `handleFileDrop(path)`（父目录）/ `handleBodyDrop`（根）：树内行拖 → `performDrag(source, targetDir, isCopy)`。
- `performDrag` 落定：
  - 移动：`api.fsMove` → `pruneTree(old)`（清旧侧缓存 + 收起旧路径下 expanded + 重载旧父层）→ 目标目录层若已缓存则 `retryDir(destDir)` → `onPathRenamed?.(old, new)`（tab 改址，见下节）→ 压撤销栈 `{kind:'move', from, to, isDir}`。
  - 复制：`api.fsCopy` → `pruneTree(new)`（重载新父层）→ 压撤销栈 `{kind:'copy', from, to}`（无 tab 动作）。
  - 失败一律进现有 `actionError` 错误条（服务端原文，show-the-truth 策略）。

### 撤销/重做（`src/client/undo.ts` 新模块）

- **每会话+cwd 级撤销栈**：模块级 `Map<'<sessionId>|<cwd>', TreeUndoStack>`（非 React state）——文件 tab 关闭、面板重开、会话切换后历史不丢；栈上限 `UNDO_LIMIT = 100`（溢出丢最旧）。
- 条目即**已执行的操作**：`{kind:'rename'|'move'|'copy', from, to, isDir?}`。`pushTreeOp` 入 undo 栈并**清空 redo 栈**（标准编辑语义：新操作后不可重做）；`undoTreeOp` 弹 undo 入 redo 返回条目（调用方执行逆操作）；`redoTreeOp` 反向。
- 逆操作：rename → `fsRename(to, baseName(from))`；move → `fsMove(to, dirname(from))`；copy → `fsRemove(to)`。重做 = 重放原操作（move/rename 的源已被第三方删除时服务端报错进错误条，可接受）。
- **键盘**：树体 `onKeyDown`（行焦点事件冒泡至此）+ 树体 `tabIndex={-1}`（空白点击可聚焦，VS Code 式「资源管理器聚焦」）；`(meta||ctrl) && key==='z'`（shift → 重做）/ `ctrl && key==='y'`（重做）；**`event.target` 是 input/textarea/contenteditable 时直接返回**（行内重命名输入框的 Cmd+Z = 原生文本撤销；搜索框同理）。处理时 `preventDefault`。
- 撤销/重做落定复用同一套 settle（`pruneTree` 双侧 + `onPathRenamed` 反向 + 对应栈转移），失败进错误条。
- 删除不录栈（用户决策）。

### tab 调解（tree-mutations.ts）

`retargetPathTabs(ctx, store, old, new)` 改为**整子树改址**（`path === old || isWithinWorkspace(old, path)`）：目录移动/撤销后，目录内已打开文件的 tab 路径跟随新前缀（否则下次保存打向旧路径）。顺带修掉 rename 目录时子文件 tab 不改址的既有缺口（同一函数同一参数，无新增面）。

## CSS

- `.explorerRowDragging`：拖起行淡化（令牌色 opacity，皮肤契约内）。
- 目标高亮复用 `.explorerRowDropTarget`；dropEffect 由浏览器绘制 move/copy 光标。

## i18n

零新增 key：文案全部复用现有「服务端原文错误条」策略与既有词条；撤销无可见控件（纯键盘），不需要标签。

## 测试

- `tests/fs-operations.spec.ts` 扩展：`moveWorkspaceEntry`（跨目录移动文件/目录（递归内容随行）、同父 no-op、目标存在 409、移入自身/子孙拒绝、根拒绝、缺源、目的非目录、fence 越界、symlink 行移链接不动目标）、`copyWorkspaceEntry`（文件/目录递归/链接按链接复制/源不受影响/409/根拒绝/自身子孙拒绝）。
- 新 `tests/file-tree-drag-undo.spec.tsx`（jsdom + mock api，沿用 rename-delete spec 的 harness 形态）：dragstart 自定义 MIME 载荷与 effectAllowed；落目录行/文件行/空白处分别的 fsMove 目标；altKey → fsCopy；无效目标（自身、目录入子孙、同父移动）不发请求；移动后 `onPathRenamed` 与 redo 栈行为；rename/move/copy 的 Cmd+Z 各自逆操作与重做；输入框聚焦不劫持；新操作清空 redo；栈上限；同一 session+cwd 跨组件实例共享历史（卸载重挂不丢）。
- 新 `tests/tree-undo.spec.ts`：栈纯逻辑（push/undo/redo/cap/清 redo）。
- `tests/tree-mutations.spec.tsx` 补充子树改址断言（目录下子文件 tab 跟随）。

## 已知限制

- **删除不可撤销**（用户决策；宿主无回收站，删前弹窗仍明示永久）。
- 无同目录排序插入线（本树固定排序），同目录内「拖动」= no-op。
- 复制不做自动 ` copy` 后缀：同目录复制目标已存在 → 409 进错误条，改名后再拖。
- 无多选（树本来无多选），一次拖一个行。
- 跨窗口并发竞争：存在性检查与 rename/cp 之间微小 TOCTOU（单用户侧边栏可忽略；服务端错误进错误条）。
- 撤销栈只存内存：刷新页面即失（与树的 expanded/revealed 一次性状态同级；持久化成本/收益不划算）。