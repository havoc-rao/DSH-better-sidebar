// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ConfirmDialog } from '../src/client/ui/kit.tsx'
import { DELETE_CONFIRM, DELETE_CANCEL, DeleteDialogHintBridge, registerDeleteDialogHotkeys, installDeleteDialogHotkeys } from '../src/client/ui/delete-dialog-hotkeys.tsx'
import { setupReactAct } from './test-utils.ts'
setupReactAct()

type Registry = Parameters<typeof registerDeleteDialogHotkeys>[0]
type Action = Parameters<Registry['registerAction']>[0]
function registry() {
  const actions = new Map<string, Action>()
  const registerAction = vi.fn((action: Action) => {
    if (actions.has(action.id)) throw new Error('duplicate action')
    actions.set(action.id, action)
    return () => { actions.delete(action.id) }
  })
  return { version: 1 as const, actions, registerAction }
}
async function fixture() {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const onConfirm = vi.fn(), onClose = vi.fn()
  const props = { open: true, title: 'Delete?', description: 'Permanent', confirmLabel: 'Delete', cancelLabel: 'Cancel', deleteHotkeys: true, onConfirm, onClose }
  const render = async (patch: Partial<typeof props> & { busy?: boolean } = {}) => {
    Object.assign(props, patch)
    await act(async () => { root.render(createElement(ConfirmDialog, props)) })
  }
  await render()
  return { root, props, render, onConfirm, onClose, close: async () => { await act(async () => { root.unmount() }); container.remove() } }
}

describe('file deletion hotkey v1 owner', () => {
  it('owns both actions in the actual portaled dialog, defaults to modified keys, and claims once', async () => {
    const registry_ = registry()
    const release = registerDeleteDialogHotkeys(registry_)
    expect(registry_.actions.size).toBe(0)
    const view = await fixture()
    const confirm = registry_.actions.get(DELETE_CONFIRM)!
    const cancel = registry_.actions.get(DELETE_CANCEL)!
    expect(confirm.scope).toBe('focus')
    expect(confirm.element).toBe(document.querySelector('[role="dialog"]'))
    expect(confirm.defaultBinding).toEqual({ mac: 'meta+enter', default: 'ctrl+enter' })
    expect(cancel.defaultBinding).toEqual({ mac: 'meta+escape', default: 'ctrl+escape' })
    expect(document.activeElement?.textContent).toBe('Cancel')
    expect(confirm.available()).toBe(true)
    await act(async () => { expect(confirm.run()).toBe(true); expect(confirm.run()).toBe(false); expect(cancel.run()).toBe(false) })
    expect(view.onConfirm).toHaveBeenCalledTimes(1)
    expect(view.onClose).not.toHaveBeenCalled()
    await view.close()
    expect(confirm.available()).toBe(false)
    expect(registry_.actions.size).toBe(0)
    release()
  })

  it('busy disables both actions, mask/close/Escape, and closing drops the IDs', async () => {
    const view = await fixture()
    const registry_ = registry()
    const release = registerDeleteDialogHotkeys(registry_)
    await view.render({ busy: true })
    for (const action of registry_.actions.values()) { expect(action.available()).toBe(false); expect(action.run()).toBe(false) }
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[aria-label="Cancel"]')?.click()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(view.onClose).not.toHaveBeenCalled()
    await view.render({ busy: false })
    await act(async () => { expect(registry_.actions.get(DELETE_CANCEL)?.run()).toBe(true) })
    expect(view.onClose).toHaveBeenCalledTimes(1)
    await view.render({ open: false })
    expect(registry_.actions.size).toBe(0)
    release()
    await view.close()
  })

  it('portals owner-specific hint slots into buttons, forwards disabled, and elects just one bridge', async () => {
    const view = await fixture()
    const host = document.createElement('div')
    const root = createRoot(host)
    const renderSlot = vi.fn((key: string, props: { hotkeyHint: { commandId: string; disabled: boolean } }) =>
      createElement('span', { 'data-hint': props.hotkeyHint.commandId }, props.hotkeyHint.disabled ? '' : key.includes('confirm') ? '⌘↵' : '⌘⎋'))
    await act(async () => { root.render(createElement('div', null,
      createElement(DeleteDialogHintBridge, { renderSlot: renderSlot as never }),
      createElement(DeleteDialogHintBridge, { renderSlot: renderSlot as never }))) })
    expect(document.querySelectorAll('[data-hint]')).toHaveLength(2)
    expect(document.querySelector(`[data-hint="${DELETE_CONFIRM}"]`)?.closest('button')?.textContent).toBe('Delete⌘↵')
    expect(renderSlot).toHaveBeenCalledWith('betterSidebar.delete.cancel.hotkeyHint', { hotkeyHint: { version: 1, commandId: DELETE_CANCEL, disabled: false } })
    await view.render({ busy: true })
    expect(document.querySelector(`[data-hint="${DELETE_CANCEL}"]`)?.textContent).toBe('')
    await act(async () => { root.unmount() })
    expect(document.querySelectorAll('[data-hint]')).toHaveLength(0)
    await view.close()
  })

  it('keeps native plain Escape and mouse controls working without hotkey', async () => {
    const view = await fixture()
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(view.onClose).toHaveBeenCalledTimes(1)
    await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Delete')?.click() })
    expect(view.onConfirm).toHaveBeenCalledTimes(1)
    await view.close()
  })

  it('injects optionally, rejects other versions, and follows the injected effect disposal', async () => {
    const view = await fixture()
    let inject: (ctx: unknown) => void = () => {}
    installDeleteDialogHotkeys({ inject: (deps: string[], callback: typeof inject) => { expect(deps).toEqual(['hotkey']); inject = callback } } as never)
    const effect = vi.fn()
    inject({ get: () => ({ version: 2 }), effect })
    expect(effect).not.toHaveBeenCalled()
    const registry_ = registry()
    let dispose = () => {}
    inject({ get: () => registry_, effect: (setup: () => () => void) => { dispose = setup() } })
    expect(registry_.actions.size).toBe(2)
    dispose()
    expect(registry_.actions.size).toBe(0)
    inject({ get: () => registry_, effect: (setup: () => () => void) => { dispose = setup() } })
    expect(registry_.actions.size).toBe(2)
    dispose()
    await view.close()
  })
})
