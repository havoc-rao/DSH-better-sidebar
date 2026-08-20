/**
 * Git Graph 风格 node line：路径生成（竖线 / 汇入弧 / 分叉弧）
 *
 * 移植自 render/renderHtml.ts 的 pathV / pathMergeIn / pathForkOut。
 */
import { CURVE_R, ROW_H } from './constants';

/** lane 竖线：从 (x, y1) 竖直画到 (x, y2) */
export function pathV(x: number, y1: number, y2: number): string {
  return ['M', x, y1, 'L', x, y2].join(' ');
}

/** 汇入：上一行 lane 竖直下行 → 圆角 → 水平进入本行圆点 */
export function pathMergeIn(fromX: number, dotX: number, mid: number): string {
  if (fromX === dotX) return pathV(fromX, 0, mid);
  const sign = dotX > fromX ? 1 : -1;
  const r = Math.min(CURVE_R, Math.abs(dotX - fromX), mid);
  return ['M', fromX, 0, 'L', fromX, mid - r, 'Q', fromX, mid, fromX + sign * r, mid, 'L', dotX, mid].join(' ');
}

/** 分叉：本行圆点水平外移 → 圆角 → 垂直下行至行底 */
export function pathForkOut(dotX: number, toX: number, mid: number): string {
  if (dotX === toX) return pathV(dotX, mid, ROW_H);
  const sign = toX > dotX ? 1 : -1;
  const r = Math.min(CURVE_R, Math.abs(toX - dotX), ROW_H - mid);
  return ['M', dotX, mid, 'L', toX - sign * r, mid, 'Q', toX, mid, toX, mid + r, 'L', toX, ROW_H].join(' ');
}
