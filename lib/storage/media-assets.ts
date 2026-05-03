import { getDatabasePool } from "@/lib/db/client"
import { deleteMeetingObject } from "@/lib/storage/object-storage"

export type MediaAssetView = {
  id: string
  meetingId: string
  meetingTitle: string
  storageKey: string
  filename?: string
  contentType: string
  sizeBytes: number
  retention: "audio" | "video"
  createdAt: string
}

type MediaAssetRow = {
  id: string
  meeting_id: string
  meeting_title: string
  storage_key: string
  filename: string | null
  content_type: string
  size_bytes: string | number
  retention: "audio" | "video"
  created_at: string | Date
}

function toIso(value: string | Date) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function mapMediaAsset(row: MediaAssetRow): MediaAssetView {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    meetingTitle: row.meeting_title,
    storageKey: row.storage_key,
    filename: row.filename ?? undefined,
    contentType: row.content_type,
    sizeBytes:
      typeof row.size_bytes === "number"
        ? row.size_bytes
        : Number.parseInt(row.size_bytes, 10),
    retention: row.retention,
    createdAt: toIso(row.created_at),
  }
}

export async function listMediaAssets(options: { limit?: number } = {}) {
  if (process.env.MEETSUM_STORAGE !== "postgres") return []

  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 100)
  const result = await getDatabasePool().query(
    `
      select a.id, a.meeting_id, m.title as meeting_title, a.storage_key,
             a.filename, a.content_type, a.size_bytes, a.retention, a.created_at
      from media_assets a
      join meetings m on m.id = a.meeting_id
      order by a.created_at desc
      limit $1
    `,
    [limit]
  )

  return (result.rows as MediaAssetRow[]).map(mapMediaAsset)
}

export async function deleteMediaAsset(id: string) {
  if (process.env.MEETSUM_STORAGE !== "postgres") {
    throw new Error("Media asset deletion requires Postgres storage")
  }

  const pool = getDatabasePool()
  const result = await pool.query(
    `
      select a.id, a.meeting_id, m.title as meeting_title, a.storage_key,
             a.filename, a.content_type, a.size_bytes, a.retention, a.created_at
      from media_assets a
      join meetings m on m.id = a.meeting_id
      where a.id = $1
    `,
    [id]
  )
  const row = result.rows[0] as MediaAssetRow | undefined

  if (!row) throw new Error("Media asset not found")

  await deleteMeetingObject(row.storage_key)
  await pool.query("delete from media_assets where id = $1", [id])

  return mapMediaAsset(row)
}
