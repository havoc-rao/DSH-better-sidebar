# 文件树缩进引导线设计（VSCode 风格）

> 状态：**已实施**（v0.16.0 目标）
> 范围：文件树（内嵌 dock / 独立资源管理器 / VSCode Side Bar 三处共用 `FileTree`）的 VSCode 式**缩进引导线**——每层展开祖先一条纵线 + 展开目录行的横向拐角分段，纯行内背景渐变绘制，零额外 DOM
> 不在本轮：hover 才显示的 `tree.indentGuides: onHover` 语义（VSCode 新版默认，本需求为"辅助观察"取常显）、设置页开关、搜索结果的引导线（VSCode 的 quick-open 也不画）
>
> **实施记录（2026-08-26）**：已全部落地——`FileTree.tsx` 新增导出 `treeGuideBackground(depth, isOpenDir)`（纯函数，返回 background longhands 层集）与几何常量 `INDENT_STEP=22` / `INDENT_BASE=6`（与行 padding 公式共用，杜绝漂移）；目录/文件行 spread 进 style，loading/error/根行保持原样；`AGENTS.md` §10 参考实现同步一句话；测试新建 `tests/file-tree-guides.spec.ts`（纯函数 5 例 + 组件集成 1 例）。**实施偏差（相对设计）**：拐角 y 定位用行高硬编码 `16.5–17.5px`（34px 行的垂直正中）而非 `calc(50% ± 0.5px)`——行高是 CSS 固定值，硬编码可读性更好；若将来行高改动态，需换 calc 写法（见 §4）。

---

## 0. 背景与目标

better-sidebar 的文件树用 `depth * 22 + 6` 的 padding 缩进，同级目录展开后只能靠"缩进量"肉眼估层级，目录多了容易看串行。VSCode Explorer 的缩进引导线（indent guides）在每层展开祖先的图标列位置画 1px 纵线，展开的目录行再补一条横线拐角（`├─` 形状），层级关系一眼可读——这是"IDE 感"最基础的视觉信号之一。

目标：把 VSCode 的引导线契约搬进 `FileTree`，**不引入任何新 DOM 节点**（行数多、懒加载展开频繁，加 span 会显著增加节点数；行内背景渐变零成本），且不破坏现有行背景/悬停填充。

## 1. VSCode 参考（权威来源）

- **VSCode 模型**（`monaco-tree` 的 indent guide 渲染）：行内嵌 `monaco-tl-indent` 容器（每祖先一层，每层 14px），行的缩进用 padding；每条 guide 元素以 `border-left` 画竖线，展开目录额外在竖线与内容之间画横线段。现代 VSCode 的显示语义：**纵线画在每个展开祖先的图标列左侧**，**拐角只出现在"已展开的目录行"**（`tree.indentGuides`，新版默认 `onHover`）。
- **颜色**：主题令牌 `tree.indentGuidesStroke`（暗色主题约 `rgba(255,255,255,0.2)` 的淡灰），比行分隔线更淡。

## 2. 设计

### 2.1 几何（对齐现有行布局）

现有行：行高 34px，图标起点 `padding-left = depth * 22 + 6`（22px 一列，根行额外 6px 内垫）。引导线坐标系 = 行 box 本身（row 为 `border-box`，背景定位区含 padding）：

- **纵线**：深度 D 的行在 `x = k * 22 + 6`（k = 0…D-1）各画一条 1px 竖线——k 即"第 k 层祖先"的图标列。根永远展开，所以 depth-1 的行有一条根列竖线（x=6）。
- **拐角（仅展开目录行）**：横向 1px 段从最深层纵线 x=`(D-1)*22+6` 连到本行图标 x=`D*22+6`（恰好跨一列），位于行垂直正中（34px → 16.5–17.5px），与文件夹图标左缘相接，形成 `├─📁` 视觉。
- **根行（depth 0）**：无祖先 → 不画任何线。
- **终止语义**：行画"自己深度"的线，深度 ≤ D 的兄弟行天然不携带该层的线——每棵子树的引导线在**子树最后一行底边**齐平收住，不会悬空穿入下一层。

