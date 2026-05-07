import { CheckCircle2Icon, CircleIcon } from "lucide-react"

import type { JobRecord, MeetingRecord } from "@/lib/meetings/repository"
import { MEETING_STATUS_FLOW } from "@/lib/meetings/state"
import { getMeetingWorkStatus } from "@/lib/meetings/work-status"

const pipeline = [
  ["artifact.import", "Artifact import"],
  ["drive.import", "Drive import"],
  ["audio.extract", "Audio extracted"],
  ["transcribing", "Audio transcription"],
  ["transcript.clean", "Transcript cleanup"],
  ["summarizing", "Summary generated"],
  ["tasks.extract", "Tasks extracted"],
  ["indexing", "Meeting indexed"],
  ["quality.review", "Quality review"],
  ["completed", "Completed"],
] as const

const legacyStatusByStage: Record<string, MeetingRecord["status"][]> = {
  "artifact.import": ["transcribing", "summarizing", "indexing", "completed"],
  "drive.import": ["media_uploaded", "transcribing", "summarizing", "indexing", "completed"],
  "audio.extract": ["media_uploaded", "transcribing", "summarizing", "indexing", "completed"],
  transcribing: ["transcribing", "summarizing", "indexing", "completed"],
  "transcript.clean": ["summarizing", "indexing", "completed"],
  summarizing: ["summarizing", "indexing", "completed"],
  "tasks.extract": ["indexing", "completed"],
  indexing: ["indexing", "completed"],
  "quality.review": ["completed"],
  completed: ["completed"],
}

const stageAliases: Record<string, string> = {
  "audio.transcribe": "transcribing",
  "summary.generate": "summarizing",
  "meeting.index": "indexing",
}

export function PipelineTimeline({
  meeting,
  jobs,
}: {
  meeting: MeetingRecord | null
  jobs: JobRecord[]
}) {
  const workStatus = meeting ? getMeetingWorkStatus(meeting, jobs) : undefined
  const currentIndex = meeting
    ? Math.max(0, MEETING_STATUS_FLOW.indexOf(meeting.status))
    : 0
  const latestJob = jobs.find((job) => job.meetingId === meeting?.id)
  const activeStage =
    typeof latestJob?.payload.stage === "string"
      ? latestJob.payload.stage
      : typeof latestJob?.result.stage === "string"
        ? latestJob.result.stage
        : undefined
  const normalizedActiveStage = activeStage
    ? (stageAliases[activeStage] ?? activeStage)
    : undefined
  const latestJobLabel = latestJob?.updatedAt
    ? new Date(latestJob.updatedAt).toLocaleString()
    : "Waiting for job update"

  return (
    <section className="ms-card p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Pipeline</h3>
          {workStatus ? (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {workStatus.title}
            </p>
          ) : null}
        </div>
        {workStatus?.kind === "failed" ? (
          <span className="rounded-md bg-[var(--tag-action)] px-2 py-1 text-[11px] font-medium text-[var(--tag-action-fg)]">
            failed
          </span>
        ) : null}
      </div>
      {workStatus?.kind === "processing" && typeof workStatus.progress === "number" ? (
        <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-[var(--surface-subtle)]">
          <div
            className="h-full rounded-full bg-[var(--primary)]"
            style={{ width: `${Math.round(workStatus.progress * 100)}%` }}
          />
        </div>
      ) : null}
      <div className="grid gap-0">
        {pipeline.map(([status, label], index) => {
          const flowIndex = MEETING_STATUS_FLOW.indexOf(status as MeetingRecord["status"])
          const done =
            meeting?.status === "completed" ||
            legacyStatusByStage[status]?.includes(meeting?.status ?? "created") ||
            (flowIndex >= 0 && flowIndex <= currentIndex)
          const active = normalizedActiveStage === status

          return (
            <div key={status} className="grid grid-cols-[18px_minmax(0,1fr)] gap-3">
              <div className="flex flex-col items-center">
                {done ? (
                  <CheckCircle2Icon className="size-4 text-emerald-600" />
                ) : (
                  <CircleIcon className={active ? "size-4 text-amber-500" : "size-4 text-emerald-500"} />
                )}
                {index < pipeline.length - 1 && (
                  <span className="h-6 w-px bg-[var(--divider)]" />
                )}
              </div>
              <div className="pb-2">
                <div className="text-sm font-medium text-foreground">{label}</div>
                <div className="text-xs text-muted-foreground">
                  {latestJob?.status === "failed" && active
                    ? latestJob.error ?? "Failed"
                    : active
                      ? (latestJob?.status ?? "active")
                      : latestJobLabel}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
