/** Root-only inspector body: host geometry and visibility arrive without SessionProvider. */
import { createElement, useEffect, useReducer, useSyncExternalStore } from 'react'
import type { BetterSidebarService } from './service.ts'
import { RenderBoundary } from './RenderBoundary.tsx'
import css from './inspectors.module.css'
import { t } from './locales.ts'

export function InspectorHost({ service, visible }: { service: BetterSidebarService; visible: boolean }) {
  const snapshot = useSyncExternalStore(service.subscribeInspectors, service.getInspectorSnapshot, service.getInspectorSnapshot)
  // Registry changes also affect fixed entries / HMR component availability.
  const [, rerender] = useReducer((value: number) => value + 1, 0)
  useEffect(() => service.subscribe(rerender), [service])
  const descriptors = service.getInspectors()
  const active = snapshot.active
  const descriptor = descriptors.find(item => item.id === active?.type)
  return <section className={css.host} data-dsh-better-sidebar-inspectors="" hidden={!visible}>
    <nav className={css.entries}>
      {descriptors.filter(item => item.entry).map(item => <button type="button" key={item.id}
        onClick={() => service.openInspector({ type: item.id, id: item.id, resource: {} })}>
        {typeof item.title === 'function' ? item.title() : item.title}
      </button>)}
    </nav>
    <nav className={css.tabs}>
      {snapshot.records.filter(record => descriptors.some(item => item.id === record.type)).map(record => {
        const type = descriptors.find(item => item.id === record.type)!
        const selected = active?.type === record.type && active.id === record.id
        return <button type="button" key={JSON.stringify([record.type, record.id])} aria-pressed={selected}
          onClick={() => service.openInspector(record)}>
          {record.title ?? (typeof type.title === 'function' ? type.title() : type.title)}
        </button>
      })}
    </nav>
    {active && descriptor && <div className={css.body}>
      <header className={css.header}>
        <span>{active.title ?? (typeof descriptor.title === 'function' ? descriptor.title() : descriptor.title)}</span>
        <button type="button" aria-label={t('close')} onClick={() => service.closeInspector(active.type, active.id)}>×</button>
      </header>
      <RenderBoundary key={JSON.stringify([active.type, active.id])}>
        {createElement(descriptor.component, { resource: active.resource, location: active.location, visible,
          close: () => service.closeInspector(active.type, active.id) })}
      </RenderBoundary>
    </div>}
  </section>
}
