import { getDatabasePool } from "@/lib/db/client"
import { deleteMeetingObject } from "@/lib/storage/object-storage"

type MediaCandidate = {
  id: string
  meeting_id: string
  storage_key: string
  filename: string | null
  content_type: string
  size_bytes: string
  created_at: Date
}

function hasFlag(name: string) {
  return process.argv.includes(name)
}

function getOption(name: string, fallback: string) {
  const index = process.argv.indexOf(name)

  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback
}

function formatBytes(value: number) {
  const units = ["B", "KB", "MB", "GB", "TB"]
  let size = value
  let index = 0

  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }

  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

async function main() {
  const execute = hasFlag("--execute")
  const limit = Number(getOption("--limit", "50"))
  const target = getOption("--target", "video")
  const pool = getDatabasePool()

  if (target !== "video") {
    throw new Error("Only --target video is supported for now")
  }

  const result = await pool.query<MediaCandidate>(
    `
      select id, meeting_id, storage_key, filename, content_type, size_bytes, created_at
      from media_assets
      where retention = 'video' or content_type like 'video/%'
      order by size_bytes desc
      limit $1
    `,
    [limit]
  )
  const totalBytes = result.rows.reduce(
    (sum, row) => sum + Number(row.size_bytes),
    0
  )

  console.log(
    `${execute ? "Deleting" : "Dry run:"} ${result.rows.length} video media asset(s), ${formatBytes(totalBytes)}`
  )

  for (const row of result.rows) {
    console.log(
      `${execute ? "delete" : "would delete"} ${formatBytes(Number(row.size_bytes))} ${row.meeting_id} ${row.filename ?? row.storage_key}`
    )

    if (!execute) continue

    await deleteMeetingObject(row.storage_key)
    await pool.query(`delete from media_assets where id = $1`, [row.id])
  }

  await pool.end()
}

main().catch(async (error) => {
  console.error(error)
  await getDatabasePool().end().catch(() => undefined)
  process.exit(1)
})
