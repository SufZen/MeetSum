import { describe, expect, it } from "vitest"

import type { MeetingParticipant, MeetingSpeaker } from "@/lib/meetings/repository"
import { enrichActionItems, type EnrichableTask } from "@/lib/tasks/enrich"
import type { TaskEnrichContext } from "@/lib/tasks/types"

const NOW = "2026-10-15T09:00:00.000Z"

const participants: MeetingParticipant[] = [
  {
    id: "p_dana",
    meetingId: "meet_1",
    name: "דנה כהן",
    email: "dana@example.com",
    role: "attendee",
    source: "calendar",
    attendanceStatus: "accepted",
    createdAt: NOW,
    updatedAt: NOW,
  },
]
const speakers: MeetingSpeaker[] = [
  {
    id: "spk_1",
    meetingId: "meet_1",
    label: "Speaker 1",
    displayName: "דנה כהן",
    participantId: "p_dana",
    mappingStatus: "confirmed",
    source: "diarization",
    talkTimeMs: 1,
    wordCount: 1,
    segmentCount: 1,
  },
]
const ctx: TaskEnrichContext = {
  // Thursday 15.10.2026 in Jerusalem.
  meetingStartedAt: "2026-10-15T09:00:00.000Z",
  timeZone: "Asia/Jerusalem",
  speakers,
  participants,
  members: [{ userId: "user_dana", email: "dana@example.com", name: "Dana" }],
  segments: [
    { id: "seg_1", startMs: 0, endMs: 5000, speakerId: "spk_1" },
    { id: "seg_2", startMs: 5000, endMs: 9000 },
  ],
}

function task(partial: Partial<EnrichableTask>): EnrichableTask {
  return {
    id: "task_1",
    title: "לשלוח את ההצעה",
    status: "open",
    priority: "normal",
    confidence: 0.8,
    sourceQuote: "אני אשלח את ההצעה עד יום ראשון",
    sourceStartMs: 1200,
    kind: "explicit",
    ...partial,
  }
}

describe("enrichActionItems", () => {
  it("prefers the parser over the model date", () => {
    const [item] = enrichActionItems(
      [task({ dueText: "עד יום ראשון", dueDate: "2026-12-01" })],
      ctx
    )

    expect(item).toMatchObject({
      dueOn: "2026-10-18",
      dueSource: "parser",
      dueConfidence: 0.9,
      dueDate: "2026-10-18T12:00:00.000Z",
    })
  })

  it("accepts an in-range model date with capped confidence", () => {
    const [item] = enrichActionItems([task({ dueDate: "2026-11-20" })], ctx)

    expect(item).toMatchObject({ dueOn: "2026-11-20", dueSource: "ai", dueConfidence: 0.6 })
  })

  it("drops model dates outside anchor-1d .. anchor+2y", () => {
    const [past, far, garbage, yesterday] = enrichActionItems(
      [
        task({ id: "a", dueDate: "2026-10-10" }),
        task({ id: "b", dueDate: "2029-01-01" }),
        task({ id: "c", dueDate: "soon" }),
        task({ id: "d", dueDate: "2026-10-14" }),
      ],
      ctx
    )

    expect(past.dueOn).toBeUndefined()
    expect(past.dueDate).toBeUndefined()
    expect(far.dueOn).toBeUndefined()
    expect(garbage.dueOn).toBeUndefined()
    expect(yesterday).toMatchObject({ dueOn: "2026-10-14", dueSource: "ai" })
  })

  it("resolves a first-person owner through the cited segment's speaker", () => {
    const [item] = enrichActionItems([task({ ownerText: "אני" })], ctx)

    expect(item).toMatchObject({
      sourceSegmentId: "seg_1",
      sourceStartMs: 0,
      ownerText: "אני",
      ownerSpeakerId: "spk_1",
      ownerParticipantId: "p_dana",
      ownerUserId: "user_dana",
      owner: "דנה כהן",
    })
  })

  it("maps a cited segment id to its start time", () => {
    const [item] = enrichActionItems([task({ sourceSegmentId: "seg_2", sourceStartMs: 0 })], ctx)

    expect(item).toMatchObject({ sourceSegmentId: "seg_2", sourceStartMs: 5000 })
  })

  it("keeps an unknown owner as text", () => {
    const [item] = enrichActionItems([task({ owner: "מחלקת כספים" })], ctx)

    expect(item).toMatchObject({ owner: "מחלקת כספים", ownerText: "מחלקת כספים" })
    expect(item.ownerUserId).toBeUndefined()
  })

  it("bumps priority from the resolved due date and urgency words", () => {
    const [soon, urgent] = enrichActionItems(
      [task({ id: "a", dueText: "מחר" }), task({ id: "b", title: "דחוף לחתום", sourceQuote: "" })],
      ctx
    )

    expect(soon.priority).toBe("high")
    expect(urgent.priority).toBe("high")
  })

  it("does not mutate its input", () => {
    const input = task({ dueText: "מחר" })

    enrichActionItems([input], ctx)
    expect(input.dueOn).toBeUndefined()
  })
})
