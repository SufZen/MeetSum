import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import type { MeetingRecord, MeetingRepository, RepoScope } from "@/lib/meetings/repository"
import { createPgliteSearchDb, seedPgliteMeetings, type PgliteSearchDb } from "@/lib/search/eval/pglite"
import { createIndexStore } from "@/lib/search/index-store"
import { createIndexer } from "@/lib/search/indexer"
import { createMemorySearchEngine } from "@/lib/search/memory-engine"
import { createPgSearchEngine } from "@/lib/search/pg-engine"
import { searchWorkspace, setSearchEngineForTesting, type SearchEngine } from "@/lib/search/service"
import type { SearchContext, SearchHit, SearchParams } from "@/lib/search/types"

import { testMeeting } from "./helpers/route-ctx"

/**
 * M6 Hebrew sanity, end to end with no doubles: a query for "תקציב" finds the
 * prefixed surface forms "והתקציב" and "בתקציב" through A's chunker and
 * normalizer, the indexer (PGlite: real index store and SQL legs; memory
 * engine otherwise), and B's search service; the highlight covers the whole
 * surface word, prefix letters included.
 */

const MEETINGS: MeetingRecord[] = [
  testMeeting({
    id: "m_vav",
    title: "ישיבת הנהלה",
    transcript: [
      { id: "seg_vav", speaker: "דנה", startMs: 0, endMs: 5000, text: "והתקציב לשנה הבאה אושר סופית" },
      { id: "seg_vav_2", speaker: "רון", startMs: 5000, endMs: 9000, text: "מעולה, נמשיך לנושא הבא" },
    ],
  }),
  testMeeting({
    id: "m_bet",
    title: "פגישת שיווק",
    transcript: [{ id: "seg_bet", speaker: "רון", startMs: 0, endMs: 5000, text: "יש חריגה קטנה בתקציב השיווק" }],
  }),
  testMeeting({
    id: "m_none",
    title: "גיוס",
    transcript: [{ id: "seg_none", speaker: "יעל", startMs: 0, endMs: 5000, text: "ראיינו שלושה מועמדים השבוע" }],
  }),
]

const scope: RepoScope = { kind: "member", workspaceId: "ws_a", userId: "user_me", email: "me@a.com", role: "member" }

function context(): SearchContext {
  const meetings = {
    listMeetings: async () => MEETINGS,
    getMeeting: async (id: string) => MEETINGS.find((meeting) => meeting.id === id),
  } as unknown as MeetingRepository

  return { scope, workspaceId: "ws_a", principalKey: "user_me", meetings }
}

const PARAMS: SearchParams = { q: "תקציב", filters: {}, group: "chunk", limit: 20, hitsPerMeeting: 3 }

function highlighted(hit: SearchHit): string[] {
  return hit.highlights.map(([start, end]) => hit.snippet.slice(start, end))
}

async function expectSurfaceForms(engine: SearchEngine) {
  setSearchEngineForTesting(engine)

  const response = await searchWorkspace(context(), PARAMS)
  const hits = response.hits ?? []
  const byMeeting = new Map(hits.map((hit) => [hit.meetingId, hit]))

  expect([...byMeeting.keys()].sort()).toEqual(["m_bet", "m_vav"])
  expect(highlighted(byMeeting.get("m_vav")!)).toContain("והתקציב")
  expect(highlighted(byMeeting.get("m_bet")!)).toContain("בתקציב")
  // Whole words only: never a bare fragment of the surface word.
  for (const hit of hits) {
    for (const mark of highlighted(hit)) expect(["והתקציב", "בתקציב"]).toContain(mark)
  }
}

afterEach(() => setSearchEngineForTesting(undefined))

describe("Hebrew prefix sanity (memory engine: A chunker + normalizer, B service)", () => {
  it("finds והתקציב and בתקציב for תקציב and highlights the whole word", async () => {
    await expectSurfaceForms(createMemorySearchEngine())
  })
})

describe("Hebrew prefix sanity (PGlite: A indexer + index store, B pg engine)", () => {
  let db: PgliteSearchDb | null = null

  beforeAll(async () => {
    db = await createPgliteSearchDb()
    if (!db) return

    await seedPgliteMeetings(db, MEETINGS)

    const index = createIndexer({
      loadMeeting: async (_workspaceId, meetingId) => MEETINGS.find((meeting) => meeting.id === meetingId),
      store: createIndexStore(db.client),
      capabilities: async () => ({
        vector: { available: false, tableReady: false, indexReady: false },
        trgm: { installed: true, hebrew: db!.hebrewTrigrams },
        embeddingKey: null,
        checkedAt: "now",
      }),
      provider: () => null,
      recordRun: async () => undefined,
    })

    for (const meeting of MEETINGS) {
      expect((await index({ workspaceId: "ws_a" }, meeting.id)).state).toBe("ready")
    }
  }, 120_000)

  afterAll(async () => {
    await db?.close()
  })

  it("indexes lexically and finds both surface forms with whole-word highlights", async () => {
    if (!db) return

    const engine = createPgSearchEngine({
      client: db.client,
      capabilities: async () => ({
        vector: { available: false, tableReady: false, indexReady: false },
        trgm: { installed: true, hebrew: db!.hebrewTrigrams },
        embeddingKey: null,
        checkedAt: "now",
      }),
    })

    await expectSurfaceForms(engine)
  })
})
