/**
 * In-memory `QueueStorage` (tests, and the fallback when IndexedDB is
 * unavailable, e.g. a private window that blocks it). Partitioned by owner.
 */
import type { ChunkRecord, QueueStorage, StoredItem } from "@/lib/client/upload-queue/types"

const key = (owner: string, captureId: string) => `${owner}\u0000${captureId}`

export function createMemoryStorage(): QueueStorage & { chunkCount(): number } {
  const chunks = new Map<string, ChunkRecord[]>()
  const items = new Map<string, StoredItem>()

  return {
    async putChunk(chunk) {
      const id = key(chunk.owner, chunk.captureId)
      const list = (chunks.get(id) ?? []).filter((existing) => existing.seq !== chunk.seq)

      chunks.set(id, [...list, chunk].sort((a, b) => a.seq - b.seq))
    },
    async listChunks(owner, captureId) {
      return [...(chunks.get(key(owner, captureId)) ?? [])]
    },
    async deleteChunks(owner, captureId) {
      chunks.delete(key(owner, captureId))
    },
    async listChunkCaptureIds(owner) {
      return [...chunks.values()].filter((list) => list[0]?.owner === owner).map((list) => list[0].captureId)
    },
    async putItem(item) {
      items.set(key(item.owner, item.captureId), { ...item })
    },
    async getItem(owner, captureId) {
      const item = items.get(key(owner, captureId))

      return item ? { ...item } : undefined
    },
    async listItems(owner) {
      return [...items.values()].filter((item) => item.owner === owner).map((item) => ({ ...item }))
    },
    async deleteItem(owner, captureId) {
      items.delete(key(owner, captureId))
    },
    async clearPrefix(prefix) {
      for (const [id, list] of chunks) if (list[0]?.owner.startsWith(prefix)) chunks.delete(id)
      for (const [id, item] of items) if (item.owner.startsWith(prefix)) items.delete(id)
    },
    chunkCount() {
      return [...chunks.values()].reduce((sum, list) => sum + list.length, 0)
    },
  }
}
