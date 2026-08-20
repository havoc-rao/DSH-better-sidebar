/**
 * Git Graph 风格 node line：包入口
 *
 * 把「嵌套调用链 → git graph 行序列 → 每行 lane SVG」独立封装，供复用：
 *
 *   import { computeAllRows, buildRowSvg, renderGitGraphHtml } from '.../gitgraph-lines/src';
 *
 *   // ① 纯逻辑：摊平为行序列
 *   const { rows, graphWidth } = computeAllRows(mainChain, { expandAll: true });
 *
 *   // ② 逐行生成 SVG（无 DOM，Node/浏览器均可）
 *   const svg = buildRowSvg(rows[i], rows[i - 1], rows[i + 1], graphWidth);
 *
 *   // ③ 一键渲染静态 HTML 查看
 *   const { html } = renderGitGraphHtml(mainChain);
 */
export { ASYNC_META, CELL_W, CURVE_R, KIND_META, LANE_BRANCH, LANE_MAIN, LANE_PARALLEL, LANE_SUB, ROW_H } from './constants';
export { computeAllRows } from './layout';
export { pathForkOut, pathMergeIn, pathV } from './paths';
export { buildRowSvg, colX } from './svg';
export { renderGitGraphHtml, renderRowHtml } from './render';
export { collectBranchMembers, collectParMembers, funcKeyOf, isDash, subColor } from './utils';
export type { GitGraphRow, InEdge, Lane, LayoutOptions, LayoutResult, OutEdge } from './types';
export type { RenderOptions } from './render';
