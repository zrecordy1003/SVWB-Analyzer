/**
 * Plan P1 acceptance: `svwb-engine` must reproduce the shipped Node addon
 * exactly, per fixture and per probe, before anything is allowed to depend on
 * it.
 *
 *   node tools/vision-node-addon/check-engine-parity.cjs
 *
 * Both halves probe the SAME registry - `svwb-engine probes` emits it and the
 * Node half consumes it - so a disagreement here is a disagreement about
 * normalisation, scaling or matching, never about which windows to look at.
 * Neither side has its own copy of the table, deliberately.
 *
 * Requires `cargo build -p svwb-engine --release` and a built
 * `tools/svwb-vision.node`.
 *
 * TEMPORARY, with a stated end date: delete this and `dump-probes.cjs` when the
 * addon goes away in plan P3. There is nothing to compare once one of the two
 * implementations is gone.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..', '..')
const ENGINE = path.join(ROOT, 'tools', 'target', 'release', 'svwb-engine.exe')
const TEMPLATES = path.join(ROOT, 'resources', 'templates')
const FIXTURES = path.join(ROOT, 'tests', 'fixtures')

function fail(message) {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

if (!fs.existsSync(ENGINE)) {
  fail(`${path.relative(ROOT, ENGINE)} not built - run:\n  cargo build --manifest-path tools/Cargo.toml -p svwb-engine --release`)
}

/** Every fixture PNG, in a stable order so the two dumps line up. */
function fixtureImages(dir) {
  const found = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...fixtureImages(full))
    else if (entry.name.endsWith('.png')) found.push(full)
  }
  return found
}

const images = fixtureImages(FIXTURES)
if (images.length === 0) fail(`no PNG fixtures under ${path.relative(ROOT, FIXTURES)}`)

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'svwb-parity-'))
const registry = path.join(work, 'probes.jsonl')

try {
  fs.writeFileSync(registry, execFileSync(ENGINE, ['probes'], { encoding: 'utf8' }))
  const probeCount = fs.readFileSync(registry, 'utf8').trim().split('\n').length

  const fromEngine = execFileSync(
    ENGINE,
    ['probe-dump', '--templates', TEMPLATES, ...images],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
  const fromAddon = execFileSync(
    process.execPath,
    [
      path.join(__dirname, 'dump-probes.cjs'),
      '--probes', registry,
      '--templates', TEMPLATES,
      ...images
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )

  const engineLines = fromEngine.trim().split('\n')
  const addonLines = fromAddon.trim().split('\n')
  const expected = images.length * probeCount

  // Guard against a vacuous pass: two empty outputs also "agree".
  if (engineLines.length !== expected) {
    fail(`engine emitted ${engineLines.length} rows, expected ${images.length} images x ${probeCount} probes = ${expected}`)
  }
  if (addonLines.length !== expected) {
    fail(`addon emitted ${addonLines.length} rows, expected ${expected}`)
  }
  const misses = engineLines.filter((l) => l.includes('"name":null')).length
  if (misses === engineLines.length) {
    fail('every probe missed - templates almost certainly failed to load')
  }

  const differences = []
  for (let i = 0; i < expected; i++) {
    if (engineLines[i] !== addonLines[i]) {
      differences.push({ row: i, engine: engineLines[i], addon: addonLines[i] })
      if (differences.length >= 10) break
    }
  }

  console.log(`engine vs addon parity: ${images.length} fixtures x ${probeCount} probes = ${expected} comparisons`)
  console.log(`  probes that found nothing: ${misses}`)

  if (differences.length > 0) {
    console.error('')
    for (const d of differences) {
      console.error(`row ${d.row}\n  engine: ${d.engine}\n  addon:  ${d.addon}`)
    }
    fail(`${differences.length}+ rows differ`)
  }

  console.log('  identical on every row - the engine reproduces the addon')
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}
