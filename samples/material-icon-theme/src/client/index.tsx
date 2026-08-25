import { createElement } from 'react'
import type {} from 'dsh-better-sidebar' // triggers the ctx.betterSidebar type merge
import type { Context } from 'cordis'
import { iconTheme } from './icons.generated.ts'
import type { IconThemeDescriptor } from 'dsh-better-sidebar/client/service'

export const inject = ['betterSidebar']

/** The theme's own default file icon as the settings-list preview. */
function previewIcon(size: number): React.ReactNode {
  const url = iconTheme.iconDefinitions.file?.iconPath
  return url === undefined ? null : createElement('img', { src: url, width: size, height: size, alt: '', style: { display: 'block' } })
}

const descriptor: IconThemeDescriptor = {
  id: 'material-icon-theme',
  title: () => 'Material Icon Theme',
  icon: previewIcon,
  order: 10,
  theme: iconTheme,
}

export function apply(ctx: Context): void {
  // Old cores lack the extension point — degrade silently (the plugin is
  // an optional peer; nothing else breaks).
  if (!ctx.betterSidebar.features.includes('iconTheme')) return
  ctx.effect(() => ctx.betterSidebar.registerIconTheme(descriptor))
}