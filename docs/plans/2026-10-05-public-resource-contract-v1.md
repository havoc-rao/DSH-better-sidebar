# 可选工作台公共资源契约 v1：本体实现与交接

日期：2026-10-05。状态：本地实现/构建/类型与行为测试已验证，未发布npm、未更新实际profile、未做本轮真实浏览器挂载验收。

## 已落实

权威公开接入文档为 `docs/external-plugin-guide.md` §0.2，公共类型出口 `dsh-better-sidebar/client/service`，服务 `ctx.betterSidebar`。能力 features：resourceActions:v1 / fileOpenTargets:v1 / textDocuments:v1 / strictGitDiff:v1。没有恢复中央工作台专用controller/UI；本体只提供通用扩展。

1. ResourceActionDescriptor 三个surface：file-tree-context / file-viewer-toolbar / git-preview-toolbar。即时dirty/readOnly、完整SessionScope/SidebarDiffRef、register disposer、latest availability/run、异常可见。无消费插件无额外入口或空Git工具栏。
2. FileOpenTargetDescriptor 仅文件树普通激活；priority升序；handled/declined；异常/取消不fallback。异步会话/cwd/service切换拒绝旧gesture，Ctrl/Shift/显式侧边新tab原行为不变。
3. mounted Viewer 用唯一owner上报dirty/readonly，custom/loading未知；TextEditor同状态但callback变化仍重新上报，避免merged切文件/refresh永久unknown。
4. DocumentProviderDescriptor 和 GitDataSource.optional readStrictDiff；首TRUE锁定，不跳过工厂异常/缺能力。不改变旧git resolver兼容路径。
5. 公共readText/writeText/readDiff与getResourceCapabilities，来源epoch与票据生命周期，显式host-local确认。

## 安全契约（消费插件不可跳过）

- no provider不证明local：默认 unavailable + reason authority-required。仅这个reason可向用户明确确认运行DSH服务的宿主机器资源。host-local传参不绕过任何matched provider，不能按cwd外观/网络异常等自行降级。
- readText完整可写未截断text签发baselineId，结果含providerId/providerEpoch。write condition必须expectedContent + baselineId + providerId + providerEpoch；票据绑定session/cwd/repoRoot/path/content/activation/epoch。成功返回新票据与提交文本基线；旧票据消耗。跨scope/path/service、未完整读、二进制/截断不得保存。
- releaseTextBaseline在文档关闭/替换时调用，pending拒绝释放；最多64活票据，超限too-large。provider稳定对象内部rebind必须invalidateResourceProviders并由subscribe通知。
- pending write不abort假装未提交。来源变化或失联结果可ambiguous，重新读验证，不盲重试。
- 本地新路由要求host-local +真实attached/persisted authoritative session，拒clientcwd/processfallback。条件写canonical同路径queue，rename前二次check；不是filesystem CAS，外部writer/别名/多实例仍TOCTOU；新inode不承诺ACL/owner/xattrs保留。
- strictGit首版worktree；明确staged/unstaged，不oppositefallback。匹配远端provider缺strict不得调用本地git/fs。请求/结果scope与requestedSide校验。
- 宿主patch/raw/numstat各流式4MiB限额，metadata仅完整NUL记录，不造partial可编辑路径；child repo + linked checkout经对应inventory验证；numstat区分unstaged纯chmod与文本修改。untracked同源读取binary/truncated/空文件新增。
- 文件client默认512KiB，server现readLimit默认512KiB但可配置；getCaps limitsSource default只表示client默认，不宣称remoteprovider实际限额。旧JSON请求体1MiB限制仍作用于content+expectedContent。

## 验证记录

- 完整typecheck通过；新增核心代码ESLint、diff --check通过。
- build通过，消费者声明测试通过（浏览器无Node；严格模式只过滤既有上游声明噪音）。manifest/chunk/icon出口15项通过。
- 新增4组测试：registry16、UI12、client data23、host route9。覆盖cancel卸载/跨session/真实TextEditor报告、未知归属failclosed、ticket代际/跨文档/容量、真实git/文件IO、字节cap、chmod、截断路径等。
- 完整回归排除已在基线确认的git-commit-actions.spec.tsx后：172文件通过，1901项通过，9跳过，fs-watch一个并行超时；单worker复跑watcher6项与新增测试合计66项全部通过。不得表述无条件全套全绿。
- 未变package版本（仍0.24.1）、未发布；消费插件通过本地引用与feature+方法探测开发，peer最低发布版本待后续发版核定。

## 向新工作台的实施交接

保持独立包，读取最新guide/公开service.d.ts，不import私有src/server或重复造HTTP。不恢复openCentralFile/openCentralDiff/setCentralEditor。可以推进运行时adapter和三动作注册，以已确认hostlocal逐操作授权或已匹配provider为准；默认未知不可用但可展示确认入口。先实现P2中央seat生命周期，再P3编辑保存票据，再P4strictDiff。读取确认不能自动授权写入，确认不跨providerepoch持久化。保存结果新baseline需替换旧ticket，dirty以实际提交文本更新。

需要测试preview→file dirty门控、provider缺能力、slot注册失败、审批返回、ticket释放、HMR/disable注销。尚未经过真实profile挂载，不能宣称运行UI已验收。
