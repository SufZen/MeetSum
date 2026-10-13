import {
  AlertTriangleIcon,
  ArchiveIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  LayoutListIcon,
  RefreshCwIcon,
  UsersIcon,
} from "lucide-react"
import { useState } from "react"

import { useI18n } from "@/components/i18n-provider"
import { stageLabel } from "@/components/pipeline-timeline"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { JobRecord, MeetingRecord } from "@/lib/meetings/repository"

type StageGroup = {
  stage: string
  /** An error category id (see `ERROR_CATEGORY_KEYS`) or the error's first line. */
  errorPattern: string
  jobs: Array<{
    job: JobRecord
    /** Empty when the meeting is unknown (rendered as "Unknown meeting"). */
    meetingTitle: string
  }>
}

type MeetingGroup = {
  meetingId: string
  /** Empty when the meeting is unknown (rendered as "Unknown meeting"). */
  meetingTitle: string
  meetingStatus?: MeetingRecord["status"]
  jobs: JobRecord[]
  latestStage: string
  latestError: string
  latestAt: string
}

type GroupMode = "stage" | "meeting"

/** Error categories used for grouping, and their message keys. */
export const ERROR_CATEGORY_KEYS: Record<string, string> = {
  timeout: "opsJobErrTimeout",
  connection: "opsJobErrConnection",
  auth: "opsJobErrAuth",
  rateLimit: "opsJobErrRateLimit",
  server: "opsJobErrServer",
  unknown: "opsJobErrUnknown",
}

function errorPatternLabel(pattern: string, t: (key: string) => string): string {
  const key = ERROR_CATEGORY_KEYS[pattern]

  return key ? t(key) : pattern
}

function jobStage(job: JobRecord): string {
  if (typeof job.result.stage === "string") return job.result.stage
  if (typeof job.payload.stage === "string") return job.payload.stage

  return job.name
}

function normalizeError(error?: string | null): string {
  if (!error) return "unknown"

  const lower = error.toLowerCase()

  // Collapse common error categories for grouping
  if (lower.includes("timeout") || lower.includes("etimedout")) return "timeout"
  if (lower.includes("econnrefused") || lower.includes("enotfound"))
    return "connection"
  if (lower.includes("401") || lower.includes("403") || lower.includes("auth"))
    return "auth"
  if (lower.includes("rate limit") || lower.includes("429")) return "rateLimit"
  if (lower.includes("500") || lower.includes("502") || lower.includes("503"))
    return "server"

  // Truncate long errors to first meaningful sentence
  const firstLine = error.split("\n")[0]
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine
}

export function groupFailedJobsByStageAndError(
  jobs: JobRecord[],
  meetings: MeetingRecord[]
): StageGroup[] {
  const failedJobs = jobs.filter(
    (job) => job.status === "failed" && job.meetingId
  )
  const meetingMap = new Map(meetings.map((meeting) => [meeting.id, meeting]))
  const groupMap = new Map<string, StageGroup>()

  for (const job of failedJobs) {
    const stage = jobStage(job)
    const errorPattern = normalizeError(job.error)
    const groupKey = `${stage}::${errorPattern}`
    const meetingTitle = meetingMap.get(job.meetingId!)?.title ?? ""

    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, {
        stage,
        errorPattern,
        jobs: [],
      })
    }

    groupMap.get(groupKey)!.jobs.push({ job, meetingTitle })
  }

  // Sort: most recent failures first
  const groups = [...groupMap.values()]
  for (const group of groups) {
    group.jobs.sort(
      (a, b) =>
        new Date(b.job.updatedAt ?? b.job.createdAt).getTime() -
        new Date(a.job.updatedAt ?? a.job.createdAt).getTime()
    )
  }

  groups.sort((a, b) => {
    const aTime = new Date(
      a.jobs[0].job.updatedAt ?? a.jobs[0].job.createdAt
    ).getTime()
    const bTime = new Date(
      b.jobs[0].job.updatedAt ?? b.jobs[0].job.createdAt
    ).getTime()

    return bTime - aTime
  })

  return groups
}

export function groupFailedJobsByMeeting(
  jobs: JobRecord[],
  meetings: MeetingRecord[]
): MeetingGroup[] {
  const failedJobs = jobs.filter(
    (job) => job.status === "failed" && job.meetingId
  )
  const meetingMap = new Map(meetings.map((meeting) => [meeting.id, meeting]))
  const groupMap = new Map<string, MeetingGroup>()

  for (const job of failedJobs) {
    const meetingId = job.meetingId!
    const meeting = meetingMap.get(meetingId)

    if (!groupMap.has(meetingId)) {
      groupMap.set(meetingId, {
        meetingId,
        meetingTitle: meeting?.title ?? "",
        meetingStatus: meeting?.status,
        jobs: [],
        latestStage: "",
        latestError: "",
        latestAt: "",
      })
    }

    groupMap.get(meetingId)!.jobs.push(job)
  }

  // For each meeting group, find the latest failed job and set summary fields
  const groups = [...groupMap.values()]
  for (const group of groups) {
    group.jobs.sort(
      (a, b) =>
        new Date(b.updatedAt ?? b.createdAt).getTime() -
        new Date(a.updatedAt ?? a.createdAt).getTime()
    )
    const latest = group.jobs[0]
    group.latestStage = jobStage(latest)
    group.latestError = normalizeError(latest.error)
    group.latestAt = latest.updatedAt ?? latest.createdAt
  }

  // Filter out meetings that already completed (stale failures)
  // but still show them with a dimmed indicator
  groups.sort(
    (a, b) => new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime()
  )

  return groups
}

