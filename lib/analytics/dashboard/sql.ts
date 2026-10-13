/**
 * Workspace analytics SQL (docs/parity/m9.md C2, security check 1). Every
 * statement starts with the same base CTE:
 *
 *   with visible as (select … from meetings m where <meetingScopeSql(scope,"m")>
 *                    and m.started_at in [from, to) [and room] [and mine])
 *
 * and every aggregate (durations, analytics speakers, tags, action items)
 * joins `visible`, never `meetings` directly, so only meetings the requester
 * may see are counted. Admins get no bypass: `meetingScopeSql` applies the
 * member rules to every role. Buckets are local dates:
 * `date_trunc(interval, started_at at time zone tz)`. Server-only.
 */
import type { AnalyticsQuery } from "@/lib/analytics/dashboard/types"
import type { RepoScope } from "@/lib/meetings/repository"
import { meetingScopeSql } from "@/lib/meetings/visibility"

export type AnalyticsStatementName =
  | "series"
  | "coverage"
  | "talk"
  | "topics"
  | "actionSeries"
  | "actionSummary"

export type AnalyticsStatement = { name: AnalyticsStatementName; text: string; values: unknown[] }

export type AnalyticsViewer = { userId: string; email: string }

type Builder = {
  values: unknown[]
  param: (value: unknown) => string
  /** `$n` of the zone and interval (always bound). */
  tz: string
  interval: string
  /** Viewer and workspace params, bound on first use (Postgres rejects unused params). */
  readonly userId: string
  readonly email: string
  readonly workspaceId: string
  cte: string
}

function builder(scope: RepoScope, query: AnalyticsQuery, viewer: AnalyticsViewer): Builder {
  const values: unknown[] = []
  const param = (value: unknown) => {
    values.push(value)
    return `$${values.length}`
  }
  const scopePredicate = meetingScopeSql(scope, "m", values)
  const lazy = (value: unknown) => {
    let placeholder: string | undefined
    return () => (placeholder ??= param(value))
  }
  const workspaceId = lazy(scope.workspaceId)
  const userId = lazy(viewer.userId)
  const email = lazy(viewer.email.trim().toLowerCase())
  const from = param(query.from)
  const to = param(query.to)
  const tz = param(query.timeZone)
  const interval = param(query.interval)
  const room = query.roomId
    ? ` and exists (select 1 from meeting_contexts mc_room where mc_room.meeting_id = m.id and mc_room.context_id = ${param(query.roomId)})`
    : ""
  const mine =
    query.scope === "me"
      ? ` and (m.owner_user_id = ${userId()} or exists (select 1 from meeting_participants mp_mine ` +
        `where mp_mine.meeting_id = m.id and lower(mp_mine.email) = ${email()}))`
      : ""

  const cte =
    `with visible as (\n` +
    `  select m.id, m.owner_user_id, coalesce(m.duration_ms, 0)::bigint as duration_ms,\n` +
    `    date_trunc(${interval}, m.started_at at time zone ${tz}) as bucket\n` +
    `  from meetings m\n` +
    `  where ${scopePredicate}\n` +
    `    and m.started_at >= ${from}::timestamptz and m.started_at < ${to}::timestamptz${room}${mine}\n` +
    `)`

  // Bucket spine for the requested range (local dates), so empty buckets show.
  const spine =
    `buckets as (\n` +
    `  select g as bucket from generate_series(\n` +
    `    date_trunc(${interval}, ${from}::timestamptz at time zone ${tz}),\n` +
    `    (${to}::timestamptz at time zone ${tz}) - interval '1 microsecond',\n` +
    `    ('1 ' || ${interval})::interval) g\n` +
    `)`

  return {
    values,
    param,
    tz,
    interval,
    get userId() {
      return userId()
    },
    get email() {
      return email()
    },
    get workspaceId() {
      return workspaceId()
    },
    cte: `${cte},\n${spine}`,
  }
}

const bucketText = (column: string) => `to_char(${column}, 'YYYY-MM-DD')`

