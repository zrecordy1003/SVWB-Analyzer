import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const binaryDirectory = path.join(repositoryRoot, 'resources', 'opencv', 'bin')
const runtimeLibraries = [
  'opencv_world4110.dll',
  'opencv_videoio_ffmpeg4110_64.dll',
  'opencv_videoio_msmf4110_64.dll'
]

const missingLibraries = []

for (const library of runtimeLibraries) {
  try {
    await access(path.join(binaryDirectory, library), constants.R_OK)
  } catch {
    missingLibraries.push(library)
  }
}

if (missingLibraries.length > 0) {
  throw new Error(
    `Missing required OpenCV runtime libraries in ${binaryDirectory}: ${missingLibraries.join(', ')}`
  )
}

console.log(`OpenCV runtime resources verified: ${runtimeLibraries.join(', ')}`)
