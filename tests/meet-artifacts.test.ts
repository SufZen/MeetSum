import { describe, expect, it } from "vitest"

import { classifyMeetArtifactType } from "@/lib/google/meet-artifacts"

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
})
