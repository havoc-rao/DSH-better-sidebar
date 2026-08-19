/**
 * The sidebar keybinding registry (v0.14.0+).
 *
 * A deliberately simple, VSCode-flavoured shortcut system with ONE boss:
 * a document-capture keydown listener (like the panel hotkeys it replaces)
 * routes every physical key event to the registered bindings. External
 * plugins contribute through `ctx.betterSidebar.registerKeybinding(...)`
 * (the injection point); the built-in panel toggles (⌘B / ⌘J / ⌘⌥B / ⌘⇧J),
 * quick-open (⌘P), search focus (⌘F) and the tab-strip keys all register
 * through the same runtime.
 *
 * Simplicity over VSCode:
 * - a binding is `{ id, key, title, when?, priority?, run }` — no command
 *   ids, no keybinding.json, no multi-chord sequences;
 * - `when` is a plain predicate over a typed context object, not a
 *   serializable when-clause string (exactly the "还是更简单" tradeoff);
 * - matching is PHYSICAL (`event.code`), like the panel hotkeys: Option+B
 *   on the US layout reports the key value "∫" and non-Latin layouts remap
 *   key values entirely, while `code` stays the key the user pressed.
 *
 * Modifier grammar (order-insensitive, case-insensitive tokens joined by
 * '+'): `Cmd` (or `Command` / `Meta` / `⌘` / `Super`) is the platform
 * primary — it matches EITHER ⌘ (macOS) or Ctrl (elsewhere), exactly like
 * the old panel matcher; `Ctrl` (or `Control`) is the LITERAL physical
 * Ctrl (meta must be absent); `Alt` (or `Opt` / `Option` / `⌥`); `Shift`.
 * The key part is a letter (`p`), a digit (`1`), a function key (`F5`),
 * a named key (`Space`, `Tab`, `Enter`, `Escape`/`Esc`, `Backspace`,
 * `Delete`/`Del`, `Home`, `End`, `PageUp`, `PageDown`, `Insert`), an
 * arrow (`ArrowUp`/`ArrowDown`/`ArrowLeft`/`ArrowRight`), a punctuation
 * key (`/`, `.`, `,`, `;`, `'`, `` ` ``, `-`, `=`, `[`, `]`, `\`), or an
 * explicit `KeyboardEvent.code` (`KeyP`, `Digit1`, `Numpad4`). Shifted
 * symbols (`+`) are spelled as the shifted chord (`Shift+Equal`).
 *
 * Global guards (mirror of the panel matcher, so plugin bindings inherit
 * them for free): IME composition (reuses {@link isImeComposition}),
 * AltGraph on Windows (AltGr reports ctrl+alt and must not hit `Ctrl+Alt`
 * bindings), and key auto-repeat (a held chord fires once, unless the
 * binding opts in with `allowRepeat: true` — handy for arrow-style keys).
 *
 * Consumption: the first binding whose key matches AND whose `when`
 * predicate passes runs; unless its `run` explicitly returns `false`, the
 * event is fully consumed (preventDefault + stopPropagation) — the shortcut
 * belongs to the sidebar, never to the focused editor / terminal / composer.
 * Ties break by `priority` (descending, registration order among equals).
 */
import { isImeComposition } from './ime-guard.ts'
import type { SidebarState, SidebarTab } from './state.ts'

/** The subset of KeyboardEvent the matcher reads (pure: testable without DOM). */
export interface KeybindingEventLike {
  code: string
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat: boolean
  isComposing: boolean
  keyCode: number
  getModifierState?: (name: string) => boolean
}

/**
 * The typed context every `when` predicate reads. Assembled per event by
 * the runtime owner (the sidebar shell in production; tests pass a fake)
 * from the store snapshot, the DOM focus, and the transient UI markers.
 */
export interface SidebarKeybindingContext {
  /** The active session's sidebar state (null before any session is current). */
  state: SidebarState | null
  /** Narrow (mobile) viewports — the bottom panel does not exist there. */
  narrow: boolean
  /** Whether document.activeElement lives inside the sidebar host. */
  focusInSidebar: boolean
  /** Whether the user is typing in an editable field OUTSIDE the sidebar
   *  (composer, terminal, the host's own inputs) — global fetch-style keys
   *  (⌘P / ⌘F) yield to the focused field then. */
  textEditing: boolean
  /** Whether a pane's + menu is open. */
  plusMenuOpen: boolean
  /** Whether the files search box is active (focused, or has a query). */
  searchActive: boolean
  /** The active tab of the active pane (resolved via the state tree). */
  activeTab: SidebarTab | null
  /** The active tab's type ('' when there is none). */
  activeTabType: string
  /** All tabs of the active pane, in strip order. */
  activePaneTabs: readonly SidebarTab[]
}

