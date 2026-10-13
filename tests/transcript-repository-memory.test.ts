import { describe, expect, it } from "vitest"

import {
  createInMemoryMeetingDatabase,
  createInMemoryMeetingRepository,
  type MeetingRepository,
} from "@/lib/meetings/repository"

const SYSTEM = { kind: "system" as const, workspaceId: "ws_default" }

async function seeded(): Promise<{ repo: MeetingRepository; meetingId: string }> {
  const repo = createInMemoryMeetingRepository(createInMemoryMeetingDatabase(), SYSTEM)
  const meeting = await repo.createMeeting({
    title: "Sync",
    source: "upload",
    language: "he",
    startedAt: "2026-10-01T10:00:00.000Z",
    participants: ["Dana Cohen"],
  })

  await repo.replaceTranscript(meeting.id, {
    segments: [
      { id: "s1", speaker: "Speaker 1", startMs: 0, endMs: 1000, text: "אממ שלום" },
      { id: "s2", speaker: "Speaker 2", startMs: 1000, endMs: 2000, text: "היי" },
    ],
    speakers: [
      { label: "Speaker 1", talkTimeMs: 1000, wordCount: 2, segmentCount: 1 },
      { label: "Speaker 2", talkTimeMs: 1000, wordCount: 1, segmentCount: 1 },
    ],
  })

  return { repo, meetingId: meeting.id }
}

describe("in-memory replaceTranscript({ preserveEdited })", () => {
  it("keeps edited segments, their revisions and confirmed speaker mappings", async () => {
    const { repo, meetingId } = await seeded()
    const [speaker1] = await repo.listMeetingSpeakers(meetingId)
    const [dana] = await repo.listMeetingParticipants(meetingId)

    await repo.updateMeetingSpeaker(meetingId, speaker1.id, {
      participantId: dana.id,
      mappingStatus: "confirmed",
    })
    await repo.updateTranscriptSegment(meetingId, "s1", { expectedRevision: 0, text: "שלום לכולם" })

    // Cleanup re-writes the same transcript (filler dropped from s1, s2 cleaned).
    await repo.replaceTranscript(
      meetingId,
      {
        segments: [
          { id: "s1", speaker: "Speaker 1", startMs: 0, endMs: 1000, text: "שלום" },
          { id: "s2", speaker: "Speaker 2", startMs: 1000, endMs: 2000, text: "היי." },
        ],
        speakers: [
          { label: "Speaker 1", talkTimeMs: 1000, wordCount: 1, segmentCount: 1 },
          { label: "Speaker 2", talkTimeMs: 1000, wordCount: 1, segmentCount: 1 },
        ],
      },
      { preserveEdited: true }
    )

    const transcript = await repo.getMeetingTranscript(meetingId)

    expect(transcript?.segments.map((segment) => [segment.id, segment.text, segment.source, segment.revision])).toEqual([
      ["s1", "שלום לכולם", "edited", 1],
      ["s2", "היי.", "asr", undefined],
    ])
    expect(transcript?.speakers[0]).toMatchObject({
      id: speaker1.id,
      mappingStatus: "confirmed",
      participantId: dana.id,
      displayName: "Dana Cohen",
    })
    expect(await repo.listTranscriptRevisions(meetingId, "s1")).toHaveLength(1)
  })

  it("re-ASR without preserveEdited discards edits and resets diarized mappings", async () => {
    const { repo, meetingId } = await seeded()
    const [speaker1] = await repo.listMeetingSpeakers(meetingId)

    await repo.updateMeetingSpeaker(meetingId, speaker1.id, { mappingStatus: "confirmed", displayName: "Dana" })
    await repo.updateTranscriptSegment(meetingId, "s1", { expectedRevision: 0, text: "שלום לכולם" })
    await repo.replaceTranscript(meetingId, {
      segments: [{ id: "s1", speaker: "Speaker 1", startMs: 0, endMs: 1500, text: "שלום" }],
      speakers: [{ label: "Speaker 1", talkTimeMs: 1500, wordCount: 1, segmentCount: 1 }],
    })

    const transcript = await repo.getMeetingTranscript(meetingId)

    expect(transcript?.segments[0]).toMatchObject({ text: "שלום", source: "asr" })
    expect(transcript?.speakers[0].mappingStatus).toBe("unmapped")
    expect(await repo.listTranscriptRevisions(meetingId, "s1")).toHaveLength(0)
  })
})

describe("in-memory transcript version, duration and media", () => {
  it("bumps the version on transcript and speaker changes", async () => {
    const { repo, meetingId } = await seeded()
    const before = (await repo.getTranscriptVersion(meetingId)) as number
    const [speaker1] = await repo.listMeetingSpeakers(meetingId)

    await repo.updateMeetingSpeaker(meetingId, speaker1.id, { displayName: "Dana" })

    expect(await repo.getTranscriptVersion(meetingId)).toBe(before + 1)
    expect(await repo.getTranscriptVersion("missing")).toBeUndefined()
  })

  it("sets a transcript duration only without a media duration", async () => {
    const { repo, meetingId } = await seeded()

    expect((await repo.getMeeting(meetingId))?.durationMs).toBe(2000)

    const asset = await repo.createMediaAsset({
      meetingId,
      storageKey: "k",
      contentType: "audio/webm",
      sizeBytes: 1,
    })

    await repo.updateMediaAssetPreparation(asset.id, { durationMs: 90_000 })
    await repo.setMeetingDurationMs(meetingId, 90_000, "media")
    await repo.setMeetingDurationMs(meetingId, 5000, "transcript")

    expect((await repo.getMeeting(meetingId))?.durationMs).toBe(90_000)
  })

  it("never changes the meeting status for a playback rendition", async () => {
    const { repo, meetingId } = await seeded()

    await repo.updateMeetingStatus(meetingId, "completed")

    const playback = await repo.createMediaAsset({
      meetingId,
      storageKey: "derived.m4a",
      contentType: "audio/mp4",
      sizeBytes: 1,
      kind: "playback",
      derivedFromAssetId: "asset_x",
      durationMs: 1000,
    })

    expect(playback).toMatchObject({ kind: "playback", derivedFromAssetId: "asset_x", durationMs: 1000 })
    expect((await repo.getMeeting(meetingId))?.status).toBe("completed")
  })
})
