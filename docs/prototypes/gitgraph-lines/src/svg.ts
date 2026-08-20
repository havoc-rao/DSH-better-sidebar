/**
 * Git Graph 风格 node line：单行 SVG 绘制
 *
 * 移植自 render/renderHtml.ts 的 buildGraph，DOM API → 字符串输出：
 *   - lane 竖线（跨行连续）
 *   - 汇入弧（上游 lane 结束 / 本 lane 起始）
 *   - 分叉弧（sub chain 挂出）
 *   - 圆点形态：叶子=实心圆；可展开=实线环（折叠时含内点）；镜像=虚线环；
 *     递归回边=虚线环+中心横杠；无法展开=淡虚线环
 */
import type { GitGraphRow, Lane } from './types';
import { CELL_W, ROW_H } from './constants';
import { pathForkOut, pathMergeIn, pathV } from './paths';

/** 列号 → 圆点 x 坐标 */
export function colX(col: number): number {
  return col * CELL_W + CELL_W / 2;
}

/** 某行的出边是否指向该列（判断竖线连续性） */
function hasOutTo(row: GitGraphRow | undefined, col: number): boolean {
  if (!row) return false;
  for (const e of row.outEdges) if (e.toCol === col) return true;
  return false;
}

function stroke(pathD: string, lane: Lane): string {
  let s = `<path d="${pathD}" fill="none" stroke="${lane.c}" stroke-width="2.2" stroke-linecap="round"`;
  if (lane.d) s += ' stroke-dasharray="4 3.5"';
  s += '/>';
  return s;
}

/** 绘制一行 lane 图，返回该行的 SVG 字符串 */
export function buildRowSvg(
  row: GitGraphRow,
  prev: GitGraphRow | undefined,
  next: GitGraphRow | undefined,
  graphWidth: number,
  expandedKeys?: Set<string>,
): string {
  const mid = ROW_H / 2;
  const parts: string[] = [];

  // ① lane 竖线（跨行连续）
  const cols = new Set<number>();
  row.lanes.forEach((_v, k) => cols.add(k));
  row.extraBelow.forEach((_v, k) => cols.add(k));
  cols.add(row.dotCol);
  cols.forEach((c) => {
    const lane: Lane = row.lanes.get(c) || row.extraBelow.get(c) || { c: row.color, d: row.dashed };
    const above = !!prev && (prev.lanes.has(c) || prev.extraBelow.has(c) || hasOutTo(prev, c));
    const below = (!!next && next.lanes.has(c)) || row.extraBelow.has(c);
    const x = colX(c);
    if (c === row.dotCol) {
      if (above) parts.push(stroke(pathV(x, 0, mid), lane));
      if (below) parts.push(stroke(pathV(x, mid, ROW_H), lane));
    } else if (above && below) {
      parts.push(stroke(pathV(x, 0, ROW_H), lane));
    } else if (above) {
      parts.push(stroke(pathV(x, 0, mid), lane));
    } else if (below) {
      parts.push(stroke(pathV(x, mid, ROW_H), lane));
    }
  });

  // ② 汇入弧（上游 lane 结束 / 本 lane 起始）
  for (const e of row.inEdges) {
    parts.push(stroke(pathMergeIn(colX(e.fromCol), colX(row.dotCol), mid), { c: e.color, d: e.dashed }));
  }
  // ③ 分叉弧（sub chain 挂出）
  for (const e of row.outEdges) {
    parts.push(stroke(pathForkOut(colX(row.dotCol), colX(e.toCol), mid), { c: e.color, d: e.dashed }));
  }

  // ④ 圆点形态
  const x = colX(row.dotCol);
  if (row.recursive) {
    parts.push(
      `<circle class="g-ring" cx="${x}" cy="${mid}" r="5.6" stroke="${row.color}" stroke-width="2.2" fill="none" stroke-dasharray="3 2"/>`,
    );
    parts.push(
      `<path d="M ${x - 2.6} ${mid} L ${x + 2.6} ${mid}" stroke="${row.color}" stroke-width="1.8" stroke-linecap="round"/>`,
    );
  } else if (row.canOpen) {
    const dash = row.mirrored ? ' stroke-dasharray="3.2 2.2"' : '';
    parts.push(
      `<circle class="g-ring" cx="${x}" cy="${mid}" r="6.2" stroke="${row.color}" stroke-width="2.6" fill="none"${dash}/>`,
    );
    // 折叠态含内点；已展开（在 expandedKeys 中）则空心环
    if (!expandedKeys || !expandedKeys.has(row.rowKey)) {
      parts.push(`<circle cx="${x}" cy="${mid}" r="2.5" fill="${row.color}"/>`);
    }
  } else if (row.step.skipped) {
    // 无法复刻（超出追踪深度 / 目标未解析）
    parts.push(
      `<circle class="g-ring" cx="${x}" cy="${mid}" r="5.2" stroke="${row.color}" stroke-width="2" fill="none" stroke-dasharray="2.4 2.4" opacity=".75"/>`,
    );
  } else {
    parts.push(
      `<circle class="g-dot" cx="${x}" cy="${mid}" r="5.2" fill="${row.color}" stroke="var(--bg, #fff)" stroke-width="1.8"/>`,
    );
  }

  return `<svg class="graph" width="${graphWidth}" height="${ROW_H}" xmlns="http://www.w3.org/2000/svg">${parts.join(
    '',
  )}</svg>`;
}
