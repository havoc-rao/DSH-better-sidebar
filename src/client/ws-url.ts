/**
 * WebSocket URL resolution for the sidebar's push sockets.
 *
 * Every sidebar WS route (`/sidebar/ws/<name>`) upgrades the host webserver,
 * which in browser deployments is the page's own origin — `new
 * URL('/sidebar/ws/x', location.origin)` + protocol swap, as it has always
 * been. The deepseek-harness desktop shell is the one exception: its renderer
 * runs on `dsh-app://app`, a custom protocol whose own `location.origin`
 * cannot carry a WebSocket (custom-scheme WS upgrades are not forwarded by
 * the shell, and the browser treats the scheme accordingly). The shell
 * publishes the physical loopback host through the same programmatic
 * `__DSH_TRANSPORT__.streamBaseUrl` seam the product's own client bundles
 * use for their `/api/remote.mux` downlink, so the sidebars upgrade against
 * that base when present — and the shell's own session integrates the cookie
 * for those sockets exactly as it does for the product's.
 *
 * Deliberately NOT used for the HTTP routes (`/sidebar/api`, `/sidebar/file`,
 * `/sidebar/bundle`, …): the shell's protocol handler forwards those to the
 * host with the page's own origin intact, and the plugin's trust fence
 * requires the request Origin to name the host — a page fetch against the
 * raw loopback URL would carry `Origin: dsh-app://app` and be refused. Only
 * the upgrade path needs the absolute address.
 */
export function sidebarWsUrl(path: string): URL {
  const globals = globalThis as { __DSH_TRANSPORT__?: { streamBaseUrl?: string } }
  const base = globals.__DSH_TRANSPORT__?.streamBaseUrl
  const parsed = new URL(path, base === undefined ? window.location.origin : base)
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
  return parsed
}