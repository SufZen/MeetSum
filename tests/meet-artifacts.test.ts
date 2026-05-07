import { describe, expect, it } from "vitest"

import {
  classifyMeetArtifactType,
  convertMeetSmartNotesTextToSegments,
  convertMeetTranscriptEntriesToSegments,
  extractMeetRecordingDriveFileId,
  extractMeetSmartNotesDocumentId,
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

  it("extracts smart-notes document ids from Meet artifact destinations", () => {
    expect(extractMeetSmartNotesDocumentId("documents/1abcDEF_234")).toBe(
      "1abcDEF_234"
    )
    expect(extractMeetSmartNotesDocumentId("files/drive-file-123")).toBe(
      "drive-file-123"
    )
    expect(
      extractMeetSmartNotesDocumentId(
        "https://docs.google.com/document/d/doc-id-456/edit"
      )
    ).toBe("doc-id-456")
    expect(extractMeetSmartNotesDocumentId(undefined)).toBeUndefined()
  })

  it("extracts recording Drive file ids from Meet artifact destinations", () => {
    expect(extractMeetRecordingDriveFileId("driveFiles/drive-rec-123")).toBe(
      "drive-rec-123"
    )
    expect(extractMeetRecordingDriveFileId("files/drive-rec-456")).toBe(
      "drive-rec-456"
    )
    expect(
      extractMeetRecordingDriveFileId(
        "https://drive.google.com/file/d/drive-rec-789/view"
      )
    ).toBe("drive-rec-789")
    expect(extractMeetRecordingDriveFileId(undefined)).toBeUndefined()
  })

  it("converts exported smart notes text into synthetic meeting segments", () => {
    const segments = convertMeetSmartNotesTextToSegments(
      `
      Summary
      The team approved the RealizeOS export flow.

      Action items
      Ran will test the public share link by Friday.
      `,
      {
        artifactId: "meetartifact_123",
        artifactStartTime: "2026-05-07T10:00:00.000Z",
      }
    )

    expect(segments).toEqual([
      {
        id: "meet_smart_note_meetartifact_123_1",
        speaker: "Google Meet smart notes",
        startMs: 0,
        endMs: 4000,
        text: "Summary\nThe team approved the RealizeOS export flow.",
        confidence: 0.9,
        language: "en",
      },
      {
        id: "meet_smart_note_meetartifact_123_2",
        speaker: "Google Meet smart notes",
        startMs: 4000,
        endMs: 8000,
        text: "Action items\nRan will test the public share link by Friday.",
        confidence: 0.9,
        language: "en",
      },
    ])
  })
})
