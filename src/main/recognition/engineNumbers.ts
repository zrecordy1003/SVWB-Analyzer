/**
 * Answers the engine's number-read requests using Tesseract.
 *
 * The engine sends the binarised crop it wants read and blocks until this
 * replies, so the two rules here are: always reply, and reply quickly.
 *
 * Why this lives on the host at all: digit recognition has not moved into the
 * engine, and it is not obviously wrong where it is. The case against Tesseract
 * turned out to rest on two claims that did not survive checking - see
 * `docs/engine-refactor-plan.md` 修訂紀錄 R-5. `NumberReader` is a seam, so this
 * can be replaced by a Rust implementation later without anything above it
 * noticing.
 */
import { createWorker, OEM, PSM, type Worker } from 'tesseract.js'

/**
 * One worker for the process's lifetime.
 *
 * Creating one is a cold start measured in hundreds of milliseconds, and a
 * result screen asks for up to four numbers per tick - paying that per read is
 * what once pushed result ticks over the 500ms budget, and a tick over budget
 * can miss the play-order overlay entirely (it is on screen for about 0.9s).
 */
let worker: Worker | null = null

export type NumberReaderConfig = {
  /** Writable location for the decompressed .traineddata. */
  cachePath: string
  /** Directory holding `eng.traineddata.gz`. */
  langPath: string
}

let config: NumberReaderConfig | null = null

export function configureNumberReader(next: NumberReaderConfig): void {
  config = next
}

async function getWorker(): Promise<Worker> {
  if (worker) return worker
  if (!config) throw new Error('configureNumberReader() must be called first')

  const created = await createWorker(['eng'], OEM.DEFAULT, {
    cachePath: config.cachePath,
    langPath: config.langPath
  })
  await created.setParameters({
    tessedit_char_whitelist: '+-0123456789',
    tessedit_pageseg_mode: PSM.SINGLE_LINE
  })
  worker = created
  return created
}

export async function disposeNumberReader(): Promise<void> {
  const current = worker
  worker = null
  if (current) await current.terminate().catch(() => {})
}

/**
 * Read one crop, or return null.
 *
 * Null means "not readable now", never "absent" - the engine retries on the next
 * frame and lets its own consensus decide. Normalising the text is deliberately
 * NOT done here: the engine owns parsing, so both this and a future Rust reader
 * hand back exactly what the recogniser said.
 */
export async function readNumber(pngBase64: string): Promise<string | null> {
  try {
    const image = Buffer.from(pngBase64, 'base64')
    const {
      data: { text }
    } = await (await getWorker()).recognize(image)
    return text ?? null
  } catch (e) {
    console.error('[Numbers] read failed:', e)
    // The worker may be wedged; rebuild it on the next read rather than failing
    // every subsequent number for the rest of the session.
    await disposeNumberReader()
    return null
  }
}
