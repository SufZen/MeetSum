/**
 * Recorder chunk preload (M9 follow-up). The recorder dock and the offline
 * upload queue are lazy chunks; if they first load when the user presses
 * Record, an offline device fails with a ChunkLoadError (and the error
 * boundary). The shell preloads them as soon as the recorder sheet opens,
 * while the device is still online; once loaded they live in the module
 * cache, and the service worker keeps the hashed `/_next/static` files
 * (cache-first), so later offline starts still work.
 */

export type ChunkLoader = () => Promise<unknown>

export type RecorderPreloader = {
  /** Loads every chunk once; resolves false (never rejects) on failure, so a later open retries. */
  preload: () => Promise<boolean>
  loaded: () => boolean
}

export function createRecorderPreloader(loaders: readonly ChunkLoader[]): RecorderPreloader {
  let pending: Promise<boolean> | null = null
  let done = false

  return {
    preload() {
      if (!pending) {
        pending = Promise.all(loaders.map((load) => load())).then(
          () => {
            done = true
            return true
          },
          () => {
            pending = null
            return false
          }
        )
      }

      return pending
    },
    loaded: () => done,
  }
}

/** The recorder's lazy chunks, the same specifiers the shell imports lazily. */
export const RECORDER_CHUNK_LOADERS: readonly ChunkLoader[] = [
  () => import("@/components/bot/recorder-dock"),
  () => import("@/lib/client/upload-queue/browser"),
]

let shared: RecorderPreloader | null = null

export function preloadRecorderChunks(): Promise<boolean> {
  shared ??= createRecorderPreloader(RECORDER_CHUNK_LOADERS)

  return shared.preload()
}
