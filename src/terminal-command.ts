/** Shared wire validation: executable basenames only, never argv or titles. */
export function isSafeTerminalCommand(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/.test(value)
}

export function terminalCommandBasename(comm: string): string | undefined {
  const name = comm.split('/').at(-1)
  return isSafeTerminalCommand(name) ? name : undefined
}
