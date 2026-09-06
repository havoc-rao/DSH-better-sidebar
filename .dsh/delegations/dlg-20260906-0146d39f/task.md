# 委派任务书 · dlg-20260906-0146d39f

| 字段 | 值 |
| --- | --- |
| 目标 | `/Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar` |
| 工作区 | `/Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar` |
| 父会话 | `session-4eb2b57f-3615-46b4-bc44-370d8ba822d9` |
| 创建时间 | 2026-09-06T19:05:38.606Z |
| 任务标题 | 在已交付的 fileTreeSection 上下双模块（v0.19.0，Tree… |
| 超时 | 300000 ms |
| 目标会话 | `session-51dfaf46-1e62-4a8e-9f17-65ef15c3507c` |
| 运行 ID | `session-51dfaf46-1e62-4a8e-9f17-65ef15c3507c` |

## 任务原文

在已交付的 fileTreeSection 上下双模块（v0.19.0，TreePanel 的 .explorerDual 容器：上区 .explorerSection = 外部注入的远程树，下区 = 本地 FileTree）基础上，为两模块之间增加**可拖动的竖向分隔条（splitter）**。工作区即 DSH-better-sidebar；先读 src/client/TreePanel.tsx（explorerDual / explorerSection 实现）、EditorHost.tsx:280-300 与 525-545（可复用的 panel-resize pointer 模式与 .editorTreeResize 样式）、sidebar.module.css。

需求（dsh-remote 对接方要求，其原话）：「这个区域能不能上下滚动/上下能够自己调整它的高度分区，就像一个划分区域的拖动条一样；默认比例 4:1——远程文件夹（上区）为 4，本地（下区）为 1」。

请实现并交付（v0.19.1）：

1. **分隔条**：双模块渲染时，上区与下区之间渲染一条可拖动的分隔条（细 handle，约 4-6px；hover/拖动时视觉反馈——十字/竖向 resize 光标 + 高亮色；可加键盘无障碍：方向键调整或至少 aria 属性，若有现成模式照 EditorHost 的 panel-resize 惯例）。
2. **拖动语义**：
   - 默认比例：上区 80% / 下区 20%（4:1）；拖动中实时更新（pointer capture，setPointerCapture 或 document-level move/up，沿用 EditorHost 模式）；
   - 钳制：上区/下区各设最小高度（建议下区 ≥120px、上区 ≥160px，可按实际行高 34px 取整），不能拖没任何一块；
   - 拖动结束（pointerup）后**持久化**比例（选择：localStorage key `dsh-better-sidebar:fileTreeSplitRatio` 存 0-1 的上区占比；理由：跨会话稳定、无需 per-tab 复杂化。若你判断 tab meta 更合适请说明——但默认 localStorage）；
   - **双击分隔条重置**为默认 4:1。
3. **布局改造**：现 explorerSection 的 `max-height:50%` 封顶改为 splitter 控制的显式 flex-basis（拖动前默认 80%）；下区仍承接剩余（flex:1、min-height 钳制）；两区各自的 overflow 滚动保持不变（上区 flex:none + basis，下区 flex:1 —— 注意上区内如果有自己被注入组件的高度自适应，保持现状）；无 section 匹配（单模块本地树）时**不渲染分隔条、布局与现在逐字节等价**（回归）。
4. **测试**：新增 splitter spec（默认 4:1、拖动后比例变化与钳制、双击重置、持久化读/写、无 section 回归、pointer 事件处理），跑 `pnpm typecheck` + 相关测试 + 既有 file-tree-section / file-tree-* 无回归。
5. 说明取舍：分隔条命中区域点击（非拖）是否也改变比例？需要的话给一个最小实现（如点击条上/下部 10px 区域调整 1/20 步进）——你认为必要再加，默认仅拖动。

约束：纯 TS/React、无新运行时依赖；单模块路径零改动；沿用仓库既有 pointer-resize 惯例（不要引入新交互范式）。

完成后结构化回报：实现要点（分隔条 DOM/样式/事件流）、比例模型与钳制、持久化与重置、测试与 typecheck 结果、改动文件清单。

## 续跑指引

见 /Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar/.dsh/delegations/dlg-20260906-0146d39f/resume.md。
