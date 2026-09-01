/**
 * Scores every probe against every image using the SHIPPED Node addon, in the
 * exact output format `svwb-engine probe-dump` produces.
 *
 * This is the Node half of the plan P1 acceptance check: the engine may not be
 * allowed to replace the addon until the two agree, per image, per probe, on
 * score, matched template and position. Diffing the two outputs is the check.
 *
 *   node tools/vision-node-addon/dump-probes.cjs \
 *     --probes <registry.jsonl> --templates <dir> <png>...
 *
 * The probe registry is NOT defined here. It is read from whatever
 * `svwb-engine probes` emitted, so both sides provably probe the same windows.
 * A parity check whose halves disagree about WHICH windows to look at proves
 * nothing, and a hand-copied table is how this directory ended up with
 * `check-rois.cjs` and a 953-line replay mirror.
 *
 * TEMPORARY. Delete this together with the addon when plan P3 lands - it has no
 * purpose once there is only one implementation left to compare.
 */
const fs = require('fs')
const path = require('path')
const v = require('../svwb-vision.node')

function parseArgs(argv) {
  const out = { probes: null, templates: null, images: [] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--probes') out.probes = argv[++i]
    else if (argv[i] === '--templates') out.templates = argv[++i]
    else out.images.push(argv[i])
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (!args.probes || !args.templates || args.images.length === 0) {
  console.error('usage: dump-probes.cjs --probes <registry.jsonl> --templates <dir> <png>...')
  process.exit(1)
}

const probes = fs
  .readFileSync(args.probes, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line))

if (probes.length === 0) {
  console.error('probe registry is empty')
  process.exit(1)
}

const loaded = v.initTemplates(args.templates)
if (!loaded) {
  console.error(`no templates loaded from ${args.templates}`)
  process.exit(1)
}

/** `<parent>/<file>`, matching the engine's label so paths never cause a diff. */
function stableLabel(p) {
  const parsed = path.parse(path.resolve(p))
  return `${path.basename(parsed.dir)}/${parsed.base}`
}

/**
 * Fixed precision rather than JS's default number formatting: the two languages
 * print the same f64 differently, and this comparison is about the value.
 */
function fmt(n) {
  return n.toFixed(6)
}

for (const imagePath of args.images) {
  const frame = v.Frame.load(imagePath)
  const label = stableLabel(imagePath)
  try {
    for (const p of probes) {
      const hit = frame.matchBest(p.set, { x: p.x, y: p.y, w: p.w, h: p.h }, p.scale)
      // A miss prints nulls rather than being skipped, so a set that failed to
      // load on one side cannot read as agreement with the other.
      const fields =
        hit == null
          ? '"name":null,"score":null,"x":null,"y":null'
          : `"name":${JSON.stringify(hit.name)},"score":${fmt(hit.score)},"x":${hit.x},"y":${hit.y}`
      process.stdout.write(
        `{"image":${JSON.stringify(label)},"probe":${JSON.stringify(p.probe)},` +
          `"set":${JSON.stringify(p.set)},${fields}}\n`
      )
    }
  } finally {
    // ~20MB of native buffers per frame; 34 fixtures without this is a spike
    // large enough to matter even in a one-shot script.
    frame.dispose?.()
  }
}
