import { describe, expect, it, vi } from "vitest"

import { createHashEmbeddingProvider } from "@/lib/ai/embeddings/hash"
import { EmbeddingError, type EmbeddingProvider } from "@/lib/ai/embeddings/types"
import type { MeetingIntelligence } from "@/lib/intelligence/types"
import type { MeetingRecord, TranscriptSegment } from "@/lib/meetings/repository"
import {
  IndexMeetingMissingError,
  IndexVersionConflictError,
  type IndexStore,
  type IndexWrite,
} from "@/lib/search/index-store"
import { createIndexer, IndexEmbeddingFailedError } from "@/lib/search/indexer"
import type { SearchCapabilities } from "@/lib/search/types"

const WS = "ws_1"

function segments(count: number, edit?: { index: number; text: string }): TranscriptSegment[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `seg_${index}`,
    speaker: index % 4 < 2 ? "דנה" : "Avi",
    turnIndex: Math.floor(index / 2),
    startMs: index * 5_000,
    endMs: index * 5_000 + 4_000,
    text:
      edit?.index === index
        ? edit.text
        : `בפגישה מספר ${index} דיברנו על התקציב של הרבעון ועל ההשקה הקרובה בשוק המקומי.`,
    language: "he",
  }))
}

function intelligence(meetingType = "budget_review"): MeetingIntelligence {
  return {
    overview: "סקרנו את התקציב.",
    decisions: [],
    actionItems: [],
    risks: [],
    openQuestions: [],
    commitments: [],
    followUpDraft: "",
    timestampedQuotes: [],
    tags: [],
    languageMetadata: { primaryLanguage: "he", secondaryLanguages: [], segmentLanguages: [], confidence: 1, mixedLanguage: false },
    version: 2,
    meetingType,
  }
}

function meeting(overrides: Partial<MeetingRecord> = {}): MeetingRecord {
  return {
    id: "m1",
    workspaceId: WS,
    title: "סקירת תקציב",
    source: "upload",
    language: "he",
    status: "ready",
    retention: "audio",
    startedAt: "2026-10-12T07:30:00.000Z",
    participants: [],
    transcript: segments(80),
    transcriptVersion: 3,
    intelligence: intelligence(),
    ...overrides,
  }
}

const READY: SearchCapabilities = {
  vector: { available: true, installedVersion: "0.8.1", tableReady: true, indexReady: true },
  trgm: { installed: true, hebrew: true },
  embeddingKey: { model: "hash-test", dimensions: 256 },
  checkedAt: "",
}

const NO_VECTOR: SearchCapabilities = {
  vector: { available: false, tableReady: false, indexReady: false, reason: "vector_unavailable" },
  trgm: { installed: true, hebrew: true },
  embeddingKey: { model: "hash-test", dimensions: 256 },
  checkedAt: "",
}

/** In-memory stand-in for index-store.ts with the same write semantics. */
function fakeStore(version = 3) {
  const state = {
    version,
    exists: true,
    vectors: new Map<string, Set<string>>(),
    writes: [] as IndexWrite[],
    skipped: 0,
    failed: [] as string[],
  }
  const keyId = (key: { model: string; dimensions: number }) => `${key.model}:${key.dimensions}`
  const store: IndexStore = {
    async existingHashes(_ws, _meetingId, key) {
      return new Set(state.vectors.get(keyId(key)) ?? [])
    },
    async writeIndex(write) {
      if (!state.exists) throw new IndexMeetingMissingError(write.meetingId)
      if (write.expectedVersion !== state.version) throw new IndexVersionConflictError(write.expectedVersion, state.version)
      state.writes.push(write)
      if (write.vectorTable && write.key) {
        const id = keyId(write.key)
        const current = state.vectors.get(id) ?? new Set<string>()
        const hashes = new Set(write.chunks.map((chunk) => chunk.contentHash))

        for (const vector of write.vectors) current.add(vector.contentHash)
        state.vectors.set(id, new Set([...current].filter((hash) => hashes.has(hash))))
        if (write.coversAllChunks) {
          for (const other of [...state.vectors.keys()]) if (other !== id) state.vectors.delete(other)
        }
      }
    },
    async markSkipped() {
      state.skipped += 1
    },
    async markFailed(_ws, _meetingId, error) {
      state.failed.push(error)
    },
  }

  return { store, state }
}