### 2.2 绘制器（纯函数，零 DOM）

`treeGuideBackground(depth, isOpenDir): CSSProperties`——用 SVG 无关的 CSS 渐变层集：

- 每条纵线 = 一 `linear-gradient(90deg, transparent X, <stroke> X, <stroke> X+1, transparent X+1)` 层（100%×100%，硬停靠 1px，无抗锯齿糊边）；
- 拐角 = 一 `linear-gradient(0deg, …16.5px…17.5px…)` 层，配 `background-size: 22px 100%` + `background-position: (D-1)*22+6 0`（只在最深层那一列可见）；
- 返回**四个 longhand**（`backgroundImage/Size/Position/Repeat`），层序 = 拐角在前、纵线在后。

选择"行内 longhand 而非 `background` shorthand"是刻意的：shorthand 会一并声明 `background-color`，与样式表里 `.explorerRow` 的底色、`.explorerRow:hover` 的悬停填充冲突（行内 shorthand 会压死悬停色）；只设 image/size/position/repeat，`background-color` 仍由 CSS 的 hover rule 提供——悬停填充与引导线叠加共存，cascade 上行内 longhand 天然赢过任何 selector 的同名 longhand，无需 !important。

### 2.3 颜色（令牌驱动，无硬编码色）

`GUIDE_STROKE = color-mix(in srgb, var(--dsw-alias-border-l1) 70%, transparent)`——仓库既有 color-mix 模式（sidebar.module.css 等处同款），比行分隔线（border-l1 原色）略淡，贴合 VSCode "引导线比分隔线更淡"的权重；皮肤系统覆写 `--dsw-alias-border-l1` 即自动换色，遵循 §8 令牌契约（不新增契约、不动 z-index/表面令牌）。不支持 color-mix 的旧 webview 只丢引导线，不影响行渲染。

### 2.4 接线

`FileTree` 目录/文件行 style 变为 `{ paddingLeft: depth * INDENT_STEP + INDENT_BASE, ...treeGuideBackground(depth, isOpen) }`（文件行 `isOpenDir=false`）；loading/error 行只换常量不画线（瞬时态）；根行不画。`FileTree` 被三处 TreePanel 复用的结构天然让所有表面（内嵌 dock / 独立资源管理器 / VSCode Side Bar）同时获得引导线，无额外接线。

## 3. 测试

`tests/file-tree-guides.spec.ts`：

- 纯函数 5 例：depth 0 空；每祖先一条线且对齐图标列（x=6/28、不含自身列 50）；拐角只在展开目录（层数断言按 `linear-gradient(` 计数——渐变串内含 color-mix 逗号，不能按逗号切）；拐角跨最深列、居中对齐；每层同一条令牌色 stroke。
- 组件集成 1 例：mock `api.fsTree` 渲染 `FileTree`（`expanded=['/repo/src']`）——展开目录行带拐角+根列竖线、其内折叠目录/文件行只有两根祖先竖线、depth-1 文件只有根列一根。

## 4. 已知边界

- **拐角 y 与行高耦合**：`16.5–17.5px` 硬编码对应 CSS 固定行高 34px；若行高改为可变（如内容撑高），须换成 `calc(50% - 0.5px)/calc(50% + 0.5px)`（本设计的能力范围内不做无谓的复杂度）。
- **常显 vs hover**：按需求取常显；VSCode 新版默认 onHover，若后续嫌"重"可改为 `:hover` 容器级显示或加设置开关（`pluginToggles` seam 已就绪），属增量。
- **色弱/极浅皮肤**：`color-mix` 出的淡线在部分浅色皮肤下可能偏淡——跟随 `--dsw-alias-border-l1` 即跟随皮肤自己的边界色，不做额外适配（符合 §8 每皮肤零适配原则）。
- **性能**：每行 D 个渐变层字符串随渲染重建，深度 ≈ 5–8 时每行 5–8 层，字符串拼接成本可忽略；行展开/收起才重算，无逐帧开销。