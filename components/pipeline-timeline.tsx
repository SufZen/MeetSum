import { CheckCircle2Icon, CircleIcon } from "lucide-react"

import type { JobRecord, MeetingRecord } from "@/lib/meetings/repository"
import { MEETING_STATUS_FLOW } from "@/lib/meetings/state"

const pipeline = [
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

export function PipelineTimeline({
  meeting,
  jobs,
}: {
  meeting: MeetingRecord | null
  jobs: JobRecord[]
}) {
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
  const latestJobLabel = latestJob?.updatedAt
    ? new Date(latestJob.updatedAt).toLocaleString()
    : "Waiting for job update"

  return (
    <section className="rounded-md border bg-white p-4">
      <h3 className="mb-3 text-sm font-semibold">Pipeline</h3>
      <div className="grid gap-0">
        {pipeline.map(([status, label], index) => {
          const flowIndex = MEETING_STATUS_FLOW.indexOf(status as MeetingRecord["status"])
          const done =
            meeting?.status === "completed" ||
            legacyStatusByStage[status]?.includes(meeting?.status ?? "created") ||
            (flowIndex >= 0 && flowIndex <= currentIndex)
          const active = activeStage === status

          return (
            <div key={status} className="grid grid-cols-[18px_minmax(0,1fr)] gap-3">
              <div className="flex flex-col items-center">
                {done ? (
                  <CheckCircle2Icon className="size-4 text-emerald-600" />
                ) : (
                  <CircleIcon className={active ? "size-4 text-amber-500" : "size-4 text-emerald-500"} />
                )}
                {index < pipeline.length - 1 && (
                  <span className="h-6 w-px bg-emerald-200" />
                )}
              </div>
              <div className="pb-2">
                <div className="text-sm font-medium text-slate-900">{label}</div>
                <div className="text-xs text-slate-500">
                  {active ? (latestJob?.status ?? "active") : latestJobLabel}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
