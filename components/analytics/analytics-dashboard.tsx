"use client"

/**
 * Workspace analytics dashboard (docs/parity/m9.md C2). Range, interval and
 * scope live in the URL (plain links). KPI row with an honest coverage line;
 * meetings and hours trend; talk time (by member for owners and admins, own
 * numbers for everyone); topics small multiples from `meeting_tags`;
 * action-item completion. Every chart has a table view; time axes are LTR;
 * names in <bdi>. With no meetings in range the page says so and shows no
 * numbers.
 */
import { ArrowLeftIcon } from "lucide-react"
import dynamic from "next/dynamic"
import Link from "next/link"

import { ChartCard } from "@/components/analytics/chart-card"
import { useI18n } from "@/components/i18n-provider"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ANALYTICS_INTERVALS, ANALYTICS_RANGE_PRESETS, type AnalyticsRangePreset } from "@/lib/analytics/dashboard/query"
import type { AnalyticsInterval, AnalyticsOverview, AnalyticsScope } from "@/lib/analytics/dashboard/types"
import { cn } from "@/lib/utils"

const ChartSkeleton = ({ className }: { className?: string }) => <Skeleton className={cn("h-56 w-full", className)} />

const TrendChart = dynamic(() => import("@/components/analytics/analytics-charts").then((mod) => mod.TrendChart), {
  ssr: false,
  loading: () => <ChartSkeleton className="h-64" />,
})
const TalkChart = dynamic(() => import("@/components/analytics/analytics-charts").then((mod) => mod.TalkChart), {
  ssr: false,
  loading: () => <ChartSkeleton className="h-32" />,
})
const SparkBars = dynamic(() => import("@/components/analytics/analytics-charts").then((mod) => mod.SparkBars), {
  ssr: false,
  loading: () => <ChartSkeleton className="h-12" />,
})
const ActionChart = dynamic(() => import("@/components/analytics/analytics-charts").then((mod) => mod.ActionChart), {
  ssr: false,
  loading: () => <ChartSkeleton />,
})

export type AnalyticsFilters = { range: AnalyticsRangePreset; interval: AnalyticsInterval; scope: AnalyticsScope }

const INTERVAL_LABEL: Record<AnalyticsInterval, string> = {
  day: "analyticsIntervalDay",
  week: "analyticsIntervalWeek",
  month: "analyticsIntervalMonth",
}

const SPEAKER_COLORS = Array.from({ length: 7 }, (_, index) => `var(--color-spk-${index + 1})`)

export function analyticsHref(locale: string, filters: AnalyticsFilters): string {
  const params = new URLSearchParams()

  if (filters.range !== 90) params.set("range", String(filters.range))
  if (filters.interval !== "week") params.set("interval", filters.interval)
  if (filters.scope !== "workspace") params.set("scope", filters.scope)

  const query = params.toString()

  return `/${locale}/analytics${query ? `?${query}` : ""}`
}

