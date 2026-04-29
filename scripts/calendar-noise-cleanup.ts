import { getDatabasePool } from "@/lib/db/client"

const args = new Set(process.argv.slice(2))
const execute = args.has("--execute")
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="))
const limit = Math.max(
  1,
  Math.min(Number(limitArg?.split("=")[1] ?? 200), 1000)
)

const pool = getDatabasePool()

const candidatesSql = `
  select m.id, m.title, m.started_at
  from meetings m
  left join calendar_events ce on ce.id = m.calendar_event_id
  where m.source = 'google_meet'
    and m.status in ('scheduled', 'failed')
    and coalesce(jsonb_array_length(m.participants), 0) = 0
    and coalesce(m.google_meet_link, ce.meet_link, '') = ''
    and not exists (select 1 from media_assets ma where ma.meeting_id = m.id)
    and not exists (select 1 from transcript_segments ts where ts.meeting_id = m.id)
    and not exists (select 1 from summaries s where s.meeting_id = m.id)
    and not exists (select 1 from action_items ai where ai.meeting_id = m.id)
  order by m.started_at desc
  limit $1
`

try {
  const candidates = await pool.query(candidatesSql, [limit])
  const rows = candidates.rows as Array<{
    id: string
    title: string
    started_at: string | Date
  }>

  console.log(
    `${execute ? "Deleting" : "Dry run:"} ${rows.length} unprocessed calendar noise meeting(s).`
  )

  for (const row of rows) {
    console.log(`- ${row.id} | ${row.title} | ${row.started_at}`)
  }

  if (execute && rows.length) {
    await pool.query(
      `delete from meetings where id = any($1::text[])`,
      [rows.map((row) => row.id)]
    )
    console.log(`Deleted ${rows.length} meeting row(s).`)
  }
} finally {
  await pool.end()
}
