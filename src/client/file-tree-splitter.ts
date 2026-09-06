/**
 * The file-tree dual-module SPLITTER model (v0.19.1+): the pure math behind
 * the draggable divider between the injected upper section and the local
 * tree (see FileTreeSplitter.tsx for the interaction, TreePanel.tsx's
 * `ExplorerDual` for the layout). One model speaks everywhere — render
 * (flex-basis), drag (pointer Y within the container) and persistence all
 * share the same ratio: the UPPER module's share of the whole dual-stack
 * height (`flex: 0 1 <ratio * 100>%`). The divider strip's own height sits
 * OUTSIDE the ratio (flex: none), so the lower module receives whatever
 * the upper does not consume.
 *
 * Clamping is pixel-honest: the upper section keeps ≥ MIN_UPPER_PX and the
 * lower tree ≥ MIN_LOWER_PX (the dsh-remote requirement: neither module may
 * be dragged out of view; a 34px row keeps roughly 5 / 3.5 rows visible).
 * The bounds derive from the CONTAINER's measured height at pointer-down;
 * a container too short to fit both floors falls back to an even split —
 * the least-broken layout under an impossible constraint.
 *
 * Persistence rides localStorage under {@link FILE_TREE_SPLIT_RATIO_KEY}
 * (cross-session stable, no per-tab state surgery): the ratio is a
 * panel-level preference that only exists while a section is matched, and
 * survives sidebar rebuilds / session switches. Reads are validated
 * (0–1, finite); every storage access is failure-proof (private-mode
 * localStorage throws — the in-memory ratio still applies).
 */
export const FILE_TREE_SPLIT_RATIO_KEY = 'dsh-better-sidebar:fileTreeSplitRatio'

/** The default proportion: upper 80% / lower 20% — the remote's 4:1. */
export const FILE_TREE_SPLIT_DEFAULT_RATIO = 0.8

/** The upper module's floor (px). ≥160 per the requirement; picked so the
 *  unclamped 4:1 default survives panels down to ≈625px tall. */
export const FILE_TREE_SPLIT_MIN_UPPER_PX = 160

/** The lower tree's floor (px): ≥120 per the requirement — a drag can
 *  never shrink the local tree below ~3.5 of its 34px rows. */
export const FILE_TREE_SPLIT_MIN_LOWER_PX = 120

/** The divider strip's own height (flex: none, outside the ratio). */
export const FILE_TREE_SPLITTER_PX = 5

/** The storage surface the model touches (localStorage in the browser;
 *  tests inject a fake — jsdom's Storage is unusable for seeding assertions
 *  across mounts without clearing, and a fake isolates the unit). */
export interface FileTreeSplitStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function defaultStorage(): FileTreeSplitStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

/**
 * Clamp a split ratio against the container's measured height. `ratio` is
 * the upper module's share of `containerHeightPx`; the divider strip
 * (`splitterHeightPx`, default 5) is subtracted from the lower module's
 * allowance so the tree's floor is honored even with the strip in place.
 * Degenerate containers (too short for both floors) resolve to 0.5; a
 * non-finite ratio resolves to the default.
 */
export function clampFileTreeSplitRatio(
  ratio: number,
  containerHeightPx: number,
  splitterHeightPx: number = FILE_TREE_SPLITTER_PX,
): number {
  if (!Number.isFinite(ratio)) return FILE_TREE_SPLIT_DEFAULT_RATIO
  const h = Math.max(1, containerHeightPx)
  const min = FILE_TREE_SPLIT_MIN_UPPER_PX / h
  const max = (h - Math.max(0, splitterHeightPx) - FILE_TREE_SPLIT_MIN_LOWER_PX) / h
  if (min >= max) return 0.5
  return Math.min(max, Math.max(min, Math.min(1, Math.max(0, ratio))))
}

/** Read the persisted ratio (validated to 0–1; anything else → the
 *  default). The pixel floors are NOT applied here — the CSS min-heights
 *  are the layout-time guard, since no container measurement exists at
 *  render. */
export function readFileTreeSplitRatio(storage: FileTreeSplitStorage | undefined = defaultStorage()): number {
  try {
    const raw = storage?.getItem(FILE_TREE_SPLIT_RATIO_KEY)
    if (raw === null || raw === undefined) return FILE_TREE_SPLIT_DEFAULT_RATIO
    const value = Number(raw)
    if (!Number.isFinite(value)) return FILE_TREE_SPLIT_DEFAULT_RATIO
    return Math.min(1, Math.max(0, value))
  } catch {
    return FILE_TREE_SPLIT_DEFAULT_RATIO
  }
}

/** Persist a committed ratio (failure-proof: storage denied/full keeps the
 *  in-memory ratio — a lost preference, never a broken drag). */
export function persistFileTreeSplitRatio(ratio: number, storage: FileTreeSplitStorage | undefined = defaultStorage()): void {
  try {
    storage?.setItem(FILE_TREE_SPLIT_RATIO_KEY, String(ratio))
  } catch {
    /* storage unavailable — the session's ratio still applies. */
  }
}