function FilterGroup<T extends string | number>({
  label,
  options,
  current,
  href,
  render,
}: {
  label: string
  options: readonly T[]
  current: T
  href: (value: T) => string
  render: (value: T) => string
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs font-medium text-fg-3">{label}</span>
      <ul className="flex flex-wrap gap-1 rounded-md border border-line bg-surface p-0.5">
        {options.map((value) => (
          <li key={String(value)}>
            <Link
              href={href(value)}
              aria-current={value === current ? "true" : undefined}
              className={cn(
                "block rounded-sm px-2 py-1 text-sm text-fg-2 hover:bg-surface-2 focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent",
                value === current && "bg-surface-3 font-medium text-fg"
              )}
            >
              {render(value)}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Kpi({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="ms-card grid gap-1 p-4">
      <span className="text-xs font-medium text-fg-3">{label}</span>
      <span className="text-2xl font-semibold text-fg tabular-nums">{value}</span>
      {detail ? <span className="text-xs text-fg-2">{detail}</span> : null}
    </div>
  )
}

export function AnalyticsDashboard({
  locale,
  overview,
  filters,
  canSeeMembers,
}: {
  locale: string
  overview: AnalyticsOverview
  filters: AnalyticsFilters
  canSeeMembers: boolean
}) {
  const i18n = useI18n()
  const { t, fmt } = i18n
  // Buckets are local dates; noon UTC keeps the same calendar day when formatted.
  const bucketLabel = (bucket: string) =>
    fmt.date(`${bucket}T12:00:00Z`, filters.interval === "month" ? "monthYear" : "dateShort")
  const hours = (ms: number) => Math.round((ms / 3_600_000) * 10) / 10
  const empty = overview.totals.meetings === 0
  const minutes = (ms: number) => Math.round(ms / 60_000)

  const talkRows: Array<{ key: string; label: string; ms: number; share?: number; color: string; isName: boolean }> = []

  if (overview.talkTime.byMember) {
    overview.talkTime.byMember.forEach((member, index) =>
      talkRows.push({
        key: member.userId,
        label: member.name,
        ms: member.ms,
        share: member.share,
        color: SPEAKER_COLORS[index % SPEAKER_COLORS.length]!,
        isName: true,
      })
    )
  } else if (overview.me.talkMs > 0) {
    talkRows.push({ key: "me", label: t("analyticsTalkYours"), ms: overview.me.talkMs, share: overview.me.talkShare, color: SPEAKER_COLORS[0]!, isName: false })
  }
  if (overview.talkTime.othersMs > 0) {
    talkRows.push({ key: "others", label: t("analyticsOthers"), ms: overview.talkTime.othersMs, color: "var(--color-spk-8)", isName: false })
  }
  if (overview.talkTime.unconfirmedMs > 0) {
    talkRows.push({ key: "unconfirmed", label: t("analyticsUnconfirmed"), ms: overview.talkTime.unconfirmedMs, color: "var(--color-fg-3)", isName: false })
  }

  const filterHref = (patch: Partial<AnalyticsFilters>) => analyticsHref(locale, { ...filters, ...patch })

  return (
    <main className="min-h-svh bg-canvas">
      <div className="mx-auto grid w-full max-w-6xl gap-5 px-4 py-4">
        <Link href={`/${locale}`} className="inline-flex items-center gap-1.5 text-sm text-fg-3 hover:text-brand-text">
          <ArrowLeftIcon aria-hidden data-icon="directional" className="size-3.5 rtl:-scale-x-100" />
          {t("navMeetings")}
        </Link>
        <header className="grid gap-3">
          <h1 className="text-xl font-semibold text-fg">{t("analyticsTitle")}</h1>
          <nav aria-label={t("analyticsFilters")} className="flex flex-wrap gap-x-4 gap-y-2">
            <FilterGroup
              label={t("analyticsRange")}
              options={ANALYTICS_RANGE_PRESETS}
              current={filters.range}
              href={(range) => filterHref({ range })}
              render={(range) => i18n.plural("analyticsRangeDays", range, { count: fmt.number(range) })}
            />
            <FilterGroup
              label={t("analyticsInterval")}
              options={ANALYTICS_INTERVALS}
              current={filters.interval}
              href={(interval) => filterHref({ interval })}
              render={(interval) => t(INTERVAL_LABEL[interval])}
            />
            <FilterGroup
              label={t("analyticsScope")}
              options={["workspace", "me"] as const}
              current={filters.scope}
              href={(scope) => filterHref({ scope })}
              render={(scope) => t(scope === "me" ? "analyticsScopeMe" : "analyticsScopeWorkspace")}
            />
          </nav>
        </header>

        {empty ? (
          <section className="ms-card grid place-items-center gap-2 p-10 text-center">
            <p className="text-sm text-fg-2">{t("analyticsEmpty")}</p>
          </section>
        ) : (
          <>
            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Kpi label={t("analyticsMeetings")} value={fmt.number(overview.totals.meetings)} />
              <Kpi label={t("analyticsHours")} value={fmt.duration(overview.totals.durationMs, "short")} />
              <Kpi label={t("analyticsAvgDuration")} value={fmt.duration(overview.totals.avgDurationMs, "short")} />
              <Kpi
                label={t("analyticsCompletionRate")}
                value={fmt.percent(overview.actionItems.completionRate)}
                detail={t("analyticsTasksOpenDone", {
                  open: fmt.number(overview.me.tasksOpen),
                  done: fmt.number(overview.me.tasksDone),
                })}
              />
            </section>
            <p className="text-sm text-fg-2">
              {t("analyticsCoverage", {
                with: fmt.number(overview.talkTime.coverage.withAnalytics),
                total: fmt.number(overview.talkTime.coverage.total),
              })}
            </p>

            <ChartCard
              title={t("analyticsTrend")}
              chart={
                <TrendChart
                  data={overview.series.map((point) => ({ label: bucketLabel(point.bucket), meetings: point.meetings, hours: hours(point.durationMs) }))}
                  labels={{ meetings: t("analyticsMeetings"), hours: t("analyticsHours") }}
                />
              }
              table={
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("analyticsPeriod")}</TableHead>
                      <TableHead>{t("analyticsMeetings")}</TableHead>
                      <TableHead>{t("analyticsHours")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {overview.series.map((point) => (
                      <TableRow key={point.bucket}>
                        <TableCell>
                          <time dateTime={point.bucket}>{bucketLabel(point.bucket)}</time>
                        </TableCell>
                        <TableCell className="tabular-nums">{fmt.number(point.meetings)}</TableCell>
                        <TableCell className="tabular-nums">{fmt.duration(point.durationMs, "short")}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              }
            />

            <div className="grid gap-5 lg:grid-cols-2">
              <ChartCard
                title={canSeeMembers ? t("analyticsTalkByMember") : t("analyticsTalkTime")}
                description={canSeeMembers ? undefined : t("analyticsTalkMembersOnly")}
                empty={talkRows.length === 0 ? t("analyticsTalkEmpty") : null}
                chart={
                  <TalkChart
                    data={talkRows.map((row) => ({ label: row.label, minutes: minutes(row.ms), color: row.color }))}
                    label={t("analyticsTalkTime")}
                  />
                }
                table={
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("analyticsName")}</TableHead>
                        <TableHead>{t("analyticsTalkTime")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {talkRows.map((row) => (
                        <TableRow key={row.key}>
                          <TableCell>{row.isName ? <bdi>{row.label}</bdi> : row.label}</TableCell>
                          <TableCell className="tabular-nums">
                            {fmt.duration(row.ms, "short")}
                            {row.share !== undefined ? ` · ${t("analyticsTalkShare", { share: fmt.percent(row.share) })}` : ""}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                }
              />

              <ChartCard
                title={t("analyticsActionItems")}
                description={
                  overview.actionItems.medianHoursToComplete !== null
                    ? `${t("analyticsMedianToComplete")}: ${fmt.duration(overview.actionItems.medianHoursToComplete * 3_600_000, "short")} · ${t("analyticsOverdue")}: ${fmt.number(overview.actionItems.overdue)}`
                    : `${t("analyticsOverdue")}: ${fmt.number(overview.actionItems.overdue)}`
                }
                empty={overview.actionItems.created === 0 ? t("analyticsActionsEmpty") : null}
                chart={
                  <ActionChart
                    data={overview.actionItems.series.map((point) => ({ label: bucketLabel(point.bucket), created: point.created, completed: point.completed }))}
                    labels={{ created: t("analyticsCreated"), completed: t("analyticsCompleted") }}
                  />
                }
                table={
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("analyticsPeriod")}</TableHead>
                        <TableHead>{t("analyticsCreated")}</TableHead>
                        <TableHead>{t("analyticsCompleted")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {overview.actionItems.series.map((point) => (
                        <TableRow key={point.bucket}>
                          <TableCell>
                            <time dateTime={point.bucket}>{bucketLabel(point.bucket)}</time>
                          </TableCell>
                          <TableCell className="tabular-nums">{fmt.number(point.created)}</TableCell>
                          <TableCell className="tabular-nums">{fmt.number(point.completed)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                }
              />
            </div>

            <ChartCard
              title={t("analyticsTopics")}
              empty={overview.topics.length === 0 ? t("analyticsTopicsEmpty") : null}
              chart={
                <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {overview.topics.map((topic, index) => (
                    <li key={topic.tag} className="grid gap-1 rounded-md border border-line p-3">
                      <div className="flex items-baseline justify-between gap-2">
                        <bdi className="truncate text-sm font-medium text-fg">{topic.tag}</bdi>
                        <span className="text-sm text-fg-2 tabular-nums">{fmt.number(topic.total)}</span>
                      </div>
                      <SparkBars
                        data={topic.series.map((point) => ({ label: point.bucket, count: point.count }))}
                        color={SPEAKER_COLORS[index % SPEAKER_COLORS.length]!}
                      />
                    </li>
                  ))}
                </ul>
              }
              table={
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("analyticsTag")}</TableHead>
                      <TableHead>{t("analyticsTotal")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {overview.topics.map((topic) => (
                      <TableRow key={topic.tag}>
                        <TableCell>
                          <bdi>{topic.tag}</bdi>
                        </TableCell>
                        <TableCell className="tabular-nums">{fmt.number(topic.total)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              }
            />
          </>
        )}
      </div>
    </main>
  )
}
