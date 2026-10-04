/** Session-independent resource inspectors. No session store or fake session is involved. */
import type { ReactNode } from 'react'

export type InspectorJson = null | boolean | number | string | InspectorJson[] | { [key: string]: InspectorJson }
export type InspectorObject = { [key: string]: InspectorJson }
export interface InspectorComponentProps {
  resource: InspectorObject
  location: InspectorObject | undefined
  visible: boolean
  close(): void
}
export interface InspectorDescriptor {
  /** Stable across reloads: persisted resources resolve through this id. */
  id: string
  title: string | (() => string)
  component: (props: InspectorComponentProps) => ReactNode
  /** Fixed root-level entry; opens id=type with resource={}. */
  entry?: boolean
}
export interface OpenInspectorSeed {
  type: string
  id: string
  title?: string
  resource: InspectorObject
  location?: InspectorObject
}
export interface InspectorSnapshot {
  readonly records: readonly OpenInspectorSeed[]
  readonly active: OpenInspectorSeed | undefined
}
/** The host owns geometry, selection and expanded state, not inspector resources. */
export interface InspectorSurface {
  reveal(): boolean
  close(): void
}
export interface InspectorApi {
  registerInspector(descriptor: InspectorDescriptor): () => void
  getInspectors(): readonly InspectorDescriptor[]
  openInspector(seed: OpenInspectorSeed): boolean
  closeInspector(type: string, id: string): void
  getInspectorSnapshot(): InspectorSnapshot
  subscribeInspectors(listener: () => void): () => void
  /** @internal Installed only while the root host slot exists. */
  setInspectorSurface(surface: InspectorSurface | undefined): void
}
export interface InspectorStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}
export const INSPECTOR_STORAGE_KEY = 'dsh-better-sidebar:inspectors:v1'

/** Reject lossy JSON values rather than silently dropping resource identities. */
function jsonObject(value: unknown): value is InspectorObject {
  const seen = new Set<object>()
  const valid = (item: unknown): boolean => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return true
    if (typeof item === 'number') return Number.isFinite(item)
    if (typeof item !== 'object' || seen.has(item)) return false
    const proto = Object.getPrototypeOf(item)
    if (!Array.isArray(item) && proto !== Object.prototype && proto !== null) return false
    seen.add(item)
    const ok = (Array.isArray(item) ? item : Object.values(item)).every(valid)
    seen.delete(item)
    return ok
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) && valid(value)
}
function validSeed(value: unknown): value is OpenInspectorSeed {
  if (value === null || typeof value !== 'object') return false
  const seed = value as OpenInspectorSeed
  return typeof seed.type === 'string' && seed.type.length > 0
    && typeof seed.id === 'string' && seed.id.length > 0
    && (seed.title === undefined || typeof seed.title === 'string')
    && jsonObject(seed.resource) && (seed.location === undefined || jsonObject(seed.location))
}
const same = (a: OpenInspectorSeed, b: OpenInspectorSeed): boolean => a.type === b.type && a.id === b.id

export function createInspectorApi(notifyRegistry: () => void, storage?: InspectorStorage): InspectorApi {
  const descriptors = new Map<string, InspectorDescriptor>()
  const listeners = new Set<() => void>()
  let surface: InspectorSurface | undefined
  let snapshot: InspectorSnapshot = { records: [], active: undefined }
  try {
    const raw = storage?.getItem(INSPECTOR_STORAGE_KEY)
    if (raw) {
      const data: unknown = JSON.parse(raw)
      if (data !== null && typeof data === 'object') {
        const saved = data as { records?: unknown; active?: unknown }
        if (Array.isArray(saved.records)) {
          const records: OpenInspectorSeed[] = []
          for (const record of saved.records.filter(validSeed).slice(-32)) {
            const index = records.findIndex(item => same(item, record))
            if (index >= 0) records.splice(index, 1)
            records.push(record)
          }
          snapshot = { records, active: validSeed(saved.active) ? records.find(item => same(item, saved.active as OpenInspectorSeed)) : undefined }
        }
      }
    }
  } catch { /* Storage denied or malformed: start clean. */ }
  const publish = (): void => {
    try { storage?.setItem(INSPECTOR_STORAGE_KEY, JSON.stringify(snapshot)) } catch { /* In-memory use still works. */ }
    for (const listener of [...listeners]) listener()
  }
  return {
    registerInspector(descriptor) {
      if (!descriptor.id || descriptors.has(descriptor.id)) throw new Error(`[dsh-better-sidebar] inspector "${descriptor.id}" already registered or empty`)
      descriptors.set(descriptor.id, descriptor)
      notifyRegistry()
      for (const listener of [...listeners]) listener()
      // Stable types can arrive after the surface or after a cold restore.
      if (snapshot.active?.type === descriptor.id) surface?.reveal()
      return () => {
        if (descriptors.get(descriptor.id) !== descriptor) return
        descriptors.delete(descriptor.id)
        notifyRegistry()
        for (const listener of [...listeners]) listener()
        // Keep the resource for HMR/cold restore; never retain a stale component.
      }
    },
    getInspectors: () => [...descriptors.values()],
    openInspector(seed) {
      if (!validSeed(seed) || !descriptors.has(seed.type) || !surface) return false
      // Copy at the boundary: a consumer mutation must not corrupt saved identity.
      const record = JSON.parse(JSON.stringify(seed)) as OpenInspectorSeed
      if (!surface.reveal()) return false
      const records = snapshot.records.filter(item => !same(item, record))
      records.push(record)
      snapshot = { records: records.slice(-32), active: record }
      publish()
      return true
    },
    closeInspector(type, id) {
      const records = snapshot.records.filter(item => item.type !== type || item.id !== id)
      if (records.length === snapshot.records.length) return
      const active = snapshot.active?.type === type && snapshot.active.id === id ? undefined : snapshot.active
      snapshot = { records, active }
      if (!active) surface?.close()
      publish()
    },
    getInspectorSnapshot: () => snapshot,
    subscribeInspectors(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    setInspectorSurface(next) {
      surface = next
      if (snapshot.active && descriptors.has(snapshot.active.type)) surface?.reveal()
    },
  }
}