function StageGroupCard({
  group,
  onRetry,
  onOpenMeeting,
}: {
  group: StageGroup
  onRetry: (job: JobRecord) => void
  onOpenMeeting?: (meetingId: string) => void
}) {
  const { t, plural, fmt } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const displayed = expanded ? group.jobs : group.jobs.slice(0, 2)
  const hasMore = group.jobs.length > 2

  return (
    <div className="rounded-lg border border-line bg-surface-2 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <AlertTriangleIcon
              aria-hidden="true"
              className="size-4 shrink-0 text-destructive"
            />
            <span className="text-sm font-semibold text-foreground">
              {stageLabel(group.stage, t)}
            </span>
          </div>
          <p dir="auto" className="mt-1 text-xs leading-5 text-destructive">
            {errorPatternLabel(group.errorPattern, t)}
          </p>
        </div>
        <Badge
          variant="outline"
          className="shrink-0 rounded-md border-destructive/50 text-destructive"
        >
          {plural("opsRecoveryFailedCount", group.jobs.length)}
        </Badge>
      </div>

      <div className="mt-3 grid gap-2">
        {displayed.map(({ job, meetingTitle }) => (
          <div
            key={job.id}
            className="rounded-md border border-line bg-surface p-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  <bdi>{meetingTitle || t("opsUnknownMeeting")}</bdi>
                </div>
                <div className="mt-1 text-2xs leading-5 text-muted-foreground">
                  <bdi className="font-mono">{job.id}</bdi> ·{" "}
                  {t("opsJobsUpdated", {
                    time: (job.updatedAt ? fmt.date(job.updatedAt, "dateTime") : "") || t("opsJobsUnknownTime"),
                  })}
                </div>
                {job.error && job.error !== group.errorPattern ? (
                  <p dir="auto" className="mt-1 line-clamp-2 text-xs leading-5 text-destructive">
                    {job.error}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {onOpenMeeting && job.meetingId ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  onClick={() => onOpenMeeting(job.meetingId!)}
                >
                  {t("opsJobsOpen")}
                </Button>
              ) : null}
              {job.retryable !== false ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  onClick={() => onRetry(job)}
                >
                  <RefreshCwIcon data-icon="inline-start" />
                  {t("retry")}
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      {hasMore ? (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 h-7 w-full text-xs"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <>
              <ChevronUpIcon data-icon="inline-start" />
              {t("opsRecoveryShowFewer")}
            </>
          ) : (
            <>
              <ChevronDownIcon data-icon="inline-start" />
              {plural("opsRecoveryShowMore", group.jobs.length - 2)}
            </>
          )}
        </Button>
      ) : null}
    </div>
  )
}

function MeetingGroupCard({
  group,
  onRetry,
  onArchive,
  onOpenMeeting,
}: {
  group: MeetingGroup
  onRetry: (job: JobRecord) => void
  onArchive?: (meetingId: string) => void
  onOpenMeeting?: (meetingId: string) => void
}) {
  const { t, plural, fmt } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const isStale = group.meetingStatus === "completed"
  const retryableJobs = group.jobs.filter((job) => job.retryable !== false)

  return (
    <div
      className={`rounded-lg border p-4 ${
        isStale
          ? "border-line bg-surface-2 opacity-60"
          : "border-line bg-surface-2"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <AlertTriangleIcon
              aria-hidden="true"
              className="size-4 shrink-0 text-destructive"
            />
            <span className="truncate text-sm font-semibold text-foreground">
              <bdi>{group.meetingTitle || t("opsUnknownMeeting")}</bdi>
            </span>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t("opsRecoveryLastFailedStage")}{" "}
            <span className="font-medium text-destructive">{stageLabel(group.latestStage, t)}</span>
            {" · "}
            <bdi>{errorPatternLabel(group.latestError, t)}</bdi>
          </p>
          {isStale ? (
            <p className="mt-1 text-xs leading-5 text-ok-text">
              {t("opsRecoveryStale")}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge
            variant="outline"
            className="rounded-md border-destructive/50 text-destructive"
          >
            {plural("opsRecoveryFailedCount", group.jobs.length)}
          </Badge>
          {isStale ? (
            <Badge variant="outline" className="rounded-md border-ok text-ok-text">
              {t("opsMeetingStatusCompleted")}
            </Badge>
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {onOpenMeeting ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            onClick={() => onOpenMeeting(group.meetingId)}
          >
            {t("opsRecoveryOpenMeeting")}
          </Button>
        ) : null}
        {retryableJobs.length > 0 && !isStale ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            onClick={() => {
              // Retry the most recent failed job for this meeting
              onRetry(retryableJobs[0])
            }}
          >
            <RefreshCwIcon data-icon="inline-start" />
            {t("opsJobsRetryLatest")}
          </Button>
        ) : null}
        {onArchive && isStale ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-muted-foreground"
            onClick={() => onArchive(group.meetingId)}
          >
            <ArchiveIcon data-icon="inline-start" />
            {t("opsRecoveryDismiss")}
          </Button>
        ) : null}
      </div>

      {expanded ? (
        <div className="mt-3 grid gap-2">
          {group.jobs.map((job) => (
            <div
              key={job.id}
              className="rounded-md border border-line bg-surface p-2 text-xs"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{stageLabel(jobStage(job), t)}</span>
                <span className="text-muted-foreground">
                  {(job.updatedAt ? fmt.date(job.updatedAt, "dateTime") : "") || t("opsJobsUnknownTime")}
                </span>
              </div>
              {job.error ? (
                <p dir="auto" className="mt-1 line-clamp-2 text-destructive">
                  {job.error}
                </p>
              ) : null}
              {job.retryable !== false && !isStale ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-1 h-6 text-xs"
                  onClick={() => onRetry(job)}
                >
                  <RefreshCwIcon data-icon="inline-start" />
                  {t("retry")}
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {group.jobs.length > 1 ? (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 h-7 w-full text-xs"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <>
              <ChevronUpIcon data-icon="inline-start" />
              {t("opsRecoveryHideJobs")}
            </>
          ) : (
            <>
              <ChevronDownIcon data-icon="inline-start" />
              {plural("opsRecoveryShowJobs", group.jobs.length)}
            </>
          )}
        </Button>
      ) : null}
    </div>
  )
}

export function JobRecoveryPanel({
  jobs,
  meetings = [],
  onRetry,
  onRetryAll,
  onArchive,
  onOpenMeeting,
}: {
  jobs: JobRecord[]
  meetings?: MeetingRecord[]
  onRetry: (job: JobRecord) => void
  onRetryAll?: () => void
  onArchive?: (meetingId: string) => void
  onOpenMeeting?: (meetingId: string) => void
}) {
  const { t, plural } = useI18n()
  const [groupMode, setGroupMode] = useState<GroupMode>("meeting")
  const stageGroups = groupFailedJobsByStageAndError(jobs, meetings)
  const meetingGroups = groupFailedJobsByMeeting(jobs, meetings)
  const totalFailed = stageGroups.reduce(
    (total, group) => total + group.jobs.length,
    0
  )
  const activeFailedMeetings = meetingGroups.filter(
    (g) => g.meetingStatus !== "completed"
  ).length

  return (
    <section className="ms-card grid gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{t("opsRecoveryTitle")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {groupMode === "meeting"
              ? `${plural("opsRecoveryNeedAttention", activeFailedMeetings)} · ${plural("opsRecoveryTotalFailed", totalFailed)}`
              : t("opsRecoveryStageHint")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            title={groupMode === "meeting" ? t("opsRecoveryGroupByStage") : t("opsRecoveryGroupByMeeting")}
            onClick={() => setGroupMode(groupMode === "meeting" ? "stage" : "meeting")}
          >
            {groupMode === "meeting" ? (
              <LayoutListIcon data-icon="inline-start" />
            ) : (
              <UsersIcon data-icon="inline-start" />
            )}
            {groupMode === "meeting" ? t("opsRecoveryByStage") : t("opsRecoveryByMeeting")}
          </Button>
          {onRetryAll && totalFailed > 0 ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={onRetryAll}
            >
              <RefreshCwIcon data-icon="inline-start" />
              {t("opsRecoveryRetryAll")}
            </Button>
          ) : null}
          <Badge
            variant={totalFailed > 0 ? "destructive" : "secondary"}
            className="rounded-md"
          >
            {plural("opsRecoveryFailedCount", totalFailed)}
          </Badge>
        </div>
      </div>

      {groupMode === "stage" ? (
        stageGroups.length ? (
          <div className="grid gap-2">
            {stageGroups.map((group) => (
              <StageGroupCard
                key={`${group.stage}::${group.errorPattern}`}
                group={group}
                onRetry={onRetry}
                onOpenMeeting={onOpenMeeting}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-line bg-surface-2 p-4 text-sm text-muted-foreground">
            {t("opsRecoveryNoFailed")}
          </div>
        )
      ) : meetingGroups.length ? (
        <div className="grid gap-2">
          {meetingGroups.map((group) => (
            <MeetingGroupCard
              key={group.meetingId}
              group={group}
              onRetry={onRetry}
              onArchive={onArchive}
              onOpenMeeting={onOpenMeeting}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-line bg-surface-2 p-4 text-sm text-muted-foreground">
          {t("opsRecoveryNoFailed")}
        </div>
      )}
    </section>
  )
}
