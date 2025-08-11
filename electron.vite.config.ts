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
      target: 'node22'
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
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (id.includes('chart.js')) return 'chart'
              if (id.includes('@mui')) return 'mui'
              if (id.includes('tesseract.js')) return 'ocr'
              return 'vendor'
            }
            return 'app'
          }
        }
      }
    }
  }
})
