/**
 * Browser wiring for the offline recording queue (docs/parity/m9.md D5):
 * IndexedDB storage (memory fallback), Web Locks, and the ingest uploader.
 * One queue per (user, workspace) per tab; no credential is ever stored, the
 * upload uses the live session cookie and names the workspace it was
 * recorded in, which the server checks against the session.
 */
import { createIdbStorage } from "@/lib/client/upload-queue/idb-storage"
import { createMemoryStorage } from "@/lib/client/upload-queue/memory-storage"
import { createUploadQueue, type UploadQueue } from "@/lib/client/upload-queue/queue"
import type { LockRunner, QueueStorage, StoredItem, UploadResult } from "@/lib/client/upload-queue/types"

export const INGEST_URL = "/api/desktop-capture/ingest"
/** Window event the service worker relay and manual retries dispatch. */
export const FLUSH_UPLOADS_EVENT = "meetsum:flush-uploads"
export const SW_SYNC_TAG = "meetsum-uploads"
/** The workspace a queued recording belongs to; the ingest route rejects a mismatch. */
export const CAPTURE_WORKSPACE_HEADER = "x-meetsum-workspace-id"

/** The multipart body for one queued recording (text fields before the file). */
export function ingestFormData(item: StoredItem): FormData {
  const form = new FormData()
  const extension = item.mime.startsWith("audio/mp4") ? "m4a" : "webm"

  form.append(
    "meeting",
    JSON.stringify({ title: item.title, startedAt: item.startedAt, language: "mixed", participants: [] })
  )
  form.append(
    "captureMetadata",
    JSON.stringify({ captureId: item.captureId, appVersion: "pwa", platform: "web", uploadStatus: "uploaded" })
  )
  form.append("file", new File([item.blob], `meetsum-recording-${item.captureId}.${extension}`, { type: item.mime }))

  return form
}

export async function ingestUploader(item: StoredItem): Promise<UploadResult> {
  const response = await fetch(INGEST_URL, {
    method: "POST",
    body: ingestFormData(item),
    credentials: "same-origin",
    headers: { [CAPTURE_WORKSPACE_HEADER]: item.workspaceId },
  })
  const body = await response.json().catch(() => null)

  return { status: response.status, body }
}

const webLock: LockRunner = async <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined

  if (!locks) return fn()

  let result!: T

  await locks.request(name, async () => {
    result = await fn()
  })

  return result
}

let sharedStorage: QueueStorage | null = null
const queues = new Map<string, UploadQueue>()

function storage(): QueueStorage {
  if (!sharedStorage) {
    sharedStorage = typeof indexedDB === "undefined" ? createMemoryStorage() : fallbackOnError(createIdbStorage())
  }

  return sharedStorage
}

/** IndexedDB can be blocked (private mode): switch to memory on the first failure. */
function fallbackOnError(primary: QueueStorage): QueueStorage {
  const memory = createMemoryStorage()
  let active: QueueStorage = primary

  async function attempt<T>(call: (storage: QueueStorage) => Promise<T>): Promise<T> {
    try {
      return await call(active)
    } catch (error) {
      if (active === memory) throw error
      active = memory
      return call(memory)
    }
  }

  return {
    putChunk: (chunk) => attempt((storage) => storage.putChunk(chunk)),
    listChunks: (owner, captureId) => attempt((storage) => storage.listChunks(owner, captureId)),
    deleteChunks: (owner, captureId) => attempt((storage) => storage.deleteChunks(owner, captureId)),
    listChunkCaptureIds: (owner) => attempt((storage) => storage.listChunkCaptureIds(owner)),
    putItem: (item) => attempt((storage) => storage.putItem(item)),
    getItem: (owner, captureId) => attempt((storage) => storage.getItem(owner, captureId)),
    listItems: (owner) => attempt((storage) => storage.listItems(owner)),
    deleteItem: (owner, captureId) => attempt((storage) => storage.deleteItem(owner, captureId)),
    clearPrefix: (prefix) => attempt((storage) => storage.clearPrefix(prefix)),
  }
}

/** The queue of `userId` in `workspaceId`: it never sees another owner's items. */
export function getUploadQueue(userId: string, workspaceId: string): UploadQueue {
  const key = `${userId}|${workspaceId}`
  let queue = queues.get(key)

  if (!queue) {
    queue = createUploadQueue({ storage: storage(), userId, workspaceId, upload: ingestUploader, withLock: webLock })
    queues.set(key, queue)
  }

  return queue
}

/** Asks for durable storage once; false when the browser denies it. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false
  } catch {
    return false
  }
}

/** Free bytes reported by the browser, or null when unknown. */
export async function freeStorageBytes(): Promise<number | null> {
  try {
    const estimate = await navigator.storage?.estimate?.()

    if (!estimate?.quota) return null
    return Math.max(0, estimate.quota - (estimate.usage ?? 0))
  } catch {
    return null
  }
}

/** Warn below this much free device storage. */
export const LOW_STORAGE_BYTES = 200 * 1024 * 1024
/** Refuse to start a recording below this much free device storage. */
export const MIN_FREE_BYTES_TO_RECORD = 25 * 1024 * 1024

/** `NEXT_PUBLIC_MEETSUM_OFFLINE_QUEUE_MAX_MB` (default 2048) in bytes: the most the queue may hold. */
export function offlineQueueMaxBytes(raw = process.env.NEXT_PUBLIC_MEETSUM_OFFLINE_QUEUE_MAX_MB): number {
  const mb = Number(raw)

  return (Number.isFinite(mb) && mb > 0 ? mb : 2048) * 1024 * 1024
}

export type StorageGate = "ok" | "low" | "refuse"

/** Whether a new recording may start, given free bytes and what the queue already holds. */
export function storageGate(freeBytes: number | null, queuedBytes: number, maxQueueBytes = offlineQueueMaxBytes()): StorageGate {
  if (queuedBytes >= maxQueueBytes) return "refuse"
  if (freeBytes === null) return "ok"
  if (freeBytes < MIN_FREE_BYTES_TO_RECORD) return "refuse"
  if (freeBytes < LOW_STORAGE_BYTES) return "low"

  return "ok"
}

/** Registers a Background Sync so the SW can wake clients to flush (Chromium). */
export async function requestBackgroundFlush(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker?.ready
    const sync = (registration as (ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }) | undefined)?.sync

    await sync?.register(SW_SYNC_TAG)
  } catch {
    // Background Sync is optional; the queue also flushes on load, online and focus.
  }
}
