import { describe, expect, it } from "vitest"

import {
  classifyMeetArtifactType,
  convertMeetTranscriptEntriesToSegments,
} from "@/lib/google/meet-artifacts"

describe("Meet artifacts", () => {
  it("classifies Google Meet artifact resource names", () => {
    expect(
      classifyMeetArtifactType("conferenceRecords/abc/recordings/rec-1")
    ).toBe("recording")
    expect(
      classifyMeetArtifactType("conferenceRecords/abc/transcripts/tr-1")
    ).toBe("transcript")
    expect(
      classifyMeetArtifactType("conferenceRecords/abc/smartNotes/note-1")
    ).toBe("smart_notes")
  })

  it("converts Google Meet transcript entries into timestamped transcript segments", () => {
    const segments = convertMeetTranscriptEntriesToSegments(
      [
        {
          name: "conferenceRecords/abc/transcripts/tr-1/entries/entry-1",
          participant: "conferenceRecords/abc/participants/ran",
          text: "שלום, נתחיל עם ההחלטות.",
          languageCode: "he-IL",
          startTime: "2026-05-07T10:00:03.000Z",
          endTime: "2026-05-07T10:00:07.000Z",
        },
        {
          name: "conferenceRecords/abc/transcripts/tr-1/entries/entry-2",
          participant: "conferenceRecords/abc/participants/asaf",
          text: "The RealizeOS export should run after the summary.",
          languageCode: "en-US",
          startTime: "2026-05-07T10:00:08.000Z",
          endTime: "2026-05-07T10:00:11.500Z",
        },
      ],
      {
        baseTime: "2026-05-07T10:00:00.000Z",
      }
    )

    expect(segments).toEqual([
      {
        id: "meet_entry_entry-1",
        speaker: "ran",
        startMs: 3000,
        endMs: 7000,
        text: "שלום, נתחיל עם ההחלטות.",
        confidence: 0.95,
        language: "he",
      },
      {
        id: "meet_entry_entry-2",
        speaker: "asaf",
        startMs: 8000,
        endMs: 11500,
        text: "The RealizeOS export should run after the summary.",
        confidence: 0.95,
        language: "en",
      },
    ])
  })
})
