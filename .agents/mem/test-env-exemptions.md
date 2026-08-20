# 本地测试：环境性失败的豁免备忘

> 适用范围：本机（`zh_CN` locale + 沙箱无 PTY）跑全量 `pnpm test` 会红 29 个**环境性失败**。
> 结论：**这些失败与代码/PR 无关，是环境限制；CI 上本就不红。** 本地想省心时用 `pnpm test:local`。

---

## 一句话用法

```bash
pnpm test:local     # = DSH_SKIP_ENV_TESTS=1 vitest run → 跳过下面 4 个环境受限文件，775 全绿
pnpm test           # 不带开关：照跑全部（= CI 行为），环境性失败照常出现
```

---

## 被跳过的是哪几个文件、为什么

默认（无开关）时 `vite`/`vitest` 会收集并运行全部 spec。设 `DSH_SKIP_ENV_TESTS=1`
后，`vitest.config.ts` 里的 `exclude` 会额外剔除如下 **4 个文件**（只剔这几个，
其余 spec 照跑——别处的回归仍会被拦截）：

| 文件 | 根因 | 性质 |
|---|---|---|
| `tests/agent-pty.spec.ts` | `node-pty` 的 `posix_spawnp failed`——本沙箱不允许分配 PTY 伪终端设备（普通 shell 能起，PTY 起不了） | 环境缺 PTY |
| `tests/smoke.spec.ts` | 同上：`pty-manager` 要 spawn 真实 shell（`posix_spawnp failed`） | 环境缺 PTY |
| `tests/host-sidebar-keeper.spec.tsx` | jsdom `MutationObserver` flush 时序在小机/沙箱里不稳定（`layoutSpy` 调用次数对不上） | jsdom 时序抖动 |
| `tests/side-card-section.spec.tsx` | 断言**英文**文案（`'Manage what the side card shows…'` 等），而本机 `LANG=zh_CN.UTF-8` → `navigator.language=zh-CN` → SSR 渲染**中文** | OS locale 是中文 |

> 三条都是「**预先存在的环境问题**」，已用基线 worktree（合入前的 `main`）复跑确认：
> 同样的文件在基线上以完全相同的原因失败，**与任何合并/代码改动无关**。

---

## 为什么这样设计（别改坏 CI）

- **`pnpm test` 保持原样**：`ci.yml` 和 `release.yml` 直接跑 `pnpm test`，所以它**必须**仍然跑全部 spec、真实的失败仍要拦。开关默认关闭就是为了不碰这条线。
- **豁免是可选、显式的**：只有设了 `DSH_SKIP_ENV_TESTS=1`（或 `pnpm test:local`）才生效。

> ⚠️ AGENTS.md 明确：**改动 `vitest.config.ts` 的 `exclude` 时必须保留全部默认排除项**
> （`exclude` 会整体替换 vitest 默认值）。本次新增的 4 条是在默认项**之后**用
> `...(skipEnvTests ? [...] : [])` 条件追加的，默认项一个都没动。

---

## 以后排查清单（万一你怀疑“是不是真坏了”）

1. 先分清是不是环境失败：看失败信息是 `posix_spawnp failed`（PTY）、`zh_CN` 中文渲染（locale）、
   还是 `MutationObserver` 计数（jsdom 时序）——这三类都不是代码 bug。
2. 想验证是否与某次改动有关：在改动前的 commit 上再跑一遍这几个文件，若同样失败即无关。
3. 想对比：`LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pnpm test` 能让 4 个 locale 类失败消失
   （`side-card-section` 15/15 全绿），其余 PTY/时序类在本沙箱仍红。

---

## 相关改动文件

- `vitest.config.ts` — 新增 `skipEnvTests` 开关 + 条件 `exclude`
- `package.json` — 新增脚本 `"test:local": "DSH_SKIP_ENV_TESTS=1 vitest run"`
