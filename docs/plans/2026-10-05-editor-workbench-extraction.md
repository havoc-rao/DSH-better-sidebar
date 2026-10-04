# 中央工作台拆分：本体回退与公共接口新方案

日期：2026-10-05。状态：本体集成已回退；公共接口为待实施设计，不是现有发布契约。

## 交接位置

完整迁移计划：[dsh-editor-workbench PLAN.md](../../../dsh-editor-workbench/PLAN.md)。实际绝对路径：`/Users/havoc/Documents/Projects/tools/dsh-plugins/dsh-editor-workbench/PLAN.md`。

完整参考快照位于本仓库 `tmp/worktree/dsh-editor-workbench-reference`，分支 `reference/editor-workbench-extraction`，提交 `eba0bf6db831d953dde6263615c84b32db94a67c`。其中保留中央编辑器、最新紧凑UI/图标/右上状态box、Git Diff、路径解码、保存冲突及全部测试。原 `feat/central-editor` 只含初版，不是完整移植来源。参考worktree不要整体合并回main；新插件在兄弟目录独立开发。

## 回退方式

- 所有未提交工作台改动先记录为参考分支提交，再创建可直接读取的worktree。
- main 使用 `git revert -m 1 97faffd`，回退提交 `5ebb94c`；不重写历史、不reset、不删除参考文件。
- 回退后 `src / tests / package.json` 与中央功能合并前 `f2ff8e7` 一致，保留文件树引用拖拽等无关功能。
- 初版fs.write冲突预条件随中央集成一起回退；下一阶段作为公共文件数据能力单独提取并review，不留专用UI半套代码。
- 不修改profile、不自动重启GUI、不推送远端。build产物应重新生成以免旧中央代码残留；用户仍应先保存浏览器内草稿再刷新。

## 新的责任划分

better-sidebar保留文件树、侧栏预览、Git/会话变更导航，以及版本化扩展能力。独立 `dsh-editor-workbench` 拥有中央布局接管、多文件/Diff标签、CodeMirror、文档状态、会话状态box、样式与工作台词典。DSH提供会话与公开槽。

### A. 最小动作注册（待实现）

覆盖file-tree context menu、file-viewer toolbar、git-preview toolbar三个已使用位置。描述符有id/label/icon/order/available/run，返回幂等disposer。动作上下文判别file/git-diff，保留完整SessionScope/absolutePath/SidebarDiffRef；viewer还传dirty/readOnly。

本体负责错误展示、可访问名、异步失败、菜单关闭和卸载移除；消费插件决定行为。provider晚到、卸载及重挂不会重复注册。没有工作台插件则完全没有工作台入口。不要继续新增 `setCentralEditor/openCentralFile/openCentralDiff` 专用API。

### B. 文件打开目标（有需求时实施）

`registerFileOpenTarget`或等价小型公开面：id/priority/accept/open(handled|declined)，仅拦普通激活。显式侧边/新标签/外部应用不被抢占。插件只在对应session的中央编辑激活时accept；decline恢复原路径，异常可见。禁止替换全局函数引用或读取私有store。

### C. 公共数据能力（待实现）

- 文件文本读取：text/binary判别、truncated、revision/完整保存基线。
- 条件保存：expectedRevision或expectedContent，错误中明确conflict；沿用鉴权、会话/远端路径解析及限额。
- Git比较：完整ref与provider路由，严格请求侧（empty就是empty，不fallback另一侧）、未跟踪/二进制/截断信息。
- consumer只调用公开service，不能跨包import本体src/hook、私有HTTP或宿主内部组件。
- 参考保存实现只有本进程归一化路径串行与检查，不是文件系统CAS；外部进程/多实例/路径别名仍有TOCTOU，需公开说明。

### D. 契约与发布门

能力需要features/版本探测，服务缺席不得形成死按钮。peer最低版本只能填写实际发布并验证版本，不能预先猜。实现同批更新唯一权威external-plugin-guide与消费者类型测试。

重点回归：本体单装无变化；两插件动作有效；disable/hot reload清理；pending interaction返回宿主；保存中切换/重开无旧IO污染；repoRoot/worktree/cwd不混用；Git中文和特殊路径解码；dirty草稿与只读Diff隔离。

## 实施顺序

1. 以兄弟目录完整PLAN为交接入口，先核定公共接口。
2. 本体独立任务实现A/C，必要时B；不恢复中央专用实现。
3. 新插件再迁移参考代码，适配公开能力并拥有独立chunk/locale命名空间。
4. 单元/组件/消费者类型/真实scratch profile挂载验收。
5. 用户明确授权后更新实际profile、验证现有GUI URL；build不冒充部署成功。

本轮仅完成保留快照、计划和回退；不宣称A/B/C已落地，不启动外部新插件任务。

## 回退验证

2026-10-05：typecheck通过；文件拖拽/编辑器/Git变更/服务/locale/theme相关145项测试通过；build成功；manifest/chunk产物11项测试通过。总计156项相关测试通过。主仓库源码、测试和package.json与`f2ff8e7`逐字相同；参考worktree干净且HEAD钉在`eba0bf6`。没有更新profile或声称当前GUI完成在线验收。
