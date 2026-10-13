/**
 * In-memory `QueueStorage` (tests, and the fallback when IndexedDB is
 * unavailable, e.g. a private window that blocks it).
 */
import type { ChunkRecord, QueueStorage, StoredItem } from "@/lib/client/upload-queue/types"

const key = (userId: string, captureId: string) => `${userId}\u0000${captureId}`

export function createMemoryStorage(): QueueStorage & { chunkCount(): number } {
  const chunks = new Map<string, ChunkRecord[]>()
  const items = new Map<string, StoredItem>()

  return {
    async putChunk(chunk) {
      const id = key(chunk.userId, chunk.captureId)
      const list = (chunks.get(id) ?? []).filter((existing) => existing.seq !== chunk.seq)

      chunks.set(id, [...list, chunk].sort((a, b) => a.seq - b.seq))
    },
    async listChunks(userId, captureId) {
      return [...(chunks.get(key(userId, captureId)) ?? [])]
    },
    async deleteChunks(userId, captureId) {
      chunks.delete(key(userId, captureId))
    },
    async listChunkCaptureIds(userId) {
      return [...chunks.values()]
        .filter((list) => list[0]?.userId === userId)
        .map((list) => list[0].captureId)
    },
    async putItem(item) {
      items.set(key(item.userId, item.captureId), { ...item })
    },
    async getItem(userId, captureId) {
      const item = items.get(key(userId, captureId))

      return item ? { ...item } : undefined
    },
    async listItems(userId) {
      return [...items.values()].filter((item) => item.userId === userId).map((item) => ({ ...item }))
    },
    async deleteItem(userId, captureId) {
      items.delete(key(userId, captureId))
    },
    async clearUser(userId) {
      for (const [id, list] of chunks) if (list[0]?.userId === userId) chunks.delete(id)
      for (const [id, item] of items) if (item.userId === userId) items.delete(id)
    },
    chunkCount() {
      return [...chunks.values()].reduce((sum, list) => sum + list.length, 0)
    },
  }
}
