import { NextResponse } from "next/server"

import { jsonError, requireAppAccess } from "@/lib/api/responses"
import { getWorkspaceSubject } from "@/lib/google/auth"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"
import { meetingRepository } from "@/lib/meetings/store"

function normalizeArtifactIds(value: unknown) {
  if (!Array.isArray(value)) return undefined

  const ids = [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    ),
  ]

  return ids.length ? ids : undefined
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAppAccess(request)

  if (unauthorized) return unauthorized

  const { id } = await params
  const meeting = await meetingRepository.getMeeting(id)

  if (!meeting) return jsonError("Meeting not found", 404)

  const body = (await request.json().catch(() => ({}))) as {
    artifactIds?: unknown
    subject?: string
  }
  const artifactIds = normalizeArtifactIds(body.artifactIds)
  const hasContentArtifact = meeting.meetConferenceRecords?.some((record) =>
    record.artifacts.some((artifact) =>
      artifactIds?.length
        ? ["transcript", "smart_notes"].includes(artifact.artifactType) &&
          artifactIds.includes(artifact.id)
        : ["transcript", "smart_notes"].includes(artifact.artifactType)
    )
  )

  if (!hasContentArtifact) {
    return NextResponse.json(
      {
        error:
          "This meeting has no linked Google Meet transcript or smart notes artifact yet. Sync Meet artifacts first, or import the Drive recording if only a recording artifact is available.",
        nextActions: ["sync_meet_artifacts", "find_drive_recordings", "upload_recording"],
      },
      { status: 409 }
    )
  }

  const job = await enqueueMeetSumJob("artifact.import", {
    meetingId: id,
    subject: body.subject ?? getWorkspaceSubject(),
    artifactIds,
    stage: "artifact.import",
    source: "google_meet_artifact",
  })

  return NextResponse.json(
    {
      job,
      mode: "meet-content-artifact",
      message:
        "Google Meet artifact import queued. MeetSum will import transcript entries or smart notes and generate intelligence from them.",
    },
    { status: 202 }
  )
}
