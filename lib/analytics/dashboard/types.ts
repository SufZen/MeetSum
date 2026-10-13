/**
 * Workspace analytics dashboard contracts (M9 Step 0, docs/parity/m9.md C2;
 * owner: Package C). `GET /api/analytics/overview` returns `AnalyticsOverview`.
 * Every number aggregates only meetings visible to the requester (the
 * `visible` CTE built from `meetingScopeSql`); admins get no private bypass.
 */

export type AnalyticsInterval = "day" | "week" | "month"

export type AnalyticsScope = "workspace" | "me"

export type AnalyticsQuery = {
  /** ISO instant, inclusive. Default: 90 days before `to` in the requester's zone. */
  from: string
  /** ISO instant, exclusive. Range at most 366 days. */
  to: string
  interval: AnalyticsInterval
  scope: AnalyticsScope
  roomId?: string
  /** The requester's IANA zone; buckets use `date_trunc(interval, started_at at time zone tz)`. */
  timeZone: string
}

export type AnalyticsSeriesPoint = { bucket: string; meetings: number; durationMs: number }

export type AnalyticsMemberTalkTime = { userId: string; name: string; ms: number; share: number }

export type AnalyticsOverview = {
  range: { from: string; to: string }
  tz: string
  interval: AnalyticsInterval
  totals: { meetings: number; durationMs: number; avgDurationMs: number }
  series: AnalyticsSeriesPoint[]
  talkTime: {
    /** Owner/admin only; members with fewer than 3 visible meetings fold into `othersMs`. */
    byMember?: AnalyticsMemberTalkTime[]
    othersMs: number
    /** Speakers without a confirmed user (`speaker_profiles.user_id`). */
    unconfirmedMs: number
    coverage: { withAnalytics: number; total: number }
  }
  /** Top 8 `meeting_tags`. */
  topics: Array<{ tag: string; total: number; series: Array<{ bucket: string; count: number }> }>
  actionItems: {
    created: number
    completed: number
    completionRate: number
    overdue: number
    medianHoursToComplete: number | null
    series: Array<{ bucket: string; created: number; completed: number }>
  }
  me: { meetings: number; talkMs: number; talkShare: number; tasksOpen: number; tasksDone: number }
}

/** Members with fewer visible meetings than this are folded into "others". */
export const ANALYTICS_MIN_MEMBER_MEETINGS = 3

export const ANALYTICS_MAX_RANGE_DAYS = 366

export const ANALYTICS_DEFAULT_RANGE_DAYS = 90
