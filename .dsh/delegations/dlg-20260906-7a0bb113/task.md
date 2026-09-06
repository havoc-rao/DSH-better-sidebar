# 委派任务书 · dlg-20260906-7a0bb113

| 字段 | 值 |
| --- | --- |
| 目标 | `/Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar` |
| 工作区 | `/Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar` |
| 父会话 | `session-4b8e003f-517f-4e36-bdca-0d0b68bb9a30` |
| 创建时间 | 2026-09-06T20:30:39.598Z |
| 任务标题 | 任务原文：/Users/havoc/Documents/Projects/too… |
| 超时 | 300000 ms |
| 目标会话 | `session-0782f87b-b0f8-45a2-b178-79be831029cb` |
| 运行 ID | `session-0782f87b-b0f8-45a2-b178-79be831029cb` |

## 任务原文

任务原文：/Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar/src/client/TerminalView.tsx:561 对于远程工作区，默认是远程 term，就不需要一个单独的远程终端了。

请先阅读 src/client/TerminalView.tsx（重点看 561 行附近，以及终端视图的整体结构：工具栏按钮、菜单项、终端类型切换等），理解「远程终端」（单独的远程 term 入口）与默认终端的关系。然后实现：当工作区是远程工作区时，默认展示的本来就是远程 term，因此不再需要那个「单独的远程终端」入口/按钮/菜单项——在远程工作区场景下将其隐藏或移除（本地/非远程场景保持原有行为不变）。注意保持与文件其它部分的风格一致，避免破坏现有状态管理与布局。修改后请运行项目自带的检查（typecheck / test / build 等，仓库无 lint 脚本），确保改动通过验证，并在结果中说明改动的文件、具体改动点与验证结论。

## 续跑指引

见 /Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar/.dsh/delegations/dlg-20260906-7a0bb113/resume.md。
