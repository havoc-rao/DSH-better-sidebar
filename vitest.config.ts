/**
 * Vitest config: inline the npm-published `@deepseek-ai/*` packages whose
 * BUILT lib bundles css side-effect imports (e.g. `dsh-client-ui-primitives`
 * imports `katex/dist/katex.min.css` at the top of its `lib/index.js`).
 *
 * Installed from the npm registry (the default since v0.4.1) these packages
 * live under `node_modules/.pnpm` and are externalized by vitest — Node then
 * chokes on the `.css` import. Inlining routes them through Vite's transform,
 * which stubs css imports (the default `css: false`). The previous
 * `link:`-to-source-checkout install needed no such config: linked files sit
 * outside `node_modules` and are transformed by default.
 */
import { defineConfig } from 'vitest/config'

// Opt-in local-environment exemption. These spec files exercise things the
// local sandbox / OS-locale cannot provide — spawning a real PTY
// (agent-pty, smoke), MutationObserver flush timing in jsdom
// (host-sidebar-keeper), and English-copy assertions under a zh_CN locale
// (side-card-section). They pass on CI (which runs the FULL suite) but fail
// deterministically on a zh_CN + no-PTY machine. Set DSH_SKIP_ENV_TESTS=1
// (or use `pnpm test:local`) to exclude them for a green local run.
// Default (absent): nothing is skipped — CI keeps running everything.
const skipEnvTests = process.env.DSH_SKIP_ENV_TESTS === '1'

export default defineConfig({
  test: {
    server: {
      deps: {
        inline: [/@deepseek-ai\/dsh-client-ui-primitives/],
      },
    },
    // The Playwright headless-render lane lives in tests/e2e (specs named
    // *.e2e.ts). Keep vitest from ever collecting it, both by naming (the
    // default include only matches *.test.* / *.spec.*) and by an explicit
    // exclude. NOTE: `exclude` REPLACES vitest's defaults, so the standard
    // node_modules/dist/etc. excludes must be restated here.
    exclude: [
      'tests/e2e/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
      // Only these 4 environment-limited files are dropped under the flag;
      // every other spec keeps running, so regressions elsewhere still gate.
      ...(skipEnvTests ? [
        'tests/agent-pty.spec.ts',          // node-pty can't allocate a PTY here
        'tests/smoke.spec.ts',              // 同上 (pty-manager spawns)
        'tests/host-sidebar-keeper.spec.tsx', // jsdom MutationObserver timing
        'tests/side-card-section.spec.tsx',   // asserts EN copy; local is zh_CN
      ] : []),
    ],
  },
})
