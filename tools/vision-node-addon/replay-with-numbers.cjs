/**
 * Drives `svwb-engine replay --numbers host` and answers its number reads.
 *
 *   node tools/vision-node-addon/replay-with-numbers.cjs <video> [engine args...]
 *
 * This is the host side of the number protocol, in the smallest form that
 * exercises it. Electron does exactly the same thing in
 * `src/main/recognition/engine.ts`, so a protocol break shows up here - in a
 * fixture run that takes seconds - rather than in a user's match history.
 *
 * It is NOT a mirror of the state machine. It answers questions and forwards
 * output; every decision is the engine's. That distinction is the whole reason
 * `replay-recording.cjs` could be deleted: this file cannot drift from the
 * shipped logic, because it does not contain any.
 *
 * --harvest <dir> additionally saves every crop Tesseract read cleanly, named
 * by its answer (`000123_+8.png`). This is plan P6-c: digit templates become a
 * HARVESTED asset instead of one someone has to collect by hand - the blocker
 * on a template-based reader was that no fixture contains a `0`, and harvesting
 * from real recordings/matches fills that in as a side effect of running.
 * A future `TemplateReader` is accepted only if it beats Tesseract on held-out
 * harvested data; until then this directory just accumulates.
 */
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const readline = require('readline')
const { createWorker, OEM, PSM } = require('tesseract.js')

const ROOT = path.join(__dirname, '..', '..')
const ENGINE = path.join(ROOT, 'tools', 'target', 'release', 'svwb-engine.exe')

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.error('usage: replay-with-numbers.cjs <video> [--harvest <dir>] [engine args...]')
    process.exit(1)
  }

  let harvestDir = null
  const harvestAt = args.indexOf('--harvest')
  if (harvestAt >= 0) {
    harvestDir = args.splice(harvestAt, 2)[1]
    fs.mkdirSync(harvestDir, { recursive: true })
  }
  let harvested = 0

  // One worker for the whole run: a cold start is hundreds of milliseconds and a
  // recording asks for a number on every frame a result screen is up.
  const worker = await createWorker(['eng'], OEM.DEFAULT, {
    langPath: ROOT
  })
  await worker.setParameters({
    tessedit_char_whitelist: '+-0123456789',
    tessedit_pageseg_mode: PSM.SINGLE_LINE
  })

  const engine = spawn(
    ENGINE,
    [
      'replay',
      ...args,
      '--templates',
      path.join(ROOT, 'resources', 'templates'),
      '--numbers',
      'host'
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] }
  )

  const lines = readline.createInterface({ input: engine.stdout })
  lines.on('line', async (line) => {
    if (!line.trim()) return
    let event
    try {
      event = JSON.parse(line)
    } catch {
      // The replay summary is plain text on the same stream; pass it through.
      console.log(line)
      return
    }
    if (event.event !== 'readNumber') {
      console.log(line)
      return
    }
    // Always reply. `text: null` means unreadable, and the engine retries on the
    // next frame; never replying would stall it forever.
    let text = null
    try {
      const png = Buffer.from(event.png, 'base64')
      const result = await worker.recognize(png)
      text = result.data.text ?? null
      // Only clean integer reads are kept: the label is the ground truth for a
      // future template reader, so an unparseable read would be a mislabelled
      // sample - worse than no sample.
      const clean = (text ?? '').replace(/\s+/g, '')
      if (harvestDir && /^[-+]?\d+$/.test(clean)) {
        fs.writeFileSync(
          path.join(harvestDir, `${String(event.id).padStart(6, '0')}_${clean}.png`),
          png
        )
        harvested++
      }
    } catch (e) {
      console.error('[numbers] read failed:', e.message)
    }
    engine.stdin.write(JSON.stringify({ numberRead: true, id: event.id, text }) + '\n')
  })

  engine.on('exit', async (code) => {
    if (harvestDir) console.log(`harvested ${harvested} labelled crops into ${harvestDir}`)
    await worker.terminate().catch(() => {})
    process.exit(code ?? 1)
  })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
