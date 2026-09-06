# 委派恢复说明 · dlg-20260906-7a0bb113

任务已于 2026-09-06T20:39:35.830Z 以 **host-reclaim** 结算。目标会话保留（会话 ID：`session-0782f87b-b0f8-45a2-b178-79be831029cb`，见任务书与 progress），父侧可直接**回到同一会话**继续，无需新建会话。

- 任务书: `/Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar/.dsh/delegations/dlg-20260906-7a0bb113/task.md` — 任务原文、目标、父会话、创建时间与超时配置
- 进度: `/Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar/.dsh/delegations/dlg-20260906-7a0bb113/progress.md` — 每行一个已完成步骤；最后一行 `[result]` 是结算状态
- 现场: `/Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar` — 用 git status/diff 与生成产物核对完成度
- 目标会话: `session-0782f87b-b0f8-45a2-b178-79be831029cb` — 宿主保留该会话；会话 ID 在委派时就已预分配并写入本记录，即使任务超时/失败也可用

## 续跑方式

1. **回到同一会话（推荐）**：再次调用 `delegate_workspace`，把 `session_id` 设为本会话 ID，新任务会直接送进本会话。上下文、现场与标题原样保留，无需新会话读文件恢复；仅本地委派路径可用。
2. 在宿主界面从目标工作区的会话列表打开保留会话直接继续，原上下文完整；或
3. 会话不可用（如被宿主回收）时，在同一工作区新开会话，先读 task.json 与 progress.md，结合现场状态确定未完成步骤，再重新委派（建议 run_in_background: true）。

## 续跑任务书样例

```json
{
  "name": "delegate_workspace",
  "arguments": {
    "target": "/Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar",
    "session_id": "session-0782f87b-b0f8-45a2-b178-79be831029cb",
    "task": "续跑委派 dlg-20260906-7a0bb113：本会话就是原任务会话（session_id 已回到同一会话），阅读进度 /Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar/.dsh/delegations/dlg-20260906-7a0bb113/progress.md 与任务书 /Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar/.dsh/delegations/dlg-20260906-7a0bb113/task.md，检查现场（git status/diff、生成产物），确定未完成步骤后继续，完成验收标准后报告。",
    "run_in_background": true
  }
}
```
