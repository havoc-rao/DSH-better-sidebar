/** Read-only, bounded process inspection. Silence is never evidence of idleness. */
import { execFile } from 'node:child_process'
import { terminalCommandBasename } from './terminal-command.ts'

const SHELL = /^(?:bash|zsh|dash|sh|ksh|fish|tcsh|csh)$/

export interface TerminalActivityResult {
  activity: 'idle' | 'busy' | 'unknown'
  reason: string
  /** Unique observed executable basenames in this terminal's foreground group. */
  runningCommands?: readonly string[]
}

/** Normalized snapshot: pid ppid pgid tpgid tty stat wchan comm.
 * ps alone cannot distinguish prompt from built-in read. Only independent
 * opt-in ZLE prompt proof permits idle, still requiring a sleeping foreground
 * zsh with no descendants or other processes on its controlling terminal.
 */
export function activityFromPs(text: string, pid: number, promptProven = false): TerminalActivityResult {
  const rows = text.trim().split('\n').filter(Boolean).map(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/)
    return m ? { pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), foreground: Number(m[4]), tty: m[5]!, state: m[6]!, wait: m[7]!, command: m[8]! } : undefined
  })
  if (rows.some(row => !row)) return { activity: 'unknown', reason: 'ps-snapshot-unparseable' }
  const processes = rows.filter(row => row !== undefined)
  const shell = processes.find(row => row.pid === pid)
  if (!shell) return { activity: 'unknown', reason: 'shell-process-not-observed' }
  // Any descendant (including stopped/background jobs) precludes idle.
  const descendants = new Set([pid])
  let count = 0
  do {
    count = descendants.size
    for (const row of processes) if (descendants.has(row.ppid)) descendants.add(row.pid)
  } while (descendants.size !== count)
  // Only the managed root or its descendants may supply names; unrelated tty
  // processes/background groups never do. Shell wrappers are transparent but
  // argv is deliberately never inspected (node script.js remains node).
  const runningCommands = [...new Set(processes.filter(row => descendants.has(row.pid)
    && row.tty === shell.tty && !['?', '??', '-'].includes(row.tty)
    && shell.foreground > 0 && row.pgid === shell.foreground
    && !/^[TXZ]/.test(row.state))
    .map(row => terminalCommandBasename(row.command))
    .filter((name): name is string => !!name && !SHELL.test(name)))].sort()
  const commands = runningCommands.length ? { runningCommands } : {}
  if (descendants.size > 1) return { activity: 'busy', reason: 'shell-has-descendants', ...commands }
  // exec replaces the managed shell in place: report the observed executable,
  // not a guessed shell/CLI name, even when no descendants remain.
  if (runningCommands.length) return { activity: 'busy', reason: 'foreground-executable', ...commands }
  if (shell.tty === '?' || shell.foreground <= 0) return { activity: 'unknown', reason: 'no-controlling-terminal' }
  if (shell.pgid !== shell.foreground) return { activity: 'busy', reason: 'shell-not-foreground' }
  if (processes.some(row => row.pid !== pid && row.tty === shell.tty)) return { activity: 'busy', reason: 'terminal-has-other-processes' }
  const command = shell.command.split('/').at(-1)
  if (!/^(?:bash|zsh|dash|sh|ksh|fish)$/.test(command ?? '')) return { activity: 'unknown', reason: 'unrecognized-shell' }
  if (promptProven && command === 'zsh' && /^S/.test(shell.state)) {
    return { activity: 'idle', reason: 'zsh-zle-prompt-no-jobs' }
  }
  if (/^S/.test(shell.state) && /^(?:n_tty_read|tty_read)$/.test(shell.wait)) {
    // `read` builtins and scripts waiting for input have exactly this shape.
    // Without authenticated shell prompt integration this cannot prove idle.
    return { activity: 'unknown', reason: 'prompt-state-unproven' }
  }
  return { activity: 'unknown', reason: 'terminal-input-wait-not-proven' }
}

export async function probeTerminalActivity(pid: number, promptProven = false): Promise<TerminalActivityResult> {
  if (!['linux', 'darwin'].includes(process.platform)) return { activity: 'unknown', reason: 'platform-probe-unsupported' }
  if (!Number.isSafeInteger(pid) || pid <= 0) return { activity: 'unknown', reason: 'invalid-shell-pid' }
  return new Promise(resolve => {
    const mac = process.platform === 'darwin'
    const args = mac ? ['-axo', 'pid=,ppid=,pgid=,tpgid=,tty=,stat=,comm=']
      : ['-e', '-o', 'pid=,ppid=,pgid=,tpgid=,tty=,stat=,wchan:64=,comm=']
    execFile('ps', args, {
      timeout: 1500, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' },
    }, (error, stdout) => {
      // Darwin has no useful wait channel; the independent ZLE proof is mandatory.
      const snapshot = mac ? stdout.split('\n').map(line => line.replace(/^(\s*\d+\s+\d+\s+-?\d+\s+-?\d+\s+\S+\s+\S+)\s+(.+)$/, '$1 - $2')).join('\n') : stdout
      resolve(error ? { activity: 'unknown', reason: 'process-probe-failed' } : activityFromPs(snapshot, pid, promptProven))
    })
  })
}
