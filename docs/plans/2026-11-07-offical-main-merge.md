# 合入 offical/main v0.30.1

目标：`0b6293f0`；本地基点：`cbf72e92`。保留本地终端、titleBar、工作区工具页与所有扩展 API。

## 冲突处理

- `.gitignore`、CHANGELOG：合并双方条目。
- 接入指南：保留本地终端/快捷键/皮肤说明，补入官方 hidden tab、侧聊图片与新 API。
- package：采用官方 0.30.1 / DSH 0.2.2-rc.1；保留本地依赖与日志脚本，移除市场规则禁止的 prepare。Mermaid 资产由 build / bundle / watch 显式生成。
- EditorHost：保留 useId 和本地资源扩展，合入官方草稿保护与引用定位。
- SideChatView：合并本地阅读位置记忆和官方图片、文件链接、GenUI 表面。
- ChangesTab / CSS / 测试：保留本地下划线 tabs。
- GitLens：保留提交扩展动作，合入菜单翻转定位；More 继续使用可透传 ARIA 的 Button，避免 IconButton 丢失 aria-expanded。
- 客户端入口：保留本地服务/原生栏初始化和快捷键，仅追加官方引用 source、侧聊表面释放与设置图标插槽，避免重复初始化。
- service / consumer-types：合并双方 API。
- terminal.module.css：保留本地删除，继续使用本地终端实现。
- 服务端入口：同时保留资源/终端路由和官方图片准入、取消信号。
- theme 测试：保留双方断言。
- 几何 e2e：用 TypeScript AST 精确提取 scheduleHostCheck；官方按相邻字符串切片会连带执行本地底部入口代码。

## 依赖与验证

`pnpm peers check` 发现旧 Cordis / schemastery 不匹配，升级为 Cordis 4.1.0、schemastery ~3.19.0、include 1.1.0；剩余四项告警来自可选旧版 better-locale 的宿主 peer 范围。

- 最终 build / pack / typecheck / check:engines 通过。
- 全量 Vitest：313 文件通过，3694 用例通过、17 跳过（logs/2026-11-07-merge-test-confirm.log）。前一轮文件监听和任务拖拽各有一次时序失败，单独复测 73 用例通过，随后完整重跑通过。
- 真实 0.2.2-rc.1 宿主全 lane：20 通过、6 跳过，唯一失败为上述几何测试提取；修正后该文件 6 用例通过。核心挂载门禁重跑 9 用例全部通过并正常退出（logs/2026-11-07-merge-mount-final.log）。
- 未修改 DSH 源码、用户 profile，未推送远端。
