import { expect, it } from 'vitest'
import { isTerminalAccessDenied } from '../src/client/terminal-errors.ts'
it('stops structured policy and explicit nonretryable failures without guessing message text', () => {
  for (const error of [{ status: 401 }, { status: 403 }, { code: 'forbidden' }, { code: 'UNAUTHORIZED' },
    { code: 'ACCESS_DENIED' }, { code: 'PERMISSION_DENIED' }, { code: 'BINDING_REVOKED' }, { retryable: false }]) {
    expect(isTerminalAccessDenied(error)).toBe(true)
  }
  for (const error of [null, '403', Error('Forbidden'), { status: 503, retryable: true }, { code: 'NETWORK', retryable: true }]) {
    expect(isTerminalAccessDenied(error)).toBe(false)
  }
})
