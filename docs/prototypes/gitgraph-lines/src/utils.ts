/**
 * Git Graph 风格 node line：通用工具
 *
 * 从 render/renderHtml.ts 的浏览器端 JS 抽出，去掉 DOM 依赖，仅保留纯计算。
 */
import type { ChainStep } from '../../../core/types';
import { LANE_SUB } from './constants';

/** 第 depth 层子链路的 lane 颜色（循环取色） */
export function subColor(depth: number): string {
  return LANE_SUB[(depth - 1 + LANE_SUB.length) % LANE_SUB.length];
}

/** fire-forget / pending → 虚线（非阻塞语义） */
export function isDash(step: ChainStep): boolean {
  return step.asyncMode === 'fire-forget' || step.asyncMode === 'pending';
}

/** 函数唯一 key（镜像索引 / 递归回边检测共用） */
export function funcKeyOf(step: ChainStep): string | null {
  if (!step.targetFile || !step.callee) return null;
  return step.targetFile + ':' + step.callee;
}

/** 相邻同 parallelGroup 成员收集 */
export function collectParMembers(steps: ChainStep[], i: number): ChainStep[] {
  const grp = [steps[i]];
  let j = i + 1;
  while (j < steps.length && steps[j].parallelGroup === steps[i].parallelGroup && !steps[j].branchKey) {
    grp.push(steps[j]);
    j += 1;
  }
  return grp;
}

/** 相邻同 branchKey 成员收集（互斥分支） */
export function collectBranchMembers(steps: ChainStep[], i: number, bk: string): ChainStep[] {
  const grp = [steps[i]];
  let j = i + 1;
  while (j < steps.length && steps[j].branchKey === bk) {
    grp.push(steps[j]);
    j += 1;
  }
  return grp;
}
