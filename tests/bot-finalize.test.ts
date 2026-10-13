import { createHash } from "node:crypto"

import { UnrecoverableError } from "bullmq"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  BotFinalizeBusyError,
  BotRecordingPendingError,
  finalizeBotSession,
  peekStream,
  type BotFinalizeStorage,
} from "@/lib/bot/finalize"
import { createMemoryBotSessionStore, type MemoryBotSessionStore } from "@/lib/bot/store-memory"
import type { BotSessionRecord } from "@/lib/bot/types"
import type { BotProvider, VexaMeeting, VexaTranscriptSegment } from "@/lib/bot/vexa/types"
import { UploadTooLargeError } from "@/lib/capture/media-validation"
import {
  createInMemoryMeetingDatabase,
  createInMemoryMeetingRepository,
  type MeetingRepository,
} from "@/lib/meetings/repository"

import { testMeeting } from "./helpers/route-ctx"

/**
 * M7 B4: recording → our storage (streamed, capped, checksummed) → one
 * `original` meeting_bot asset → meeting media_found → exactly one
 * media.ingest with the workspace, even across concurrent runs.
 */

const WS = "ws_1"

function wavBytes(dataBytes = 4096): Uint8Array {
  const header = Buffer.alloc(44)

  header.write("RIFF", 0, "latin1")
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write("WAVE", 8, "latin1")
  header.write("fmt ", 12, "latin1")

  return new Uint8Array(Buffer.concat([header, Buffer.alloc(dataBytes)]))
}

function streamOf(bytes: Uint8Array, chunk = 1000): ReadableStream<Uint8Array> {
  let offset = 0

  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close()
        return
      }
      controller.enqueue(bytes.slice(offset, offset + chunk))
      offset += chunk
    },
  })
}

function vexaMeeting(overrides: Partial<VexaMeeting> = {}): VexaMeeting {
  return {
    id: "4242",
    platform: "google_meet",
    nativeMeetingId: "abc-defg-hij",
    status: "completed",
    recordings: [
      {
        id: "rec1",
        startedAt: "2026-10-13T10:00:00.000Z",
        media: [{ id: "m1", type: "audio", contentType: "audio/wav", durationSeconds: 2700 }],
      },
    ],
    raw: {},
    ...overrides,
  }
}

function fakeProvider(options: {
  meeting?: VexaMeeting
  bytes?: Uint8Array
  contentLength?: number
  segments?: VexaTranscriptSegment[]
} = {}) {
  const bytes = options.bytes ?? wavBytes()

  return {
    getMeeting: vi.fn(async () => options.meeting ?? vexaMeeting()),
    getRecordingMaster: vi.fn(async () => ({ mediaId: "m_master", raw: {} })),
    streamRecordingMedia: vi.fn(async () => ({
      body: streamOf(bytes),
      contentType: "audio/wav",
      contentLength: options.contentLength,
    })),
    getTranscript: vi.fn(async () => ({ vexaMeetingId: "4242", segments: options.segments ?? [], raw: {} })),
  } as unknown as BotProvider & {
    streamRecordingMedia: ReturnType<typeof vi.fn>
    getMeeting: ReturnType<typeof vi.fn>
  }
}

function fakeStorage() {
  const objects = new Map<string, Buffer>()
  const storage: BotFinalizeStorage & { objects: typeof objects; deleted: string[] } = {
    objects,
    deleted: [],
    async storeStream(options) {
      const chunks: Buffer[] = []
      let size = 0

      for await (const chunk of options.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength
        if (size > options.maxBytes) throw new UploadTooLargeError(options.maxBytes)
        chunks.push(Buffer.from(chunk))
      }

      const body = Buffer.concat(chunks)
      const key = `${options.keyPrefix}/${options.filename}`

      objects.set(key, body)
      return { key, sizeBytes: body.length, checksumSha256: createHash("sha256").update(body).digest("hex") }
    },
    async deleteObject(key) {
      storage.deleted.push(key)
      objects.delete(key)
    },
  }

  return storage
}

let store: MemoryBotSessionStore
let meetings: MeetingRepository
let session: BotSessionRecord
const enqueueIngest = vi.fn<(...args: unknown[]) => Promise<{ id: string }>>(async () => ({ id: "job_ingest_1" }))

