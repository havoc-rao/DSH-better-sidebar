# VSCode 插件体系兼容层（二）：命令注册 + 菜单贡献设计

> 状态：**已实施**（v0.16.0 目标）
> 范围：L1「贡献点契约兼容」的第二个扩展点 `commands`——注册表 + 可编程执行 + 两个右键菜单表面（文件树行 / tab 条）的菜单贡献。补齐 §2.2 映射表里标 ⏳ 的 `commands` + `menus` 行。
> 不在本轮：命令面板（⌘P 仍是文件快速打开）、`menus` 的 `group`/分隔线、`enablement`（禁用态由 `when` 谓词替代）、keybindings ↔ commands 绑定层（插件可在 keybinding `run` 里自行 `executeCommand`）。

---

## 0. 背景

图标主题扩展点（首例）验证了 L1 契约模式：**声明式数据注册 → 核心解析 → 纯渲染 → 设置选择 → features gate**。命令系统是 VSCode 插件体系的中枢——`contributes.commands` + `contributes.menus`（+ `executeCommand`）覆盖「插件暴露动作 + 挂到既有表面 + 程序化互调」三件事。better-sidebar 已有成熟右键菜单形态（FileTree 行菜单、tab 条菜单都是 `Menu` + 静态 items），把插件命令作为**追加行**塞进这两处 + 提供 `executeCommand` 互调，即完成最小但完整的命令语义。

## 1. 扩展点 API

### 1.1 `CommandDescriptor`

```ts
interface CommandDescriptor {
  /** 唯一 id（建议包前缀：'my-plugin:format'）；重复注册抛错。 */
  id: string
  /** 展示名（i18n 友好：字符串或 () => string）。 */
  title: string | (() => string)
  /** 菜单行图标（可选；ReactNode 或 (size) => ReactNode）。 */
  icon?: ReactNode | ((size: number) => ReactNode)
  /** 挂载的右键菜单表面（缺省 = 无菜单入口，仅可编程执行）。 */
  menus?: readonly {
    /** 'file-row' 文件行 / 'dir-row' 目录行 / 'root-row' 会话根行 / 'tab' tab 条 */
    where: 'file-row' | 'dir-row' | 'root-row' | 'tab'
    /** 上下文谓词；false 隐藏该行；抛错 fail-open（保持可见）。 */
    when?: (menu: CommandMenuContext) => boolean
    /** 组内排序（升序）；默认 100。 */
    order?: number
  }[]
  /** 执行体；payload 携带触发上下文。抛错只 console.error（safeCall），
   *  绝不打断菜单流程。 */
  run: (payload: CommandRunPayload) => void
}

interface CommandMenuContext {
  path?: string     // 行菜单：触发路径
  isDir?: boolean   // 行菜单：是否目录行
  isRoot?: boolean  // 行菜单：是否会话根行
  tab?: SidebarTab  // tab 菜单：触发的 tab 实例
}

interface CommandRunPayload {
  /** 触发表面（'programmatic' = executeCommand 直接调用，无菜单上下文）。 */
  where: 'file-row' | 'dir-row' | 'root-row' | 'tab' | 'programmatic'
  path?: string
  isDir?: boolean
  isRoot?: boolean
  tab?: SidebarTab
}
```

### 1.2 服务方法

```ts
registerCommand(descriptor: CommandDescriptor): () => void
getCommands(): readonly CommandDescriptor[]
executeCommand(id: string, payload?: CommandRunPayload): boolean
```

- `executeCommand`：未知 id → `false`（无副作用）；命中 → safeCall 执行并返回 `true`。处在外键位置（菜单选择、其它插件互调）——抛错吞掉，绝不炸调用方。
- disposer / 生命周期与其它注册表完全一致；`features` 增 `'commands'`。

## 2. 菜单贡献（纯函数 + 两处挂载）

### 2.1 构建器 `src/client/commands.ts`（无 React 依赖？含 icon 渲染需要 ReactNode——保持 icon 原样传递，构建器返回描述行）

```ts
commandMenuRows(
  commands,                       // service.getCommands()
  where: 'file-row' | 'dir-row' | 'root-row' | 'tab',
  context: CommandMenuContext,
): Array<{ id: string; label: string; icon?: ReactNode }>
```

- 过滤：`menus` 含该 `where` 的 descriptor；
- `when` 求值：false → 跳过；抛错 → **保留**（fail-open，与设置行 `when` 同语义）；
- 按 `order` 升序（稳定），映射为 `{ id: command.id, label: title(), icon }`。
- 纯函数可测；菜单渲染端零逻辑。

### 2.2 FileTree 行菜单

追加在现有内置行之后（不引入分隔线——Menu 行形态单一，顺序即分组）：`where` 由 `rowMenu` 派生（`path === root && isDir` → `'root-row'`；isDir → `'dir-row'`；否则 `'file-row'`）。`onSelect` 路由：未知 id → `executeCommand(id, { where, path, isDir, isRoot })`。

### 2.3 tab 条菜单

同构：`where: 'tab'`，context `{ tab }`；`selectTabMenu` 未知 id → `executeCommand(id, { where: 'tab', tab })`。

### 2.4 可编程互调

`executeCommand` 本身即插件间协作通道（`features.includes('commands')` gate；老核心上调用返回 false）。

## 3. 测试计划

- `tests/commands.spec.ts`：注册表生命周期（register/get/dispose/重复 id 抛错）；`executeCommand` 命中/未知 id/抛错吞掉；`commandMenuRows` 过滤、`when` false 跳过、`when` 抛错 fail-open、order 稳定排序、icon 透传、无 menus → 空。
- `tests/commands-menu.spec.tsx`（jsdom）：FileTree 行右键 → 插件行出现（title/icon）→ 点击 → executeCommand payload 断言（where/path/isDir/isRoot）；无插件时菜单与现状一致（回归）。
- `tests/api-surface.spec.ts` / `tests/service.spec.ts`：features 增 `'commands'`。

## 4. 风险与回退

| 风险 | 缓解 |
|---|---|
| 菜单行数量膨胀 | order 排序 + 无分隔线；插件行恒在内置行之后（内置优先） |
| when 抛错炸菜单 | fail-open（显示）+ safeCall 记录 |
| 与现有菜单 id 冲突 | 内置 id 优先路由；未知 id 才走 executeCommand |
| 老核心调用新 API | features gate |

回退 = 不注册任何命令（现状零变化）。

## 5. 实施阶段

1. `commands.ts` 类型 + 构建器 + service 三方法 + features（纯逻辑，可独立测）。
2. FileTree / tab 条菜单挂载 + 路由。
3. 测试 + AGENTS.md（§12 命令注册 API）+ 本设计文档收尾。