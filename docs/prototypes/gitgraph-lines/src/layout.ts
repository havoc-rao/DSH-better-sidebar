/**
 * Git Graph 风格 node line：Layout 算法
 *
 * 把嵌套 chain 摊平为 git graph 行序列（移植自 render/renderHtml.ts 的 computeAllRows）：
 *   - lanes  : Map<col, Lane>  当前活跃 lane
 *   - pending: 已结束、等待并入下一个节点的 lane（画汇入弧）
 *   - 列回收：lane 结束后其列号立即回收复用，避免图无限变宽（同 git graph）
 *   - 镜像展开：同一函数（key = targetFile:callee）只在首次出现处展开，其余点位
 *     按 FUNC_INDEX 就地复刻（内容等价、无需重跑 AST）
 *   - 递归回边：目标函数已在祖先展开路径（funcStack）上 → 标记 recursive 不再展开
 *
 * 纯计算、无 DOM，可在 Node / 浏览器任意侧复用。
 */
import type { ChainStep } from '../../../core/types';
import { CELL_W, LANE_BRANCH, LANE_MAIN, LANE_PARALLEL } from './constants';
import type { GitGraphRow, InEdge, Lane, LayoutOptions, LayoutResult, OutEdge } from './types';
import { collectBranchMembers, collectParMembers, funcKeyOf, isDash, subColor } from './utils';

/** 已结束、等待并入下一个节点的 lane */
interface PendingLane {
  col: number;
  color: string;
  dashed: boolean;
}

/** 镜像索引：targetFile:callee → 首次出现的 subChain */
function buildFuncIndex(steps: ChainStep[], index: Map<string, ChainStep[]>): void {
  for (const s of steps) {
    if (s.subChain && s.subChain.length) {
      const k = funcKeyOf(s);
      if (k && !index.has(k)) index.set(k, s.subChain);
      buildFuncIndex(s.subChain, index);
    }
  }
}

/** 返回该节点可展开的子链：自身携带的，或从别处镜像复刻的 */
function resolveSub(
  step: ChainStep,
  funcIndex: Map<string, ChainStep[]>,
): { chain: ChainStep[]; mirrored: boolean } | null {
  if (step.subChain && step.subChain.length) return { chain: step.subChain, mirrored: false };
  const k = funcKeyOf(step);
  if (k && funcIndex.has(k)) return { chain: funcIndex.get(k) as ChainStep[], mirrored: true };
  return null;
}