beforeEach(async () => {
  enqueueIngest.mockClear()
  store = createMemoryBotSessionStore()
  meetings = createInMemoryMeetingRepository(
    createInMemoryMeetingDatabase([
      testMeeting({ id: "meet_1", workspaceId: WS, status: "scheduled", source: "meeting_bot" }),
    ]),
    { kind: "system", workspaceId: WS }
  )
  session = await store.create({
    workspaceId: WS,
    meetingId: "meet_1",
    origin: "manual",
    platform: "google_meet",
    nativeMeetingId: "abc-defg-hij",
    botName: "MeetSum Notetaker",
    status: "requested",
  })
  await store.update(session.id, { vexaMeetingId: "4242" }, { workspaceId: WS })
  await store.transition(session.id, { status: "active", at: "2026-10-13T10:00:00Z", source: "webhook", workspaceId: WS })
  session = (await store.transition(session.id, {
    status: "completed",
    at: "2026-10-13T10:45:00Z",
    source: "webhook",
    workspaceId: WS,
  }))!.session
})

function run(overrides: Partial<Parameters<typeof finalizeBotSession>[0]> = {}) {
  return finalizeBotSession({
    sessionId: session.id,
    workspaceId: WS,
    provider: fakeProvider(),
    storage: fakeStorage(),
    store,
    meetings,
    enqueueIngest: enqueueIngest as never,
    maxBytes: 1_000_000,
    ...overrides,
  })
}