/** One registered keybinding. */
export interface KeybindingDescriptor {
  /** Unique id (dup registration throws, like tabs). Suggest a plugin
   *  prefix: `'my-plugin:open-notes'`. */
  id: string
  /** Display title (i18n friendly): the hint shown in settings/tooltips. */
  title: string | (() => string)
  /** One key spec string or several aliases (`'Cmd+P'` or
   *  `['Cmd+P', 'Ctrl+P']` — the latter is redundant since `Cmd` already
   *  matches Ctrl on non-macOS, but explicit `Ctrl+` specifiers are
   *  literal). */
  key: string | readonly string[]
  /** Context predicate; absent = always active while the key matches. */
  when?: (context: SidebarKeybindingContext) => boolean
  /** Higher wins first when several bindings match the same key+context;
   *  default 0. */
  priority?: number
  /** Allow auto-repeat (held key fires repeatedly); default false. */
  allowRepeat?: boolean
  /**
   * The action. Receives the raw event AND the already-assembled context
   * (so `run` can branch on live state without re-deriving it). Return
   * `false` to explicitly OPT OUT and let the next matching binding try the
   * event (rare); `undefined` (default) consumes.
   */
  run: (event: KeybindingEventLike, context: SidebarKeybindingContext) => boolean | void
}

/** The parsed modifier policy of one key spec. */
export type KeybindingModifier = 'cmd' | 'ctrl' | 'none'

/** A parsed key spec (`parseKeySpec` output). */
export interface KeySpec {
  /** The physical `KeyboardEvent.code` the key part maps to. */
  code: string
  /** 'cmd' = the platform command modifier (⌘/Ctrl — either); 'ctrl' = the
   *  literal physical Ctrl (no meta); 'none' = no command modifier. */
  mod: KeybindingModifier
  alt: boolean
  shift: boolean
  /** The original key string (error messages). */
  raw: string
  /** Platform-aware display form ('⌘⇧P' on macOS, 'Ctrl+Shift+P' elsewhere). */
  label: string
}

/** Map a single letter / digit / named key to its physical `KeyboardEvent.code`. */
const NAMED_KEYS: Readonly<Record<string, string>> = {
  space: 'Space',
  tab: 'Tab',
  enter: 'Enter',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  insert: 'Insert',
  '/': 'Slash',
  '.': 'Period',
  ',': 'Comma',
  ';': 'Semicolon',
  "'": 'Quote',
  '`': 'Backquote',
  '-': 'Minus',
  '=': 'Equal',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
}

/** Resolve the key part of a spec ('p', '1', 'F5', 'KeyP', 'ArrowUp', '/') to a code. */
function codeOfKeyPart(part: string): string {
  const upper = part.toUpperCase()
  // Explicit `KeyboardEvent.code` forms, canonicalized to the real casing
  // ('KeyA' / 'Digit1' / 'Numpad4' / 'F5' / 'ArrowUp' — whatever the input
  // case, the emitted code matches what browsers actually report).
  const key = /^Key([A-Z])$/i.exec(part)
  if (key !== null) return `Key${key[1]!.toUpperCase()}`
  const digit = /^Digit([0-9])$/i.exec(part)
  if (digit !== null) return `Digit${digit[1]}`
  const numpad = /^Numpad([0-9])$/i.exec(part)
  if (numpad !== null) return `Numpad${numpad[1]}`
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(upper)) return upper
  // Arrows keep their camelCase code ('ArrowUp'), whatever the input case.
  const arrow = /^Arrow(Up|Down|Left|Right)$/i.exec(part)
  if (arrow !== null) return `Arrow${arrow[1]}`
  // Single letter / digit.
  if (/^[A-Z]$/.test(upper)) return `Key${upper}`
  if (/^[0-9]$/.test(upper)) return `Digit${upper}`
  // Named keys.
  const named = NAMED_KEYS[part.toLowerCase()]
  if (named !== undefined) return named
  throw new Error(`[dsh-better-sidebar] unknown keybinding key "${part}"`)
}

/** True when the current platform spells the primary modifier ⌘ (else Ctrl). */
export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
}

