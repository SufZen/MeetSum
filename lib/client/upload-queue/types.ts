/**
 * Offline recording queue types (docs/parity/m9.md D5; owner: Package D).
 * Every record carries the user id so a shared device never mixes users.
 */

export type UploadStatus =
  /** Waiting for the next flush (possibly backing off). */
  | "pending"
  /** The server answered 401: paused until the user signs in again. */
  | "paused-auth"
  /** 400/409/413/415: never retried; the blob is kept for "save to device". */
  | "failed-permanent"

export type QueueItem = {
  userId: string
  captureId: string
  title: string
  /** ISO timestamp of the recording start. */
  startedAt: string
  mime: string
  size: number
  status: UploadStatus
  attempts: number
  /** epoch ms before which a retry is not attempted; null = now. */
  nextAttemptAt: number | null
  /** Last HTTP status (0 = network error). */
  lastStatus?: number
  /** The meeting the item is for (dock "open meeting"), when known. */
  meetingId?: string | null
  /** Assembled from chunks found unfinished on load. */
  recovered?: boolean
}

export type StoredItem = QueueItem & { blob: Blob }

export type ChunkRecord = {
  userId: string
  captureId: string
  seq: number
  blob: Blob
  /** Written with the first chunk so a recovered recording keeps its start. */
  startedAt?: string
  mime?: string
  meetingId?: string | null
}

/** Persistence port: IndexedDB in the browser, an in-memory map in tests. */
export interface QueueStorage {
  putChunk(chunk: ChunkRecord): Promise<void>
  /** The capture's chunks sorted by `seq`. */
  listChunks(userId: string, captureId: string): Promise<ChunkRecord[]>
  deleteChunks(userId: string, captureId: string): Promise<void>
  /** Capture ids that still have chunks (unfinished or not yet assembled). */
  listChunkCaptureIds(userId: string): Promise<string[]>
  putItem(item: StoredItem): Promise<void>
  getItem(userId: string, captureId: string): Promise<StoredItem | undefined>
  listItems(userId: string): Promise<StoredItem[]>
  deleteItem(userId: string, captureId: string): Promise<void>
  /** Deletes every chunk and item of the user (logout after confirmation). */
  clearUser(userId: string): Promise<void>
}

export type UploadResult = { status: number; body: unknown }

/** Performs the HTTP upload; throws on a network failure. */
export type Uploader = (item: StoredItem) => Promise<UploadResult>

/** Runs `fn` while holding an exclusive lock named `name` (Web Locks). */
export type LockRunner = <T>(name: string, fn: () => Promise<T>) => Promise<T>
