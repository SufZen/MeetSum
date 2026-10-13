/**
 * Offline recording queue types (docs/parity/m9.md D5; owner: Package D).
 * Every record is partitioned by `owner` = user id + workspace id, captured
 * when the recording starts, so a shared device never mixes users and a
 * workspace switch never uploads into the wrong workspace. No credentials
 * are ever stored: uploads use the live session cookie.
 */

/** The storage partition of one user in one workspace. */
export function ownerKey(userId: string, workspaceId: string): string {
  return `${userId}|${workspaceId}`
}

/** Prefix shared by every partition of a user (logout purge). */
export function userPrefix(userId: string): string {
  return `${userId}|`
}

export type UploadStatus =
  /** Waiting for the next flush (possibly backing off). */
  | "pending"
  /** The server answered 401: paused until the user signs in again. */
  | "paused-auth"
  /** 400/409/413/415: never retried; the blob is kept for "save to device". */
  | "failed-permanent"

export type QueueItem = {
  owner: string
  userId: string
  workspaceId: string
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
  owner: string
  userId: string
  workspaceId: string
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
  listChunks(owner: string, captureId: string): Promise<ChunkRecord[]>
  deleteChunks(owner: string, captureId: string): Promise<void>
  /** Capture ids that still have chunks (unfinished or not yet assembled). */
  listChunkCaptureIds(owner: string): Promise<string[]>
  putItem(item: StoredItem): Promise<void>
  getItem(owner: string, captureId: string): Promise<StoredItem | undefined>
  listItems(owner: string): Promise<StoredItem[]>
  deleteItem(owner: string, captureId: string): Promise<void>
  /** Deletes every chunk and item whose owner starts with `prefix` (logout after confirmation). */
  clearPrefix(prefix: string): Promise<void>
}

export type UploadResult = { status: number; body: unknown }

/** Performs the HTTP upload; throws on a network failure. */
export type Uploader = (item: StoredItem) => Promise<UploadResult>

/** Runs `fn` while holding an exclusive lock named `name` (Web Locks). */
export type LockRunner = <T>(name: string, fn: () => Promise<T>) => Promise<T>
