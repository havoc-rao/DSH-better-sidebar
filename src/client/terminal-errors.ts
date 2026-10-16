/** Structural cross-provider error contract; never depend on another plugin's class. */
export function isTerminalAccessDenied(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const value = error as { code?: unknown; status?: unknown; retryable?: unknown }
  return value.retryable === false || value.status === 401 || value.status === 403
    || typeof value.code === 'string' && ['FORBIDDEN', 'UNAUTHORIZED', 'ACCESS_DENIED', 'PERMISSION_DENIED', 'BINDING_REVOKED'].includes(value.code.toUpperCase())
}
