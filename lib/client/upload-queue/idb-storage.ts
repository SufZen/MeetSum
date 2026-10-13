/**
 * IndexedDB `QueueStorage` (database `meetsum-recordings`). Records are keyed
 * by `[owner, captureId(, seq)]` (owner = user id + workspace id), so every
 * query is scoped to one user in one workspace.
 * Browser-only; callers fall back to the memory adapter when it fails.
 */
import type { ChunkRecord, QueueStorage, StoredItem } from "@/lib/client/upload-queue/types"

export const RECORDINGS_DB = "meetsum-recordings"
const VERSION = 2
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

      // v1 keyed by user only: drop it (pre-release, never shipped).
      for (const name of [CHUNKS, ITEMS]) if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name)
      db.createObjectStore(CHUNKS, { keyPath: ["owner", "captureId", "seq"] })
      db.createObjectStore(ITEMS, { keyPath: ["owner", "captureId"] })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** Key range over every record of `owner` (optionally one capture). */
function ownerRange(owner: string, captureId?: string): IDBKeyRange {
  return captureId === undefined
    ? IDBKeyRange.bound([owner], [owner, []])
    : IDBKeyRange.bound([owner, captureId], [owner, captureId, []])
}

/** Key range over every owner starting with `prefix`. */
function prefixRange(prefix: string): IDBKeyRange {
  return IDBKeyRange.bound([prefix], [prefix + String.fromCharCode(0xffff), []])
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
    listChunks: (owner, captureId) =>
      run([CHUNKS], "readonly", async (tx) => {
        const rows = (await promisify(tx.objectStore(CHUNKS).getAll(ownerRange(owner, captureId)))) as ChunkRecord[]

        return rows.sort((a, b) => a.seq - b.seq)
      }),
    deleteChunks: (owner, captureId) => run([CHUNKS], "readwrite", (tx) => void tx.objectStore(CHUNKS).delete(ownerRange(owner, captureId))),
    listChunkCaptureIds: (owner) =>
      run([CHUNKS], "readonly", async (tx) => {
        const keys = (await promisify(tx.objectStore(CHUNKS).getAllKeys(ownerRange(owner)))) as unknown as [string, string, number][]

        return [...new Set(keys.map((key) => key[1]))]
      }),
    putItem: (item) => run([ITEMS], "readwrite", (tx) => void tx.objectStore(ITEMS).put(item)),
    getItem: (owner, captureId) =>
      run([ITEMS], "readonly", async (tx) => (await promisify(tx.objectStore(ITEMS).get([owner, captureId]))) as StoredItem | undefined),
    listItems: (owner) =>
      run([ITEMS], "readonly", async (tx) => (await promisify(tx.objectStore(ITEMS).getAll(ownerRange(owner)))) as StoredItem[]),
    deleteItem: (owner, captureId) => run([ITEMS], "readwrite", (tx) => void tx.objectStore(ITEMS).delete([owner, captureId])),
    clearPrefix: (prefix) =>
      run([CHUNKS, ITEMS], "readwrite", (tx) => {
        tx.objectStore(CHUNKS).delete(prefixRange(prefix))
        tx.objectStore(ITEMS).delete(prefixRange(prefix))
      }),
  }
}
