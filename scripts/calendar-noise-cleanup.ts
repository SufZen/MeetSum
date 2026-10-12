import { getDatabasePool } from "@/lib/db/client"

/**
 * Deletes unprocessed calendar-noise meetings. Dry run unless --execute.
 * --workspace=<id> restricts the run to one workspace; every candidate and
 * every delete is keyed by (id, workspace_id).
 */
const args = new Set(process.argv.slice(2))
const execute = args.has("--execute")
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="))
const workspaceArg = process.argv.find((arg) => arg.startsWith("--workspace="))
const workspaceId = workspaceArg?.split("=")[1]?.trim() || null
const limit = Math.max(
  1,
  Math.min(Number(limitArg?.split("=")[1] ?? 200), 1000)
)

const pool = getDatabasePool()

const candidatesSql = `
  select m.id, m.workspace_id, m.title, m.started_at
  from meetings m
  left join calendar_events ce on ce.id = m.calendar_event_id
  where m.source = 'google_meet'
    and ($2::text is null or m.workspace_id = $2)
    and m.calendar_event_id is not null
    and m.status in ('scheduled', 'failed')
    and coalesce(jsonb_array_length(m.participants), 0) = 0
    and coalesce(m.google_meet_link, ce.meet_link, '') = ''
    and not exists (select 1 from media_assets ma where ma.meeting_id = m.id)
    and not exists (select 1 from transcript_segments ts where ts.meeting_id = m.id)
    and not exists (select 1 from summaries s where s.meeting_id = m.id)
    and not exists (select 1 from action_items ai where ai.meeting_id = m.id)
    and not exists (select 1 from meeting_drive_files mdf where mdf.meeting_id = m.id)
    and not exists (select 1 from jobs j where j.meeting_id = m.id)
  order by m.started_at desc
  limit $1
`

try {
  const candidates = await pool.query(candidatesSql, [limit, workspaceId])
  const rows = candidates.rows as Array<{
    id: string
    workspace_id: string
    title: string
    started_at: string | Date
  }>

  console.log(
    `${execute ? "Deleting" : "Dry run:"} ${rows.length} unprocessed calendar noise meeting(s)` +
      (workspaceId ? ` in ${workspaceId}.` : " across all workspaces.")
  )

  for (const row of rows) {
    console.log(`- [${row.workspace_id}] ${row.id} | ${row.title} | ${row.started_at}`)
  }

  if (execute && rows.length) {
    await pool.query(
      `
        delete from meetings m
        using unnest($1::text[], $2::text[]) as target(id, workspace_id)
        where m.id = target.id and m.workspace_id = target.workspace_id
      `,
      [rows.map((row) => row.id), rows.map((row) => row.workspace_id)]
    )
    console.log(`Deleted ${rows.length} meeting row(s).`)
  }
} finally {
  await pool.end()
}
