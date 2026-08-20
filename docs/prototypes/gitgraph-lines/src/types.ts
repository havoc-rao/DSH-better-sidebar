/**
 * Git Graph 风格 node line：类型定义
 */
import type { ChainStep } from '../../../core/types';

/** 一条 lane（列）的视觉属性 */
export interface Lane {
  /** 颜色 */
  c: string;
  /** 是否虚线（异步不阻塞 / 镜像复刻） */
  d: boolean;
}

/** 汇入弧（上游 lane 结束 → 本行圆点） */
export interface InEdge {
  fromCol: number;
  color: string;
  dashed: boolean;
}

/** 分叉弧（本行圆点 → 子链 lane） */
export interface OutEdge {
  fromCol: number;
  toCol: number;
  color: string;
  dashed: boolean;
}

/** 摊平后的一行：对应一个 ChainStep + 该行的 lane 快照与连线 */
export interface GitGraphRow {
  step: ChainStep;
  depth: number;
  /** 圆点所在列 */
  dotCol: number;
  color: string;
  dashed: boolean;
  /** 路径唯一键（镜像使同一 step.id 可多处出现，故用 rowKey 而非 id） */
  rowKey: string;
  /** 本行所有活跃 lane 的快照 */
  lanes: Map<number, Lane>;
  /** 汇入本行圆点的弧（上游 lane 结束 / 本 lane 起始） */
  inEdges: InEdge[];
  /** 从本行圆点挂出的弧（sub chain 分叉） */
  outEdges: OutEdge[];
  /** 本行下方仍需画竖线的 lane（等待汇入） */
  extraBelow: Map<number, Lane>;
  groupKind: 'parallel' | 'branch' | null;
  groupSize: number;
  groupIndex: number;
  /** 有可展开子链 */
  canOpen: boolean;
  /** 子链来自镜像复刻（别处展开，内容等价） */
  mirrored: boolean;
  /** 递归回边（目标函数已在祖先展开路径上） */
  recursive: boolean;
  subSize: number;
}

export interface LayoutOptions {
  /** 展开状态集合；expandAll=false 时按此集合决定是否展开 sub chain */
  expandedKeys?: Set<string>;
  /** 全展开（忽略 expandedKeys） */
  expandAll?: boolean;
  /** 行数上限兜底（镜像展开可能放大规模） */
  maxRows?: number;
}

export interface LayoutResult {
  rows: GitGraphRow[];
  /** 图区总宽度（px） */
  graphWidth: number;
  truncated: boolean;
}
