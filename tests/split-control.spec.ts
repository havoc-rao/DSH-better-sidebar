/** Native split visibility belongs to the host: it considers raw room even
 * when the disabled reason is budget, using stable control measurements.
 * Plugin CSS must not reintroduce a second visibility/measurement policy.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/client/sidebar.module.css', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')

describe('native split control visibility', () => {
  it('does not override host split control geometry or visibility', () => {
    expect(css).not.toContain('data-dockkit-split-control')
    expect(css).not.toContain('data-dockkit-split-blocked')
  })
})
