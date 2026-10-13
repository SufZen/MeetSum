/**
 * IndexedDB `QueueStorage` (database `meetsum-recordings`). Records are keyed
 * by `[userId, captureId(, seq)]`, so every query is scoped to one user.
 * Browser-only; callers fall back to the memory adapter when it fails.
 */
import type { ChunkRecord, QueueStorage, StoredItem } from "@/lib/client/upload-queue/types"

export const RECORDINGS_DB = "meetsum-recordings"
const VERSION = 1
const CHUNKS = "chunks"
const ITEMS = "items"

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(RECORDINGS_DB, VERSION)

    request.onupgradeneeded = () => {
      const db = request.result

      if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS, { keyPath: ["userId", "captureId", "seq"] })
      if (!db.objectStoreNames.contains(ITEMS)) db.createObjectStore(ITEMS, { keyPath: ["userId", "captureId"] })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** Key range over every record of `userId` (optionally one capture). */
function userRange(userId: string, captureId?: string): IDBKeyRange {
  return captureId === undefined
    ? IDBKeyRange.bound([userId], [userId, []])
    : IDBKeyRange.bound([userId, captureId], [userId, captureId, []])
}

export function createIdbStorage(factory: IDBFactory = indexedDB): QueueStorage {
  let dbPromise: Promise<IDBDatabase> | null = null
  const db = () => (dbPromise ??= openDb(factory))

  async function run<T>(stores: string[], mode: IDBTransactionMode, body: (tx: IDBTransaction) => Promise<T> | T): Promise<T> {
    const tx = (await db()).transaction(stores, mode)
    const result = await body(tx)

    await done(tx)
    return result
  }

  return {
    putChunk: (chunk) => run([CHUNKS], "readwrite", (tx) => void tx.objectStore(CHUNKS).put(chunk)),
    listChunks: (userId, captureId) =>
      run([CHUNKS], "readonly", async (tx) => {
        const rows = (await promisify(tx.objectStore(CHUNKS).getAll(userRange(userId, captureId)))) as ChunkRecord[]

        return rows.sort((a, b) => a.seq - b.seq)
      }),
    deleteChunks: (userId, captureId) => run([CHUNKS], "readwrite", (tx) => void tx.objectStore(CHUNKS).delete(userRange(userId, captureId))),
    listChunkCaptureIds: (userId) =>
      run([CHUNKS], "readonly", async (tx) => {
        const keys = (await promisify(tx.objectStore(CHUNKS).getAllKeys(userRange(userId)))) as unknown as [string, string, number][]

        return [...new Set(keys.map((key) => key[1]))]
      }),
    putItem: (item) => run([ITEMS], "readwrite", (tx) => void tx.objectStore(ITEMS).put(item)),
    getItem: (userId, captureId) =>
      run([ITEMS], "readonly", async (tx) => (await promisify(tx.objectStore(ITEMS).get([userId, captureId]))) as StoredItem | undefined),
    listItems: (userId) =>
      run([ITEMS], "readonly", async (tx) => (await promisify(tx.objectStore(ITEMS).getAll(userRange(userId)))) as StoredItem[]),
    deleteItem: (userId, captureId) => run([ITEMS], "readwrite", (tx) => void tx.objectStore(ITEMS).delete([userId, captureId])),
    clearUser: (userId) =>
      run([CHUNKS, ITEMS], "readwrite", (tx) => {
        tx.objectStore(CHUNKS).delete(userRange(userId))
        tx.objectStore(ITEMS).delete(userRange(userId))
      }),
  }
}