describe("finalizeBotSession", () => {
  it("stores the recording as an original meeting_bot asset and enqueues media.ingest", async () => {
    const storage = fakeStorage()
    const statusSpy = vi.spyOn(meetings, "updateMeetingStatus")
    const result = await run({ storage })

    expect(result).toEqual({ status: "imported", assetId: expect.any(String), ingestJobId: "job_ingest_1" })
    expect(statusSpy).toHaveBeenCalledWith("meet_1", "media_found")

    const meeting = await meetings.getMeeting("meet_1")
    const asset = meeting?.mediaAssets?.[0]

    expect(meeting?.mediaAssets).toHaveLength(1)
    expect(asset).toMatchObject({
      kind: "original",
      source: "meeting_bot",
      sourceFileId: "vexa:rec1:m1",
      contentType: "audio/wav",
      retention: "audio",
      sizeBytes: wavBytes().length,
      checksumSha256: createHash("sha256").update(wavBytes()).digest("hex"),
      metadata: { vexaMeetingId: "4242", platform: "google_meet", botSessionId: session.id },
    })
    expect(asset?.storageKey).toBe(`meetings/meet_1/bot-${session.id}.wav`)
    expect([...storage.objects.keys()]).toEqual([asset?.storageKey])
    expect(enqueueIngest).toHaveBeenCalledWith(
      "media.ingest",
      { meetingId: "meet_1", workspaceId: WS, assetId: asset?.id, source: "meeting_bot", botSessionId: session.id },
      { jobId: `media.ingest:bot:${session.id}` }
    )
    expect(await store.get(session.id, { workspaceId: WS })).toMatchObject({
      recordingStatus: "imported",
      ingestJobId: "job_ingest_1",
      mediaAssetId: asset?.id,
    })
  })

  it("enqueues media.ingest once across two concurrent calls", async () => {
    const results = await Promise.allSettled([run(), run()])

    expect(enqueueIngest).toHaveBeenCalledTimes(1)
    expect((await meetings.getMeeting("meet_1"))?.mediaAssets).toHaveLength(1)
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.any(BotFinalizeBusyError),
    })
    expect(await run()).toEqual({ status: "skipped", reason: "already_imported" })
    expect(enqueueIngest).toHaveBeenCalledTimes(1)
  })

  it("reuses an existing asset instead of downloading again", async () => {
    const provider = fakeProvider()

    await meetings.createMediaAsset({
      meetingId: "meet_1",
      storageKey: "meetings/meet_1/existing.wav",
      contentType: "audio/wav",
      sizeBytes: 10,
      source: "meeting_bot",
      sourceFileId: "vexa:rec1:m1",
    })

    const result = await run({ provider })

    expect(result.status).toBe("imported")
    expect(provider.streamRecordingMedia).not.toHaveBeenCalled()
  })

  it("marks the recording pending and throws a retryable error when none exists yet", async () => {
    const error = await run({ provider: fakeProvider({ meeting: vexaMeeting({ recordings: [] }) }) }).catch(
      (caught: unknown) => caught
    )

    expect(error).toBeInstanceOf(BotRecordingPendingError)
    expect(error).not.toBeInstanceOf(UnrecoverableError)
    expect((await store.get(session.id, { workspaceId: WS }))?.recordingStatus).toBe("pending")
  })

  it("marks the recording missing on the final attempt", async () => {
    const result = await run({
      provider: fakeProvider({ meeting: vexaMeeting({ recordings: [] }) }),
      finalAttempt: true,
    })

    expect(result).toEqual({ status: "missing" })
    expect(await store.get(session.id, { workspaceId: WS })).toMatchObject({
      recordingStatus: "missing",
      statusReason: "no_recording",
    })
    expect(enqueueIngest).not.toHaveBeenCalled()
  })

  it("deletes the stored object when creating the asset fails", async () => {
    const storage = fakeStorage()

    vi.spyOn(meetings, "createMediaAsset").mockRejectedValueOnce(new Error("db down"))

    await expect(run({ storage })).rejects.toThrow("db down")
    expect(storage.deleted).toHaveLength(1)
    expect(storage.objects.size).toBe(0)
    expect((await store.get(session.id, { workspaceId: WS }))?.recordingStatus).toBe("pending")
  })

  it("respects the size cap while streaming and from Content-Length", async () => {
    const storage = fakeStorage()
    const streamed = await run({ storage, maxBytes: 1000 }).catch((caught: unknown) => caught)

    expect(streamed).toBeInstanceOf(UnrecoverableError)
    expect(storage.objects.size).toBe(0)
    expect((await store.get(session.id, { workspaceId: WS }))?.recordingStatus).toBe("failed")

    await store.update(session.id, { recordingStatus: "none" }, { workspaceId: WS })
    const provider = fakeProvider({ contentLength: 5_000_000 })
    const declared = await run({ provider, maxBytes: 1000 }).catch((caught: unknown) => caught)

    expect(declared).toBeInstanceOf(UnrecoverableError)
    expect(enqueueIngest).not.toHaveBeenCalled()
  })

  it("rejects non-media bytes permanently", async () => {
    const error = await run({
      provider: fakeProvider({ bytes: new TextEncoder().encode("<html>not audio</html>") }),
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(UnrecoverableError)
  })

  it("skips a deleted meeting and an already imported session", async () => {
    await store.update(session.id, { meetingId: null }, { workspaceId: WS })
    expect(await run()).toEqual({ status: "skipped", reason: "meeting_deleted" })

    await store.update(session.id, { meetingId: "meet_1", recordingStatus: "imported", ingestJobId: "j" }, { workspaceId: WS })
    expect(await run()).toEqual({ status: "skipped", reason: "already_imported" })
  })

  it("refuses a session id from another workspace", async () => {
    await expect(run({ workspaceId: "ws_2" })).rejects.toBeInstanceOf(UnrecoverableError)
    expect(enqueueIngest).not.toHaveBeenCalled()
  })

  it("stores the bot speaker timeline when transcription was enabled", async () => {
    await store.update(session.id, { transcribeEnabled: true }, { workspaceId: WS })

    const provider = fakeProvider({
      segments: [
        { segmentId: "s1", speaker: "Dana Cohen", text: "שלום", start: 1, end: 3, absoluteStartTime: "2026-10-13T10:00:01.000Z" },
        { segmentId: "s2", speaker: "MeetSum Notetaker", text: "recording", start: 3, end: 4 },
        { segmentId: "s3", speaker: "Avi", text: "היי", start: 5, end: 6 },
      ],
    })

    await run({ provider })

    expect((await store.get(session.id, { workspaceId: WS }))?.speakerTimeline).toEqual([
      { name: "Dana Cohen", startMs: 1000, endMs: 3000 },
      { name: "Avi", startMs: 5000, endMs: 6000 },
    ])
  })
})

describe("peekStream", () => {
  it("returns the head without losing bytes", async () => {
    const bytes = wavBytes(100)
    const { head, body } = await peekStream(streamOf(bytes, 7), 16)
    const chunks: Uint8Array[] = []

    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk)

    expect(Buffer.from(head).toString("latin1", 0, 4)).toBe("RIFF")
    expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))).toEqual(Buffer.from(bytes))
  })
})
