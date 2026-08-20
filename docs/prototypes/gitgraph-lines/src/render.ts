/**
 * Git Graph 风格 node line：静态 HTML 渲染器
 *
 * 把 LayoutResult 渲染为单文件 HTML（纯静态、无需 JS 交互即可看图），
 * 用于快速验证 node line 效果 / 嵌入到其它工具的导出流程。
 */
import type { ChainStep } from '../../../core/types';
import { ASYNC_META, KIND_META, LANE_BRANCH, LANE_MAIN, LANE_PARALLEL, LANE_SUB, ROW_H } from './constants';
import { computeAllRows } from './layout';
import { buildRowSvg } from './svg';
import type { GitGraphRow, LayoutOptions, LayoutResult } from './types';

export interface RenderOptions {
  /** 页面标题（默认用入口文件） */
  title?: string;
  /** 副标题 */
  subtitle?: string;
  /** 展开策略，透传给 layout */
  layout?: LayoutOptions;
  /** 是否高亮 recursive/mirrored/skipped（默认 true） */
  annotate?: boolean;
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pathBase(p: string): string {
  const parts = String(p).split('/');
  return parts.length > 2 ? parts.slice(-2).join('/') : p;
}

function kindMeta(k: string): { color: string; icon: string; name: string } {
  return KIND_META[k as keyof typeof KIND_META] || { color: '#8a93a0', icon: '·', name: k };
}

/** 渲染一行内容（svg + 文字信息），返回 HTML 字符串 */
export function renderRowHtml(
  row: GitGraphRow,
  graphWidth: number,
  opts: { expandedKeys?: Set<string>; annotate?: boolean; index: number; prev?: GitGraphRow; next?: GitGraphRow },
): string {
  const step = row.step;
  const km = kindMeta(step.kind);
  const parts: string[] = [];
  parts.push(`<div class="row" id="row-${opts.index}">`);
  parts.push(buildRowSvg(row, opts.prev, opts.next, graphWidth, opts.expandedKeys));

  const content: string[] = [];
  content.push(`<div class="content" style="padding-left:${Math.min(row.dotCol, 8) * 10 + 8}px">`);

  // 类型图标
  content.push(`<span class="kico" style="color:${km.color}">${km.icon}</span>`);
  // 并行/分支组徽标
  if (row.groupKind) {
    const label = row.groupKind === 'parallel' ? `⇶ 并行 ${row.groupIndex + 1}/${row.groupSize}` : `⌁ 分支 ${row.groupIndex + 1}/${row.groupSize}`;
    content.push(`<span class="pill grp ${row.groupKind}">${label}</span>`);
  }
  // label
  content.push(`<span class="lbl" title="${esc(step.file)}:${step.line}:${step.col}">${esc(step.label)}</span>`);
  // scene
  if (step.scene) content.push(`<span class="scene">· ${esc(step.scene)}</span>`);
  // 异步语义
  if (step.asyncMode && ASYNC_META[step.asyncMode]) {
    const m = ASYNC_META[step.asyncMode];
    content.push(`<span class="pill badge" style="background:${m.color}">${m.label}</span>`);
  }
  // func 跳转
  if (step.kind === 'func' && step.callee) {
    content.push(`<span class="pill func">→ ${esc(step.callee)}${step.targetLine ? ':' + step.targetLine : ''}</span>`);
  }
  // 镜像 / 递归 / 无法展开
  if (opts.annotate !== false) {
    if (row.recursive) {
      content.push(`<span class="pill loop">↺ 递归回边 · ${row.subSize} 步</span>`);
    } else if (row.mirrored) {
      content.push(`<span class="pill mirror">⧉ 镜像 · ${row.subSize} 步</span>`);
    } else if (step.skipped && !row.canOpen) {
      content.push(`<span class="pill warn">⚠ ${esc(step.skipped)}</span>`);
    }
  }
  // 位置
  content.push(`<span class="loc">${esc(pathBase(step.file))}:${step.line}</span>`);
  content.push('</div>');
  parts.push(content.join(''));

  parts.push('</div>');
  return parts.join('\n');
}

const CSS = `
:root {
  --bg: #ffffff; --bg-soft: #f6f8fa; --bg-hover: #f2f5fb;
  --border: #d6dce4; --border-soft: #e8ebef;
  --text: #1f2328; --text-soft: #5b6572; --text-dim: #8a93a0;
  --row-h: ${ROW_H}px;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  background: var(--bg); color: var(--text); font-size: 13px; line-height: 1.45;
}
header {
  position: sticky; top: 0; z-index: 10; background: rgba(255,255,255,.94);
  border-bottom: 1px solid var(--border); padding: 12px 22px;
  backdrop-filter: saturate(160%) blur(8px);
}
header h1 { font-size: 15px; font-weight: 650; }
header .sub { color: var(--text-soft); font-size: 12px; margin-top: 4px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.legend { display: flex; gap: 13px; flex-wrap: wrap; margin-top: 8px; font-size: 11px; color: var(--text-soft); align-items: center; }
.legend span { display: flex; align-items: center; gap: 5px; }
.legend .bar { width: 14px; height: 3px; border-radius: 2px; display: inline-block; }
.legend svg { display: block; }
main { padding: 6px 0 60px; overflow-x: auto; }
#chain { min-width: fit-content; }
.row { display: flex; align-items: stretch; min-height: var(--row-h); transition: background .08s; }
.row:hover { background: var(--bg-hover); }
.row .graph { flex: none; display: block; }
.row .graph .g-ring { fill: var(--bg); }
.row .graph .g-dot { stroke: var(--bg); }
.row .content { flex: 1; display: flex; align-items: center; gap: 7px; padding: 4px 16px 4px 0; min-width: 0; }
.row .kico { flex: none; width: 14px; text-align: center; font-size: 12px; }
.row .lbl { flex: none; max-width: 46%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550; }
.row .scene { flex: none; color: var(--text-soft); font-style: italic; font-size: 12px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .pill {
  flex: none; font-size: 11px; padding: 1px 8px; border-radius: 999px; font-weight: 500;
  max-width: 210px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}
.row .pill.badge { color: #fff; border: none; }
.row .pill.func { color: ${LANE_MAIN}; background: rgba(76,141,255,.13); }
.row .pill.warn { color: #ff8a3d; background: rgba(255,138,61,.14); }
.row .pill.mirror { color: #b76cf0; background: rgba(183,108,240,.15); border: 1px dashed rgba(183,108,240,.5); }
.row .pill.loop { color: #ff5d7e; background: rgba(255,93,126,.14); border: 1px dashed rgba(255,93,126,.5); }
.row .pill.grp.parallel { color: ${LANE_PARALLEL}; background: rgba(33,201,168,.14); }
.row .pill.grp.branch { color: #a17103; background: rgba(240,180,41,.16); }
.row .loc { margin-left: auto; flex: none; font-size: 11px; color: var(--text-dim); font-family: ui-monospace, Consolas, monospace; }
`;

/** 渲染完整静态 HTML */
export function renderGitGraphHtml(
  mainChain: ChainStep[],
  options: RenderOptions = {},
): { html: string; result: LayoutResult } {
  const result = computeAllRows(mainChain, options.layout || { expandAll: true });
  const { rows, graphWidth, truncated } = result;
  const expandedKeys = new Set<string>();
  if (!options.layout || !options.layout.expandAll) {
    // 折叠模式：仅把已展开 key 标记出来（demo 默认全展开，这里兜底）
    if (options.layout && options.layout.expandedKeys) {
      for (const k of options.layout.expandedKeys) expandedKeys.add(k);
    }
  }

  const laneLegend = [
    ['主链', LANE_MAIN],
    ['并行组', LANE_PARALLEL],
    ['互斥分支', LANE_BRANCH],
    ['子链路', LANE_SUB[0]],
  ]
    .map(([label, color]) => `<span><i class="bar" style="background:${color}"></i>${label}</span>`)
    .join('');

  const dotLegend = [
    `<span><svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="4.6" fill="${LANE_MAIN}"/></svg>叶子节点</span>`,
    `<span><svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.4" fill="none" stroke="${LANE_MAIN}" stroke-width="2.4"/><circle cx="7" cy="7" r="2.2" fill="${LANE_MAIN}"/></svg>可展开</span>`,
    `<span><svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.4" fill="none" stroke="${LANE_SUB[0]}" stroke-width="2.4" stroke-dasharray="3.2 2.2"/><circle cx="7" cy="7" r="2.2" fill="${LANE_SUB[0]}"/></svg>镜像可展开</span>`,
    `<span><svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.4" fill="none" stroke="#ff5d7e" stroke-width="2.2" stroke-dasharray="3 2"/><path d="M4.4 7 L9.6 7" stroke="#ff5d7e" stroke-width="1.8" stroke-linecap="round"/></svg>递归回边</span>`,
    `<span><svg width="20" height="14" viewBox="0 0 20 14"><path d="M3 0 L3 9" stroke="${LANE_PARALLEL}" stroke-width="2" fill="none" stroke-dasharray="4 3"/></svg>异步不阻塞</span>`,
  ].join('');

  const rowsHtml = rows
    .map((row, i) => renderRowHtml(row, graphWidth, { expandedKeys, prev: rows[i - 1], next: rows[i + 1], index: i }))
    .join('\n');

  const title = options.title || '请求链路 · Git Graph';
  const subtitle =
    options.subtitle ||
    `主链 ${rows.length} 行 ｜ lane 图宽 ${graphWidth}px${truncated ? ' ｜ ⚠ 已达行数上限，截断' : ''}`;

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <h1>${esc(title)}</h1>
  <div class="sub">${esc(subtitle)}</div>
  <div class="legend">${laneLegend}<span style="opacity:.4">|</span>${dotLegend}</div>
</header>
<main>
  <div id="chain">${rowsHtml}</div>
</main>
</body>
</html>`;

  return { html, result };
}
