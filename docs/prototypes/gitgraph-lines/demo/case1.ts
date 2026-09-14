#!/usr/bin/env npx ts-node
/**
 * demo case1：手工构造一个覆盖各类调用语义的 trace，验证 git graph node line 渲染
 *
 *   - 串行主链（entry → stage → ...）
 *   - Promise.all 并行组（3 个 RPC 各占一列，弧线挂出后汇入）
 *   - if 互斥分支（isVIP / !isVIP，带 subChain）
 *   - func 点位 + subChain（DFS 拆开的子链）
 *   - 镜像展开（同一函数二次出现，按 targetFile:callee 复刻）
 *   - 递归回边（子链里再次出现祖先函数 → 虚线环+横杠）
 *   - fire-forget 异步（虚线 lane）
 *   - 无法展开（skipped → 淡虚线环）
 *
 * 运行：
 *   npx ts-node scripts/request-trace/pkgs/gitgraph-lines/demo/case1.ts
 *   输出：demo/out/case1.html（浏览器打开查看）
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ChainStep } from '../../../core/types';
import { buildRowSvg, computeAllRows, renderGitGraphHtml } from '../src/index';

function step(partial: Partial<ChainStep> & { id: string; label: string }): ChainStep {
  return {
    kind: 'rpc',
    file: 'demo.ts',
    line: 0,
    col: 0,
    details: {},
    ...partial,
  };
}

/** 手工构造 mainChain */
function buildChain(): ChainStep[] {
  // processMessage 的 subChain（含一层递归 → 触发递归回边）
  const processMsgSub: ChainStep[] = [
    step({ id: 'parse.ts:6:split', label: 'splitChunk', kind: 'rpc', scene: 'split', file: 'parse.ts', line: 6 }),
    step({
      id: 'recurse.ts:4:recurse',
      label: 'recurse',
      kind: 'func',
      file: 'recurse.ts',
      line: 4,
      callee: 'recurse',
      targetFile: 'recurse.ts',
      targetLine: 2,
      subChain: [
        step({ id: 'recurse.ts:5:llm', label: '摘要生成', kind: 'llm', scene: 'summarize', file: 'recurse.ts', line: 5 }),
        // 祖先函数再次出现 → 递归回边
        step({ id: 'parse.ts:1:processMsg#inner', label: 'processMessage', kind: 'func', file: 'parse.ts', line: 1, callee: 'processMessage', targetFile: 'parse.ts', targetLine: 1 }),
      ],
    }),
  ];

  return [
    step({ id: 'entry.ts:1:handleChat', label: 'handleChat', kind: 'entry', scene: 'chat', file: 'entry.ts', line: 1 }),
    step({ id: 'entry.ts:3:auth', label: '鉴权', kind: 'stage', file: 'entry.ts', line: 3 }),
    // Promise.all 并行组
    step({ id: 'entry.ts:6:getUser', label: 'getUser', kind: 'rpc', scene: 'getUser', parallelGroup: 'pg@entry.ts:6', file: 'entry.ts', line: 6 }),
    step({ id: 'entry.ts:6:getOrders', label: 'getOrders', kind: 'rpc', scene: 'getOrders', parallelGroup: 'pg@entry.ts:6', file: 'entry.ts', line: 6 }),
    step({ id: 'entry.ts:6:getCoupon', label: 'getCoupon', kind: 'rpc', scene: 'getCoupon', parallelGroup: 'pg@entry.ts:6', file: 'entry.ts', line: 6 }),
    // if 互斥分支：isVIP 带 subChain
    step({
      id: 'entry.ts:9:vipGift',
      label: '发放会员券',
      kind: 'tool',
      file: 'entry.ts',
      line: 9,
      branchKey: 'if@entry.ts:9',
      branchCond: 'isVIP',
      branchPath: 'if (isVIP)',
      subChain: [step({ id: 'entry.ts:10:coupon', label: '查询券包', kind: 'rpc', scene: 'couponQuery', file: 'entry.ts', line: 10 })],
    }),
    // 分支另一路：非 VIP
    step({ id: 'entry.ts:12:marketing', label: '普通营销文案', kind: 'llm', scene: 'marketing', branchKey: 'if@entry.ts:9', branchCond: '!(isVIP)', file: 'entry.ts', line: 12 }),
    // func 点位：首次出现 → 展开 subChain
    step({
      id: 'entry.ts:15:processMsg',
      label: 'processMessage',
      kind: 'func',
      file: 'entry.ts',
      line: 15,
      callee: 'processMessage',
      targetFile: 'parse.ts',
      targetLine: 1,
      subChain: processMsgSub,
    }),
    // func 点位：镜像（同一函数二次出现，仅留 skipped）
    step({
      id: 'entry.ts:16:processMsg#2',
      label: 'processMessage',
      kind: 'func',
      file: 'entry.ts',
      line: 16,
      callee: 'processMessage',
      targetFile: 'parse.ts',
      targetLine: 1,
      skipped: '该函数已在其它点位展开（防环）',
    }),
    // fire-forget 异步上报
    step({ id: 'entry.ts:19:report', label: 'reportAnalytics', kind: 'rpc', scene: 'analytics', asyncMode: 'fire-forget', file: 'entry.ts', line: 19 }),
    // 无法展开
    step({ id: 'entry.ts:21:ext', label: 'callExternal', kind: 'func', callee: 'notResolved', targetFile: 'unknown.ts', targetLine: 0, file: 'entry.ts', line: 21, skipped: '无法解析目标函数（超出追踪范围）' }),
  ];
}

function main(): void {
  const chain = buildChain();

  // ① 纯逻辑：摊平为 git graph 行序列
  const { rows, graphWidth, truncated } = computeAllRows(chain, { expandAll: true });
  console.log(`✔ layout: ${rows.length} 行, 图宽 ${graphWidth}px, truncated=${truncated}`);
  console.log('');

  // ② 每行 SVG（编程 API 示例：打印前 3 行的 svg 尺寸）
  for (let i = 0; i < Math.min(3, rows.length); i += 1) {
    const svg = buildRowSvg(rows[i], rows[i - 1], rows[i + 1], graphWidth, new Set(rows.map((r) => r.rowKey)));
    console.log(`  行 ${i + 1} ${rows[i].step.label.padEnd(16)} dotCol=${rows[i].dotCol} svgLen=${svg.length}`);
  }

  // ③ 渲染静态 HTML 并落盘
  const outDir = path.join(__dirname, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const { html } = renderGitGraphHtml(chain, {
    title: 'demo case1 · Git Graph node line',
    subtitle: `手工构造 trace ｜ ${rows.length} 行 ｜ 覆盖：并行组/分支/镜像/递归回边/fire-forget/无法展开`,
  });
  const outFile = path.join(outDir, 'case1.html');
  fs.writeFileSync(outFile, html, 'utf-8');
  console.log('');
  console.log(`✔ HTML 已生成: ${outFile}`);
}

if (require.main === module) {
  main();
}