function setup(options: { record?: MeetingRecord; caps?: SearchCapabilities; provider?: EmbeddingProvider | null } = {}) {
  const { store, state } = fakeStore()
  const provider = options.provider === undefined ? createHashEmbeddingProvider() : options.provider
  const embed = provider ? vi.spyOn(provider, "embed") : undefined
  const recordRun = vi.fn(async () => undefined)
  let record = options.record ?? meeting()
  const index = createIndexer({
    loadMeeting: async (workspaceId, meetingId) =>
      workspaceId === WS && meetingId === record.id ? record : undefined,
    store,
    capabilities: async () => options.caps ?? READY,
    provider: () => provider,
    recordRun,
    now: () => new Date("2026-10-13T10:00:00.000Z"),
  })

  return {
    state,
    embed,
    recordRun,
    run: () => index({ workspaceId: WS }, "m1", { jobId: "job_1" }),
    setRecord: (next: MeetingRecord) => {
      record = next
    },
  }
}

describe("indexMeeting", () => {
  it("indexes chunks and vectors (hybrid), then a second run embeds nothing", async () => {
    const ctx = setup()
    const first = await ctx.run()

    expect(first.state).toBe("ready")
    expect(first.mode).toBe("hybrid")
    expect(first.embedded).toBeGreaterThan(0)
    expect(first.reused).toBe(0)
    const write = ctx.state.writes[0]

    expect(write).toMatchObject({
      workspaceId: WS,
      meetingId: "m1",
      expectedVersion: 3,
      mode: "hybrid",
      coversAllChunks: true,
      meetingType: "budget_review",
      key: { model: "hash-test", dimensions: 256 },
    })
    expect(write.startedAt.toISOString()).toBe("2026-10-13T10:00:00.000Z")
    expect(write.chunks.map((chunk) => chunk.kind)).toEqual(expect.arrayContaining(["transcript", "meta", "summary"]))
    expect(ctx.embed?.mock.calls[0][0][0].title).toBe("סקירת תקציב")
    expect(ctx.embed?.mock.calls[0][1].task).toBe("RETRIEVAL_DOCUMENT")
    expect(ctx.recordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "completed",
        workspaceId: WS,
        meetingId: "m1",
        jobId: "job_1",
        metadata: expect.objectContaining({ chunks: write.chunks.length, embedded: first.embedded, reused: 0 }),
      })
    )

    const second = await ctx.run()

    expect(second).toMatchObject({ state: "ready", mode: "hybrid", embedded: 0, reused: first.embedded })
    expect(ctx.embed).toHaveBeenCalledTimes(1)
    expect(ctx.recordRun).toHaveBeenCalledTimes(1)
  })

  it("re-embeds at most two chunks after a one-segment edit", async () => {
    const ctx = setup()

    await ctx.run()
    ctx.setRecord(
      meeting({
        transcript: segments(80, {
          index: 41,
          text: "בפגישה מספר 41 דיברנו על התכנון של הרבעון ועל ההשקה הקרובה בשוק המקומי.",
        }),
      })
    )
    const result = await ctx.run()

    expect(result.embedded).toBeGreaterThan(0)
    expect(result.embedded).toBeLessThanOrEqual(2)
  })

  it("writes chunks lexically without vector capability", async () => {
    const ctx = setup({ caps: NO_VECTOR })
    const result = await ctx.run()

    expect(result).toMatchObject({ state: "ready", mode: "lexical", embedded: 0, reused: 0 })
    expect(ctx.state.writes[0]).toMatchObject({ mode: "lexical", vectorTable: false, vectors: [] })
    expect(ctx.state.writes[0].chunks.length).toBeGreaterThan(0)
    expect(ctx.embed).not.toHaveBeenCalled()
  })

  it("writes chunks lexically without an embedding provider", async () => {
    const ctx = setup({ provider: null })

    await expect(ctx.run()).resolves.toMatchObject({ state: "ready", mode: "lexical" })
    expect(ctx.state.writes[0]).toMatchObject({ key: null, coversAllChunks: false })
  })

  it("re-embeds everything on a key change and removes the old key's vectors", async () => {
    const ctx = setup({ provider: createHashEmbeddingProvider({ model: "hash-test", dimensions: 256 }) })

    await ctx.run()
    const next = setup({ provider: createHashEmbeddingProvider({ model: "hash-test", dimensions: 128 }) })

    next.state.vectors = ctx.state.vectors
    const result = await next.run()

    expect(result.embedded).toBe(new Set(next.state.writes[0].chunks.map((chunk) => chunk.contentHash)).size)
    expect([...next.state.vectors.keys()]).toEqual(["hash-test:128"])
  })

  it("throws a retryable error when the transcript changes while indexing", async () => {
    const ctx = setup()

    ctx.state.version = 4
    await expect(ctx.run()).rejects.toBeInstanceOf(IndexVersionConflictError)
    await expect(ctx.run()).rejects.toMatchObject({ retryable: true })
  })

  it("skips a meeting with no transcript and no intelligence (no throw)", async () => {
    const ctx = setup({ record: meeting({ transcript: [], intelligence: undefined, summary: undefined }) })

    await expect(ctx.run()).resolves.toEqual({ state: "skipped", chunks: 0, embedded: 0, reused: 0 })
    expect(ctx.state.skipped).toBe(1)
    expect(ctx.state.writes).toHaveLength(0)
  })

  it("indexes intelligence alone before transcription and a missing meeting is skipped", async () => {
    const ctx = setup({ record: meeting({ transcript: [] }) })

    await expect(ctx.run()).resolves.toMatchObject({ state: "ready" })
    expect(ctx.state.writes[0].chunks.some((chunk) => chunk.kind === "transcript")).toBe(false)

    const gone = setup()

    gone.state.exists = false
    await expect(gone.run()).resolves.toMatchObject({ state: "skipped" })
    const foreign = setup({ record: meeting({ workspaceId: "ws_other" }) })

    await expect(foreign.run()).resolves.toMatchObject({ state: "skipped" })
    expect(foreign.state.writes).toHaveLength(0)
  })

  it("writes meeting_type from the intelligence (null when absent)", async () => {
    const typed = setup({ record: meeting({ intelligence: intelligence("hiring") }) })

    await typed.run()
    expect(typed.state.writes[0].meetingType).toBe("hiring")

    const untyped = setup({ record: meeting({ intelligence: { ...intelligence(), meetingType: undefined } }) })

    await untyped.run()
    expect(untyped.state.writes[0].meetingType).toBeNull()
  })

  it("marks failed and throws when embedding fails with no usable vectors", async () => {
    const provider = createHashEmbeddingProvider()

    vi.spyOn(provider, "embed").mockRejectedValue(new EmbeddingError("quota", "rate_limit", true))
    const ctx = setup({ provider })

    await expect(ctx.run()).rejects.toBeInstanceOf(IndexEmbeddingFailedError)
    expect(ctx.state.failed).toHaveLength(1)
    expect(ctx.state.writes).toHaveLength(0)
    expect(ctx.recordRun).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", error: "rate_limit: quota" }))
  })

  it("continues lexically for the misses when some vectors already exist", async () => {
    const provider = createHashEmbeddingProvider()
    const ctx = setup({ provider })

    await ctx.run()
    ctx.setRecord(meeting({ transcript: segments(80, { index: 10, text: "שינוי קטן בתקציב" }) }))
    vi.spyOn(provider, "embed").mockRejectedValue(new EmbeddingError("down", "server", true))

    const result = await ctx.run()

    expect(result).toMatchObject({ state: "ready", mode: "lexical", embedded: 0 })
    expect(result.reused).toBeGreaterThan(0)
    expect(ctx.state.writes[1]).toMatchObject({ mode: "lexical", coversAllChunks: false })
    expect(ctx.recordRun).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed" }))
  })
})
