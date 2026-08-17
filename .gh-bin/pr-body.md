## 变更一览

四组类 VSCode 快捷键 + 一项布局协同：

| 按键 | 作用 |
|---|---|
| `Ctrl/Cmd + B` | 切换宿主左侧栏（走 ui-layout 公开服务 `ctx.layout.toggleSidebar`） |
| `Ctrl/Cmd + J` | 切换底部面板 |
| `Ctrl/Cmd + Shift + J` | 底部面板中间区域全屏 / 还原（VSCode "Toggle Maximized Panel" 语义） |
| `Ctrl/Cmd + Alt + B` | 切换右侧栏 |

**布局协同**：右侧面板打开时把宿主 AppFrame 挤压到 1024px 断点以下（默认 30% 宽度时窗口 < ~1463px 即触发），宿主会因此自动收起左侧栏——新增 keeper 自动保持左侧栏展开。

## 实现要点

- **快捷键**（`src/client/hotkeys.ts`）：document capture 阶段 keydown（与 IME guard 同层），命中后 `preventDefault + stopPropagation` 全量消费；**按物理键 `event.code` 匹配**（US 布局 ⌥B 的 key 值是 `∫`、非拉丁布局不受影响）；守卫：IME 组合输入（复用 `isImeComposition`）、Windows AltGr 和弦、按键重复（按住只切一次）、shift 组合仅 `⌘⇧J` 一个绑定（`⌘⇧B`/`⌘⌥⇧B`/`⌘⌥⇧J` 全部放行）、窄视口（<768px 无底部面板，⌘J/⌘⇧J 为 no-op）、无会话时严格 no-op；经 `ctx.effect` 注册（HMR-safe）。
- **⌘B 宿主左侧栏**：零 DSH 源码改动——走宿主官方公开服务 `ctx.layout`（ui-layout 的 `LayoutController`，ui-sidebar 自身的收起按钮同款调用），惰性 `ctx.get('layout')` 读取（`conversation` 同款模式），宿主缺失时降级为 logged no-op。
- **⌘⇧J 全屏**（`state.ts` + `Sidebar.tsx`）：新增 `bottomMaximized` 状态（持久化，旧状态默认 false）；全屏 = 面板高度撑满视口 + **布局推送归零**（覆盖而非挤压，对话区坐在面板后面）；关闭面板 / 窄屏迁移都会遗忘全屏标记，重开永远是普通高度；全屏时隐藏拖拽条与角手柄，X 按钮变为「还原」。
- **宿主左侧栏 keeper**（`src/client/host-sidebar.ts`）：crossing 触发状态机——只在「真实 ≥1024 → <1024 的 frame 宽度穿越 + 我们的挤压生效 + 窗口本身 ≥1024」时武装，只在宿主 `data-sidebar-collapsed` 属性**出现**（突变）时消费，然后经 `ctx.layout.toggleSidebar()` 重展开（宿主处于 narrow 模式时 toggle 翻转其 narrowExpanded 覆盖）。**用户 ⌘B 主动收起永不被反悔**（⌘B 不改变 frame 宽度 → 不武装；穿越前已存在的折叠不触发突变 → 不消费）；关闭面板 / 恢复后武装自动清除，无残留、无反馈循环。

## 验证

- 单测新增 25 个（hotkeys / state / host-sidebar 机器状态机 + DOM 接线），全量 `pnpm test` 574 通过；本地仅剩的 27 个失败为环境性既有失败（node-pty spawn 被沙箱拦截，agent-pty / smoke / side-card-section），在干净 main 上同样存在，CI（Linux runner）不受影响
- `pnpm typecheck` / `pnpm build`（含构建纯度门）/ `pnpm check:consumer-types` 全绿
- 真实挂载冒烟：`scripts/e2e-mount.sh`（npm 打包 → scratch profile 真实挂载 → 无头渲染 + tab 深扫）通过
- 真实浏览器探针（临时 spec，未提交）：⌘B 翻转宿主 `data-sidebar-collapsed` 且 ⌘⌥B/⌘J 不碰宿主侧栏；⌘⇧J 全屏高度 = 视口且 push 归零、再按还原、⌘J 关闭后重开为普通状态；1440 视口下右侧面板默认打开（frame 1008 < 1024）时宿主左侧栏保持展开、手动 ⌘B 仍可收起/恢复

## 备注

- 在浏览器标签页中运行 DSH Web 时，`⌘B` / `⌘⇧J` 可能被 Chrome 等浏览器的原生快捷键截走（如 Chrome macOS `⌘⇧J` = 下载页）；桌面 App（Electron）与键位自由的浏览器无此问题——页面只能收到未被浏览器截走的按键
- 移动端（<768px）无底部面板：⌘J / ⌘⇧J 为 no-op，与隐藏的切换按钮一致
- 面板按钮 tooltip 已附带快捷键提示（macOS `⌘B`/`⌘J`/`⌘⇧J`/`⌘⌥B`，其余平台 `Ctrl+...` 对应组合）
