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
        '@renderer': resolve('src/renderer/src')
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
            ],
            'vendor-ocr': ['tesseract.js']
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
