# @trace/gitgraph-lines

Git Graph 风格 **node line** 渲染器：把嵌套调用链摊平为 git graph 行序列，并为每行生成 lane SVG（竖线 / 汇入弧 / 分叉弧 / 圆点形态）。

从 `scripts/request-trace/render/renderHtml.ts` 独立封装，逻辑逐行对齐，仅去掉 DOM 依赖（纯字符串/纯计算），Node 与浏览器均可复用。

## 结构

```
pkgs/gitgraph-lines/
├── src/
│   ├── constants.ts   # 几何参数 / 配色 / 类型元信息
│   ├── utils.ts       # 纯计算工具（取色/虚线判定/组成员收集）
│   ├── types.ts       # Lane / InEdge / OutEdge / GitGraphRow
│   ├── paths.ts       # 路径生成：pathV / pathMergeIn / pathForkOut
│   ├── layout.ts      # 核心算法：computeAllRows（嵌套 chain → 行序列）
│   ├── svg.ts         # 单行 SVG：buildRowSvg（lane 竖线 + 弧线 + 圆点）
│   ├── render.ts      # 静态 HTML 渲染：renderGitGraphHtml
│   └── index.ts       # 统一导出
└── demo/
    ├── case1.ts       # 小 case：手工构造 trace → 生成 HTML
    └── out/case1.html # 生成产物（浏览器打开查看）
```

## 用法

```bash
# 运行 demo（生成 demo/out/case1.html）
npx ts-node scripts/request-trace/pkgs/gitgraph-lines/demo/case1.ts
```

```ts
import { computeAllRows, buildRowSvg, renderGitGraphHtml } from '../pkgs/gitgraph-lines/src';

// ① 纯逻辑：摊平为行序列（返回每行的 lane 快照 / 汇入 / 分叉 / 圆点形态）
const { rows, graphWidth } = computeAllRows(mainChain, { expandAll: true });

// ② 逐行生成 SVG（无 DOM）
const svg = buildRowSvg(rows[i], rows[i - 1], rows[i + 1], graphWidth);

// ③ 一键渲染静态 HTML 查看
const { html } = renderGitGraphHtml(mainChain);
```

## Git Graph 约定（对齐 VSCode Git Graph / GitLens）

| 元素 | 说明 |
|---|---|
| lane 竖线 | 一条 lane 在其存活的所有行里画满行高竖线，跨行连成整条 |
| 分叉弧 | 父节点圆点 → 水平外移 → 二次贝塞尔圆角 → 垂直向下 |
| 汇入弧 | 上一行 lane 竖直下行 → 圆角 → 水平进入圆点 |
| 圆点形态 | 叶子=实心圆；可展开=实线环（含内点）；镜像=虚线环；递归回边=虚线环+中心横杠；无法展开=淡虚线环 |
| 列回收 | lane 结束后列号立即回收复用，避免图无限变宽（同 git graph） |
| 虚线 lane | fire-forget / pending（非阻塞）、镜像复刻子链 |
| 镜像展开 | 同一函数（`targetFile:callee`）只在首次展开，其余点位按索引复刻，内容等价 |
| 递归回边 | 目标函数已在祖先展开路径 → 虚线环+横杠，不再展开 |

## 数据形状

输入为 `ChainStep[]`（mainChain），定义见 `scripts/request-trace/core/types.ts`：
- `parallelGroup`：同一 `Promise.all` 的成员共享 → 并行组
- `branchKey` / `branchCond`：if/switch 互斥分支
- `subChain`：func 点位 DFS 拆出的子链
- `asyncMode: 'fire-forget' | 'pending'` → 虚线 lane
- `skipped`：未展开原因（无法复刻时显示）
