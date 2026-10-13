import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { Queryable } from "@/lib/db/client"
import { createPostgresMeetingRepository } from "@/lib/meetings/postgres-repository"
import {
  createInMemoryMeetingDatabase,
  createInMemoryMeetingRepository,
  TranscriptConflictError,
  type MeetingRepository,
} from "@/lib/meetings/repository"
import { createM8Database, seedM8Workspaces, type PgLike } from "@/tests/helpers/pglite-m8"
import { testMeeting } from "@/tests/helpers/route-ctx"

/**
 * M9 B5 (M4 carry-over): a whole-turn speaker change undoes atomically, on
 * the memory repository and on Postgres (PGlite, migrations 001–030). A
 * concurrent edit of any segment of the turn refuses the undo (409) and
 * reverts nothing; segment-scope undo is unchanged.
 */

const SEGMENTS = [
  { id: "s1", speaker: "Speaker 1", startMs: 0, endMs: 2000, text: "שלום לכולם" },
  { id: "s2", speaker: "Speaker 2", startMs: 2000, endMs: 4000, text: "היי" },
  { id: "s3", speaker: "Speaker 2", startMs: 4000, endMs: 6000, text: "נתחיל בתקציב" },
  { id: "s4", speaker: "Speaker 2", startMs: 6000, endMs: 8000, text: "ואז בלוח הזמנים" },
  { id: "s5", speaker: "Speaker 1", startMs: 8000, endMs: 9000, text: "מצוין" },
]
const SPEAKERS = [
  { label: "Speaker 1", talkTimeMs: 3000, wordCount: 3, segmentCount: 2 },
  { label: "Speaker 2", talkTimeMs: 6000, wordCount: 6, segmentCount: 3 },
]

type Fixture = { repo: MeetingRepository; meetingId: string }

let pg: PgLike | undefined
let pgCounter = 0

beforeAll(async () => {
  pg = await createM8Database()
  if (pg) await seedM8Workspaces(pg)
}, 60_000)

afterAll(async () => {
  await pg?.close()
})

async function memoryFixture(): Promise<Fixture> {
  const database = createInMemoryMeetingDatabase([testMeeting({ id: "m_turn", workspaceId: "ws_a" })])
  const repo = createInMemoryMeetingRepository(database, { kind: "system", workspaceId: "ws_a" })

  await repo.replaceTranscript("m_turn", { segments: SEGMENTS, speakers: SPEAKERS })

  return { repo, meetingId: "m_turn" }
}

async function postgresFixture(): Promise<Fixture | undefined> {
  if (!pg) return undefined

  const repo = createPostgresMeetingRepository(pg as unknown as Queryable, { kind: "system", workspaceId: "ws_1" })
  const meeting = await repo.createMeeting({
    title: `Turn undo ${++pgCounter}`,
    startedAt: "2026-10-13T08:00:00.000Z",
    source: "upload",
    language: "he",
    participants: [],
  })
  const suffix = `_${pgCounter}`

  await repo.replaceTranscript(meeting.id, {
    segments: SEGMENTS.map((segment) => ({ ...segment, id: `${segment.id}${suffix}` })),
    speakers: SPEAKERS,
  })

  return { repo, meetingId: meeting.id }
}

async function state(fixture: Fixture) {
  const transcript = (await fixture.repo.getMeetingTranscript(fixture.meetingId))!
  const label = new Map(transcript.speakers.map((speaker) => [speaker.id, speaker.label]))
  const byPrefix = (prefix: string) => transcript.segments.find((segment) => segment.id.split("_")[0] === prefix)!

  return {
    transcript,
    segment: byPrefix,
    speakerOf: (prefix: string) => label.get(byPrefix(prefix).speakerId ?? "") ?? byPrefix(prefix).speaker,
    speakerId: (speakerLabel: string) => transcript.speakers.find((speaker) => speaker.label === speakerLabel)!.id,
  }
}

const suites: Array<[string, () => Promise<Fixture | undefined>]> = [
  ["memory", memoryFixture],
  ["postgres (PGlite)", postgresFixture],
]

