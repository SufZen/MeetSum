/**
 * Offline-safe recording upload queue (docs/parity/m9.md D5; owner:
 * Package D). Pure logic over a `QueueStorage` port so it runs in tests with
 * the in-memory adapter and in the browser with IndexedDB.
 *
 * - Chunks are written as the recorder produces them (at most one chunk is
 *   lost on a crash); stop assembles them into one queued item.
 * - Chunks left behind by a closed tab become a "recovered recording".
 * - Flush uploads one item at a time, under a per-capture lock so two tabs
 *   never upload the same item, and deletes local data only after a 2xx that
 *   names a meeting. `/api/desktop-capture/ingest` is idempotent by captureId,
 *   so a retried upload never creates a second meeting.
 */
import type {
  ChunkRecord,
  LockRunner,
  QueueItem,
  QueueStorage,
  StoredItem,
  UploadResult,
  Uploader,
} from "@/lib/client/upload-queue/types"
import { ownerKey, userPrefix } from "@/lib/client/upload-queue/types"

/** Retry delays after the 1st, 2nd, 3rd and later failures. */
export const BACKOFF_MS = [5_000, 30_000, 120_000, 600_000] as const

/** ±20% jitter; `random` in [0, 1). */
export function backoffDelay(attempts: number, random: () => number = Math.random): number {
  const base = BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1]

  return Math.round(base * (0.8 + random() * 0.4))
}

export type UploadOutcome =
  | { kind: "done"; meetingId: string }
  | { kind: "auth" }
  | { kind: "permanent"; status: number }
  | { kind: "retry"; status: number }

function meetingIdOf(body: unknown): string | null {
  if (!body || typeof body !== "object") return null

  const record = body as { meeting?: { id?: unknown }; meetingId?: unknown }
  const id = record.meeting?.id ?? record.meetingId

  return typeof id === "string" && id ? id : null
}

/** Maps an ingest response to what the queue does next. */
export function classifyUploadResponse(result: UploadResult): UploadOutcome {
  const { status } = result

  if (status >= 200 && status < 300) {
    const meetingId = meetingIdOf(result.body)

    // A 2xx without a meeting id is not proof of storage: keep and retry.
    return meetingId ? { kind: "done", meetingId } : { kind: "retry", status }
  }
  if (status === 401) return { kind: "auth" }
  // The session moved to another workspace: pause, never upload elsewhere.
  if (status === 409 && (result.body as { error?: unknown } | null)?.error === "workspace_mismatch") return { kind: "auth" }
  if (status === 408 || status === 429 || status >= 500) return { kind: "retry", status }

  return { kind: "permanent", status }
}

export type QueueSnapshot = {
  items: QueueItem[]
  pending: number
  pausedForAuth: boolean
  permanentFailures: number
  uploading: string | null
}

export type UploadQueue = {
  /** Persists one recorder chunk (owner fields are the queue's). */
  recordChunk(chunk: Omit<ChunkRecord, "owner" | "userId" | "workspaceId">): Promise<void>
  /** Assembles the capture's chunks into a queued item and drops the chunks. */
  finalize(input: { captureId: string; title: string; startedAt: string; mime: string; meetingId?: string | null }): Promise<QueueItem | null>
  /** Enqueues chunks left by a previous session (skips `activeCaptureIds`). */
  recover(input: { title: string; activeCaptureIds?: string[] }): Promise<QueueItem[]>
  /** Uploads due items one at a time; `force` ignores back-off and the auth pause. */
  flush(options?: { force?: boolean }): Promise<QueueSnapshot>
  snapshot(): Promise<QueueSnapshot>
  /** The stored blob of an item (for "save to device"). */
  blobOf(captureId: string): Promise<Blob | null>
  remove(captureId: string): Promise<void>
  /** Deletes this user's recordings in this workspace. */
  clear(): Promise<void>
  /** Deletes this user's recordings in every workspace (logout). */
  clearUser(): Promise<void>
  subscribe(listener: (snapshot: QueueSnapshot) => void): () => void
}

const noLock: LockRunner = (_name, fn) => fn()

function strip(item: StoredItem): QueueItem {
  const { blob: _blob, ...rest } = item

  void _blob

  return rest
}

