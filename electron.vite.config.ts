import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import viteCompression from 'vite-plugin-compression'

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
    plugins: [
      react(),
      // @ts-ignore viteCompression
      viteCompression({
        algorithm: 'gzip',
        threshold: 10240,
        ext: '.gz'
      })
    ],
    build: {
      sourcemap: false,
      minify: true,
      target: 'chrome134',
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-chart': ['chart.js', 'react-chartjs-2'],
            'vendor-mui': [
              '@mui/material',
              '@mui/icons-material',
              '@emotion/react',
              '@emotion/styled'
            ]
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
