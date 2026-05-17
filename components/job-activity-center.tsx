import { RefreshCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import type { JobRecord, MeetingRecord } from "@/lib/meetings/repository"

const progressByStatus = {
  queued: 16,
  active: 58,
  completed: 100,
  failed: 100,
} as const

function jobStage(job: JobRecord) {
  if (typeof job.result.stage === "string") return job.result.stage
  if (typeof job.payload.stage === "string") return job.payload.stage

  return job.name
}

function formatJobTime(value?: string) {
  if (!value) return "unknown"
  const date = new Date(value)

  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString()
}

export function JobActivityCenter({
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
  const failedGroups = jobs
    .filter((job) => job.status === "failed" && job.meetingId)
    .reduce<Array<{ meetingId: string; meetingTitle: string; jobs: JobRecord[] }>>(
      (groups, job) => {
        const meetingId = job.meetingId!
        const group = groups.find((item) => item.meetingId === meetingId)
        const meetingTitle =
          meetings.find((meeting) => meeting.id === meetingId)?.title ??
          "Unknown meeting"

        if (group) {
          group.jobs.push(job)
          group.jobs.sort(
            (a, b) =>
              new Date(b.updatedAt ?? b.createdAt).getTime() -
              new Date(a.updatedAt ?? a.createdAt).getTime()
          )
        } else {
          groups.push({ meetingId, meetingTitle, jobs: [job] })
        }

        return groups
      },
      []
    )

  return (
    <section className="ms-card grid gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Job activity</h3>
        <span className="font-mono text-xs text-muted-foreground">
          {jobs.length}
        </span>
      </div>
      <div className="grid gap-2 rounded-lg border border-[var(--divider)] bg-[var(--surface-subtle)] p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h4 className="text-sm font-semibold">Processing recovery</h4>
            <p className="mt-1 text-xs text-muted-foreground">
              Failed meeting jobs are grouped here so a stale failure does not hide
              completed content.
            </p>
          </div>
          <span className="rounded-md bg-[var(--tag-action)] px-2 py-1 text-xs font-medium text-[var(--tag-action-fg)]">
            {failedGroups.length}
          </span>
        </div>
        {failedGroups.length ? (
          <div className="grid gap-2">
            {failedGroups.slice(0, 4).map((group) => {
              const latest = group.jobs[0]

              return (
                <article
                  key={group.meetingId}
                  className="rounded-md border border-[var(--divider)] bg-[var(--surface)] p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {group.meetingTitle}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-destructive">
                        {latest.error ?? "Processing failed without a stored error."}
                      </p>
                      <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                        {jobStage(latest)} · {latest.id} · updated{" "}
                        {formatJobTime(latest.updatedAt)}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-md border border-[var(--divider)] px-2 py-1 text-xs text-muted-foreground">
                      {group.jobs.length}
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {onOpenMeeting ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8"
                        onClick={() => onOpenMeeting(group.meetingId)}
                      >
                        Open
                      </Button>
                    ) : null}
                    {latest.retryable !== false ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8"
                        onClick={() => onRetry(latest)}
                      >
                        <RefreshCwIcon data-icon="inline-start" />
                        Retry latest
                      </Button>
                    ) : null}
                  </div>
                </article>
              )
            })}
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-[var(--divider)] bg-[var(--surface)] p-3 text-sm text-muted-foreground">
            No failed meeting jobs need recovery.
          </div>
        )}
      </div>
      <div className="ms-scrollbar grid max-h-72 gap-2 overflow-y-auto">
        {jobs.length ? (
          jobs.map((job) => (
            <article key={job.id} className="grid gap-2 rounded-lg border border-[var(--divider)] bg-[var(--surface-subtle)] p-3">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate font-medium">{job.name}</span>
                <span className="capitalize text-muted-foreground">
                  {job.status}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span>{jobStage(job)}</span>
                <span className="font-mono">{job.id}</span>
                <span>updated {formatJobTime(job.updatedAt)}</span>
              </div>
              <Progress value={progressByStatus[job.status]} />
              {job.error && (
                <p className="break-words text-xs leading-5 text-destructive">
                  {job.error}
                </p>
              )}
              {job.status === "failed" && job.retryable !== false && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 w-fit"
                  onClick={() => onRetry(job)}
                >
                  <RefreshCwIcon data-icon="inline-start" />
                  Retry
                </Button>
              )}
            </article>
          ))
        ) : (
          <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            No jobs yet. Upload, record, or sync Google Workspace to start the
            pipeline.
          </div>
        )}
      </div>
    </section>
  )
}
