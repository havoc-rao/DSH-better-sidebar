# fixtures 说明

## `material-icon-theme.sample.json`

从 **material-icon-theme 5.38.1**（`pkief.material-icon-theme-5.38.1.vsix`）提取的**真实数据子集**：
28 个位真实 def id 中的 27 个真实图标定义（SVG 原文件转 `data:image/svg+xml;base64,…`）、
真实映射键（`tsconfig.json` / `package.json` / `justfile` / `.pug-lintrc.json` /
`d.ts` / `ts` / `cpp` / `node_modules` / `src` / `.git` / `rust` 等）、
真实默认四件套（`file` / `folder` / `folder-open` / `folder-root` / `folder-root-open`）、
以及真实存在的 `languageIds` / `light` 片段（测试断言引擎**忽略**它们）。

### 再生成（换主题大版本时）

```bash
unzip -o /path/to/pkief.material-icon-theme-<ver>.vsix -d /tmp/mi 'extension/*'
node - <<'EOF'   # 步骤：读 /tmp/mi/extension/dist/material-icons.json，
                 # 把选中的 iconDefinitions 的 iconPath 相对路径换成对应 SVG 的 base64 data URL，
                 # 组装与现夹具相同形状的 JSON 写入本目录。
EOF
```

生成的脚本化版本见 `tools/convert-vscode-icon-theme.mjs`（设计文档
`docs/plans/2026-08-25-vscode-icon-theme-plugin-design.md` §8.1 计划产出，P3 实施）；
在工具落地前，夹具刷新按上述手工步骤执行，并在 `tests/icon-theme.spec.ts` 的
断言注释中同步真实键名（`d.ts → typescript-def` 等）。