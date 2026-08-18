import { chromium } from '@playwright/test'

const url = process.env.DSH_E2E_URL
const ws = process.env.DSH_E2E_WORKSPACE
async function rpc(method, payload) {
  const res = await fetch(url + '/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'repro-' + method, method, payload }),
  })
  return (await res.json()).result
}
const wsRes = await rpc('workspace.create', { path: ws })
const workspaceId = wsRes.value.workspace.workspaceId
await rpc('session.create', { workspaceId })

const browser = await chromium.launch({ executablePath: '/Users/havoc420/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell' })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(url, { waitUntil: 'networkidle' })
await page.waitForSelector('[data-dsh-better-sidebar]', { state: 'attached', timeout: 30000 })
await page.waitForTimeout(1500)
for (let round = 0; round < 8; round++) {
  let dismissed = false
  for (const name of ['Continue', 'Configure later']) {
    const button = page.getByRole('button', { name, exact: true }).first()
    if ((await button.count()) === 0) continue
    try { await button.click({ timeout: 4000 }); dismissed = true; await page.waitForTimeout(800) } catch {}
  }
  if (!dismissed) break
}
await page.waitForTimeout(800)

// 打开底部面板
const bottomBtn = page.locator('[aria-label="Expand bottom panel"]').first()
if (await bottomBtn.isVisible().catch(() => false)) {
  await bottomBtn.click()
  await page.waitForTimeout(900)
}
// 最大化：dispatch ⌘⇧J
await page.keyboard.press('Meta+Shift+J')
await page.waitForTimeout(900)

const info = await page.evaluate(() => {
  const host = document.querySelector('[data-dsh-better-sidebar]')
  const panel = host?.querySelector('[class*="bottomPanel"]') || [...document.querySelectorAll('div')].find(d => /bottomPanel/.test(d.className || '') && !/Hidden/.test(d.className || ''))
  const scroll = document.querySelector('[data-conversation-scroll]')
  const inputBar = [...document.querySelectorAll('div')].find(d => /input/.test(d.className || '') && d.getBoundingClientRect().height > 20 && d.getBoundingClientRect().bottom > 500)
  const rect = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return { cls: (el.className || '').toString().slice(0, 60), top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), z: cs.zIndex, pos: cs.position, bg: cs.backgroundColor, transform: cs.transform.slice(0, 40) }
  }
  // 面板区域内 elementFromPoint 命中谁（中心点偏上 20px，避开 tab 条）
  const pRect = panel?.getBoundingClientRect()
  const hitTop = pRect ? document.elementFromPoint(pRect.left + pRect.width / 2, pRect.top + 40) : null
  const hitMid = pRect ? document.elementFromPoint(pRect.left + pRect.width / 2, pRect.top + pRect.height / 2) : null
  const hitCls = (el) => el ? (el.className || el.tagName).toString().slice(0, 60) : null
  // 命中元素的祖先链（class + z-index + position + 是否在 host 内）
  const chain = (el) => {
    const out = []
    let cur = el
    while (cur && cur !== document.body) {
      const cs = getComputedStyle(cur)
      const r = cur.getBoundingClientRect()
      out.push({
        tag: cur.tagName.toLowerCase(),
        cls: (cur.className || '').toString().slice(0, 50),
        z: cs.zIndex,
        pos: cs.position,
        inHost: Boolean(host && host.contains(cur)),
        h: Math.round(r.height),
      })
      cur = cur.parentElement
    }
    return out
  }
  // 宿主输入区候选：在 #root 内找 z-index >= 40 或 transform 的元素
  const hostOverlays = [...document.querySelectorAll('#root *')].filter((el) => {
    const cs = getComputedStyle(el)
    const z = Number(cs.zIndex || 0)
    return z >= 40 || cs.transform !== 'none'
  }).slice(0, 8).map((el) => {
    const cs = getComputedStyle(el)
    return { cls: (el.className || '').toString().slice(0, 50), z: cs.zIndex, pos: cs.position, transform: cs.transform.slice(0, 30) }
  })
  // 完整层叠列表（从最上层开始）
  const stack = pRect ? document.elementsFromPoint(pRect.left + pRect.width / 2, pRect.top + pRect.height / 2)
    .slice(0, 6).map((el) => {
      const cs = getComputedStyle(el)
      return { cls: (el.className || el.tagName).toString().slice(0, 45), z: cs.zIndex, pe: cs.pointerEvents, inHost: Boolean(host && host.contains(el)) }
    }) : []
  // 宿主 composer 的 DOM 位置（body 直接子级顺序）
  const bodyKids = [...document.body.children].map((el) => ({
    tag: el.tagName.toLowerCase(),
    cls: (el.className || '').toString().slice(0, 40),
    id: el.id,
  }))
  // 命中的宿主元素是否带 transform/isolation/contain（创建 stacking context 的线索）
  const hitInfo = hitMid ? (() => {
    const cs = getComputedStyle(hitMid)
    return { transform: cs.transform.slice(0, 30), isolation: cs.isolation, contain: cs.contain, z: cs.zIndex }
  })() : null
  const probe = (sel, css) => {
    const style = document.createElement('style')
    style.textContent = css
    document.head.appendChild(style)
    const pRect2 = panel.getBoundingClientRect()
    const hit = document.elementFromPoint(pRect2.left + pRect2.width / 2, pRect2.top + pRect2.height / 2)
    style.remove()
    return hitCls(hit) + ' (probe: ' + sel + ')'
  }
  return {
    host: rect(host),
    panel: rect(panel),
    hitMid: hitCls(hitMid),
    probePanelZ: probe('panel z-1000', '[class*="bottomPanel"]{z-index:1000 !important}'),
    probeHostZ: probe('host z-1000', '[data-dsh-better-sidebar]{z-index:1000 !important}'),
  }
})
console.log(JSON.stringify(info, null, 1))
await browser.close()
