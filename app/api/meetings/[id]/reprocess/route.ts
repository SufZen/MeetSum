import { NextResponse } from "next/server"

import {
  loadVisibleMeeting,
  meetingNotFound,
} from "@/app/api/_lib/meeting-access"
import { withAuthz } from "@/lib/auth/authz"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"
import { createPlatformEvent } from "@/lib/platform/events"

const modes = ["full", "summary", "tasks", "transcript-cleanup"] as const
type ReprocessMode = (typeof modes)[number]

function parseMode(value: unknown): ReprocessMode {
  return modes.includes(value as ReprocessMode)
    ? (value as ReprocessMode)
    : "full"
}

export const POST = withAuthz<{ id: string }>(
  "meeting:write",
  async (request, ctx, { params }) => {
    const { id } = await params
    const meeting = await loadVisibleMeeting(ctx, id)

    if (!meeting) return meetingNotFound()

    const body = (await request.json().catch(() => ({}))) as { mode?: unknown }
    const mode = parseMode(body.mode)
    const workspaceId = ctx.workspace.id
    const hasMedia = Boolean(
      meeting.mediaAssets?.some((asset) => asset.storageKey)
    )
    const hasTranscript = Boolean(meeting.transcript?.length)
    const hasMeetImportableArtifact = meeting.meetConferenceRecords?.some(
      (record) =>
        record.artifacts.some((artifact) =>
          ["transcript", "smart_notes", "recording"].includes(
            artifact.artifactType
          )
        )
    )

    if (mode === "full" && !hasMedia && !hasMeetImportableArtifact) {
      return NextResponse.json(
        {
          error:
            "This meeting has no recording attached yet. Import a Drive recording, sync Meet artifacts, or upload audio before full reprocessing.",
          nextActions: [
            "find_drive_recordings",
            "upload_recording",
            "sync_meet_artifacts",
          ],
        },
        { status: 409 }
      )
    }

    if (mode === "full" && !hasMedia && hasMeetImportableArtifact) {
      const job = await enqueueMeetSumJob("artifact.import", {
        meetingId: id,
        workspaceId,
        mode,
        stage: "artifact.import",
        source: "reprocess",
      })

      return NextResponse.json(
        {
          job,
          mode: "meet-content-artifact",
          event: createPlatformEvent("summary.created", {
            meetingId: id,
            mode,
          }),
        },
        { status: 202 }
      )
    }

    if (mode !== "full" && !hasTranscript) {
      return NextResponse.json(
        {
          error:
            "This meeting has no transcript yet. Attach or import a recording before rerunning summary or task extraction.",
          nextActions: [
            "find_drive_recordings",
            "upload_recording",
            "sync_meet_artifacts",
          ],
        },
        { status: 409 }
      )
    }

    const job = await enqueueMeetSumJob(
      mode === "full" ? "media.ingest" : "meeting.summarize",
      {
        meetingId: id,
        workspaceId,
        mode,
        stage: mode,
      }
    )

    return NextResponse.json(
      {
        job,
        mode,
        event: createPlatformEvent("summary.created", { meetingId: id, mode }),
      },
      { status: 202 }
    )
  }
)
