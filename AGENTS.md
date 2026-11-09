# dsh-better-sidebar 仓库规则（AGENTS）

> ⚠️ **合并状态（2026-11-09）**：本仓库已合入官方 `main` `bd636302`，v0.30.1 线（DSH 0.2.2-rc.1）。与官方存在**有意保留的分叉差异**，下文按官方口径为主，差异如下：
> - **内置清单 = 7 tab + 3 viewer**（`editor` / `git` / `subagent` / `sidechat` / `terminal` / `workspace-terminals` / `diff`）：终端保留本地实现（插件自有 pty 路由 + agent 终端 + workspace 终端 + terminal-source 传输层），**官方 #774 的 `terminal-bottom`（宿主 `ctx.webTerminals` 服务）未并入**——两个底部终端并存是坏 UX，本地实现是功能超集。
> - **titleBar 机制保留**（`titleBarScheme` / `titleBarPresetId` / `titleBarCompat` / `titleBarStripPx` + shell-presets / titlebar-strip）：官方已删，本仓库未跟随。
> - **本地扩展 API 全部保留**：`gitCommitActions`（Git 提交行 More 菜单 + `registerGitCommitAction`）、`terminalSource` / `workspaceTerminalSource` / `gitSource` / `inspectors` / `resourceActions:v1` / `fileOpenTargets:v1` / `textDocuments:v1` / `strictGitDiff:v1` / `sharedRendering:v1` / `panelFlags` / `planDiff`。
> - **Git 提交栏 = 官方底座 + 本地扩展**：官方 textarea + 生成提交信息 + push/pull，加本地 More 菜单（commitAndPush / stage-all / 注册的动作槽）。
> - 原文中所有「terminal-bottom / bottomOnly / #774 / titleBar 已移除」的提法在本仓库均**不成立**，引用时以本节为准。


> 这里只放**每次动手都要遵守**的规则。细则、模板与历史记录在 docs/：

| 想找什么 | 去哪 |
| --- | --- |
| 发版步骤、版本号同步清单、Release note 模板 | [docs/release.md](docs/release.md) |
| 开发规范细则（构建 / i18n / 皮肤 / 稳态 / 测试矩阵） | [docs/development.md](docs/development.md) |
| DSH 基线、支持线、抬基线清单 | [docs/dsh-version-adaptation.md](docs/dsh-version-adaptation.md) |
| 宿主契约（原 §3.4 第 1–13 条，编号不变） | [docs/host-contracts.md](docs/host-contracts.md) |
| 插件接入 API 全参考 | [docs/external-plugin-guide.md](docs/external-plugin-guide.md) |
| 设计史、历次适配与分诊记录 | [docs/plans/](docs/plans/) |

---

## 0. 分支模型：`main` 唯一集成分支

- 功能与修复在 `feat/*` / `fix/*` / `chore/*` 等主题分支开发，合回 `main`。本地 `dev` 已退役，不要重建；远端 `offical/dev` 独立演进。
- 发版直接从 `main` 打 tag；仅纯文档改动允许直接提交 `main`。
- 每批合并必须跑门禁；集成在单一 worktree 串行进行。

---

## 1. 硬约束

- **禁止修改 DSH 源码**（官方 checkout `~/.dsh/source/current` 零写入）。缺能力时用宿主现成的只读 / 公开 API 或插件自有路由；做不到先说明取舍。
- **非文档改动必须走分支并合入 `main`**：外部贡献者走 `gh pr create` + review；维护者本地批量整合可以直接 `git merge --no-ff` 进 `main`，但每批都要跑门禁。
- **挂载只走 `cordis.patch.yml` + profile 机制**：插件作为独立包被 profile 引用，不反向侵入 DSH。
- **市场受管安装约束**：`dependencies` / `peerDependencies` / `optionalDependencies` 不得出现 `cordis`；`scripts` 不得含 `preinstall` / `install` / `postinstall` / `prepare`（tests/market-manifest.spec.ts 守护）。

## 2. 门禁：改什么跑什么

| 改动 | 必跑 |
| --- | --- |
| 任何非文档改动 | typecheck + lint + test |
| 动构建产物 / 公开导出面 | 上面 + build + check:consumer-types |
| 动承载面（客户端渲染、tab、原生侧栏、编辑器、文件 / Git / 终端路由、事件通道） | 上面 + **test:mount**（真实宿主 + Chromium） |
| 动 win32 分支 / 安装脚本 | 上面 + test:windows |
| 改搜索引擎 | check:engines |
| 抬 DSH 基线 | [docs/dsh-version-adaptation.md](docs/dsh-version-adaptation.md) 的清单 |

