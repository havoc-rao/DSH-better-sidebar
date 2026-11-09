# Files/Git 快捷键跨分栏复用

## 规则

快捷键是 reveal 而不是当前 pane 的 new/open：当前会话已有工具页时，激活原 tab 并聚焦原 pane，不移动 tab、不复制内容。已有多个同类型页时优先当前激活的同类页，否则稳定选择库存首项。没有才新建；显式新建、guide 点击和普通 service.openTab 的既有 pane-local 语义不改。

## 所有权

- Git 由 better-sidebar `open.git` owner 负责。仅在快捷键路径使用公开 sidebarRight mounted/tabsIn/active/focus/isExpanded/toggleExpanded，flushSync 提交布局后转 DOM 焦点；只查当前 seat 的 tab，隐藏会话与重复 DOM 不可抢焦点。native 无 Git 时查底部工作台现有 Git，最后才 openTab。
- Files 仍由 dsh-hotkey `open.files` owner 负责，在其已有 focus 修复上添加当前会话库存查询；不在 better-sidebar 重复注册 action，不改宿主。

## 验证记录

- `tests/tool-shortcut.spec.ts`：左 pane Git 复用与 DOM focus、重复调用不增加 tab、已激活副本优先、收起后展开、会话隔离/隐藏 DOM、底部现有 Git 复用、没有才调用 open。
- `logs/2026-11-09-tool-shortcut-checks.log`：定向测试、typecheck、lint 通过（既有 hook warnings）。
- `logs/2026-11-09-tool-shortcut-build.log`：build、consumer-types、pack 与全量单测通过（3793 tests）；后补底部用例另跑定向检查。
- 最终会话切换保护与底部用例追加后，定向 12 tests、typecheck、lint、build、consumer-types、pack 与 diff-check 通过：`logs/2026-11-09-tool-shortcut-session-guard.log`。
- 真实宿主挂载核心 sweep 与文件行全屏往返通过：`logs/2026-11-09-tool-shortcut-final.log`。
- 真实双插件跨 pane 回归通过，主侧已读取相邻 dsh-hotkey `.scratch/files-focus/result.json`：MacIntel 左 Files pane1 / 右 pane3，快捷键回左、数量 1→1；左 Git tab7/pane1 / 右 pane3，连续三次 Cmd+Shift+G 均回 pane1，数量 1→1；全屏 push/fullscreen/push，errors=[]。测试服务器已停止。
- dsh-hotkey 新增库存/无库存/已有多页/隐藏与切换等回归和构建检查通过；完整 npm test 仍受原 settings.section.icon 旧断言冲突阻断，未借本特性修改无关设置逻辑。

## 集成边界

分支 feat/tool-shortcut-reuse 保留之前所有未提交改动，不整体提交用户其他功能。上一批完整 mount 门禁仍有终端 posix_spawnp 与会话切换失败，不能宣称已解除。当前 GUI profile 不自动更新。
