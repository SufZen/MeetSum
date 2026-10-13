/**
 * Capture readiness of a meeting as codes only (M9: server modules return
 * codes, components translate them; see `readinessText` /
 * `readinessCheckLabel` in components/google-context-card.tsx).
 */
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
  state: "ready" | "pending" | "missing"
}

export type CaptureReadiness = {
  status: CaptureReadinessStatus
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
  // M4: the meeting detail carries a segment count instead of the transcript.
  const hasTranscript = Boolean(meeting.transcriptSegmentCount ?? meeting.transcript?.length)
  const hasSummary = Boolean(meeting.summary?.overview)
  const hasImportableSource =
    hasMedia ||
    hasTranscript ||
    hasRecordingArtifact ||
    hasTranscriptArtifact ||
    hasSmartNotesArtifact
  const checks: CaptureReadinessCheck[] = [
    { key: "calendar", state: meeting.source === "google_meet" ? "ready" : "pending" },
    { key: "meet_record", state: hasMeetRecord ? "ready" : "pending" },
    { key: "recording", state: hasMedia || hasRecordingArtifact ? "ready" : "pending" },
    { key: "transcript", state: hasTranscript || hasTranscriptArtifact ? "ready" : "pending" },
    { key: "smart_notes", state: hasSmartNotesArtifact ? "ready" : "pending" },
    { key: "media", state: hasMedia ? "ready" : "pending" },
  ]

  if (hasSummary || meeting.status === "completed") {
    return { status: "processed", primaryAction: "none", checks }
  }

  if (hasImportableSource) {
    return { status: "ready_to_process", primaryAction: "process", checks }
  }

  if (meeting.source === "google_meet" && isFutureMeeting(meeting)) {
    return { status: "capture_armed", primaryAction: "sync_artifacts", checks }
  }

  if (meeting.source === "google_meet") {
    return { status: "needs_artifact_sync", primaryAction: "sync_artifacts", checks }
  }

  return { status: "manual_capture", primaryAction: "upload", checks }
}
