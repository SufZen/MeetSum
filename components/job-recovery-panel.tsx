import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  RefreshCwIcon,
} from "lucide-react"
import { useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { JobRecord, MeetingRecord } from "@/lib/meetings/repository"

type StageGroup = {
  stage: string
  errorPattern: string
  jobs: Array<{
    job: JobRecord
    meetingTitle: string
  }>
}

function formatJobTime(value?: string) {
  if (!value) return "unknown"
  const date = new Date(value)

  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString()
}

function jobStage(job: JobRecord): string {
  if (typeof job.result.stage === "string") return job.result.stage
  if (typeof job.payload.stage === "string") return job.payload.stage

  return job.name
}

function normalizeError(error?: string | null): string {
  if (!error) return "Unknown error"

  const lower = error.toLowerCase()

  // Collapse common error categories for grouping
  if (lower.includes("timeout") || lower.includes("etimedout")) return "Timeout"
  if (lower.includes("econnrefused") || lower.includes("enotfound"))
    return "Connection refused"
  if (lower.includes("401") || lower.includes("403") || lower.includes("auth"))
    return "Authentication error"
  if (lower.includes("rate limit") || lower.includes("429")) return "Rate limited"
  if (lower.includes("500") || lower.includes("502") || lower.includes("503"))
    return "Server error"

  // Truncate long errors to first meaningful sentence
  const firstLine = error.split("\n")[0]
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine
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
    const meetingTitle =
      meetingMap.get(job.meetingId!)?.title ?? "Unknown meeting"

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

function StageGroupCard({
  group,
  onRetry,
  onOpenMeeting,
}: {
  group: StageGroup
  onRetry: (job: JobRecord) => void
  onOpenMeeting?: (meetingId: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const displayed = expanded ? group.jobs : group.jobs.slice(0, 2)
  const hasMore = group.jobs.length > 2

  return (
    <div className="rounded-lg border border-[var(--divider)] bg-[var(--surface-subtle)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <AlertTriangleIcon
              aria-hidden="true"
              className="size-4 shrink-0 text-destructive"
            />
            <span className="text-sm font-semibold text-foreground">
              {group.stage}
            </span>
          </div>
          <p className="mt-1 text-xs leading-5 text-destructive">
            {group.errorPattern}
          </p>
        </div>
        <Badge
          variant="outline"
          className="shrink-0 rounded-md border-destructive/50 text-destructive"
        >
          {group.jobs.length} failed
        </Badge>
      </div>

      <div className="mt-3 grid gap-2">
        {displayed.map(({ job, meetingTitle }) => (
          <div
            key={job.id}
            className="rounded-md border border-[var(--divider)] bg-[var(--surface)] p-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {meetingTitle}
                </div>
                <div className="mt-1 text-[11px] leading-5 text-muted-foreground">
                  {job.id} · updated {formatJobTime(job.updatedAt)}
                </div>
                {job.error && job.error !== group.errorPattern ? (
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-destructive">
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
                  Open
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
                  Retry
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
              Show fewer
            </>
          ) : (
            <>
              <ChevronDownIcon data-icon="inline-start" />
              Show {group.jobs.length - 2} more
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
  onOpenMeeting,
}: {
  jobs: JobRecord[]
  meetings?: MeetingRecord[]
  onRetry: (job: JobRecord) => void
  onOpenMeeting?: (meetingId: string) => void
}) {
  const stageGroups = groupFailedJobsByStageAndError(jobs, meetings)
  const totalFailed = stageGroups.reduce(
    (total, group) => total + group.jobs.length,
    0
  )

  return (
    <section className="ms-card grid gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Job recovery</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Failed jobs grouped by processing stage and error type for fast triage.
          </p>
        </div>
        <Badge
          variant={totalFailed > 0 ? "destructive" : "secondary"}
          className="rounded-md"
        >
          {totalFailed} failed
        </Badge>
      </div>

      {stageGroups.length ? (
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
        <div className="rounded-md border border-dashed border-[var(--divider)] bg-[var(--surface-subtle)] p-4 text-sm text-muted-foreground">
          No failed jobs need recovery. All processing pipelines are healthy.
        </div>
      )}
    </section>
  )
}
