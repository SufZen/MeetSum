import { describe, expect, it } from "vitest"

import { deriveMeetingQualityWarnings } from "@/lib/meetings/quality"
import type { MeetingRecord } from "@/lib/meetings/repository"

const baseMeeting: MeetingRecord = {
  id: "meet_quality",
  title: "Hebrew quality review",
  source: "google_meet",
  language: "he",
  status: "completed",
  retention: "audio",
  startedAt: "2026-05-17T10:00:00.000Z",
  participants: [],
}

describe("meeting quality warnings", () => {
  it("marks Google smart-notes-only meetings without treating them as full transcripts", () => {
    const warnings = deriveMeetingQualityWarnings({
      ...baseMeeting,
      transcript: [
        {
          id: "seg_1",
          speaker: "Google Meet smart notes",
          startMs: 0,
          endMs: 4000,
          text: "Summary\nThe meeting approved the plan.",
          confidence: 0.9,
          language: "en",
        },
      ],
      meetConferenceRecords: [
        {
          id: "record_1",
          conferenceRecordName: "conferenceRecords/abc",
          artifacts: [
            {
              id: "artifact_1",
              conferenceRecordId: "record_1",
              conferenceRecordName: "conferenceRecords/abc",
              artifactType: "smart_notes",
              artifactName: "conferenceRecords/abc/smartNotes/notes",
            },
          ],
        },
      ],
    })

    expect(warnings.map((warning) => warning.code)).toContain("smart_notes_only")
  })

  it("surfaces local ASR fallback and weak transcript confidence", () => {
    const warnings = deriveMeetingQualityWarnings({
      ...baseMeeting,
      transcript: [
        {
          id: "seg_1",
          speaker: "Speaker 1",
          startMs: 0,
          endMs: 5000,
          text: "טקסט לא בטוח",
          confidence: 0.42,
          language: "he",
        },
        {
          id: "seg_2",
          speaker: "Speaker 2",
          startMs: 5000,
          endMs: 9000,
          text: "עוד טקסט",
          confidence: 0.58,
          language: "he",
        },
      ],
      aiRuns: [
        {
          id: "airun_1",
          meetingId: baseMeeting.id,
          provider: "gemini",
          task: "audio.transcribe",
          status: "completed",
          model: "gemini-3.5-flash",
          metadata: {
            fallbackUsed: true,
            attemptedProvider: "local-whisper",
          },
          startedAt: "2026-05-17T10:01:00.000Z",
        },
      ],
    })

    expect(warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining([
        "transcription_fallback",
        "weak_transcript_confidence",
        "no_speaker_diarization",
      ])
    )
  })

  it("flags open action items missing owner or due date before automation", () => {
    const warnings = deriveMeetingQualityWarnings({
      ...baseMeeting,
      summary: {
        overview: "The team agreed to follow up.",
        decisions: [],
        actionItems: [
          {
            id: "task_1",
            title: "Send the follow-up note",
            status: "open",
          },
        ],
      },
    })

    expect(warnings.map((warning) => warning.code)).toContain(
      "task_missing_owner_or_due_date"
    )
  })
})
