/** Opt-in zsh/ZLE integration. Markers are trusted shell hints, not a same-UID security boundary. */
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

export interface ZshIntegration {
  directory: string
  token: string
  env: NodeJS.ProcessEnv
  dispose(): void
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/** Only non-login interactive zsh, without caller-supplied args, is supported. */
export function prepareZshIntegration(executable: string, args: string[], env: NodeJS.ProcessEnv = process.env): ZshIntegration | undefined {
  if (!['darwin', 'linux'].includes(process.platform) || basename(executable) !== 'zsh' || args.length) return undefined
  const directory = mkdtempSync(join(tmpdir(), 'dsh-zsh-'))
  chmodSync(directory, 0o700)
  const token = randomBytes(24).toString('hex')
  const suffix = token.slice(0, 16)
  const name = `_dsh_${suffix}`
  const original = env.ZDOTDIR ?? env.HOME ?? ''
  try {
    // zsh still sources global rc files normally. User .zshenv may redirect ZDOTDIR.
    writeFileSync(join(directory, '.zshenv'), `ZDOTDIR=${quote(original)}\n[[ -r "$ZDOTDIR/.zshenv" ]] && source "$ZDOTDIR/.zshenv"\ntypeset -g ${name}_rcdir="\${ZDOTDIR:-$HOME}"\nZDOTDIR=${quote(directory)}\n`, { mode: 0o600 })
    writeFileSync(join(directory, '.zshrc'), `ZDOTDIR="$${name}_rcdir"\n[[ -r "$ZDOTDIR/.zshrc" ]] && source "$ZDOTDIR/.zshrc"\n# Disabled ZLE/RCS, overwritten hooks, unsupported themes: no marker means unknown.\nautoload -Uz add-zsh-hook add-zle-hook-widget\ntypeset -g ${name}_ready=0\nfunction ${name}_precmd() {\n  ${name}_ready=0\n  local -a ${name}_init_hooks ${name}_finish_hooks\n  zstyle -a zle-line-init widgets ${name}_init_hooks\n  zstyle -a zle-line-finish widgets ${name}_finish_hooks\n  if (( \${#${name}_init_hooks} != 1 || \${#${name}_finish_hooks} != 1 )) || [[ \${${name}_init_hooks[1]} != <->:${name}_prompt || \${${name}_finish_hooks[1]} != <->:${name}_start ]]; then\n    builtin printf '\\033]633;dsh;${token};unsupported\\007'\n    return\n  fi\n  if [[ \${widgets[zle-line-init]} != user:azhw:zle-line-init || \${widgets[zle-line-finish]} != user:azhw:zle-line-finish ]] || (( \${#precmd_functions} > 1 || \${#preexec_functions} > 1 )); then\n    builtin printf '\\033]633;dsh;${token};unsupported\\007'\n    return\n  fi\n  if (( \${#\${(M)\${(k)functions}:#TRAP*}} )) || (( TMOUT )) || zmodload -e zsh/sched || [[ -n \"$(zle -F -L 2>/dev/null)\" ]]; then\n    builtin printf '\\033]633;dsh;${token};unsupported\\007'\n    return\n  fi\n  ${name}_ready=1\n}\nfunction ${name}_start() {\n  ${name}_ready=0\n  builtin printf '\\033]633;dsh;${token};start\\007'\n}\nfunction ${name}_prompt() {\n  if (( ${name}_ready )) && [[ $CONTEXT == start ]]; then\n    ${name}_ready=0\n    builtin printf '\\033]633;dsh;${token};prompt\\007'\n  fi\n}\nadd-zsh-hook precmd ${name}_precmd\nadd-zsh-hook preexec ${name}_start\nadd-zle-hook-widget line-init ${name}_prompt\nadd-zle-hook-widget line-finish ${name}_start\n`, { mode: 0o600 })
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error }
  let disposed = false
  return { directory, token, env: { ...env, ZDOTDIR: directory }, dispose() {
    if (disposed) return
    disposed = true
    // directory comes directly from mkdtempSync, never from client input.
    try { rmSync(directory, { recursive: true, force: true }) } catch { /* do not crash PTY exit/teardown if external permissions changed */ }
  } }
}

/** Incremental, bounded parser; only exact per-PTY markers are consumed. */
export class ZshMarkerParser {
  private pending = ''
  private readonly prefix: string
  constructor(token: string) { this.prefix = `\x1b]633;dsh;${token};` }
  feed(data: string, output: (text: string) => void, marker: (kind: 'start' | 'prompt' | 'unsupported') => void): void {
    let text = this.pending + data
    this.pending = ''
    while (text) {
      const index = text.indexOf(this.prefix)
      if (index < 0) {
        let keep = Math.min(text.length, this.prefix.length - 1)
        while (keep && !this.prefix.startsWith(text.slice(-keep))) keep--
        if (keep) { this.pending = text.slice(-keep); text = text.slice(0, -keep) }
        if (text) output(text)
        return
      }
      if (index) output(text.slice(0, index))
      text = text.slice(index)
      const tail = text.slice(this.prefix.length)
      const kind = tail.startsWith('prompt\x07') ? 'prompt' : tail.startsWith('start\x07') ? 'start' : tail.startsWith('unsupported\x07') ? 'unsupported' : undefined
      if (kind) {
        marker(kind)
        text = tail.slice(kind.length + 1)
      } else if (['prompt\x07', 'start\x07', 'unsupported\x07'].some(value => value.startsWith(tail))) {
        this.pending = text
        return
      } else {
        output(text[0]!)
        text = text.slice(1)
      }
    }
  }
}