for (const [name, makeFixture] of suites) {
  describe(`turn undo: ${name}`, () => {
    async function reassignTurn(fixture: Fixture) {
      const before = await state(fixture)
      const s3 = before.segment("s3")

      const result = await fixture.repo.updateTranscriptSegment(fixture.meetingId, s3.id, {
        expectedRevision: s3.revision ?? 0,
        speakerId: before.speakerId("Speaker 1"),
        scope: "turn",
        actorUserId: "usr_dana",
      })

      return { before, result }
    }

    it("writes one edit group for the whole turn and undoes all three segments at once", async (context) => {
      const fixture = await makeFixture()

      if (!fixture) return context.skip()

      const { result } = await reassignTurn(fixture)

      expect(result.segments?.map((segment) => segment.id.split("_")[0]).sort()).toEqual(["s2", "s3", "s4"])

      const revisions = await Promise.all(
        result.segments!.map((segment) => fixture.repo.listTranscriptRevisions(fixture.meetingId, segment.id))
      )
      const groups = new Set(revisions.map((list) => list[0]?.editGroupId))

      expect(groups.size).toBe(1)
      expect([...groups][0]).toBeTruthy()

      const edited = await state(fixture)

      expect(["s2", "s3", "s4"].map(edited.speakerOf)).toEqual(["Speaker 1", "Speaker 1", "Speaker 1"])

      const s2 = edited.segment("s2")
      const undone = await fixture.repo.undoTranscriptSegment(fixture.meetingId, s2.id, {
        expectedRevision: s2.revision ?? 0,
        actorUserId: "usr_dana",
      })

      expect(undone.segments?.map((segment) => segment.id.split("_")[0]).sort()).toEqual(["s2", "s3", "s4"])

      const after = await state(fixture)

      expect(["s1", "s2", "s3", "s4", "s5"].map(after.speakerOf)).toEqual([
        "Speaker 1",
        "Speaker 2",
        "Speaker 2",
        "Speaker 2",
        "Speaker 1",
      ])
      for (const segment of result.segments!) {
        const [latest] = await fixture.repo.listTranscriptRevisions(fixture.meetingId, segment.id)

        expect(latest?.revertedAt).toBeTruthy()
      }
    })

    it("refuses the undo (conflict) and reverts nothing when one segment changed since", async (context) => {
      const fixture = await makeFixture()

      if (!fixture) return context.skip()

      await reassignTurn(fixture)

      const edited = await state(fixture)
      const s4 = edited.segment("s4")

      // A concurrent edit of one segment of the turn.
      await fixture.repo.updateTranscriptSegment(fixture.meetingId, s4.id, {
        expectedRevision: s4.revision ?? 0,
        text: "ואז בלוח הזמנים המעודכן",
        actorUserId: "usr_yossi",
      })

      const s2 = edited.segment("s2")

      await expect(
        fixture.repo.undoTranscriptSegment(fixture.meetingId, s2.id, { expectedRevision: s2.revision ?? 0 })
      ).rejects.toBeInstanceOf(TranscriptConflictError)

      const after = await state(fixture)

      expect(["s2", "s3", "s4"].map(after.speakerOf)).toEqual(["Speaker 1", "Speaker 1", "Speaker 1"])
      expect(after.segment("s2").revision).toBe(s2.revision)
      expect(after.segment("s4").text).toBe("ואז בלוח הזמנים המעודכן")

      const [s3Latest] = await fixture.repo.listTranscriptRevisions(fixture.meetingId, after.segment("s3").id)

      expect(s3Latest?.revertedAt).toBeUndefined()

      // Once the later edit is undone, the turn undo goes through.
      const s4Now = after.segment("s4")

      await fixture.repo.undoTranscriptSegment(fixture.meetingId, s4Now.id, { expectedRevision: s4Now.revision ?? 0 })

      const s2Now = (await state(fixture)).segment("s2")

      await fixture.repo.undoTranscriptSegment(fixture.meetingId, s2Now.id, { expectedRevision: s2Now.revision ?? 0 })

      const final = await state(fixture)

      expect(["s2", "s3", "s4"].map(final.speakerOf)).toEqual(["Speaker 2", "Speaker 2", "Speaker 2"])
      expect(final.segment("s4").text).toBe("ואז בלוח הזמנים")
    })

    it("keeps segment-scope undo a group of one", async (context) => {
      const fixture = await makeFixture()

      if (!fixture) return context.skip()

      const before = await state(fixture)
      const s1 = before.segment("s1")
      const edited = await fixture.repo.updateTranscriptSegment(fixture.meetingId, s1.id, {
        expectedRevision: s1.revision ?? 0,
        text: "שלום לכולם וברוכים הבאים",
      })

      expect(edited.segments?.map((segment) => segment.id)).toEqual([s1.id])

      const undone = await fixture.repo.undoTranscriptSegment(fixture.meetingId, s1.id, {
        expectedRevision: edited.segment.revision ?? 0,
      })

      expect(undone.segments?.map((segment) => segment.id)).toEqual([s1.id])
      expect(undone.segment.text).toBe("שלום לכולם")
      expect((await state(fixture)).speakerOf("s2")).toBe("Speaker 2")
    })
  })
}
