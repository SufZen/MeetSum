import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it, vi } from "vitest"

import {
  buildMeetTimeline,
  classifyMeetArtifactType,
  listMeetParticipants,
  loadMeetTimelineForMeeting,
  meetParticipantNameMap,
  convertMeetSmartNotesTextToSegments,
  convertMeetTranscriptEntriesToSegments,
  extractMeetRecordingDriveFileId,
  extractMeetSmartNotesDocumentId,
  createMeetResourceId,
} from "@/lib/google/meet-artifacts"

describe("Meet artifacts", () => {
  it("creates distinct stable ids for long Google resources with identical prefixes", () => {
    const prefix =
      "gident_aW5mb0ByZWFsaXphdGlvbi5jby5pbDpjb25mZXJlbmNlUmVjb3Jkcy/"
    const first = createMeetResourceId("meetconf", `${prefix}aaaaaaaaaaaaaaaaaaaa`)
    const second = createMeetResourceId("meetconf", `${prefix}bbbbbbbbbbbbbbbbbbbb`)

    expect(first).not.toBe(second)
    expect(first).toMatch(/^meetconf_[A-Za-z0-9_-]{16,}$/)
    expect(second).toMatch(/^meetconf_[A-Za-z0-9_-]{16,}$/)
  })

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
        source: "meet",
      },
      {
        id: "meet_entry_entry-2",
        speaker: "asaf",
        startMs: 8000,
        endMs: 11500,
        text: "The RealizeOS export should run after the summary.",
        confidence: 0.95,
        language: "en",
        source: "meet",
      },
    ])
  })

  it("extracts smart-notes document ids from Meet artifact destinations", () => {
    expect(extractMeetSmartNotesDocumentId("1abcDEF_234")).toBe("1abcDEF_234")
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
    expect(extractMeetRecordingDriveFileId("drive-rec-123")).toBe("drive-rec-123")
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

  it("removes Google smart notes boilerplate before creating segments", () => {
    const segments = convertMeetSmartNotesTextToSegments(
      `
      Summary
      The team approved the RealizeOS export flow.

      You should review Gemini's notes to make sure they're accurate. Get tips and learn how Gemini takes notes.
      How is the quality of these specific notes? Take a short survey to let us know your feedback.
      `,
      {
        artifactId: "meetartifact_123",
        artifactStartTime: "2026-05-07T10:00:00.000Z",
      }
    )

    expect(segments).toHaveLength(1)
    expect(segments[0]?.text).toBe(
      "Summary\nThe team approved the RealizeOS export flow."
    )
  })
})

function meetFixture(name: string) {
  return JSON.parse(
    readFileSync(path.join(__dirname, "fixtures", "asr", "meet", name), "utf8")
  ) as Record<string, unknown>
}

describe("Meet participant names (M3)", () => {
  it("lists conference participants with display names across pages", async () => {
    const fetchMock = vi.fn(async (url: URL | string) => {
      const pageToken = new URL(String(url)).searchParams.get("pageToken")
      const body = meetFixture(pageToken ? "participants-page-2.json" : "participants-page-1.json")

      return new Response(JSON.stringify(body), { status: 200 })
    })

    const participants = await listMeetParticipants(
      "token",
      "conferenceRecords/rec-1",
      fetchMock as unknown as typeof fetch
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const firstUrl = new URL(String(fetchMock.mock.calls[0][0]))

    expect(firstUrl.pathname).toBe("/v2/conferenceRecords/rec-1/participants")
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get("pageToken")).toBe(
      "page-2"
    )
    expect(participants).toEqual([
      {
        name: "conferenceRecords/rec-1/participants/p-dana",
        displayName: "דנה כהן",
        kind: "signedin",
        userId: "users/111",
      },
      {
        name: "conferenceRecords/rec-1/participants/p-ran",
        displayName: "Ran Levi",
        kind: "signedin",
        userId: "users/222",
      },
      {
        name: "conferenceRecords/rec-1/participants/p-guest",
        displayName: "Guest Maya",
        kind: "anonymous",
      },
      {
        name: "conferenceRecords/rec-1/participants/p-phone",
        displayName: "+972-5x-xxx-1234",
        kind: "phone",
      },
    ])
    // No resolver → no verified emails, so no Meet name can confirm.
    expect(participants.some((participant) => participant.verifiedEmail)).toBe(false)
  })

  it("names transcript speakers from participants and builds the Meet timeline", async () => {
    const participants = await listMeetParticipants(
      "token",
      "conferenceRecords/rec-1",
      (async (url: URL | string) =>
        new Response(
          JSON.stringify(
            meetFixture(
              new URL(String(url)).searchParams.get("pageToken")
                ? "participants-page-2.json"
                : "participants-page-1.json"
            )
          )
        )) as unknown as typeof fetch
    )
    const entries = meetFixture("transcript-entries.json").transcriptEntries as Parameters<
      typeof convertMeetTranscriptEntriesToSegments
    >[0]
    const segments = convertMeetTranscriptEntriesToSegments(entries, {
      baseTime: "2026-10-01T09:00:00Z",
      participantNames: meetParticipantNameMap(participants),
    })

    expect(segments.map((segment) => [segment.speaker, segment.source])).toEqual([
      ["דנה כהן", "meet"],
      ["Ran Levi", "meet"],
      // No display name → falls back to the participant id.
      ["p unknown", "meet"],
    ])
    expect(buildMeetTimeline(segments)).toEqual([
      { name: "דנה כהן", startMs: 3000, endMs: 7000 },
      { name: "Ran Levi", startMs: 8000, endMs: 12000 },
      { name: "p unknown", startMs: 13000, endMs: 15000 },
    ])
  })

  it("surfaces Meet API errors from the participant listing", async () => {
    await expect(
      listMeetParticipants(
        "token",
        "conferenceRecords/rec-1",
        (async () =>
          new Response(JSON.stringify({ error: { message: "Permission denied" } }), {
            status: 403,
          })) as unknown as typeof fetch
      )
    ).rejects.toThrow("Permission denied")
  })

  it("does not load the Meet timeline when disabled", async () => {
    await expect(
      loadMeetTimelineForMeeting({
        meetingId: "meet_1",
        workspaceId: "ws_1",
        subject: "ops@example.com",
        env: { MEETSUM_SPEAKER_SUGGEST_USE_MEET: "false" } as unknown as NodeJS.ProcessEnv,
      })
    ).resolves.toBeUndefined()
  })
})
