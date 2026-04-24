import { CheckCircle2Icon, CircleIcon } from "lucide-react"

import type { JobRecord, MeetingRecord } from "@/lib/meetings/repository"
import { MEETING_STATUS_FLOW } from "@/lib/meetings/state"

const pipeline = [
  ["media_uploaded", "Media uploaded"],
  ["transcribing", "Transcribing"],
  ["summarizing", "Summarizing"],
  ["indexing", "Indexing"],
  ["completed", "Completed"],
] as const

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

  return (
    <section className="rounded-md border bg-white p-4">
      <h3 className="mb-3 text-sm font-semibold">Pipeline</h3>
      <div className="grid gap-0">
        {pipeline.map(([status, label], index) => {
          const flowIndex = MEETING_STATUS_FLOW.indexOf(status)
          const done =
            meeting?.status === "completed" ||
            (flowIndex >= 0 && flowIndex <= currentIndex)

          return (
            <div key={status} className="grid grid-cols-[18px_minmax(0,1fr)] gap-3">
              <div className="flex flex-col items-center">
                {done ? (
                  <CheckCircle2Icon className="size-4 text-emerald-600" />
                ) : (
                  <CircleIcon className="size-4 text-emerald-500" />
                )}
                {index < pipeline.length - 1 && (
                  <span className="h-7 w-px bg-emerald-200" />
                )}
              </div>
              <div className="pb-3">
                <div className="text-sm font-medium text-slate-900">{label}</div>
                <div className="text-xs text-slate-500">
                  {latestJob?.updatedAt
                    ? new Date(latestJob.updatedAt).toLocaleString()
                    : "Waiting for job update"}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