- 本地挂载冒烟：`pnpm build && pnpm pack && pnpm test:mount`。它钉住插件挂载无 pageerror、原生 guide 里宿主终端条目恰好 1 条、browser 条目缺席、文件树能打开 seed 文件并加载 editor chunk、页面内条目替换无 `native register … error`。逐条机制与本地命令见 [docs/development.md](docs/development.md) 的「挂载冒烟」。
- 环境：`NODE_OPTIONS=--max-old-space-size=4096`；**不要加 `--legacy-peer-deps`**；本机 registry 是 npmmirror，装不到新预发布时加 `--registry https://registry.npmjs.org`。
- 已知 flake：tests/fs-watch.spec.ts 满载下偶发超时（#868），隔离跑通过即可，不要为它改代码。

## 3. 发版

一句话：`main` 准备提交 → 门禁 → 打 tag → GitHub Release 触发 npm 发布。**完整步骤、版本号同步清单与 Release note 模板见 [docs/release.md](docs/release.md)。**

不可省的三件事：

- **版本号三处齐**：package.json / dsh.plugin.json / SIDEBAR_SERVICE_VERSION（tests/service.spec.ts 锁步校验）。
- **Release note 中英双语、面向用户**：写现象 / 变更 / 影响面，**不写内部发布细节**；**贡献者必须署名**（`@handle` + PR 链接表）。
- **发布后验证**：npm `dist-tags` 的 latest 指向新版本，版本端点与 tarball 可下载。

## 4. 开发红线

每条一句话；理由、示例与例外在 [docs/development.md](docs/development.md) 对应小节。

- **构建纯度**：client bundle 禁止 value-import `@dsh-external/*` 或非白名单 `@deepseek-ai/*`（tsdown.config.ts 拦截）；跨插件交互走 `ctx.betterSidebar`。
- **懒加载 chunk**：重依赖只在 `lib/client-<name>.js`，经 `/sidebar/bundle` 下发；核心 bundle 禁止静态 import `src/client/chunks/*`；`CHUNK_NAMES` 的 5 处镜像要同步。
- **i18n**：新增 zh key 必须同步 locales-ja.ts 与其余词典（tests/locales.spec.ts 守护）。
- **保存语义**：写盘前按磁盘现状还原编码与行尾；客户端只发送 LF。
- **皮肤**：视觉值只用 `--dsw-alias-*` / `--dsw-font-*` / `--ds-*`，零硬编码颜色，插件没有任何豁免面。
- **图标**：宿主 `Icon*` 默认 16px，要 14px 显式传 `size={14}`；设置页导航图标走 `settings.section.icon` 插槽，不要用「标记行 + CSS 遮盖」。
- **稳态开销**：轮询器 / socket / 观察者按可见性门控；每会话 / 每资源的东西单例化；模块级 Map 必须有上限与淘汰。
- **单一数据源**：git 状态轮询只有 src/client/ui/git-status.ts 一条，不要自建第二个。
- **接入 API 即文档**：src/client/service.ts 与 src/client/builtins/ 的行为变更必须同步 [docs/external-plugin-guide.md](docs/external-plugin-guide.md)。
- **不写运行时兼容层**：抬基线就抬下限，旧宿主固定旧插件版本（见 [docs/dsh-version-adaptation.md](docs/dsh-version-adaptation.md)）。

- **日志一律落 `logs/`**：长输出命令用 `pnpm build:log` / `pnpm test:log` 或 `bash scripts/log-run.sh <name> -- <cmd>`；不要往仓库根丢日志。
- 后台任务使用宿主 `ctx.jobs`，不要自建回放路由。

## 5. 去哪找什么

- 测试契约写在每个 spec 的头注释里；子系统到 spec 的映射与跨平台三规则在 [docs/development.md](docs/development.md)。
- Issue / PR 分诊：[.agents/skills/issue-triage/SKILL.md](.agents/skills/issue-triage/SKILL.md)（脚本在同目录）。
- 用户可见变更：CHANGELOG.md（中文权威）+ CHANGELOG_EN.md。