/** The macOS symbol for one modifier ('⌘' / '⌥' / '⇧'), or null for the plain label. */
function macSymbol(token: string): string | null {
  if (token === 'cmd') return '⌘'
  if (token === 'alt') return '⌥'
  if (token === 'shift') return '⇧'
  return null
}
/** The plain-text label resolution of one modifier token ('Cmd' → '⌘'/'Cmd'). */
function modLabel(token: string, mac: boolean): string {
  if (token === 'cmd') return mac ? '⌘' : 'Ctrl'
  if (token === 'ctrl') return mac ? '⌃' : 'Ctrl'
  if (token === 'alt') return mac ? '⌥' : 'Alt'
  if (token === 'shift') return mac ? '⇧' : 'Shift'
  return token
}

/** Parse one key spec string into a matcher-ready {@link KeySpec}. Throws on
 *  unknown tokens / empty key parts — a broken spec must fail at
 *  registration, not silently never match. */
export function parseKeySpec(raw: string): KeySpec {
  const parts = raw.split('+').map(part => part.trim()).filter(part => part !== '')
  if (parts.length === 0) throw new Error(`[dsh-better-sidebar] empty keybinding spec "${raw}"`)
  let mod: KeybindingModifier = 'none'
  let alt = false
  let shift = false
  const keyParts: string[] = []
  for (const part of parts) {
    const token = part.toLowerCase()
    if (token === 'cmd' || token === 'command' || token === 'meta' || token === 'super' || token === '⌘') {
      mod = 'cmd'
    } else if (token === 'ctrl' || token === 'control') {
      mod = 'ctrl'
    } else if (token === 'alt' || token === 'opt' || token === 'option' || token === '⌥') {
      alt = true
    } else if (token === 'shift' || token === '⇧') {
      shift = true
    } else {
      keyParts.push(part)
    }
  }
  if (keyParts.length !== 1) {
    throw new Error(`[dsh-better-sidebar] keybinding "${raw}" must name exactly one key (got ${keyParts.length === 0 ? 'none' : keyParts.join('+')})`)
  }
  const code = codeOfKeyPart(keyParts[0]!)
  const mac = isMacPlatform()
  // Display: modifiers in display order (Cmd/Ctrl, Alt, Shift), then the key
  // part — a faithful echo of the original raw string, so hints stay
  // recognizable either way.
  const displayParts: string[] = []
  for (const token of [mod === 'cmd' ? 'cmd' : mod === 'ctrl' ? 'ctrl' : null, alt ? 'alt' : null, shift ? 'shift' : null]) {
    if (token !== null) displayParts.push(macSymbol(token) ?? modLabel(token, mac))
  }
  // Map the code back to a readable key token (KeyP → 'P', Digit1 → '1', …).
  const keyToken = displayKeyOfCode(code, keyParts[0]!, mac)
  displayParts.push(keyToken)
  return { code, mod, alt, shift, raw, label: displayParts.join('+') }
}

/** The readable key token for a code (presentation only). */
function displayKeyOfCode(code: string, fallback: string, mac: boolean): string {
  const match = /^KEY([A-Z])$/.exec(code)
  if (match !== null) return match[1]!
  const digit = /^DIGIT([0-9])$/.exec(code)
  if (digit !== null) return digit[1]!
  if (/^Arrow(Up|Down|Left|Right)$/.test(code)) return code
  if (code === 'Escape') return 'Esc'
  // Named / punct / explicit codes fall back to their raw spelling.
  return fallback
}

/** The pure match: does the event's modifiers + physical code satisfy the spec? */
export function matchKeySpec(spec: KeySpec, event: KeybindingEventLike): boolean {
  if (event.code !== spec.code) return false
  const commandMod = event.metaKey || event.ctrlKey
  if (spec.mod === 'cmd') {
    if (!commandMod) return false
  } else if (spec.mod === 'ctrl') {
    if (!event.ctrlKey || event.metaKey) return false
  } else if (commandMod) {
    return false
  }
  if (spec.alt !== event.altKey) return false
  if (spec.shift !== event.shiftKey) return false
  return true
}

/** The platform-aware display hint of a parsed spec ('⌘⇧P' / 'Ctrl+Shift+P'). */
export function keySpecLabel(spec: KeySpec): string {
  return spec.label
}

/**
 * The runtime: owns the binding registry and the document-capture dispatch.
 * One instance per plugin activation (created in the client apply and handed
 * to the sidebar service as the `registerKeybinding` backend). The context
 * builder is injected so unit tests run without DOM/store plumbing.
 */
export class KeybindingRuntime {
  private readonly entries: Array<{ descriptor: KeybindingDescriptor; specs: KeySpec[] }> = []
  private readonly byId = new Map<string, KeybindingDescriptor>()

  constructor(private readonly getContext: () => SidebarKeybindingContext) {}

