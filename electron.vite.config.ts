import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      sourcemap: false,
      minify: true,
      target: 'node22'
    }
  },

  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      sourcemap: false,
      minify: true,
      target: 'node22',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          exitConfirm: resolve(__dirname, 'src/preload/exit-confirm.ts'),
          exitChoice: resolve(__dirname, 'src/preload/exit-choice.ts')
        }
      }
    }
  },

  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        // `tsconfig.web.json` has always declared this one, so type-only imports
        // resolved and typecheck stayed green - but the bundler never knew about
        // it, so the first renderer module to import a *value* from `@shared`
        // failed the build instead.
        '@shared': resolve('src/shared')
      }
    },
    // No gzip plugin here, deliberately. It used to emit a `.gz` beside every
    // chunk, and `build.files` ships `out/**` - so ~370KB of compressed copies
    // went into the installer that nothing ever reads: the renderer loads over
    // `file://`, where there is no server to negotiate an encoding.
    plugins: [react()],
    build: {
      sourcemap: false,
      minify: true,
      target: 'chrome134',
      rollupOptions: {
        output: {
          /**
           * One eager `vendor` chunk, and `chart.js` on its own so it can be
           * lazy. The shape matters more than it looks, so here is the whole
           * reasoning.
           *
           * ## What this is for
           *
           * `chart.js` has exactly one consumer in this app: the HUD's
           * doughnut (`HudDonut.tsx`, lazily imported). It has no business in
           * the main window at all. But with the previous config - a
           * `manualChunks` OBJECT naming only `vendor-chart` and `vendor-mui` -
           * Rollup placed shared dependencies into whichever named chunk
           * already reached them, and React landed inside `vendor-chart`.
           * Every entry then had to load that chunk to get React, so the main
           * window eagerly downloaded 120KB of charting it never uses.
           *
           * ## Why a function and not a longer object
           *
           * The obvious fix - adding `'vendor-react': ['react', 'react-dom']` -
           * fails, in two different ways. Object values are resolved as ENTRY
           * MODULES, so they match only that exact specifier: the app imports
           * `react-dom/client`, a different module, which went on being placed
           * elsewhere and left a 12KB `vendor-react` with every entry still
           * pulling `vendor-chart`. Quiet, and easy to believe you had fixed
           * it. Naming `scheduler` fails loudly instead - pnpm does not hoist
           * it, so it is not resolvable from here and the build stops.
           *
           * Matching resolved paths avoids both.
           *
           * ## Why React and MUI share one chunk
           *
           * Because splitting them produced a CIRCULAR pair of chunks, and the
           * symptom was the app not starting: `Uncaught ReferenceError: Cannot
           * access 'In' before initialization`. Vite's CommonJS interop helper
           * is a shared virtual module; with two vendor chunks it was emitted
           * into `vendor-mui`, `vendor-react` imported it back, and whichever
           * chunk evaluated second read an uninitialised binding.
           *
           * Pinning the helper would fix that instance, but the shape stays
           * fragile - any future shared helper can recreate it. And on
           * `file://` there is nothing to win: no HTTP cache, no parallel
           * download budget, and both entries need both libraries anyway. One
           * chunk cannot form a cycle with itself.
           *
           * `chart.js` stays separate because it is the one thing NOT wanted
           * eagerly, and a lazy chunk importing an eager one is an ordinary
           * edge, not a cycle.
           *
           * `@mui/x-date-pickers` is deliberately left out: its only consumer
           * is the custom date range in `FilterEditors`, whose chunk is
           * already lazy, and folding it in here turns "loaded if needed" into
           * "loaded always" for 190KB.
           *
           * The E2E suite is what catches all of this. The build reports none
           * of it.
           */
          manualChunks(id) {
            if (/[\\/]node_modules[\\/](chart\.js|react-chartjs-2)[\\/]/.test(id)) {
              return 'vendor-chart'
            }
            if (
              /[\\/]node_modules[\\/](react|react-dom|scheduler|react-is)[\\/]/.test(id) ||
              /[\\/]node_modules[\\/](@mui[\\/](?!x-)|@emotion[\\/])/.test(id)
            ) {
              return 'vendor'
            }
            // Vite's CommonJS interop helpers are a virtual module (`\0`-
            // prefixed, not under node_modules). Pinned to the eager chunk so
            // they can never end up somewhere `vendor` has to import back.
            if (id.includes('commonjsHelpers')) return 'vendor'
            return undefined
          }
        },
        input: {
          main: resolve('src/renderer/index.html'),
          hud: resolve('src/renderer/hud.html')
        }
      }
    }
  }
})
