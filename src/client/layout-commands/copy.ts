/** User-facing strings for the layout commands; zh is the source language, en follows. */
import { isZh } from '../locales.ts'

const copy = {
  unavailable: ['宿主尚未提供布局预设 API', 'The host does not provide layout presets'],
  noSession: ['请先打开一个会话', 'Open a session first'],
  noFiles: ['请先在侧栏打开 Files 文件页', 'Open Files in the sidebar first'],
  missingPane: ['Files 分栏已变化，请重新执行', 'The Files pane changed; try again'],
  blocked: ['当前布局无法应用该预设', 'This preset is unavailable for the current layout'],
  narrow: ['侧栏宽度不足，请先全屏或扩大侧栏', 'Expand or fullscreen the sidebar before applying this layout'],
  collapsed: ['请先展开侧栏再调整布局', 'Expand the sidebar before changing its layout'],
  twoPanes: ['均分布局需要两个已存在的分栏', 'Equal Columns requires two existing panes'],
  threePanes: ['经典三栏布局需要三个已存在的分栏', 'Classic three-column layout requires three existing panes'],
} as const

/**
 * Localize one command message.
 * @param key - dictionary entry to read.
 * @returns the current UI language's text.
 */
export function text(key: keyof typeof copy): string { return copy[key][isZh() ? 0 : 1] }