export function buildAnalyticsStatements(
  scope: RepoScope,
  query: AnalyticsQuery,
  viewer: AnalyticsViewer
): AnalyticsStatement[] {
  const make = (name: AnalyticsStatementName, body: (b: Builder) => string): AnalyticsStatement => {
    const b = builder(scope, query, viewer)

    return { name, text: `${b.cte}\n${body(b)}`, values: b.values }
  }

  return [
    make(
      "series",
      () =>
        `select ${bucketText("b.bucket")} as bucket, count(v.id)::int as meetings,\n` +
        `  coalesce(sum(v.duration_ms), 0)::bigint as duration_ms\n` +
        `from buckets b left join visible v on v.bucket = b.bucket\n` +
        `group by b.bucket order by b.bucket`
    ),
    make(
      "coverage",
      (b) =>
        `select count(v.id)::int as total, count(ma.meeting_id)::int as with_analytics,\n` +
        `  count(v.id) filter (where v.owner_user_id = ${b.userId} or exists (\n` +
        `    select 1 from meeting_participants mp_me where mp_me.meeting_id = v.id and lower(mp_me.email) = ${b.email}\n` +
        `  ))::int as mine\n` +
        `from visible v left join meeting_analytics ma on ma.meeting_id = v.id`
    ),
    make(
      "talk",
      (b) =>
        `, spk as (\n` +
        `  select v.id as meeting_id, s.value as speaker\n` +
        `  from visible v\n` +
        `  join meeting_analytics ma on ma.meeting_id = v.id\n` +
        `  cross join lateral jsonb_array_elements(\n` +
        `    case when jsonb_typeof(ma.metrics -> 'speakers') = 'array' then ma.metrics -> 'speakers' else '[]'::jsonb end\n` +
        `  ) s(value)\n` +
        `)\n` +
        `select p.user_id,\n` +
        `  coalesce(nullif(trim(u.name), ''), nullif(trim(u.display_name), ''), u.email) as name,\n` +
        `  coalesce(sum(case when jsonb_typeof(spk.speaker -> 'talkTimeMs') = 'number'\n` +
        `    then greatest((spk.speaker ->> 'talkTimeMs')::numeric, 0) else 0 end), 0)::bigint as ms,\n` +
        `  count(distinct spk.meeting_id)::int as meetings\n` +
        `from spk\n` +
        `left join speakers sp on sp.id = spk.speaker ->> 'speakerId' and sp.meeting_id = spk.meeting_id\n` +
        `  and sp.mapping_status = 'confirmed'\n` +
        `left join speaker_profiles p on p.id = sp.profile_id and p.workspace_id = ${b.workspaceId}\n` +
        `left join users u on u.id = p.user_id\n` +
        `group by p.user_id, u.name, u.display_name, u.email`
    ),
    make(
      "topics",
      (b) =>
        `select t.name as tag, ${bucketText("v.bucket")} as bucket, count(*)::int as count\n` +
        `from visible v\n` +
        `join meeting_tags mt on mt.meeting_id = v.id\n` +
        `join tags t on t.id = mt.tag_id and t.workspace_id = ${b.workspaceId}\n` +
        `group by t.name, v.bucket`
    ),
    make(
      "actionSeries",
      () =>
        `select ${bucketText("v.bucket")} as bucket, count(ai.id)::int as created,\n` +
        `  count(ai.id) filter (where ai.status = 'done')::int as completed\n` +
        `from visible v join action_items ai on ai.meeting_id = v.id\n` +
        `group by v.bucket`
    ),
    make(
      "actionSummary",
      (b) =>
        `, items as (\n` +
        `  select ai.status, ai.created_at, ai.completed_at, ai.due_on, ai.owner_user_id\n` +
        `  from visible v join action_items ai on ai.meeting_id = v.id\n` +
        `)\n` +
        `select\n` +
        `  (select count(*) from items where status <> 'done' and due_on is not null\n` +
        `    and due_on < (now() at time zone ${b.tz})::date)::int as overdue,\n` +
        `  (select percentile_cont(0.5) within group (order by extract(epoch from (completed_at - created_at)) / 3600.0)\n` +
        `    from items where status = 'done' and completed_at is not null and completed_at >= created_at) as median_hours,\n` +
        `  (select count(*) from items where owner_user_id = ${b.userId} and status <> 'done')::int as mine_open,\n` +
        `  (select count(*) from items where owner_user_id = ${b.userId} and status = 'done')::int as mine_done`
    ),
  ]
}