  /** Resolve a descriptor's title (i18n friendly). */
  static titleOf(descriptor: KeybindingDescriptor): string {
    return typeof descriptor.title === 'function' ? descriptor.title() : descriptor.title
  }

  /** Register a binding (duplicate id throws, like tabs/viewers). Returns
   *  the disposer (call through `ctx.effect` for HMR safety). */
  register(descriptor: KeybindingDescriptor): () => void {
    if (this.byId.has(descriptor.id)) {
      throw new Error(`[dsh-better-sidebar] keybinding "${descriptor.id}" already registered`)
    }
    const keys = typeof descriptor.key === 'string' ? [descriptor.key] : [...descriptor.key]
    const specs = keys.map(parseKeySpec)
    const entry = { descriptor, specs }
    // Stable priority sort: higher priority first, registration order among
    // equals (Array#sort is stable per spec).
    this.entries.push(entry)
    this.entries.sort((a, b) => (b.descriptor.priority ?? 0) - (a.descriptor.priority ?? 0))
    this.byId.set(descriptor.id, descriptor)
    return () => {
      if (this.byId.get(descriptor.id) !== descriptor) return
      this.byId.delete(descriptor.id)
      const index = this.entries.findIndex(candidate => candidate.descriptor === descriptor)
      if (index !== -1) this.entries.splice(index, 1)
    }
  }

  /** Get one registered binding by id. */
  get(id: string): KeybindingDescriptor | undefined {
    return this.byId.get(id)
  }

  /** The registered bindings in dispatch order (priority desc). */
  list(): readonly KeybindingDescriptor[] {
    return this.entries.map(entry => entry.descriptor)
  }

  /** Parse one descriptor's specs (exposed for tooltips; throws on bad keys). */
  specsOf(descriptor: KeybindingDescriptor): KeySpec[] {
    const keys = typeof descriptor.key === 'string' ? [descriptor.key] : [...descriptor.key]
    return keys.map(parseKeySpec)
  }

  /**
   * The pure dispatch: run the first binding that matches the key AND its
   * `when` context. Returns true when an event was consumed (the caller
   * preventDefault + stopPropagation). Guards run before any matching:
   * IME composition, AltGraph, and auto-repeat (unless the binding opts in).
   */
  dispatch(event: KeybindingEventLike): boolean {
    if (event.repeat) {
      const hasRepeatable = this.entries.some(entry =>
        entry.descriptor.allowRepeat === true
        && entry.specs.some(spec => matchKeySpec(spec, event)))
      if (!hasRepeatable) return false
    }
    if (isImeComposition(event)) return false
    if (event.getModifierState?.('AltGraph') === true) return false
    const context = this.getContext()
    for (const entry of this.entries) {
      if (!entry.specs.some(spec => matchKeySpec(spec, event))) continue
      if (entry.descriptor.when !== undefined && !entry.descriptor.when(context)) continue
      const consumed = entry.descriptor.run(event, context)
      if (consumed !== false) return true
    }
    return false
  }

  /** Wire the document-capture keydown listener. Returns the disposer. */
  attach(): () => void {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (this.dispatch(event)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }
}

// ── Transient UI markers (module-level; reset when the module re-evaluates
// ── on HMR, exactly like the store-window pattern). Components publish
// ── them; the runtime's context builder reads them. ────────────────────────

/** Whether any pane's + menu is currently open (published by TabBar). */
let plusMenuOpenFlag = false
/** Set the + menu open state (TabBar publishes on open/close). */
export function setPlusMenuOpen(open: boolean): void { plusMenuOpenFlag = open }
/** Read the + menu open state (runtime context, tests). */
export function isPlusMenuOpen(): boolean { return plusMenuOpenFlag }

/** Whether the files search input is active (focused or query non-empty). */
let searchActiveFlag = false
/** Publish the files search active state (TreePanel). */
export function setSearchActive(active: boolean): void { searchActiveFlag = active }
/** Read the search active state (runtime context). */
export function isSearchActive(): boolean { return searchActiveFlag }

/** The visible files search input (last mounted VISIBLE tree panel). */
let searchInputElement: HTMLInputElement | null = null
/** Register / clear the visible files search input (TreePanel). */
export function setSearchInputElement(element: HTMLInputElement | null): void {
  searchInputElement = element
}
/** Focus + select-all the files search input (⌘P / ⌘F bindings). Returns
 *  whether an input was found. */
export function focusSidebarSearchInput(): boolean {
  if (searchInputElement === null) return false
  searchInputElement.focus()
  searchInputElement.select()
  return true
}