export function createUploadQueue({
  storage,
  userId,
  workspaceId,
  upload,
  now = () => Date.now(),
  random = Math.random,
  withLock = noLock,
}: {
  storage: QueueStorage
  userId: string
  /** The session's workspace: only its items are listed or uploaded. */
  workspaceId: string
  upload: Uploader
  now?: () => number
  random?: () => number
  withLock?: LockRunner
}): UploadQueue {
  const owner = ownerKey(userId, workspaceId)
  const listeners = new Set<(snapshot: QueueSnapshot) => void>()
  let uploading: string | null = null
  let flushing: Promise<QueueSnapshot> | null = null

  async function snapshot(): Promise<QueueSnapshot> {
    const items = (await storage.listItems(owner)).map(strip).sort((a, b) => a.startedAt.localeCompare(b.startedAt))

    return {
      items,
      pending: items.length,
      pausedForAuth: items.some((item) => item.status === "paused-auth"),
      permanentFailures: items.filter((item) => item.status === "failed-permanent").length,
      uploading,
    }
  }

  async function notify() {
    if (!listeners.size) return

    const value = await snapshot()

    listeners.forEach((listener) => listener(value))
  }

  async function assemble(
    captureId: string,
    fallback: { title: string; startedAt?: string; mime?: string; meetingId?: string | null; recovered?: boolean }
  ): Promise<QueueItem | null> {
    const existing = await storage.getItem(owner, captureId)

    if (existing) {
      await storage.deleteChunks(owner, captureId)
      return strip(existing)
    }

    const chunks = await storage.listChunks(owner, captureId)

    if (!chunks.length) return null

    const first = chunks[0]
    const mime = fallback.mime || first.mime || first.blob.type || "audio/webm"
    const blob = new Blob(
      chunks.map((chunk) => chunk.blob),
      { type: mime }
    )

    if (blob.size === 0) {
      await storage.deleteChunks(owner, captureId)
      return null
    }

    const item: StoredItem = {
      owner,
      userId,
      workspaceId,
      captureId,
      title: fallback.title,
      startedAt: fallback.startedAt ?? first.startedAt ?? new Date(now()).toISOString(),
      mime,
      size: blob.size,
      status: "pending",
      attempts: 0,
      nextAttemptAt: null,
      meetingId: fallback.meetingId ?? first.meetingId ?? null,
      ...(fallback.recovered ? { recovered: true } : {}),
      blob,
    }

    // Item first, then chunks: a crash in between leaves both, and the next
    // recover() sees the item and only drops the chunks.
    await storage.putItem(item)
    await storage.deleteChunks(owner, captureId)

    return strip(item)
  }

  async function uploadOne(captureId: string, force: boolean): Promise<void> {
    await withLock(`meetsum-upload:${owner}:${captureId}`, async () => {
      // Re-read under the lock: another tab may have finished it.
      const item = await storage.getItem(owner, captureId)

      // Defence in depth: never upload a record of another user or workspace.
      if (!item || item.owner !== owner || item.userId !== userId || item.workspaceId !== workspaceId) return
      if (item.status === "failed-permanent") return
      if (!force && item.nextAttemptAt !== null && item.nextAttemptAt > now()) return

      uploading = captureId
      await notify()

      let outcome: UploadOutcome

      try {
        outcome = classifyUploadResponse(await upload(item))
      } catch {
        outcome = { kind: "retry", status: 0 }
      } finally {
        uploading = null
      }

      if (outcome.kind === "done") {
        await storage.deleteItem(owner, captureId)
        await storage.deleteChunks(owner, captureId)
        return
      }

      const attempts = item.attempts + 1

      if (outcome.kind === "auth") {
        await storage.putItem({ ...item, attempts, status: "paused-auth", lastStatus: 401, nextAttemptAt: null })
      } else if (outcome.kind === "permanent") {
        await storage.putItem({ ...item, attempts, status: "failed-permanent", lastStatus: outcome.status, nextAttemptAt: null })
      } else {
        await storage.putItem({
          ...item,
          attempts,
          status: "pending",
          lastStatus: outcome.status,
          nextAttemptAt: now() + backoffDelay(attempts, random),
        })
      }
    })
  }

  async function runFlush(force: boolean): Promise<QueueSnapshot> {
    const items = (await storage.listItems(owner)).sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    // A 401 pauses the whole queue until a forced flush (sign-in, retry).
    let paused = !force && items.some((item) => item.status === "paused-auth")

    for (const item of items) {
      if (paused) break
      if (item.status === "failed-permanent") continue
      if (item.status === "paused-auth" && !force) continue

      await uploadOne(item.captureId, force)

      const after = await storage.getItem(owner, item.captureId)

      if (after?.status === "paused-auth") paused = true
    }
    await notify()

    return snapshot()
  }

  return {
    async recordChunk(chunk) {
      await storage.putChunk({ ...chunk, owner, userId, workspaceId })
    },
    async finalize(input) {
      const item = await assemble(input.captureId, input)

      await notify()
      return item
    },
    async recover({ title, activeCaptureIds = [] }) {
      const recovered: QueueItem[] = []

      for (const captureId of await storage.listChunkCaptureIds(owner)) {
        if (activeCaptureIds.includes(captureId)) continue

        const item = await assemble(captureId, { title, recovered: true })

        if (item) recovered.push(item)
      }
      if (recovered.length) await notify()

      return recovered
    },
    flush(options) {
      // One flush at a time per tab; concurrent callers share it.
      if (!flushing) {
        flushing = runFlush(Boolean(options?.force)).finally(() => {
          flushing = null
        })
      }

      return flushing
    },
    snapshot,
    async blobOf(captureId) {
      return (await storage.getItem(owner, captureId))?.blob ?? null
    },
    async remove(captureId) {
      await storage.deleteItem(owner, captureId)
      await storage.deleteChunks(owner, captureId)
      await notify()
    },
    async clear() {
      // Exact owner only (a prefix would also match "w1" vs "w10").
      for (const item of await storage.listItems(owner)) await storage.deleteItem(owner, item.captureId)
      for (const captureId of await storage.listChunkCaptureIds(owner)) await storage.deleteChunks(owner, captureId)
      await notify()
    },
    async clearUser() {
      await storage.clearPrefix(userPrefix(userId))
      await notify()
    },
    subscribe(listener) {
      listeners.add(listener)

      return () => listeners.delete(listener)
    },
  }
}
