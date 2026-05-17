import type {
  AiRunRecord,
  MeetingQualityWarning,
  MeetingRecord,
} from "@/lib/meetings/repository"

function averageTranscriptConfidence(meeting: MeetingRecord) {
  const values = (meeting.transcript ?? [])
    .map((segment) => segment.confidence)
    .filter((value): value is number => typeof value === "number")

  if (!values.length) return undefined

  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function latestTranscriptionRun(meeting: MeetingRecord): AiRunRecord | undefined {
  return (meeting.aiRuns ?? []).find((run) => run.task === "audio.transcribe")
}

function hasOnlySmartNotesSource(meeting: MeetingRecord) {
  const artifacts =
    meeting.meetConferenceRecords?.flatMap((record) => record.artifacts) ?? []
  const hasSmartNotes = artifacts.some(
    (artifact) => artifact.artifactType === "smart_notes"
  )
  const hasMedia = Boolean(meeting.mediaAssets?.length)
  const transcript = meeting.transcript ?? []

  return (
    hasSmartNotes &&
    !hasMedia &&
    transcript.length > 0 &&
    transcript.every((segment) => /google meet smart notes/i.test(segment.speaker))
  )
}

function hasGenericSpeakers(meeting: MeetingRecord) {
  const transcript = meeting.transcript ?? []

  if (transcript.length < 2) return false

  return transcript.every((segment) =>
    /^(speaker\s+\d+|speaker|google meet smart notes)$/i.test(segment.speaker)
  )
}

export function deriveMeetingQualityWarnings(
  meeting: MeetingRecord
): MeetingQualityWarning[] {
  const warnings: MeetingQualityWarning[] = []
  const confidence = averageTranscriptConfidence(meeting)
  const transcriptionRun = latestTranscriptionRun(meeting)
  const fallbackUsed = transcriptionRun?.metadata.fallbackUsed === true
  const attemptedProvider =
    typeof transcriptionRun?.metadata.attemptedProvider === "string"
      ? transcriptionRun.metadata.attemptedProvider
      : undefined

  if (hasOnlySmartNotesSource(meeting)) {
    warnings.push({
      code: "smart_notes_only",
      severity: "info",
      title: "Smart notes source",
      detail:
        "This meeting was generated from Google smart notes, not a full transcript or audio recording.",
    })
  }

  if (fallbackUsed) {
    warnings.push({
      code: "transcription_fallback",
      severity: "warning",
      title: "Transcription fallback used",
      detail: attemptedProvider
        ? `${attemptedProvider} failed, so MeetSum used ${transcriptionRun.provider}.`
        : `MeetSum used ${transcriptionRun.provider} after the primary transcription path failed.`,
    })
  }

  if (typeof confidence === "number" && confidence < 0.72) {
    warnings.push({
      code: "weak_transcript_confidence",
      severity: "warning",
      title: "Weak transcript confidence",
      detail: `Average segment confidence is ${Math.round(confidence * 100)}%. Review transcript details before relying on tasks or decisions.`,
    })
  }

  if (hasGenericSpeakers(meeting)) {
    warnings.push({
      code: "no_speaker_diarization",
      severity: "info",
      title: "Speaker names need review",
      detail:
        "Speaker labels are generic. Assign participants in the transcript view when speaker ownership matters.",
    })
  }

  const incompleteTasks = (meeting.summary?.actionItems ?? []).filter(
    (item) => item.status !== "done" && (!item.owner || !item.dueDate)
  )

  if (incompleteTasks.length) {
    warnings.push({
      code: "task_missing_owner_or_due_date",
      severity: "info",
      title: "Tasks need owner or due date",
      detail: `${incompleteTasks.length} open action item${incompleteTasks.length === 1 ? "" : "s"} need an owner or due date before external automation.`,
    })
  }

  return warnings
}
