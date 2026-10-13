import { describe, expect, it } from "vitest"

import {
  alignBotSpeakerTimeline,
  botTimelineOffsetMs,
  buildBotSpeakerTimeline,
  loadBotSpeakerTimeline,
} from "@/lib/bot/speaker-timeline"
import { createMemoryBotSessionStore } from "@/lib/bot/store-memory"
import type { VexaTranscriptSegment } from "@/lib/bot/vexa/types"

/** M7 B5: grouping, bot filtering, offset rules, scoped loading (suggestion only). */

const seg = (
  segmentId: string,
  speaker: string | undefined,
  start: number,
  end: number,
  absoluteStartTime?: string
): VexaTranscriptSegment => ({ segmentId, speaker, text: "x", start, end, absoluteStartTime })

describe("buildBotSpeakerTimeline", () => {
  it("merges runs with gaps of at most 1.5 s and splits larger gaps", () => {
    const timeline = buildBotSpeakerTimeline(
      [
        seg("1", "Dana", 0, 2),
        seg("2", "Dana", 3.5, 5),
        seg("3", "Dana", 6.6, 7),
        seg("4", "Avi", 7, 9),
      ],
      { offsetMs: 0 }
    )

    expect(timeline).toEqual([
      { name: "Dana", startMs: 0, endMs: 5000 },
      { name: "Dana", startMs: 6600, endMs: 7000 },
      { name: "Avi", startMs: 7000, endMs: 9000 },
    ])
  })

  it("drops empty speakers and the bot's own name or email, and never sets an email", () => {
    const timeline = buildBotSpeakerTimeline(
      [
        seg("1", "", 0, 1),
        seg("2", undefined, 1, 2),
        seg("3", "MeetSum Notetaker", 2, 3),
        seg("4", "meetsum notetaker · Recording", 3, 4),
        seg("5", "notetaker@realization.co.il", 4, 5),
        seg("6", "דנה כהן", 5, 6),
      ],
      { offsetMs: 500, botName: "MeetSum Notetaker", botEmail: "notetaker@realization.co.il" }
    )

    expect(timeline).toEqual([{ name: "דנה כהן", startMs: 5500, endMs: 6500 }])
    expect(timeline[0]).not.toHaveProperty("email")
  })
})

describe("botTimelineOffsetMs", () => {
  it("uses absolute_start_time minus the recording start when both are known", () => {
    expect(
      botTimelineOffsetMs([seg("1", "Dana", 10, 12, "2026-10-13T10:00:25.000Z")], {
        recordingStartedAt: "2026-10-13T10:00:05.000Z",
      })
    ).toBe(10_000)
  })

  it("falls back to 0 only when the recording and session spans agree within 2%", () => {
    const segments = [seg("1", "Dana", 0, 1)]
    const session = { sessionStartedAt: "2026-10-13T10:00:00Z", sessionEndedAt: "2026-10-13T11:00:00Z" }

    expect(botTimelineOffsetMs(segments, { ...session, recordingDurationMs: 3_600_000 - 60_000 })).toBe(0)
    expect(botTimelineOffsetMs(segments, { ...session, recordingDurationMs: 3_000_000 })).toBeUndefined()
    expect(botTimelineOffsetMs(segments, { recordingDurationMs: 3_600_000 })).toBeUndefined()
  })

  it("returns no timeline when the offset is untrusted", () => {
    expect(alignBotSpeakerTimeline([seg("1", "Dana", 0, 1)], {})).toBeUndefined()
  })
})

describe("loadBotSpeakerTimeline", () => {
  it("returns the newest session timeline for the workspace only, without emails", async () => {
    const store = createMemoryBotSessionStore()
    const base = {
      meetingId: "meet_1",
      origin: "manual" as const,
      platform: "google_meet" as const,
      nativeMeetingId: "abc-defg-hij",
      botName: "MeetSum Notetaker",
    }
    const w1 = await store.create({ ...base, workspaceId: "ws_1" })
    const w2 = await store.create({ ...base, workspaceId: "ws_2" })

    await store.update(
      w1.id,
      {
        speakerTimeline: [
          { name: "Dana", email: "dana@example.com", startMs: 0, endMs: 1000 },
          { name: "MeetSum Notetaker", startMs: 1000, endMs: 2000 },
          { bogus: true },
        ],
      },
      { workspaceId: "ws_1" }
    )
    await store.update(w2.id, { speakerTimeline: [{ name: "Other", startMs: 0, endMs: 1 }] }, { workspaceId: "ws_2" })

    expect(await loadBotSpeakerTimeline("meet_1", "ws_1", { store })).toEqual([
      { name: "Dana", startMs: 0, endMs: 1000 },
    ])
    expect(await loadBotSpeakerTimeline("meet_1", "ws_3", { store })).toBeUndefined()
  })
})
