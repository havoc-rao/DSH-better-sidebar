import { describe, expect, it } from 'vitest'
import { activityFromPs, probeTerminalActivity } from '../src/terminal-activity.ts'

const shell = '100 1 100 100 pts/3 S+ n_tty_read bash'
describe('conservative terminal process activity', () => {
  it('never mistakes a terminal-reading shell builtin or script for a prompt', () => {
    expect(activityFromPs(shell, 100)).toEqual({ activity: 'unknown', reason: 'prompt-state-unproven' })
    for (const text of [shell.replace('n_tty_read', 'wait_woken'), shell.replace('n_tty_read', 'do_wait'),
      shell.replace('S+', 'R+'), shell.replace('pts/3', '?')]) {
      expect(activityFromPs(text, 100).activity).toBe('unknown')
    }
  })
  it('protects stopped/background descendants and other foreground terminal processes', () => {
    expect(activityFromPs(`${shell}\n101 100 101 100 pts/3 T do_signal_stop sleep`, 100).activity).toBe('busy')
    expect(activityFromPs(`${shell}\n101 1 101 101 pts/3 S hrtimer_nanosleep sleep`, 100).activity).toBe('busy')
    expect(activityFromPs(shell.replace('100 100 pts', '100 200 pts'), 100).activity).toBe('busy')
  })
  it('requires independent ZLE proof even on mac-style sleeping zsh snapshots', () => {
    const mac = '100 1 100 100 ttys003 S+ - /bin/zsh\n200 1 200 -1 ?? Ss - /Applications/Some App/worker'
    expect(activityFromPs(mac, 100).activity).toBe('unknown')
    expect(activityFromPs(mac, 100, true).activity).toBe('idle')
    expect(activityFromPs(mac + '\n101 100 101 100 ttys003 S - /bin/sleep', 100, true).activity).toBe('busy')
    expect(activityFromPs(mac.replace('S+ - /bin/zsh', 'R+ - /bin/zsh'), 100, true).activity).toBe('unknown')
  })
  it('identifies foreground executable basenames through wrappers without guessing script names', () => {
    const root = shell.replace('100 100 pts', '100 200 pts')
    const text = `${root}\n200 100 200 200 pts/3 S do_wait /bin/sh\n201 200 200 200 pts/3 S ep_poll /usr/bin/node\n202 201 200 200 pts/3 S ep_poll /usr/bin/node\n203 100 203 200 pts/3 S wait /usr/bin/python\n204 1 200 200 pts/3 S wait unrelated`
    expect(activityFromPs(text, 100).runningCommands).toEqual(['node'])
    expect(activityFromPs(shell.replace('bash', '/opt/bin/codex'), 100)).toMatchObject({ activity: 'busy', runningCommands: ['codex'] })
  })
  it('omits stopped, zombie, background, unsafe and unknown commands', () => {
    for (const row of ['101 100 101 100 pts/3 S wait python', '101 100 100 100 pts/3 T stop claude',
      '101 100 100 100 pts/3 Z - codex', '101 100 100 100 pts/3 S wait node --token=secret',
      '101 100 100 100 pts/3 S wait /tmp/unsafe name', '101 100 100 100 pts/3 S wait /bin/bash']) {
      expect(activityFromPs(`${shell}\n${row}`, 100).runningCommands).toBeUndefined()
    }
    expect(activityFromPs(shell.replace('bash', 'zsh'), 100, true).runningCommands).toBeUndefined()
    expect(activityFromPs(`${shell}\ntruncated`, 100).runningCommands).toBeUndefined()
  })
  it('fails closed on missing, malformed or unsupported probe data', async () => {
    expect(activityFromPs('', 100).activity).toBe('unknown')
    expect(activityFromPs(`${shell}\ntruncated`, 100).activity).toBe('unknown')
    expect((await probeTerminalActivity(-1)).activity).toBe('unknown')
  })
})