export function computeAllRows(mainChain: ChainStep[], options: LayoutOptions = {}): LayoutResult {
  const { expandedKeys, expandAll = false, maxRows = 4000 } = options;
  const expandedSet: Set<string> | null = expandAll ? null : expandedKeys || new Set<string>();
  const isExpanded = (key: string): boolean => (expandedSet ? expandedSet.has(key) : true);

  const funcIndex = new Map<string, ChainStep[]>();
  buildFuncIndex(mainChain, funcIndex);

  const usedCols = new Set<number>();
  function takeCol(): number {
    let c = 0;
    while (usedCols.has(c)) c += 1;
    usedCols.add(c);
    return c;
  }
  function freeCol(c: number): void {
    usedCols.delete(c);
  }

  const lanes = new Map<number, Lane>();
  const rows: GitGraphRow[] = [];
  let pending: PendingLane[] = [];
  let maxCol = 0;
  let truncated = false;

  function emit(
    step: ChainStep,
    depth: number,
    dotCol: number,
    lane: Lane,
    startFrom: number | null,
    rowKey: string,
  ): GitGraphRow {
    const prev = rows[rows.length - 1];
    const inEdges: InEdge[] = [];
    // ① 先把已结束的 lane 汇入本节点
    for (const p of pending) {
      inEdges.push({ fromCol: p.col, color: p.color, dashed: p.dashed });
      if (prev) prev.extraBelow.set(p.col, { c: p.color, d: p.dashed });
    }
    pending = [];
    // ② 本 lane 若在此行才起始，从父 lane 挂出一条弧
    if (startFrom !== null && startFrom !== undefined && startFrom !== dotCol) {
      inEdges.push({ fromCol: startFrom, color: lane.c, dashed: lane.d });
    }
    lanes.set(dotCol, lane);
    if (dotCol > maxCol) maxCol = dotCol;
    const row: GitGraphRow = {
      step,
      depth,
      dotCol,
      color: lane.c,
      dashed: lane.d,
      rowKey,
      lanes: new Map(lanes),
      inEdges,
      outEdges: [],
      extraBelow: new Map(),
      groupKind: null,
      groupSize: 0,
      groupIndex: 0,
      canOpen: false,
      mirrored: false,
      recursive: false,
      subSize: 0,
    };
    rows.push(row);
    return row;
  }

  /** 节点子链：从本行圆点分叉出新 lane，递归后回收列号并挂 merge 弧 */
  function expandSub(
    step: ChainStep,
    depth: number,
    parentRow: GitGraphRow,
    rowKey: string,
    funcStack: Set<string>,
  ): void {
    const res = resolveSub(step, funcIndex);
    if (!res) return;
    const fk = funcKeyOf(step);
    // 环检测：目标函数已在当前展开路径上 → 回边，不展开
    if (fk && funcStack.has(fk)) {
      parentRow.recursive = true;
      parentRow.mirrored = true;
      parentRow.subSize = res.chain.length;
      return;
    }
    parentRow.canOpen = true;
    parentRow.mirrored = res.mirrored;
    parentRow.subSize = res.chain.length;
    if (!isExpanded(rowKey) || truncated) return;

    const col = takeCol();
    const color = subColor(depth + 1);
    const lane: Lane = { c: color, d: isDash(step) || res.mirrored };
    parentRow.outEdges.push({ fromCol: parentRow.dotCol, toCol: col, color, dashed: lane.d });
    lanes.set(col, lane);
    if (col > maxCol) maxCol = col;
    if (fk) funcStack.add(fk);
    walk(res.chain, depth + 1, col, lane, null, rowKey, funcStack);
    if (fk) funcStack.delete(fk);
    lanes.delete(col);
    freeCol(col);
    pending.push({ col, color, dashed: lane.d });
  }

  function walk(
    steps: ChainStep[],
    depth: number,
    myCol: number,
    myLane: Lane,
    startFrom: number | null,
    pathPrefix: string,
    funcStack: Set<string>,
  ): void {
    let firstStart = startFrom;
    for (let i = 0; i < steps.length; i += 1) {
      if (rows.length >= maxRows) {
        truncated = true;
        return;
      }
      const s = steps[i];

      // 并行组 / 互斥分支：成员各占一列，从主 lane 挂出弧线
      let grp: ChainStep[] | null = null;
      let gkind: 'parallel' | 'branch' | null = null;
      let gcolor = LANE_MAIN;
      if (s.parallelGroup && !s.branchKey) {
        grp = collectParMembers(steps, i);
        gkind = 'parallel';
        gcolor = LANE_PARALLEL;
      } else if (s.branchKey) {
        grp = collectBranchMembers(steps, i, s.branchKey);
        gkind = 'branch';
        gcolor = LANE_BRANCH;
      }

      if (grp) {
        const memberCols: number[] = [];
        for (let k = 0; k < grp.length; k += 1) {
          const m = grp[k];
          const col = takeCol();
          const lane: Lane = { c: gcolor, d: isDash(m) };
          const key = pathPrefix + '/' + (i + k);
          const row = emit(m, depth, col, lane, myCol, key);
          row.groupKind = gkind;
          row.groupSize = grp.length;
          row.groupIndex = k;
          memberCols.push(col);
          expandSub(m, depth, row, key, funcStack);
        }
        for (const c of memberCols) {
          lanes.delete(c);
          freeCol(c);
          pending.push({ col: c, color: gcolor, dashed: false });
        }
        i += grp.length - 1;
        firstStart = null;
        continue;
      }

      const key = pathPrefix + '/' + i;
      const row = emit(s, depth, myCol, { c: myLane.c, d: myLane.d }, firstStart, key);
      firstStart = null;
      expandSub(s, depth, row, key, funcStack);
    }
  }

  walk(mainChain, 0, takeCol(), { c: LANE_MAIN, d: false }, null, 'r', new Set());
  const graphWidth = (maxCol + 1) * CELL_W + 6;
  return { rows, graphWidth, truncated };
}
