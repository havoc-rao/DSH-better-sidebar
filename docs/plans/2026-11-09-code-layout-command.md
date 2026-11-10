# CMD 显式代码阅读布局

## 用户授权与边界

用户要求以 command-palette 的 CMD action 接入 CODE 模式，并明确授权将宿主 API 改动委派到 deepseek-harness 工作区。本插件不通过 CSS 覆盖、拖动模拟或私有 store 调整宿主几何。

## 命令

- better-sidebar.layout.code：切换为代码阅读布局 / Code Layout；别名 CODE、代码模式、阅读布局。
- better-sidebar.layout.equal：均分两栏 / Equal Columns。

使用可选 ctx.inject(['commandPalette'])，注入 scope.effect 管理注册/回滚/卸载；不强依赖 palette，不注册默认全局快捷键，不运行时导入其 bundle。文案通过双语 command descriptor 与现有 isZh 展示，不增加不完整的 locale key。

CMD 执行时重新读取 mounted Session、公开 openTabs 与 Files tab 所在 docked pane 标记，检查 AbortSignal 和身份，调用 sidebarRight.applyLayoutPreset。没有 Files 不隐式创建 Files，浮窗不充当导航栏；equal 不创建分栏。Palette 默认 context 为空，不宣称捕获打开前的 Session。

## 宿主公开契约

input: { preset: 'code' | 'equal'; navigationPaneId?: PaneId; navigationWidthPx?: number }

result: { status: 'applied'; changed: boolean; sessionId: SessionId; navigationPaneId?: PaneId } 或 { status: 'rejected'; reason: string }。

CODE 请求240px导航目标宽度，宿主按自身像素/比例下限约束并负责一次undo与持久化；仅显式命令调整，tab切换/打开文件/拖动不会自动重新应用。收起状态提示先展开，过窄提示扩大或全屏，不自动切换fullscreen。

## 验证

- 插件全量单测通过：3801 tests（logs/2026-11-09-layout-command-gates.log）。
- 最终命令测试9/9覆盖注册/执行、取消、缺失能力、浮窗、会话/隐藏/歧义目标、宿主拒绝、注册及订阅中途失败回滚、卸载、执行中会话切换及changed:false重复执行（logs/2026-11-09-layout-command-idempotent.log）。
- typecheck/lint通过（既有22条hook warnings）；build、consumer-types与pack通过（logs/2026-11-09-layout-command-resumed.log）；最终回滚测试与静态检查通过（logs/2026-11-09-layout-command-rollback.log）。
- 插件真实宿主核心挂载 sweep 通过（logs/2026-11-09-layout-command-mount.log），无新增挂载崩溃；该项不是CMD尺寸验收。
- 宿主followup补充invalid-input拒绝；主侧review发现大屏20%最小比例与320px硬上限冲突，已要求将200–320仅作为首选宽度范围，最终可按宿主最小尺寸上调，阅读区不足才too-narrow；不强制全屏。
- 宿主阶段证据：focused 68/68、scoped seat+preset 66 tests、build:artifacts 8/8与build:check 2/2通过。完整test:gui为763文件通过/5文件失败，13376 tests通过；失败位于未改的menu-updates、settings section-icon/settings-root、sidebar-root、focus-ring-styles。doc-sync 42/43，已有slot catalog过期，未混入无关生成diff。
- 真实三方CMD阶段验收：从Meta+Shift+P搜索CODE并执行，1200px fullscreen实测导航240/阅读960px，equal600/600；1600px下20%最小比例为320/1280；tab点击后库存和比例不变；CMD打开后缩至400px再执行显示宽度不足，持久化字节不变。浏览器没有公开undo UI，单次undo/redo和恢复仅由真实store API测试验证，不宣称浏览器点击undo。
- 宿主委派延时上限超时后恢复收尾，大屏修正已完成并主侧读源码复核：不再以320px硬上限拒绝，测试1700→340、1920→384、2560→512px。最终focused 135/135、artifacts8/8、build-check2/2、docs21/21、范围lint/diff-check通过。
- 主侧已读宿主最终报告与真实浏览器日志：`.dsh/delegations/dlg-20261109-ad000e15/report.md` / `browser.log`，1920px CODE 384/1536、equal960/960，tab切换不重排、400px拒绝存储不变。截图在宿主`.dsh/layout-scratch/{code,equal,narrow}.png`。scratch服务器已停止，未改当前GUI profile。

## 部署

开发分支 feat/code-layout-command。当前 GUI profile 未更新，不承诺当前页面刷新即生效；宿主公开API属于新能力，旧宿主命令显示不可用。
