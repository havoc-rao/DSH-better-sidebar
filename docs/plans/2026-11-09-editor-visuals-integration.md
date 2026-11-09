# 独立 dsh-editor-visuals 接入记录

## 分工

- 独立 workspace `../dsh-editor-visuals` 维护 minimap / Git 背景绘制，交付 0.1.0 tarball，不把原型重新内置。
- better-sidebar 仅维护 `editorExtensions:v1` owner 注册表、同 lazy chunk CM runtime、可见性快照和同一 Git gutter map。
- 不修改 DSH 源码，不自动安装用户 profile，不发布。

## 接入

`ctx.betterSidebar.editorExtensions.register(signal, {id, create(context)})`，类型从 service 入口导出。异步工厂结果以注册实例和 view lifetime 校验；每 view 使用 Compartment，卸载保留原编辑状态。核心注册表不 value-import CodeMirror。核心和 lazy bundle 通过服务对象上的 symbol registry 共用同一实例，不依赖模块级 Map 的跨包同一性。

内置 TextEditor regular view 安装桥接；streaming 不创建 CM，外部 controlled renderer 不自动注入。隐藏 tab / 渲染预览传 visible=false。Git 同步快照表示 head / provisional / unavailable，不新增 Git 请求。临时输入映射的 undo 不等于精确 HEAD diff，等待下次权威刷新。

## 验证与局限

- 独立包交付记录：4 文件 / 28 测试，typecheck / lint / build / check:bundle 通过，CM runtime 零打包。
- 本仓库桥接目标测试覆盖 owner/duplicate/abort、异步取消、失败隔离、metadata、history/search/selection、真实 TextEditor 可见性。
- 独立包 built lib 复制到本仓库 ignored tmp 后，通过 `DSH_EDITOR_VISUALS_ENTRY=../tmp/editor-visuals-consumer-lib/index.js pnpm exec vitest run tests/editor-visuals-consumer.spec.ts` 验证消费包与真实 CM view 安装/卸载；jsdom，不是宿主浏览器。
- 本轮全量初跑 316 文件通过，fs-watch 的 2 例为已知满载 flake；隔离该文件 6/6 通过。审查修复后以 4 workers 重跑（含独立包 built 消费测试）318 文件 / 3728 例通过，18 例既有 skip。
- typecheck / lint（22 条既有 warnings）/ build / check:consumer-types 已运行通过；新增公开类型包含在 consumer 检查中。
- test:mount 已尝试 dev CLI 及固定基线 npx；启动预检 `--version` 长时间无输出。停止后保留 logs，不宣称 mount 或当前 GUI 验收通过。未合入 main，未修改用户 profile。

## 后续验收命令

构建并 pack 双方后，以 `EDITOR_VISUALS_TARBALL=<独立包绝对路径>` 运行本仓库 `pnpm test:mount`。脚本只向临时 profile 增装消费包，mount spec 将断言独立 minimap 真正安装。需先解决本机基线 CLI 的启动预检问题，再完成 Chromium 验收、最终 diff review 和合入 main；仅有 jsdom 不能跳过此门禁。

实际 GUI 需要确认安装 profile、构建监听及刷新现有 URL；不另起替代服务器，不承诺 HMR。
