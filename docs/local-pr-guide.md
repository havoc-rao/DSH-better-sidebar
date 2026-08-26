# 本地提 PR 操作指导（dsh-better-sidebar）

> 依据 2026-08-27 实操 PR #420（TOC 按钮被代码块 header 遮挡修复）全流程整理。
> 适用范围：本仓库所有功能 / 修复 / 测试等非文档改动（规则见 AGENTS.md §0：改动必须走分支 + PR，review 合并后才进 main；仅纯文档可直推 main）。

## 0. 出发前检查

```bash
git status -s          # 先看工作区有没有无关脏改动 / 未跟踪残留
```

- 无关脏改动（其他任务改的文件、`??` 目录如 samples/ 等）：**不要带进新分支**——只 add 本次相关文件。
- 基线建议用已同步的 upstream：`git fetch offical --prune && git fetch origin --prune`。

## 1. 建分支

```bash
git switch -c fix/<topic> offical/main     # 或基于已同步的 main-offical
# 提交时只 add 本次相关文件：
git add <files...> && git commit -m "fix: ..."
```

- 分支命名：`fix/*` / `feat/*`（仓库约定）。
- 提交信息用 conventional commits（`fix:` / `feat:` / `docs:` / `chore(release):`）。

## 2. 本地验证（建议全绿再推）

```bash
pnpm run typecheck
pnpm test                        # 单元测试
pnpm build && pnpm pack          # 打包！见坑 1
bash scripts/e2e-mount.sh        # 挂载冒烟（真实 DSH + Chromium）；可加 --grep 只跑相关 spec
```

### 本机已知坑（2026-08 实测）

1. **旧 tarball 干扰**：`scripts/e2e-mount.sh` 按 **mtime 选最新**的 `dsh-better-sidebar-*.tgz`——仓库里可能残留过期 tarball（实测 8-20 的 0.14.0），导致挂载的产物不是最新代码。**必须先 `pnpm pack`**（必要时删掉旧 tgz），再跑 mount。
2. **dsh CLI 版本**：PATH 上的 `dsh`（≥0.1.2）会 **daemonize**（打印 `dsh web: http://...` 后 CLI 立即退出），mount 脚本的存活检查误判「dsh web 提前退出」。用 CI 钉住版本跑：
   ```bash
   # /tmp/dshbin/dsh 包装器：
   #   #!/usr/bin/env bash
   #   export npm_config_cache=/tmp/dsh-npm-cache
   #   exec npx -y --package @deepseek-ai/dsh@0.1.1-rc.2 dsh "$@"
   # 然后：
   PATH="/tmp/dshbin:$PATH" bash scripts/e2e-mount.sh
   ```
   - npx 必须用 **`--package <pkg> dsh`** 形式；写成 `npx -y <pkg> dsh ...` 位置参数会让 npx 误吃后续参数（报 `--profile <name> is required`）。
   - 不要用 `DSH_CMD="npx ..."` 环境变量覆盖——脚本 `set -u` 下该路径会崩（变量名后跟中文标点被误解析）。
   - `npm_config_cache` 重定向：本机 `~/.npm` 有 root 属主文件时 npx 报 `EPERM`。
3. **PTY 环境失败**：沙箱里 node-pty 无法 spawn（`agent-pty.spec.ts` / `smoke.spec.ts` 的 `posix_spawnp failed`）。与改动无关——可用 `git stash` 验证基线同样失败来举证。
4. **全量 e2e 一起跑会互相干扰**：14 个 mount/drag/float spec 共享同一个 server 与 workspace，交互类（drag/float）可能误伤。改动只影响 mount 时用 `bash scripts/e2e-mount.sh --grep "mount.e2e"`。
5. 挂载冒烟结束后确认没有遗留的 daemon 化 `dsh web` 进程（`lsof -nP -iTCP -sTCP:LISTEN` 找 node 进程 kill）。

## 3. 推送

```bash
git push -u origin fix/<topic>                # origin = 个人 fork
git push --force-with-lease origin fix/<topic> # 之后 amend 提交时强推（PR 分支允许）
```

## 4. 创建 PR

### 4a. 有 gh CLI（推荐）

```bash
gh pr create --repo omdsh-dev/DSH-better-sidebar \
  --base main --head havoc-rao:fix/<topic> \
  --title "..." --body "..."
```

### 4b. 无 gh：GitHub API + macOS 钥匙串 token（本次 PR #420 实际路径）

```bash
# 1) 确认 upstream 默认分支（本仓库为 main）
curl -s https://api.github.com/repos/omdsh-dev/DSH-better-sidebar | python3 -c "import json,sys; print(json.load(sys.stdin).get('default_branch'))"

# 2) 从钥匙串取 GitHub token（git 的 osxkeychain helper 存过 https 认证）
#    —— token 只在单条命令内存中使用，绝不打印明文 / 写文件 / 进提交
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p')

# 3) 创建 PR（head 格式 = "<fork 用户名>:<分支名>"，base = upstream 默认分支）
curl -s -X POST https://api.github.com/repos/omdsh-dev/DSH-better-sidebar/pulls \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -d '{"title":"fix: ...","head":"havoc-rao:fix/<topic>","base":"main","body":"..."}'
# 成功返回 {"number": N, "html_url": "https://github.com/omdsh-dev/DSH-better-sidebar/pull/N", ...}
```

## 5. PR body 结构（PR #420 的写法，可直接套）

1. **Problem**：现象 + 根因（精确到文件/行号/样式证据，如 "host CodeBlock.module.css 的 .bannerWrap 是 `position: sticky; top: 0; z-index: 6`，盖住 z-index 3 的 TOC bar"）。
2. **Fix**：每个文件改了什么、为什么。
3. **Regression guard**：测试如何防回归（种子数据改动 + 什么断言在旧代码下必红）。
4. **Verification**：typecheck / 单测 / 挂载冒烟结果（含环境限制说明）。
5. **关联**：设计文档 / AGENTS.md 同步更新记录（本仓库要求 z-index 等契约改动同步 docs/plans/* 与 tests/theme.spec.ts）。

## 6. 收尾

- CI 全绿后等 review；merge 后清理：`git branch -d fix/<topic>`、`git push origin --delete fix/<topic>`。
- 未跟踪残留（如 samples/）与本任务无关时先确认来源再决定删除 / gitignore / 保留（不留 `??` 垃圾进 git status）。