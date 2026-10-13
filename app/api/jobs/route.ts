import { NextResponse } from "next/server"

import { withAuthz } from "@/lib/auth/authz"
import { getDictionary } from "@/lib/i18n/dictionaries"
import type { JobRecord, JobStatus } from "@/lib/meetings/repository"
import { meetingStageMessageKey } from "@/lib/meetings/work-status"

const STAGE_PROGRESS: Record<string, number> = {
  "audio.transcribe": 0.35,
  "summary.generate": 0.65,
  // M6: the summarize path's persist step (was the inline "meeting.index").
  "summary.persist": 0.7,
  "meeting.index": 0.85,
}

/** API compatibility: stage titles from the dictionaries (gender-neutral Hebrew). */
function stageTitle(stage: string, locale: "he" | "en"): string | undefined {
  const key = meetingStageMessageKey(stage)

  return key ? (getDictionary(locale) as Record<string, string>)[key] : undefined
}

function serializeJob(job: JobRecord) {
  const stage =
    typeof job.result.stage === "string"
      ? job.result.stage
      : typeof job.payload.stage === "string"
        ? job.payload.stage
        : job.name

  return {
    ...job,
    stage,
    stageTitle: stageTitle(stage, "en"),
    stageTitleHe: stageTitle(stage, "he"),
    progress:
      job.status === "completed"
        ? 1
        : job.status === "failed"
          ? 0
          : (STAGE_PROGRESS[stage] ?? 0.15),
  }
}

export const GET = withAuthz("jobs:read", async (request, ctx) => {
  const url = new URL(request.url)
  const meetingId = url.searchParams.get("meetingId") ?? undefined
  const status = url.searchParams.get("status") as JobStatus | null

  const jobs = await ctx.meetings.listJobs({
    meetingId,
    status: status ?? undefined,
  })

  return NextResponse.json({ jobs: jobs.map(serializeJob) })
})
