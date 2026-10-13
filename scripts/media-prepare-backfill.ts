import { getDatabasePool } from "@/lib/db/client"
import { prepareMediaAsset } from "@/lib/media/prepare"
import { getSystemMeetingRepository } from "@/lib/meetings/store"

/**
 * Backfills playback renditions, waveform peaks and durations for existing
 * media (M4 Package A). Dry run unless --execute.
 *
 *   --limit N       max original assets (default 50)
 *   --meeting ID    only this meeting
 *   --force         re-prepare assets that are already prepared
 *
 * Runs in-process (needs ffmpeg/ffprobe and object storage access), one
 * asset at a time; a failure is recorded on the asset and the run continues.
 */

type Candidate = {
  id: string
  meeting_id: string
  workspace_id: string
  content_type: string
  size_bytes: string | number
  prepared_at: string | Date | null
}

function hasFlag(name: string) {
  return process.argv.includes(name)
}

function getOption(name: string, fallback: string) {
  const index = process.argv.indexOf(name)

  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback
}

async function main() {
  const execute = hasFlag("--execute")
  const force = hasFlag("--force")
  const meetingId = getOption("--meeting", "")
  const limit = Math.min(Math.max(Math.trunc(Number(getOption("--limit", "50"))) || 50, 1), 10_000)
  const values: unknown[] = []
  const conditions = ["a.kind = 'original'", "a.storage_key is not null", "a.storage_key <> ''"]

  if (!force) conditions.push("a.prepared_at is null")
  if (meetingId) {
    values.push(meetingId)
    conditions.push(`a.meeting_id = $${values.length}`)
  }
  values.push(limit)

  const pool = getDatabasePool()
  const result = await pool.query<Candidate>(
    `
      select a.id, a.meeting_id, a.workspace_id, a.content_type, a.size_bytes, a.prepared_at
      from media_assets a
      join meetings m on m.id = a.meeting_id
      where ${conditions.join(" and ")}
      order by a.created_at desc
      limit $${values.length}
    `,
    values
  )

  console.log(
    `${execute ? "Preparing" : "Dry run:"} ${result.rows.length} media asset(s)${force ? " (force)" : ""}`
  )

  let prepared = 0
  let failed = 0

  for (const row of result.rows) {
    const label = `${row.workspace_id}/${row.meeting_id}/${row.id} ${row.content_type} ${row.size_bytes} B`

    if (!execute) {
      console.log(`  would prepare ${label}`)
      continue
    }

    const repo = getSystemMeetingRepository(row.workspace_id)

    try {
      const outcome = await prepareMediaAsset({
        meetingId: row.meeting_id,
        assetId: row.id,
        repo,
        force,
      })

      prepared += outcome.status === "prepared" ? 1 : 0
      console.log(
        `  ${outcome.status} ${label} duration=${outcome.durationMs ?? "?"}ms playback=${outcome.playback}`
      )
    } catch (error) {
      failed += 1
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500)

      console.error(`  failed ${label}: ${message}`)
      await repo
        .updateMediaAssetPreparation(row.id, { prepareError: message })
        .catch(() => undefined)
    }
  }

  if (execute) console.log(`Done: ${prepared} prepared, ${failed} failed`)
  await pool.end()
}

main().catch(async (error) => {
  console.error(error)
  await getDatabasePool().end().catch(() => undefined)
  process.exit(1)
})
