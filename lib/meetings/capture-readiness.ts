import type { MeetingRecord } from "@/lib/meetings/repository"

export type CaptureReadinessStatus =
  | "processed"
  | "ready_to_process"
  | "capture_armed"
  | "needs_artifact_sync"
  | "manual_capture"

export type CaptureReadinessAction =
  | "none"
  | "process"
  | "sync_artifacts"
  | "upload"

export type CaptureReadinessCheck = {
  key: "calendar" | "meet_record" | "recording" | "transcript" | "smart_notes" | "media"
  label: string
  state: "ready" | "pending" | "missing"
}

export type CaptureReadiness = {
  status: CaptureReadinessStatus
  title: string
  description: string
  primaryAction: CaptureReadinessAction
  checks: CaptureReadinessCheck[]
}

function isFutureMeeting(meeting: MeetingRecord) {
  return new Date(meeting.startedAt).getTime() > Date.now()
}

export function getMeetingCaptureReadiness(meeting: MeetingRecord): CaptureReadiness {
  const artifacts =
    meeting.meetConferenceRecords?.flatMap((record) => record.artifacts) ?? []
  const hasMeetRecord = Boolean(meeting.meetConferenceRecords?.length)
  const hasRecordingArtifact = artifacts.some(
    (artifact) => artifact.artifactType === "recording"
  )
  const hasTranscriptArtifact = artifacts.some(
    (artifact) => artifact.artifactType === "transcript"
  )
  const hasSmartNotesArtifact = artifacts.some(
    (artifact) => artifact.artifactType === "smart_notes"
  )
  const hasMedia = Boolean(meeting.mediaAssets?.some((asset) => asset.storageKey))
  const hasTranscript = Boolean(meeting.transcript?.length)
  const hasSummary = Boolean(meeting.summary?.overview)
  const hasImportableSource =
    hasMedia ||
    hasTranscript ||
    hasRecordingArtifact ||
    hasTranscriptArtifact ||
    hasSmartNotesArtifact
  const checks: CaptureReadinessCheck[] = [
    {
      key: "calendar",
      label: "Calendar event",
      state: meeting.source === "google_meet" ? "ready" : "pending",
    },
    {
      key: "meet_record",
      label: "Meet record",
      state: hasMeetRecord ? "ready" : "pending",
    },
    {
      key: "recording",
      label: "Recording",
      state: hasMedia || hasRecordingArtifact ? "ready" : "pending",
    },
    {
      key: "transcript",
      label: "Transcript",
      state: hasTranscript || hasTranscriptArtifact ? "ready" : "pending",
    },
    {
      key: "smart_notes",
      label: "Smart notes",
      state: hasSmartNotesArtifact ? "ready" : "pending",
    },
    {
      key: "media",
      label: "Uploaded/imported media",
      state: hasMedia ? "ready" : "pending",
    },
  ]

  if (hasSummary || meeting.status === "completed") {
    return {
      status: "processed",
      title: "Processed",
      description: "This meeting already has generated intelligence.",
      primaryAction: "none",
      checks,
    }
  }

  if (hasImportableSource) {
    return {
      status: "ready_to_process",
      title: "Ready to process",
      description:
        "MeetSum found recording, transcript, smart notes, or media that can be turned into meeting intelligence.",
      primaryAction: "process",
      checks,
    }
  }

  if (meeting.source === "google_meet" && isFutureMeeting(meeting)) {
    return {
      status: "capture_armed",
      title: "Capture armed",
      description:
        "This Google Meet is on the calendar. Enable native recording, transcript, or smart notes during the meeting, then sync artifacts afterward.",
      primaryAction: "sync_artifacts",
      checks,
    }
  }

  if (meeting.source === "google_meet") {
    return {
      status: "needs_artifact_sync",
      title: "Sync artifacts",
      description:
        "This Google meeting has no imported content yet. Sync Meet artifacts or find the Drive recording.",
      primaryAction: "sync_artifacts",
      checks,
    }
  }

  return {
    status: "manual_capture",
    title: "Manual capture needed",
    description:
      "Upload a recording or use the browser recorder to generate meeting intelligence.",
    primaryAction: "upload",
    checks,
  }
}
