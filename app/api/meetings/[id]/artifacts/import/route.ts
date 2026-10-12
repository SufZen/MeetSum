import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"
import { resolveRequestWorkspaceSubject } from "@/lib/google/request-subject"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"

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

export const POST = withAuthz<{ id: string }>(
  "meeting:write",
  async (request, ctx, { params }) => {
    const { id } = await params
    const meeting = await ctx.meetings.getMeeting(id)

    if (!meeting) return jsonError("Meeting not found", 404)

    const body = (await request.json().catch(() => ({}))) as {
      artifactIds?: unknown
      subject?: string
    }
    const artifactIds = normalizeArtifactIds(body.artifactIds)
    const hasImportableArtifact = meeting.meetConferenceRecords?.some((record) =>
      record.artifacts.some((artifact) =>
        artifactIds?.length
          ? ["transcript", "smart_notes", "recording"].includes(artifact.artifactType) &&
            artifactIds.includes(artifact.id)
          : ["transcript", "smart_notes", "recording"].includes(artifact.artifactType)
      )
    )

    if (!hasImportableArtifact) {
      return NextResponse.json(
        {
          error:
            "This meeting has no linked Google Meet recording, transcript, or smart notes artifact yet. Sync Meet artifacts first, or upload a recording manually.",
          nextActions: ["sync_meet_artifacts", "find_drive_recordings", "upload_recording"],
        },
        { status: 409 }
      )
    }

    const resolved = resolveRequestWorkspaceSubject(ctx, body.subject)

    if ("response" in resolved) return resolved.response

    const job = await enqueueMeetSumJob("artifact.import", {
      meetingId: id,
      workspaceId: ctx.workspace.id,
      subject: resolved.subject,
      artifactIds,
      stage: "artifact.import",
      source: "google_meet_artifact",
    })

    return NextResponse.json(
      {
        job,
        mode: "meet-content-artifact",
        message:
          "Google Meet artifact import queued. MeetSum will import transcript entries, smart notes, or the linked recording and generate intelligence from them.",
      },
      { status: 202 }
    )
  }
)
