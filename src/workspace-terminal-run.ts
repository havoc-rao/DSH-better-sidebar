/** One interactive shell, with a startup-only command file; never injects PTY input. */
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { SidebarError } from './wire.ts'

export interface TerminalRunBootstrap {
  directory: string
  token: string
  args: string[]
  env: NodeJS.ProcessEnv
  dispose(): void
}
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`

/** Deliberately narrow contract: non-login bash/zsh only. Custom startup flags
 * can suppress/replace rc files and cannot safely be combined with this launch.
 * Source an exact-byte file at top level (not eval, a function or a conditional):
 * heredocs, state changes, return, errexit and explicit exit retain shell semantics.
 */
export function prepareTerminalRun(executable: string, args: string[], command: string, env: NodeJS.ProcessEnv = process.env): TerminalRunBootstrap {
  const shell = basename(executable)
  if (process.platform === 'win32' || !['bash', 'zsh'].includes(shell) || args.length) {
    throw new SidebarError('pty-error', 'terminal-run-unsupported: persistent Run requires bash or zsh without custom shell arguments', 400)
  }
  const directory = mkdtempSync(join(tmpdir(), 'dsh-terminal-run-'))
  const token = randomBytes(24).toString('hex')
  const marker = `\\033]633;dsh;${token};`
  const fdNumber = 100 + Number.parseInt(token.slice(0, 4), 16) % 900
  const commandPath = join(directory, 'command')
  const name = `_dsh_run_${token.slice(0, 16)}`
  const fd = shell === 'zsh' ? `$${name}_fd` : String(fdNumber)
  const openFd = shell === 'zsh' ? `exec {${name}_fd}>&1` : `exec ${fd}>&1`
  const closeFd = shell === 'zsh' ? `exec {${name}_fd}>&-` : `exec ${fd}>&-`
  // Keep completion off user stdout/stderr: exec redirections inside the command
  // must not hide it. A random high FD is held only until the first prompt. Hooks, rather
  // than a statement after source, also survive an interrupt aborting rc input.
  const finish = `local ${name}_status=$?\nbuiltin printf '${marker}end;%s\\007' "$${name}_status" >&${fd}\n${closeFd}\n`
  const hook = shell === 'bash'
    ? `${name}_saved_prompt=("\${PROMPT_COMMAND[@]}")\nfunction ${name}_finish() {\n${finish}PROMPT_COMMAND=("\${${name}_saved_prompt[@]}")\nfunction ${name}_restore_status() { return "$${name}_status"; }\nlocal ${name}_prompt\nfor ${name}_prompt in "\${${name}_saved_prompt[@]}"; do\n${name}_restore_status\nbuiltin eval "$${name}_prompt"\ndone\nunset ${name}_saved_prompt\nunset -f ${name}_finish ${name}_restore_status\nreturn "$${name}_status"\n}\nPROMPT_COMMAND=${name}_finish\n`
    : `functions[${name}_saved_precmd]="\${functions[precmd]-}"\nfunction precmd() {\n${finish}functions[precmd]="\${functions[${name}_saved_precmd]}"\nunfunction ${name}_saved_precmd\nif [[ -n \${functions[precmd]} ]]; then\n  function ${name}_restore_status() { return "$${name}_status"; }\n  ${name}_restore_status\n  precmd\n  unfunction ${name}_restore_status\nelse\n  unfunction precmd\nfi\nreturn 0\n}\n`
  // Commands deliberately replacing prompt hooks/closing private FDs are outside
  // this cooperative completion contract; markers are not a same-UID boundary.
  const execute = `set +x +v\n${hook}builtin printf '${marker}start\\007' >&${fd}\nbuiltin source ${quote(commandPath)}\n`
  try {
    chmodSync(directory, 0o700)
    writeFileSync(commandPath, command, { mode: 0o600 })
    if (shell === 'bash') {
      writeFileSync(join(directory, 'bashrc'), `${openFd}\n[[ -r "$HOME/.bashrc" ]] && builtin source "$HOME/.bashrc"\n${execute}`, { mode: 0o600 })
    } else {
      const original = env.ZDOTDIR ?? env.HOME ?? ''
      const variable = `_dsh_run_${token.slice(0, 16)}_rcdir`
      writeFileSync(join(directory, '.zshenv'), `${openFd}\nZDOTDIR=${quote(original)}\n[[ -r "$ZDOTDIR/.zshenv" ]] && builtin source "$ZDOTDIR/.zshenv"\ntypeset -g ${name}_rcs=$options[rcs]\ntypeset -g ${variable}="\${ZDOTDIR:-$HOME}"\nZDOTDIR=${quote(directory)}\nsetopt rcs\n`, { mode: 0o600 })
      writeFileSync(join(directory, '.zshrc'), `ZDOTDIR="$${variable}"\nunset ${variable}\nif [[ $${name}_rcs == on ]]; then\n  [[ -r "$ZDOTDIR/.zshrc" ]] && builtin source "$ZDOTDIR/.zshrc"\nelse\n  unsetopt rcs\nfi\nunset ${name}_rcs\n${execute}`, { mode: 0o600 })
    }
  } catch (error) {
    // This exact absolute directory is allocated above, never supplied by clients.
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
  let disposed = false
  return {
    directory, token,
    args: shell === 'bash' ? ['--rcfile', join(directory, 'bashrc'), '-i'] : ['-i'],
    env: shell === 'zsh' ? { ...env, ZDOTDIR: directory } : { ...env },
    dispose() {
      if (disposed) return
      disposed = true
      // Only remove the exact mkdtemp directory retained by this bootstrap.
      try { rmSync(directory, { recursive: true, force: true }) } catch { /* teardown must not throw */ }
    },
  }
}
