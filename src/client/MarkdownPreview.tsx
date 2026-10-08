/** Pure shared preview: no document cache, draft, save or selection side effects. */
import { useMemo } from 'react'
import type { MarkdownRenderProps } from './rendering.tsx'
import { markdownPreviewSource } from './markdown-frontmatter.ts'
import { analyzeMarkdownHtml } from './markdown-html.ts'
import { MarkdownDocument, type MarkdownHtmlMedia } from './MarkdownHtml.tsx'
import { MdToc } from './md-toc.tsx'

export function MarkdownPreview({ text, scope, path, codeLabels, className }: MarkdownRenderProps) {
  const source = useMemo(() => markdownPreviewSource(text), [text])
  const info = useMemo(() => analyzeMarkdownHtml(source), [source])
  const media = useMemo<MarkdownHtmlMedia>(
    () => ({ scope, path, origin: window.location.origin }),
    [scope.sessionId, scope.cwd, path],
  )
  const children = <><MdToc /><MarkdownDocument info={info} media={media} codeLabels={codeLabels} /></>
  // Without a wrapper MdToc stays a direct child of the caller's scroll surface.
  return className === undefined ? children : <div className={className}>{children}</div>
}
