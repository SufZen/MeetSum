import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api/responses"
import { withAuthz } from "@/lib/auth/authz"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"
import type { MeetingRecord } from "@/lib/meetings/repository"
import { getAppSettings } from "@/lib/settings/app-settings"

const ARTIFACT_IMPORT_MESSAGE =
  "Google Meet artifact import queued. MeetSum will import transcript entries, smart notes, or the linked recording and generate intelligence from them."

function hasArtifact(meeting: MeetingRecord, types: readonly string[]) {
  return Boolean(
    meeting.meetConferenceRecords?.some((record) =>
      record.artifacts.some((artifact) => types.includes(artifact.artifactType))
    )
  )
}

export const POST = withAuthz<{ id: string }>(
  "meeting:write",
  async (_request, ctx, { params }) => {
    const { id } = await params
    const meeting = await ctx.meetings.getMeeting(id)

    if (!meeting) return jsonError("Meeting not found", 404)

    const workspaceId = ctx.workspace.id
    const mediaAsset = meeting.mediaAssets?.find((asset) => asset.storageKey)
    const hasTranscript = Boolean(meeting.transcript?.length)
    const hasMeetImportableArtifact = hasArtifact(meeting, [
      "transcript",
      "smart_notes",
      "recording",
    ])
    const settings = await getAppSettings(workspaceId)

    const queueArtifactImport = async () => {
      const job = await enqueueMeetSumJob("artifact.import", {
        meetingId: id,
        workspaceId,
        stage: "artifact.import",
        source: "manual-process",
      })

      return NextResponse.json(
        { job, mode: "meet-content-artifact", message: ARTIFACT_IMPORT_MESSAGE },
        { status: 202 }
      )
    }

    // googleArtifactsFirst: Google's own transcript/smart notes beat running
    // ASR on the recording, as long as the meeting has no transcript yet.
    if (
      settings.googleArtifactsFirst &&
      !hasTranscript &&
      hasArtifact(meeting, ["transcript", "smart_notes"])
    ) {
      return queueArtifactImport()
    }

    if (mediaAsset) {
      const job = await enqueueMeetSumJob("media.ingest", {
        meetingId: id,
        workspaceId,
        assetId: mediaAsset.id,
        storageKey: mediaAsset.storageKey,
        stage: "audio.transcribe",
        source: "manual-process",
      })

      return NextResponse.json(
        {
          job,
          mode: "media",
          message: "Processing queued from the attached recording.",
        },
        { status: 202 }
      )
    }

    if (hasTranscript) {
      const job = await enqueueMeetSumJob("meeting.summarize", {
        meetingId: id,
        workspaceId,
        mode: "summary",
        stage: "summary.generate",
        source: "manual-process",
      })

      return NextResponse.json(
        {
          job,
          mode: "transcript",
          message: "Summary generation queued from the existing transcript.",
        },
        { status: 202 }
      )
    }

    if (hasMeetImportableArtifact) {
      return queueArtifactImport()
    }

    return NextResponse.json(
      {
        error:
          "This meeting has no recording or transcript yet. Import a Drive recording, sync Meet artifacts, or upload audio before processing.",
        nextActions: ["find_drive_recordings", "upload_recording", "sync_meet_artifacts"],
      },
      { status: 409 }
    )
  }
)
