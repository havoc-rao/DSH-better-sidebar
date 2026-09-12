/**
 * Git Graph 风格 node line：几何常量 / 配色 / 元信息
 *
 * 对齐 VSCode Git Graph / GitLens 视觉，与 render/renderHtml.ts 保持同一套参数。
 */
import type { NodeKind } from '../../../core/types';

/** 几何参数（与 renderHtml.ts 的 --row-h / --cell-w 保持一致） */
export const CELL_W = 22;
export const ROW_H = 34;
export const CURVE_R = 11;

/** lane 主色：亮/暗主题下均有足够对比度（取自 git graph 常见配色） */
export const LANE_MAIN = '#4c8dff'; // 主链
export const LANE_PARALLEL = '#21c9a8'; // 并行组
export const LANE_BRANCH = '#f0b429'; // 互斥分支
/** 子链路按嵌套深度循环取色 */
export const LANE_SUB = ['#b76cf0', '#ff8a3d', '#ff5d7e', '#3ecf8e', '#4dc4ff', '#e879f9'];

/** 节点类型元信息（图标 / 颜色 / 名称） */
export const KIND_META: Record<NodeKind, { color: string; icon: string; name: string }> = {
  entry: { color: '#ff8a3d', icon: '◉', name: '入口' },
  stage: { color: '#4c8dff', icon: '▤', name: '阶段' },
  llm: { color: '#f0b429', icon: '◆', name: 'LLM' },
  rpc: { color: '#b76cf0', icon: '◎', name: 'RPC' },
  tool: { color: '#3ecf8e', icon: '⚙', name: 'Tool' },
  resume: { color: '#8b95a5', icon: '↺', name: 'Resume' },
  func: { color: '#4c8dff', icon: '↪', name: '函数跳转' },
};

/** 异步语义元信息 */
export const ASYNC_META: Record<string, { label: string; color: string }> = {
  parallel: { label: '并行', color: '#21c9a8' },
  'fire-forget': { label: '异步', color: '#ff8a3d' },
  pending: { label: '挂起', color: '#ff5d7e' },
};
