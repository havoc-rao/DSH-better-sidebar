# dsh-material-icon-theme（参考实现）

把 **material-icon-theme** 移植到 better-sidebar 的文件图标主题扩展点
（`ctx.betterSidebar.registerIconTheme`，v0.16.0+）的**参考插件**。完整生成数据
（~1.9MB）不入库——用你本地的 VSIX 一条命令再生成。

这是「VSCode 插件体系契约兼容」的首个落地案例（设计见
`docs/plans/2026-08-25-vscode-icon-theme-plugin-design.md`）：主题贡献点的声明式
载荷（`contributes.iconThemes` → 图标 JSON + SVG）被官方转换工具重写为纯数据模块，
运行时只调一次 `registerIconTheme`。

## 文件

| 路径 | 说明 |
|---|---|
| `src/client/index.tsx` | 插件入口：`features` gate + `ctx.effect` 注册（HMR-safe） |
| `src/client/icons.generated.ts` | **生成物，不入库**：归一化 `IconThemeDocument`（1251 定义 / 12820 映射，data URL 资产 + MIT 许可头） |
| `scripts/convert.mjs` | 从本地 VSIX 再生成（解压 → 官方转换器 → 写盘） |

## 使用

1. **再生成图标数据**（一次性；产物 ~1.9MB source / 374KB gzip）：

   ```bash
   node scripts/convert.mjs /path/to/pkief.material-icon-theme-5.38.1.vsix
   ```

2. **作为普通 Cordis 插件挂载**（与任何消费插件相同，见 AGENTS.md §9）：

   - `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 加
     `"dsh-material-icon-theme": "link:<本目录绝对路径>"`；
   - `~/.dsh/profiles/<profile>/cordis.patch.yml` 加挂载行；
   - `pnpm install`，浏览器硬刷新（client 改动热加载，无需重启 `dsh web`）。

3. **启用**：设置页 → 「侧边卡片」→ editor 卡齿轮 → **文件图标主题** →
   `Material Icon Theme`（无主题插件时该行不出现）。文件树行与带路径的
   编辑器 tab 即刻换用 Material 图标；选回「内置图标」即还原。

## 验证

- 仓库 `tests/icon-theme.spec.ts` 用本主题 5.38.1 的真实数据子集锁定解析算法
  （`tsconfig.json` / `d.ts` 最长后缀 / `src` 展开态 / 空 root 变体兜底…）；
- `tests/convert-icon-theme.spec.ts` 锁定转换工具行为；真实全量转换已手工验证
  （1251 定义，引擎逐行解析通过）。

## 许可

Material Icon Theme 是 MIT（VSIX 内 `LICENSE.txt` 原文随生成模块逐字保留）；
本参考实现的组织与脚本为 MIT（随仓库）。