/**
 * Turns the analytics statement rows into `AnalyticsOverview`
 * (docs/parity/m9.md C2). Pure. The per-member talk-time breakdown is for
 * owners and admins only; members with fewer than 3 visible meetings are
 * folded into `othersMs`. Talk time of speakers without a confirmed user goes
 * to `unconfirmedMs`. Topics are the top 8 `meeting_tags`.
 */
import {
  ANALYTICS_MIN_MEMBER_MEETINGS,
  type AnalyticsMemberTalkTime,
  type AnalyticsOverview,
  type AnalyticsQuery,
} from "@/lib/analytics/dashboard/types"

export type SeriesRow = { bucket: string; meetings: number | string; duration_ms: number | string }
export type CoverageRow = { total: number | string; with_analytics: number | string; mine: number | string }
export type TalkRow = { user_id: string | null; name: string | null; ms: number | string; meetings: number | string }
export type TopicRow = { tag: string; bucket: string; count: number | string }
export type ActionSeriesRow = { bucket: string; created: number | string; completed: number | string }
export type ActionSummaryRow = {
  overdue: number | string
  median_hours: number | string | null
  mine_open: number | string
  mine_done: number | string
}

export type AnalyticsRows = {
  series: SeriesRow[]
  coverage: CoverageRow[]
  talk: TalkRow[]
  topics: TopicRow[]
  actionSeries: ActionSeriesRow[]
  actionSummary: ActionSummaryRow[]
}

export const TOP_TOPICS = 8

const num = (value: unknown): number => {
  const parsed = Number(value)

  return Number.isFinite(parsed) ? parsed : 0
}

const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : 0)

export function computeAnalyticsOverview(
  query: AnalyticsQuery,
  rows: AnalyticsRows,
  viewer: { userId: string; canSeeMembers: boolean }
): AnalyticsOverview {
  const buckets = rows.series.map((row) => row.bucket)
  const series = rows.series.map((row) => ({
    bucket: row.bucket,
    meetings: num(row.meetings),
    durationMs: num(row.duration_ms),
  }))
  const meetings = series.reduce((sum, point) => sum + point.meetings, 0)
  const durationMs = series.reduce((sum, point) => sum + point.durationMs, 0)
  const coverage = rows.coverage[0]

  // Talk time.
  const totalTalk = rows.talk.reduce((sum, row) => sum + num(row.ms), 0)
  const unconfirmedMs = rows.talk.filter((row) => !row.user_id).reduce((sum, row) => sum + num(row.ms), 0)
  const confirmed = rows.talk
    .filter((row): row is TalkRow & { user_id: string } => Boolean(row.user_id))
    .map((row) => ({ userId: row.user_id, name: row.name ?? "", ms: num(row.ms), meetings: num(row.meetings) }))
  const myTalk = confirmed.find((row) => row.userId === viewer.userId)?.ms ?? 0
  let byMember: AnalyticsMemberTalkTime[] | undefined
  let othersMs: number

  if (viewer.canSeeMembers) {
    const shown = confirmed.filter((row) => row.meetings >= ANALYTICS_MIN_MEMBER_MEETINGS)

    byMember = shown
      .map((row) => ({ userId: row.userId, name: row.name, ms: row.ms, share: ratio(row.ms, totalTalk) }))
      .sort((a, b) => b.ms - a.ms || a.name.localeCompare(b.name))
    othersMs = confirmed
      .filter((row) => row.meetings < ANALYTICS_MIN_MEMBER_MEETINGS)
      .reduce((sum, row) => sum + row.ms, 0)
  } else {
    othersMs = confirmed.filter((row) => row.userId !== viewer.userId).reduce((sum, row) => sum + row.ms, 0)
  }

  // Topics.
  const byTag = new Map<string, Map<string, number>>()

  for (const row of rows.topics) {
    const perBucket = byTag.get(row.tag) ?? new Map<string, number>()

    perBucket.set(row.bucket, (perBucket.get(row.bucket) ?? 0) + num(row.count))
    byTag.set(row.tag, perBucket)
  }

  const topics = [...byTag.entries()]
    .map(([tag, perBucket]) => ({
      tag,
      total: [...perBucket.values()].reduce((sum, count) => sum + count, 0),
      series: buckets.map((bucket) => ({ bucket, count: perBucket.get(bucket) ?? 0 })),
    }))
    .sort((a, b) => b.total - a.total || a.tag.localeCompare(b.tag))
    .slice(0, TOP_TOPICS)

  // Action items.
  const actionByBucket = new Map(rows.actionSeries.map((row) => [row.bucket, row]))
  const actionSeries = buckets.map((bucket) => ({
    bucket,
    created: num(actionByBucket.get(bucket)?.created),
    completed: num(actionByBucket.get(bucket)?.completed),
  }))
  const created = rows.actionSeries.reduce((sum, row) => sum + num(row.created), 0)
  const completed = rows.actionSeries.reduce((sum, row) => sum + num(row.completed), 0)
  const summary = rows.actionSummary[0]
  const median = summary?.median_hours

  return {
    range: { from: query.from, to: query.to },
    tz: query.timeZone,
    interval: query.interval,
    totals: { meetings, durationMs, avgDurationMs: meetings ? Math.round(durationMs / meetings) : 0 },
    series,
    talkTime: {
      ...(byMember ? { byMember } : {}),
      othersMs,
      unconfirmedMs,
      coverage: { withAnalytics: num(coverage?.with_analytics), total: num(coverage?.total) },
    },
    topics,
    actionItems: {
      created,
      completed,
      completionRate: ratio(completed, created),
      overdue: num(summary?.overdue),
      medianHoursToComplete: median === null || median === undefined ? null : Math.round(num(median) * 10) / 10,
      series: actionSeries,
    },
    me: {
      meetings: num(coverage?.mine),
      talkMs: myTalk,
      talkShare: ratio(myTalk, totalTalk),
      tasksOpen: num(summary?.mine_open),
      tasksDone: num(summary?.mine_done),
    },
  }
}

/** An overview with no data (demo storage, or before any meeting). */
export function emptyAnalyticsOverview(query: AnalyticsQuery): AnalyticsOverview {
  return computeAnalyticsOverview(
    query,
    { series: [], coverage: [], talk: [], topics: [], actionSeries: [], actionSummary: [] },
    { userId: "", canSeeMembers: false }
  )
}
