/**
 * Runs `tools/sync-dev/server.ts` (TypeScript, with imports Node cannot resolve
 * on its own) by bundling it first. esbuild comes along with Vite, so there is
 * nothing extra to install.
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(root, 'package.json'))
const viteDir = path.dirname(require.resolve('vite/package.json'))
const esbuild = createRequire(path.join(viteDir, 'package.json'))('esbuild')

// Inside node_modules so that the bundle's `import 'better-sqlite3'` resolves from the repo.
const outDir = path.join(root, 'node_modules', '.cache', 'sync-dev')
fs.mkdirSync(outDir, { recursive: true })
const out = path.join(outDir, 'server.mjs')
await esbuild.build({
  entryPoints: [path.join(root, 'tools/sync-dev/server.ts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['better-sqlite3'],
  logLevel: 'warning'
})
const child = spawn(process.execPath, [out], { stdio: 'inherit', cwd: root })
child.on('exit', (code) => process.exit(code ?? 0))
