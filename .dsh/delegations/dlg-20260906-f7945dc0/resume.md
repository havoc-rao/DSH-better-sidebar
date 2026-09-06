# 委派恢复说明 · dlg-20260906-f7945dc0

任务已于 2026-09-06T16:48:08.063Z 以 **timeout** 结算。目标会话与现场保留，可按下面步骤继续（重新委派时新会话对上一会话无上下文，只能从本目录与现场恢复）。

- 任务书: `/Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar/.dsh/delegations/dlg-20260906-f7945dc0/task.md` — 任务原文、目标、父会话、创建时间与超时配置
- 进度: `/Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar/.dsh/delegations/dlg-20260906-f7945dc0/progress.md` — 每行一个已完成步骤；最后一行 `[result]` 是结算状态
- 现场: `/Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar` — 用 git status/diff 与生成产物核对完成度
- 目标会话: `session-5cc8bf78-f7d4-4d51-845d-4cf7193e9186` — 宿主保留该会话；crashed/aborted 后若宿主侧仍存活可从工作区列表直接打开继续

## 续跑方式

1. 在宿主界面从目标工作区的会话列表打开保留会话直接继续，原上下文完整；或
2. 在同一工作区新开会话，先读 task.json 与 progress.md，结合现场状态确定未完成步骤，再重新委派（建议 run_in_background: true）。

## 续跑任务书样例

```json
{
  "name": "delegate_workspace",
  "arguments": {
    "target": "/Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar",
    "task": "续跑委派 dlg-20260906-f7945dc0：任务书 /Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar/.dsh/delegations/dlg-20260906-f7945dc0/task.md，进度 /Users/havoc/Documents/Projects/tools/dsh-plugins/DSH-better-sidebar/.dsh/delegations/dlg-20260906-f7945dc0/progress.md。先阅读两者，检查现场（git status/diff、生成产物），确定未完成步骤后继续，完成验收标准后报告。",
    "run_in_background": true
  }
}
```
