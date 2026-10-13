import { RefreshCwIcon } from "lucide-react"

import { useI18n } from "@/components/i18n-provider"
import { JOB_STATUS_KEYS, stageLabel } from "@/components/pipeline-timeline"
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
  const { t, fmt } = useI18n()
  const jobTime = (value?: string) => (value ? fmt.date(value, "dateTime") : "") || t("opsJobsUnknownTime")
  const failedGroups = jobs
    .filter((job) => job.status === "failed" && job.meetingId)
    .reduce<Array<{ meetingId: string; meetingTitle: string; jobs: JobRecord[] }>>(
      (groups, job) => {
        const meetingId = job.meetingId!
        const group = groups.find((item) => item.meetingId === meetingId)
        const meetingTitle =
          meetings.find((meeting) => meeting.id === meetingId)?.title ??
          t("opsUnknownMeeting")

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
        <h3 className="text-sm font-semibold">{t("opsJobsTitle")}</h3>
        <span className="font-mono text-xs text-muted-foreground">
          {jobs.length}
        </span>
      </div>
      <div className="grid gap-2 rounded-lg border border-line bg-surface-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h4 className="text-sm font-semibold">{t("opsJobsRecoveryTitle")}</h4>
            <p className="mt-1 text-xs text-muted-foreground">{t("opsJobsRecoveryHint")}</p>
          </div>
          <span className="rounded-md bg-warn-soft px-2 py-1 text-xs font-medium text-warn-text">
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
                  className="rounded-md border border-line bg-surface p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        <bdi>{group.meetingTitle}</bdi>
                      </div>
                      <p dir="auto" className="mt-1 line-clamp-2 text-xs leading-5 text-destructive">
                        {latest.error ?? t("opsJobsFailedNoError")}
                      </p>
                      <p className="mt-1 text-2xs leading-5 text-muted-foreground">
                        {stageLabel(jobStage(latest), t)} · <bdi className="font-mono">{latest.id}</bdi> ·{" "}
                        {t("opsJobsUpdated", { time: jobTime(latest.updatedAt) })}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-md border border-line px-2 py-1 text-xs text-muted-foreground">
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
                        {t("opsJobsOpen")}
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
                        {t("opsJobsRetryLatest")}
                      </Button>
                    ) : null}
                  </div>
                </article>
              )
            })}
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-line bg-surface p-3 text-sm text-muted-foreground">
            {t("opsJobsNoFailed")}
          </div>
        )}
      </div>
      <div className="ms-scrollbar grid max-h-72 gap-2 overflow-y-auto">
        {jobs.length ? (
          jobs.map((job) => (
            <article key={job.id} className="grid gap-2 rounded-lg border border-line bg-surface-2 p-3">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate font-medium">{job.name}</span>
                <span className="text-muted-foreground">
                  {t(JOB_STATUS_KEYS[job.status])}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
                <span>{stageLabel(jobStage(job), t)}</span>
                <bdi className="font-mono">{job.id}</bdi>
                <span>{t("opsJobsUpdated", { time: jobTime(job.updatedAt) })}</span>
              </div>
              <Progress value={progressByStatus[job.status]} />
              {job.error && (
                <p dir="auto" className="break-words text-xs leading-5 text-destructive">
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
                  {t("retry")}
                </Button>
              )}
            </article>
          ))
        ) : (
          <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            {t("opsJobsEmpty")}
          </div>
        )}
      </div>
    </section>
  )
}
