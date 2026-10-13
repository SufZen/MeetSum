import { getDatabasePool } from "@/lib/db/client"
import { cleanupReadNotifications } from "@/lib/notifications/cleanup"
import { deleteMeetingObject } from "@/lib/storage/object-storage"
import {
  applyMediaRetention,
  listRetentionWorkspaceIds,
} from "@/lib/storage/retention"

/**
 * Media retention, one workspace at a time. Dry run unless --execute.
 *
 *   --target age    (default) delete media of completed meetings older than the
 *                   workspace's audioRetentionDays (or --days N)
 *   --target video  delete every stored video asset (legacy space reclaim)
 *   --workspace ID  only this workspace (default: every live workspace)
 *   --limit N       max assets per workspace (default 50)
 */

type VideoCandidate = {
  id: string
  meeting_id: string
  storage_key: string
  filename: string | null
  size_bytes: string
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

async function purgeVideos(workspaceId: string, execute: boolean, limit: number) {
  const pool = getDatabasePool()
  const result = await pool.query<VideoCandidate>(
    `
      select id, meeting_id, storage_key, filename, size_bytes
      from media_assets
      where workspace_id = $1
        and (retention = 'video' or content_type like 'video/%')
      order by size_bytes desc
      limit $2
    `,
    [workspaceId, limit]
  )
  const totalBytes = result.rows.reduce((sum, row) => sum + Number(row.size_bytes), 0)

  console.log(
    `[${workspaceId}] ${execute ? "Deleting" : "Dry run:"} ${result.rows.length} video asset(s), ${formatBytes(totalBytes)}`
  )

  for (const row of result.rows) {
    console.log(
      `  ${execute ? "delete" : "would delete"} ${formatBytes(Number(row.size_bytes))} ${row.meeting_id} ${row.filename ?? row.storage_key}`
    )

    if (!execute) continue

    await deleteMeetingObject(row.storage_key)
    await pool.query(`delete from media_assets where id = $1 and workspace_id = $2`, [
      row.id,
      workspaceId,
    ])
  }
}

async function main() {
  const execute = hasFlag("--execute")
  const limit = Number(getOption("--limit", "50"))
  const target = getOption("--target", "age")
  const onlyWorkspace = getOption("--workspace", "")
  const daysOption = getOption("--days", "")

  if (target !== "age" && target !== "video") {
    throw new Error("--target must be age or video")
  }

  const workspaceIds = onlyWorkspace
    ? [onlyWorkspace]
    : await listRetentionWorkspaceIds()

  for (const workspaceId of workspaceIds) {
    if (target === "video") {
      await purgeVideos(workspaceId, execute, limit)
      continue
    }

    const result = await applyMediaRetention({
      workspaceId,
      execute,
      limit,
      retentionDays: daysOption ? Number(daysOption) : undefined,
    })

    console.log(
      `[${workspaceId}] retention ${result.retentionDays}d: ${result.candidates} candidate(s)` +
        (execute
          ? `, deleted ${result.deleted} (${formatBytes(result.deletedBytes)})`
          : " (dry run)") +
        (result.errors.length ? `, ${result.errors.length} error(s)` : "")
    )
  }

  // M9: read notifications past MEETSUM_NOTIFICATIONS_RETENTION_DAYS (90).
  const notifications = await cleanupReadNotifications(getDatabasePool(), { execute })

  console.log(
    `notifications retention ${notifications.days}d: ${notifications.matched} read row(s)` +
      (execute ? `, deleted ${notifications.deleted}` : " (dry run)")
  )

  await getDatabasePool().end()
}

main().catch(async (error) => {
  console.error(error)
  await getDatabasePool().end().catch(() => undefined)
  process.exit(1)
})
