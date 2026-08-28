// Transpiles one Electron-free TypeScript source file so a check script can
// import and drive it directly.
//
// Used by the diagnostics checks: those modules deliberately import nothing from
// Electron precisely so they can be exercised outside the app.
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..', '..')

/** Scratch dirs created this run, so a caller can tidy up when it finishes. */
const emitted = []

/**
 * @param {string} relSource repo-relative path to the .ts file
 * @returns {string} path to an importable .mjs
 */
function transpileToMjs(relSource) {
  // Emit inside the repo, not into the system temp dir: the transpiled module
  // keeps its bare imports (jszip, for one), and Node only resolves those by
  // walking up to a node_modules. Emitting outside the tree breaks that.
  const outDir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.svwb-check-'))

  // Invoke tsc's JS entrypoint through node: the .bin shim needs a shell, which
  // execFileSync does not provide on Windows.
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
  execFileSync(
    process.execPath,
    [
      tsc,
      path.join(ROOT, relSource),
      '--outDir',
      outDir,
      '--module',
      'esnext',
      '--target',
      'es2022',
      '--moduleResolution',
      'bundler',
      '--skipLibCheck',
      '--esModuleInterop'
    ],
    { stdio: 'pipe' }
  )

  // tsc infers its output root from every input in the program, so a source that
  // imports from node_modules emits nested rather than flat. Locate the emit
  // instead of assuming where it landed.
  const wanted = `${path.basename(relSource, '.ts')}.js`
  const found = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === wanted) found.push(full)
    }
  }
  walk(outDir)
  if (found.length === 0) throw new Error(`tsc produced no ${wanted} under ${outDir}`)

  // Rename so Node treats it as ESM regardless of any package.json nearby.
  const mjs = found[0].replace(/\.js$/, '.mjs')
  fs.renameSync(found[0], mjs)
  emitted.push(outDir)
  return mjs
}

function cleanupTranspiled() {
  for (const dir of emitted) fs.rmSync(dir, { recursive: true, force: true })
  emitted.length = 0
}

module.exports = { transpileToMjs, cleanupTranspiled, ROOT }
