import { UnrecoverableError } from "bullmq"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { SmartTask } from "@/lib/intelligence"
import type { MeetSumJob } from "@/lib/jobs/processor"
import {
  createInMemoryMeetingRepository,
  type MeetingRepository,
} from "@/lib/meetings/repository"

const mocks = vi.hoisted(() => ({
  repository: undefined as unknown as MeetingRepository,
  transcribe: vi.fn(),
  transcriptionRun: undefined as unknown,
  summarize: vi.fn(),
  summaryRun: undefined as unknown,
  query: vi.fn(),
  deliverWebhookEvent: vi.fn(),
  processWebhookDeliveryJob: vi.fn(),
  importPlatformRecording: vi.fn(),
  renewTeamsSubscriptions: vi.fn(),
  repositoryWorkspaces: [] as string[],
  pollCalendar: vi.fn(),
  applyMediaRetention: vi.fn(),
  refreshSuggestions: vi.fn(),
  loadMeetTimeline: vi.fn(),
  glossary: vi.fn(),
  enqueue: vi.fn(),
  prepare: vi.fn(),
  deleteObjects: vi.fn(),
  audit: vi.fn(),
}))

vi.mock("@/lib/jobs/queue", () => ({ enqueueMeetSumJob: mocks.enqueue }))

vi.mock("@/lib/media/prepare", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/media/prepare")>()

  return { ...actual, prepareMediaAsset: mocks.prepare }
})

vi.mock("@/lib/storage/object-storage", () => ({
  deleteMeetingObjects: mocks.deleteObjects,
}))

vi.mock("@/lib/audit", () => ({ recordAuditLog: mocks.audit }))

vi.mock("@/lib/meetings/store", () => {
  const repository = new Proxy(
    {},
    {
      get(_target, property) {
        const value = Reflect.get(mocks.repository, property, mocks.repository)
        return typeof value === "function" ? value.bind(mocks.repository) : value
      },
    }
  )

  return {
    getSystemMeetingRepository: (workspaceId: string) => {
      mocks.repositoryWorkspaces.push(workspaceId)
      return repository
    },
    resolveMeetingWorkspaceId: async (meetingId: string) =>
      (await mocks.repository.getMeeting(meetingId)) ? "ws_1" : undefined,
  }
})

vi.mock("@/lib/ai/asr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/asr")>()

  return { ...actual, transcribeWithRouter: mocks.transcribe }
})

vi.mock("@/lib/settings/asr-glossary", () => ({
  getAsrGlossary: mocks.glossary,
}))

vi.mock("@/lib/meetings/speakers/suggest", () => ({
  refreshSpeakerSuggestions: mocks.refreshSuggestions,
}))

vi.mock("@/lib/ai/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/providers")>()

  return {
    ...actual,
    createSummaryProvider: () => ({
      id: "gemini",
      model: "gemini-3.5-flash",
      summarize: mocks.summarize,
      getLastRun: () =>
        mocks.summaryRun ?? { provider: "gemini", model: "gemini-3.5-flash" },
    }),
  }
})

vi.mock("@/lib/db/client", () => ({
  getDatabasePool: () => ({ query: mocks.query }),
}))

vi.mock("@/lib/webhooks/delivery", () => ({
  deliverWebhookEvent: mocks.deliverWebhookEvent,
  processWebhookDeliveryJob: mocks.processWebhookDeliveryJob,
}))

vi.mock("@/lib/capture/recording-import", () => ({
  importPlatformRecording: mocks.importPlatformRecording,
}))

vi.mock("@/lib/capture/teams-subscriptions", () => ({
  renewTeamsSubscriptions: mocks.renewTeamsSubscriptions,
  isTeamsSubscriptionConfigured: () => false,
}))

vi.mock("@/lib/google/meet-artifacts", () => ({
  importMeetRecordingArtifactsForMeeting: vi.fn(),
  importMeetTranscriptArtifactsForMeeting: vi.fn(),
  loadMeetTimelineForMeeting: mocks.loadMeetTimeline,
  syncMeetArtifacts: vi.fn(),
}))

vi.mock("@/lib/storage/retention", () => ({
  applyMediaRetention: mocks.applyMediaRetention,
}))

vi.mock("@/lib/google/services", () => ({
  pollCalendar: mocks.pollCalendar,
  pollDrive: vi.fn(),
  pollGmail: vi.fn(),
}))

vi.mock("@/lib/integrations/realizeos", () => ({
  exportMeetingToRealizeOS: vi.fn(),
}))

const { processJob } = await import("@/lib/jobs/processor")
const { TranscriptionUnavailableError } = await import("@/lib/ai/providers")
const { AsrChainError, AsrError } = await import("@/lib/ai/asr")

type RouterResult = Awaited<ReturnType<typeof import("@/lib/ai/asr").transcribeWithRouter>>

/** A synthetic diarized router result (two speakers, word timings). */
function routerResult(overrides: Partial<RouterResult> = {}): RouterResult {
  return {
    provider: "runpod-ivrit",
    model: "ivrit-ai/whisper-large-v3-turbo-ct2",
    language: "he",
    durationMs: 120_000,
    segments: [
      {
        startMs: 0,
        endMs: 2_000,
        text: "שלום, אני דנה",
        speaker: "Speaker 1",
        turnIndex: 0,
        confidence: 0.9,
        language: "he",
        words: [
          { startMs: 0, endMs: 600, text: "שלום,", confidence: 0.9 },
          { startMs: 700, endMs: 1_200, text: "אני", confidence: 0.95 },
          { startMs: 1_300, endMs: 2_000, text: "דנה", confidence: 0.85 },
        ],
      },
      {
        startMs: 2_500,
        endMs: 4_000,
        text: "Supabase מוכן",
        speaker: "Speaker 2",
        turnIndex: 1,
        confidence: 0.7,
        language: "he",
        words: [
          { startMs: 2_500, endMs: 3_200, text: "Supabase", confidence: 0.6, language: "en" },
        ],
      },
    ],
    speakers: [
      { label: "Speaker 1", talkTimeMs: 2_000, wordCount: 3, segmentCount: 1, firstStartMs: 0 },
      { label: "Speaker 2", talkTimeMs: 1_500, wordCount: 1, segmentCount: 1, firstStartMs: 2_500 },
    ],
    diarization: "provider",
    cost: { usd: 0.0123, basis: "gpu_seconds", billedSeconds: 64.7, unitPrice: 0.00019 },
    timings: { queueMs: 900, executionMs: 64_700 },
    glossaryReplacements: 2,
    warnings: [],
    attempts: [{ provider: "runpod-ivrit", ok: true, elapsedMs: 66_000 }],
    fallbackUsed: false,
    ...overrides,
  }
}

function aiRunInserts() {
  return mocks.query.mock.calls
    .filter(([sql]) => typeof sql === "string" && sql.includes("insert into ai_runs"))
    .map(([, values]) => values as unknown[])
}

function task(id: string, title: string): SmartTask {
  return {
    id,
    title,
    status: "open",
    priority: "normal",
    confidence: 0.8,
    sourceQuote: title,
    sourceStartMs: 0,
    kind: "explicit",
  }
}

function intelligenceWith(actionItems: SmartTask[]) {
  return {
    overview: "Overview",
    decisions: [],
    actionItems,
    risks: [],
    openQuestions: [],
    commitments: [],
    followUpDraft: "",
    timestampedQuotes: [],
    tags: ["hebrew"],
    languageMetadata: {
      primaryLanguage: "he",
      detectedLanguages: ["he"],
      mixedLanguage: false,
      confidence: 0.9,
    },
  }
}

async function seedMeeting() {
  const meeting = await mocks.repository.createMeeting({
    title: "Weekly sync",
    source: "upload",
    language: "he",
    startedAt: "2026-04-23T09:00:00.000Z",
  })

  return meeting
}

async function addAsset(meetingId: string, storageKey: string) {
  return mocks.repository.createMediaAsset({
    meetingId,
    storageKey,
    contentType: "audio/mp4",
    sizeBytes: 100,
  })
}

async function makeJob(
  name: MeetSumJob["name"],
  data: Record<string, unknown>,
  options: { attemptsMade?: number; attempts?: number; createRecord?: boolean } = {}
) {
  let jobRecordId: string | undefined

  if (options.createRecord !== false) {
    const record = await mocks.repository.createJob({
      name,
      meetingId: typeof data.meetingId === "string" ? data.meetingId : undefined,
      payload: data,
      maxAttempts: options.attempts ?? 3,
    })
    jobRecordId = record.id
  }

  return {
    id: jobRecordId ?? "bull_job",
    name,
    data: { ...data, jobRecordId },
    attemptsMade: options.attemptsMade ?? 0,
    opts: { attempts: options.attempts ?? 3 },
  } as unknown as MeetSumJob
}

function eventsNamed(name: string) {
  return mocks.deliverWebhookEvent.mock.calls
    .map(([event]) => event)
    .filter((event) => event.eventName === name)
}

beforeEach(() => {
  mocks.repository = createInMemoryMeetingRepository()
  mocks.transcriptionRun = undefined
  mocks.summaryRun = undefined
  mocks.transcribe.mockReset().mockResolvedValue(routerResult())
  mocks.glossary.mockReset().mockResolvedValue({
    version: 1,
    terms: [{ term: "Supabase", aliases: ["סופרבייס"], hotword: true }],
  })
  mocks.refreshSuggestions.mockReset().mockResolvedValue(1)
  mocks.loadMeetTimeline.mockReset().mockResolvedValue(undefined)
  mocks.summarize.mockReset().mockResolvedValue(intelligenceWith([task("t1", "Send deck")]))
  mocks.query.mockReset().mockResolvedValue({ rows: [] })
  mocks.deliverWebhookEvent.mockReset().mockResolvedValue({ delivered: 0 })
  mocks.processWebhookDeliveryJob.mockReset()
  mocks.importPlatformRecording.mockReset()
  mocks.renewTeamsSubscriptions.mockReset()
  mocks.pollCalendar.mockReset()
  mocks.applyMediaRetention.mockReset()
  mocks.enqueue.mockReset().mockResolvedValue({ id: "job_prepare" })
  mocks.prepare.mockReset().mockResolvedValue({ status: "prepared", playback: "none" })
  mocks.deleteObjects.mockReset().mockImplementation(async (keys: string[]) => ({
    deleted: keys,
    failed: [],
  }))
  mocks.audit.mockReset().mockResolvedValue(undefined)
  mocks.repositoryWorkspaces.length = 0
  process.env.MEETSUM_STORAGE = "postgres"
})

afterEach(() => {
  delete process.env.MEETSUM_STORAGE
})

describe("processJob media pipeline", () => {
  it("transcribes the asset named by payload.assetId, not the newest one", async () => {
    const meeting = await seedMeeting()
    const target = await addAsset(meeting.id, "meetings/a/first.m4a")
    await addAsset(meeting.id, "meetings/a/second.m4a")
    const job = await makeJob("media.ingest", { meetingId: meeting.id, assetId: target.id })

    const result = await processJob(job)

    expect(result).toMatchObject({ meetingId: meeting.id, assetId: target.id })
    const request = mocks.transcribe.mock.calls[0][0]
    expect(request.media).toMatchObject({ kind: "object", storageKey: target.storageKey })

    const transcribeRun = mocks.query.mock.calls.find(
      ([, values]) => values[3] === "audio.transcribe"
    )
    expect(JSON.parse(transcribeRun![1][5])).toMatchObject({ inputAsset: target.id })
    expect(transcribeRun![1][11]).toBe(job.data.jobRecordId)
    expect((await mocks.repository.getMeeting(meeting.id))?.status).toBe("completed")
  })

  it("fails permanently when payload.assetId is unknown", async () => {
    const meeting = await seedMeeting()
    await addAsset(meeting.id, "meetings/a/first.m4a")
    const job = await makeJob("media.ingest", { meetingId: meeting.id, assetId: "asset_missing" })

    await expect(processJob(job)).rejects.toBeInstanceOf(UnrecoverableError)

    expect(mocks.transcribe).not.toHaveBeenCalled()
    expect((await mocks.repository.getJob(String(job.data.jobRecordId)))?.status).toBe("failed")
    expect((await mocks.repository.getMeeting(meeting.id))?.status).toBe("failed")
    expect(eventsNamed("meeting.process_failed")).toHaveLength(1)
    expect(eventsNamed("meeting.process_failed")[0].data).toMatchObject({ permanent: true })
  })

  it("keeps a transient failure on attempt 1/3 queued without failing the meeting", async () => {
    const meeting = await seedMeeting()
    await addAsset(meeting.id, "meetings/a/first.m4a")
    mocks.transcribe.mockRejectedValue(new Error("ASR timeout"))
    const job = await makeJob("media.ingest", { meetingId: meeting.id }, { attemptsMade: 0 })

    await expect(processJob(job)).rejects.toThrow("ASR timeout")

    const record = await mocks.repository.getJob(String(job.data.jobRecordId))
    expect(record).toMatchObject({ status: "queued", error: "ASR timeout", attempts: 1 })
    expect((await mocks.repository.getMeeting(meeting.id))?.status).not.toBe("failed")
    expect(eventsNamed("meeting.process_failed")).toHaveLength(0)
  })

  it("fails the meeting with exactly one event on the final attempt 3/3", async () => {
    const meeting = await seedMeeting()
    await addAsset(meeting.id, "meetings/a/first.m4a")
    mocks.transcribe.mockRejectedValue(new Error("ASR timeout"))
    const job = await makeJob("media.ingest", { meetingId: meeting.id }, { attemptsMade: 2 })

    await expect(processJob(job)).rejects.toThrow("ASR timeout")

    const record = await mocks.repository.getJob(String(job.data.jobRecordId))
    expect(record).toMatchObject({ status: "failed", attempts: 3 })
    expect((await mocks.repository.getMeeting(meeting.id))?.status).toBe("failed")
    const failures = eventsNamed("meeting.process_failed")
    expect(failures).toHaveLength(1)
    expect(failures[0].data).toMatchObject({ attempts: 3, permanent: false })
  })

  it("does not fail a processed meeting when a non-processing job (export) fails", async () => {
    const meeting = await seedMeeting()
    await mocks.repository.updateMeetingStatus(meeting.id, "completed")
    const realizeos = await import("@/lib/integrations/realizeos")
    vi.mocked(realizeos.exportMeetingToRealizeOS).mockRejectedValue(
      new Error("RealizeOS unavailable")
    )
    const job = await makeJob("realizeos.export", { meetingId: meeting.id }, { attemptsMade: 2 })

    await expect(processJob(job)).rejects.toThrow()

    expect((await mocks.repository.getJob(String(job.data.jobRecordId)))?.status).toBe("failed")
    expect((await mocks.repository.getMeeting(meeting.id))?.status).toBe("completed")
    expect(eventsNamed("meeting.process_failed")).toHaveLength(0)
  })

  it("treats TranscriptionUnavailableError as permanent and records a failed ai_run", async () => {
    const meeting = await seedMeeting()
    await addAsset(meeting.id, "meetings/a/first.m4a")
    mocks.transcribe.mockRejectedValue(new TranscriptionUnavailableError("No ASR configured"))
    const job = await makeJob("media.ingest", { meetingId: meeting.id }, { attemptsMade: 0 })

    await expect(processJob(job)).rejects.toBeInstanceOf(UnrecoverableError)

    expect((await mocks.repository.getMeeting(meeting.id))?.status).toBe("failed")
    const failedRun = mocks.query.mock.calls.find(([, values]) => values[4] === "failed")
    expect(failedRun?.[1]).toEqual(
      expect.arrayContaining(["audio.transcribe", "failed", "No ASR configured"])
    )
  })

  it("records a failed ai_run when summarization throws", async () => {
    const meeting = await seedMeeting()
    await addAsset(meeting.id, "meetings/a/first.m4a")
    mocks.summarize.mockRejectedValue(new Error("Gemini 503"))
    const job = await makeJob("media.ingest", { meetingId: meeting.id })

    await expect(processJob(job)).rejects.toThrow("Gemini 503")

    const failedRun = mocks.query.mock.calls.find(
      ([, values]) => values[3] === "summary.generate" && values[4] === "failed"
    )
    expect(failedRun?.[1][10]).toBe("Gemini 503")
  })

  it("records the summary provider/model reported by getLastRun", async () => {
    const meeting = await seedMeeting()
    await addAsset(meeting.id, "meetings/a/first.m4a")
    mocks.summaryRun = {
      provider: "heuristic",
      model: "heuristic-v1",
      fallbackUsed: true,
      fallbackReason: "Gemini returned unparseable output",
    }
    const job = await makeJob("media.ingest", { meetingId: meeting.id })

    await processJob(job)

    const summaryRun = mocks.query.mock.calls.find(
      ([, values]) => values[3] === "summary.generate"
    )
    expect(summaryRun?.[1][2]).toBe("heuristic")
    expect(summaryRun?.[1][6]).toBe("heuristic-v1")
    expect(JSON.parse(summaryRun![1][5])).toMatchObject({ fallbackUsed: true })
  })

  it("emits action_item.created only for newly created action items", async () => {
    const meeting = await seedMeeting()
    await addAsset(meeting.id, "meetings/a/first.m4a")
    mocks.summarize.mockResolvedValue(intelligenceWith([task("t1", "Send deck")]))
    await processJob(await makeJob("media.ingest", { meetingId: meeting.id }))
    expect(eventsNamed("action_item.created")).toHaveLength(1)

    mocks.deliverWebhookEvent.mockClear()
    mocks.summarize.mockResolvedValue(
      intelligenceWith([task("t9", "Send deck"), task("t10", "Book venue")])
    )
    await processJob(await makeJob("media.ingest", { meetingId: meeting.id }))

    const created = eventsNamed("action_item.created")
    expect(created).toHaveLength(1)
    expect(created[0].data).toMatchObject({ actionItemId: "t10", title: "Book venue" })
  })

  it("downloads a Zoom recording when the meeting has no asset yet", async () => {
    const meeting = await seedMeeting()
    const captureEvent = {
      platform: "zoom",
      eventType: "recording.available",
      externalId: "zoom-uuid",
      title: "Zoom",
      startedAt: "2026-04-23T09:00:00.000Z",
      participants: [],
      metadata: {},
    }
    mocks.importPlatformRecording.mockImplementation(async (input) => {
      const asset = await addAsset(input.meetingId, "meetings/zoom/audio.m4a")
      return {
        assetId: asset.id,
        storageKey: asset.storageKey,
        contentType: asset.contentType,
        sizeBytes: asset.sizeBytes,
        reused: false,
      }
    })
    const job = await makeJob("media.ingest", {
      meetingId: meeting.id,
      platform: "zoom",
      externalId: "zoom-uuid",
      captureEvent,
    })

    const result = await processJob(job)

    expect(mocks.importPlatformRecording).toHaveBeenCalledWith({
      meetingId: meeting.id,
      workspaceId: "ws_1",
      platform: "zoom",
      captureEvent,
    })
    expect(mocks.transcribe.mock.calls[0][0].media.storageKey).toBe(
      "meetings/zoom/audio.m4a"
    )
    expect(result).toMatchObject({ meetingId: meeting.id })
  })

  it("fails permanently with no recording and no platform import", async () => {
    const meeting = await seedMeeting()
    const job = await makeJob("media.ingest", { meetingId: meeting.id })

    await expect(processJob(job)).rejects.toThrow(/no recording attached/)
    await expect(processJob(await makeJob("media.ingest", { meetingId: meeting.id }))).rejects.toBeInstanceOf(
      UnrecoverableError
    )
  })

  it("fails permanently when the meeting does not exist", async () => {
    const job = await makeJob("media.ingest", {
      meetingId: "meet_missing",
      workspaceId: "ws_1",
    })

    await expect(processJob(job)).rejects.toBeInstanceOf(UnrecoverableError)
    expect((await mocks.repository.getJob(String(job.data.jobRecordId)))?.status).toBe("failed")
  })

  it("never processes a job whose workspace cannot be resolved", async () => {
    const updateJob = vi.spyOn(mocks.repository, "updateJob")
    const job = await makeJob("google.drive.poll", { subject: "a@example.test" })

    await expect(processJob(job)).rejects.toBeInstanceOf(UnrecoverableError)
    expect(updateJob).not.toHaveBeenCalled()
    expect(mocks.repositoryWorkspaces).toEqual([])
  })
})

describe("processJob workspace scoping", () => {
  it("runs in the payload workspace and tags every webhook event with it", async () => {
    const meeting = await seedMeeting()
    await addAsset(meeting.id, "meetings/a/first.m4a")

    await processJob(
      await makeJob("media.ingest", { meetingId: meeting.id, workspaceId: "ws_9" })
    )

    expect(new Set(mocks.repositoryWorkspaces)).toEqual(new Set(["ws_9"]))
    const events = mocks.deliverWebhookEvent.mock.calls.map(([event]) => event)
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((event) => event.workspaceId === "ws_9")).toBe(true)
  })

  it("falls back to the meeting's workspace for payloads without one", async () => {
    const meeting = await seedMeeting()
    await addAsset(meeting.id, "meetings/a/first.m4a")

    await processJob(await makeJob("media.ingest", { meetingId: meeting.id }))

    expect(new Set(mocks.repositoryWorkspaces)).toEqual(new Set(["ws_1"]))
  })

  it("polls Google as the workspace's google_subject", async () => {
    mocks.query.mockImplementation(async (sql: string) =>
      /from workspaces/.test(sql)
        ? { rows: [{ google_subject: "Owner@W2.test" }] }
        : { rows: [] }
    )
    mocks.pollCalendar.mockResolvedValue({ source: "calendar" })

    await processJob(await makeJob("google.calendar.poll", { workspaceId: "ws_2" }))

    expect(mocks.pollCalendar).toHaveBeenCalledWith({
      subject: "owner@w2.test",
      workspaceId: "ws_2",
    })
  })

  it("fails a Google job permanently when the workspace has no subject", async () => {
    const job = await makeJob("google.calendar.poll", { workspaceId: "ws_2" })

    await expect(processJob(job)).rejects.toBeInstanceOf(UnrecoverableError)
    expect(mocks.pollCalendar).not.toHaveBeenCalled()
    expect((await mocks.repository.getJob(String(job.data.jobRecordId)))?.status).toBe(
      "failed"
    )
  })

  it("enforces media retention for the job's workspace", async () => {
    mocks.applyMediaRetention.mockResolvedValue({ deleted: 2 })

    await processJob(await makeJob("media.retention", { workspaceId: "ws_3" }))

    expect(mocks.applyMediaRetention).toHaveBeenCalledWith({
      workspaceId: "ws_3",
      execute: true,
    })
  })
})

describe("processJob dispatch", () => {
  it("routes webhook.deliver with a deliveryId without touching the jobs table", async () => {
    const updateJob = vi.spyOn(mocks.repository, "updateJob")
    mocks.processWebhookDeliveryJob.mockResolvedValue({ deliveryId: "dlv_1", status: "sent" })
    const job = await makeJob(
      "webhook.deliver",
      { deliveryId: "dlv_1" },
      { attemptsMade: 1, attempts: 6, createRecord: false }
    )

    const result = await processJob(job)

    expect(result).toEqual({ deliveryId: "dlv_1", status: "sent" })
    expect(mocks.processWebhookDeliveryJob).toHaveBeenCalledWith({
      deliveryId: "dlv_1",
      attempt: 2,
      maxAttempts: 6,
    })
    expect(updateJob).not.toHaveBeenCalled()
  })

  it("keeps legacy webhook.deliver payloads working", async () => {
    const job = await makeJob(
      "webhook.deliver",
      { eventName: "summary.created", data: { meetingId: "m1" }, workspaceId: "ws_1" },
      { createRecord: false }
    )

    await processJob(job)

    expect(mocks.deliverWebhookEvent).toHaveBeenCalledWith({
      eventName: "summary.created",
      data: { meetingId: "m1" },
      workspaceId: "ws_1",
    })
    expect(mocks.processWebhookDeliveryJob).not.toHaveBeenCalled()
  })

  it("runs teams.subscription.renew", async () => {
    mocks.renewTeamsSubscriptions.mockResolvedValue({ renewed: 1, created: 0, failed: 0 })
    const job = await makeJob("teams.subscription.renew", {})

    await expect(processJob(job)).resolves.toEqual({ renewed: 1, created: 0, failed: 0 })
    expect((await mocks.repository.getJob(String(job.data.jobRecordId)))?.status).toBe(
      "completed"
    )
  })

  it("meeting.index never transcribes", async () => {
    const meeting = await seedMeeting()
    await addAsset(meeting.id, "meetings/a/first.m4a")
    await mocks.repository.replaceTranscriptSegments(meeting.id, [
      { id: "seg_1", speaker: "A", startMs: 0, endMs: 1000, text: "hello" },
    ])

    const result = await processJob(await makeJob("meeting.index", { meetingId: meeting.id }))

    expect(result).toEqual({
      meetingId: meeting.id,
      indexed: false,
      reason: "search indexing ships in M6",
    })
    expect(mocks.transcribe).not.toHaveBeenCalled()
    expect(mocks.summarize).not.toHaveBeenCalled()
  })

  it("meeting.index without a transcript fails permanently", async () => {
    const meeting = await seedMeeting()

    await expect(
      processJob(await makeJob("meeting.index", { meetingId: meeting.id }))
    ).rejects.toBeInstanceOf(UnrecoverableError)
    expect(mocks.transcribe).not.toHaveBeenCalled()
  })
})

describe("processJob ASR router (M3)", () => {
  // ai_runs insert values: [0] id, [2] provider, [3] task, [4] status,
  // [5] metadata, [6] model, [7] latency, [8] confidence, [10] error,
  // [11] job id, [12] cost_estimate, [13] audio_duration_ms, [14] workspace_id.
  async function seedWithAsset() {
    const meeting = await seedMeeting()
    const asset = await addAsset(meeting.id, "meetings/a/audio.m4a")

    return { meeting, asset }
  }

  it("transcribes with the workspace glossary and stores words, speakers and a costed ai_run", async () => {
    const { meeting, asset } = await seedWithAsset()
    const replaceTranscript = vi.spyOn(mocks.repository, "replaceTranscript")
    const job = await makeJob("media.ingest", { meetingId: meeting.id })

    const result = await processJob(job)

    expect(mocks.glossary).toHaveBeenCalledWith("ws_1")
    expect(mocks.transcribe).toHaveBeenCalledWith({
      meetingId: meeting.id,
      workspaceId: "ws_1",
      language: "he",
      media: {
        kind: "object",
        storageKey: asset.storageKey,
        contentType: "audio/mp4",
        filename: undefined,
        sizeBytes: 100,
      },
      glossary: await mocks.glossary.mock.results[0].value,
      diarize: true,
    })

    const [run] = aiRunInserts().filter((values) => values[3] === "audio.transcribe")

    expect(run[2]).toBe("runpod-ivrit")
    expect(run[4]).toBe("completed")
    expect(run[6]).toBe("ivrit-ai/whisper-large-v3-turbo-ct2")
    // Word-weighted: (0.9 × 3 + 0.7 × 1) / 4.
    expect(run[8]).toBeCloseTo(0.85, 4)
    expect(run[11]).toBe(job.data.jobRecordId)
    expect(run.slice(12, 15)).toEqual([0.0123, 120_000, "ws_1"])
    expect(JSON.parse(run[5] as string)).toMatchObject({
      fallbackUsed: false,
      diarization: "provider",
      speakerCount: 2,
      wordCount: 4,
      segmentCount: 2,
      glossaryTerms: 1,
      glossaryReplacements: 2,
      timings: { queueMs: 900, executionMs: 64_700 },
      billedSeconds: 64.7,
      costBasis: "gpu_seconds",
      warnings: [],
      inputAsset: asset.id,
      attempts: [{ provider: "runpod-ivrit", ok: true }],
    })

    expect(replaceTranscript).toHaveBeenCalledWith(
      meeting.id,
      expect.objectContaining({ asrRunId: run[0] })
    )
    const stored = await mocks.repository.getMeeting(meeting.id)

    expect(stored?.speakers?.map((speaker) => speaker.label)).toEqual(["Speaker 1", "Speaker 2"])
    expect(stored?.transcript?.[0]).toMatchObject({
      text: "שלום, אני דנה",
      turnIndex: 0,
      source: "asr",
      words: [
        { startMs: 0, endMs: 600, text: "שלום,", confidence: 0.9 },
        { startMs: 700, endMs: 1_200, text: "אני", confidence: 0.95 },
        { startMs: 1_300, endMs: 2_000, text: "דנה", confidence: 0.85 },
      ],
    })
    // Glossary output is kept verbatim (no second term rewrite).
    expect(stored?.transcript?.[1].words?.[0]).toMatchObject({ text: "Supabase", language: "en" })
    expect(mocks.refreshSuggestions).toHaveBeenCalledWith(
      expect.anything(),
      meeting.id,
      expect.objectContaining({ loadMeetTimeline: undefined })
    )
    expect(replaceTranscript.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.refreshSuggestions.mock.invocationCallOrder[0]
    )
    expect(result).toMatchObject({ asrProvider: "runpod-ivrit", speakers: 2, suggestedSpeakers: 1 })
    expect(stored?.status).toBe("completed")
  })

  it("derives speaker rows and turns from the cleaned transcript, keeping embeddings", async () => {
    const { meeting } = await seedWithAsset()
    const base = routerResult()
    const replaceTranscript = vi.spyOn(mocks.repository, "replaceTranscript")

    mocks.transcribe.mockResolvedValue(
      routerResult({
        segments: [
          base.segments[0],
          // Punctuation-only: cleanup drops it, so Speaker 3 must vanish.
          {
            startMs: 2_100,
            endMs: 2_400,
            text: "…",
            speaker: "Speaker 3",
            turnIndex: 1,
            words: [{ startMs: 2_100, endMs: 2_400, text: "…" }],
          },
          { ...base.segments[1], turnIndex: 2 },
        ],
        speakers: [
          { ...base.speakers[0], talkTimeMs: 99_999, embedding: [0.1, 0.2], embeddingModel: "pyannote/test" },
          { label: "Speaker 3", talkTimeMs: 300, wordCount: 1, segmentCount: 1, firstStartMs: 2_100 },
          base.speakers[1],
        ],
      })
    )

    await processJob(await makeJob("media.ingest", { meetingId: meeting.id }))

    const input = replaceTranscript.mock.calls[0][1]

    expect(input.speakers?.map((speaker) => speaker.label)).toEqual(["Speaker 1", "Speaker 2"])
    expect(input.speakers?.[0]).toMatchObject({
      source: "asr",
      talkTimeMs: 2_000,
      wordCount: 3,
      segmentCount: 1,
      embedding: [0.1, 0.2],
      embeddingModel: "pyannote/test",
    })
    expect(input.segments.every((segment) => segment.turnIndex === undefined)).toBe(true)

    const stored = await mocks.repository.getMeeting(meeting.id)

    expect(stored?.transcript?.map((segment) => segment.turnIndex)).toEqual([0, 1])
  })

  it("redacts provider warnings before storing them in ai_runs metadata", async () => {
    const { meeting } = await seedWithAsset()

    mocks.transcribe.mockResolvedValue(
      routerResult({
        warnings: ["diarization_failed: GET https://s3.example.com/asr-handoff/h1.ogg?X-Amz-Signature=sig123 failed"],
      })
    )

    await processJob(await makeJob("media.ingest", { meetingId: meeting.id }))

    const [run] = aiRunInserts().filter((values) => values[3] === "audio.transcribe")
    const metadata = run[5] as string

    expect(metadata).not.toContain("sig123")
    expect(JSON.parse(metadata).warnings).toEqual([
      "diarization_failed: GET https://s3.example.com/asr-handoff/h1.ogg?[redacted] failed",
    ])
  })

  it("records a failed ai_run per failed attempt and the fallback on success", async () => {
    const { meeting } = await seedWithAsset()

    mocks.transcribe.mockResolvedValue(
      routerResult({
        provider: "soniox",
        model: "stt-async-v3",
        fallbackUsed: true,
        cost: { usd: 0.0033, basis: "audio_hours" },
        attempts: [
          { provider: "runpod-ivrit", ok: false, kind: "server", error: "RunPod 503", elapsedMs: 1_200 },
          { provider: "soniox", ok: true, elapsedMs: 30_000, cost: { usd: 0.0033, basis: "audio_hours" } },
        ],
      })
    )

    await processJob(await makeJob("media.ingest", { meetingId: meeting.id }))

    const runs = aiRunInserts().filter((values) => values[3] === "audio.transcribe")

    expect(runs.map((values) => [values[2], values[4], values[10]])).toEqual([
      ["runpod-ivrit", "failed", "RunPod 503"],
      ["soniox", "completed", null],
    ])
    expect(runs[0][7]).toBe(1_200)
    expect(JSON.parse(runs[1][5] as string)).toMatchObject({
      fallbackUsed: true,
      attemptedProvider: "runpod-ivrit",
      fallbackReason: "RunPod 503",
    })
    expect(runs[1][12]).toBe(0.0033)
  })

  it("fails permanently on bad input", async () => {
    const { meeting } = await seedWithAsset()

    mocks.transcribe.mockRejectedValue(
      new AsrError("Audio could not be decoded", "bad_input", "runpod-ivrit", false, 400)
    )

    await expect(
      processJob(await makeJob("media.ingest", { meetingId: meeting.id }, { attemptsMade: 0 }))
    ).rejects.toBeInstanceOf(UnrecoverableError)

    const runs = aiRunInserts().filter((values) => values[3] === "audio.transcribe")

    expect(runs.map((values) => [values[2], values[4], values[10]])).toEqual([
      ["runpod-ivrit", "failed", "Audio could not be decoded"],
    ])
    expect((await mocks.repository.getMeeting(meeting.id))?.status).toBe("failed")
  })

  it("rethrows a retryable chain failure (BullMQ retries) with one failed run per attempt", async () => {
    const { meeting } = await seedWithAsset()
    const attempts = [
      { provider: "runpod-ivrit" as const, ok: false, kind: "timeout" as const, error: "timeout", elapsedMs: 10 },
      { provider: "soniox" as const, ok: false, kind: "rate_limit" as const, error: "429", elapsedMs: 20 },
    ]

    mocks.transcribe.mockRejectedValue(new AsrChainError("All ASR providers failed", attempts, true))
    const job = await makeJob("media.ingest", { meetingId: meeting.id }, { attemptsMade: 0 })

    const error = await processJob(job).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AsrChainError)
    expect(error).not.toBeInstanceOf(UnrecoverableError)
    expect((await mocks.repository.getJob(String(job.data.jobRecordId)))?.status).toBe("queued")
    expect(
      aiRunInserts()
        .filter((values) => values[3] === "audio.transcribe")
        .map((values) => [values[2], values[10]])
    ).toEqual([
      ["runpod-ivrit", "timeout"],
      ["soniox", "429"],
    ])
  })

  it("treats a non-retryable chain failure as permanent", async () => {
    const { meeting } = await seedWithAsset()

    mocks.transcribe.mockRejectedValue(
      new AsrChainError(
        "All ASR providers failed",
        [{ provider: "soniox", ok: false, kind: "auth", error: "401", elapsedMs: 5 }],
        false
      )
    )

    await expect(
      processJob(await makeJob("media.ingest", { meetingId: meeting.id }, { attemptsMade: 0 }))
    ).rejects.toBeInstanceOf(UnrecoverableError)
  })

  it("fails permanently with 'No speech detected' on an empty result", async () => {
    const { meeting } = await seedWithAsset()

    mocks.transcribe.mockResolvedValue(routerResult({ segments: [], speakers: [] }))

    await expect(
      processJob(await makeJob("media.ingest", { meetingId: meeting.id }, { attemptsMade: 0 }))
    ).rejects.toThrow(/No speech detected/)

    const [run] = aiRunInserts().filter((values) => values[3] === "audio.transcribe")

    expect(run[4]).toBe("failed")
    expect(run[12]).toBe(0.0123)
    expect(mocks.summarize).not.toHaveBeenCalled()
    expect((await mocks.repository.getMeeting(meeting.id))?.status).toBe("failed")
  })

  it("does not fail the pipeline when the speaker suggestion refresh throws", async () => {
    const { meeting } = await seedWithAsset()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    mocks.refreshSuggestions.mockRejectedValue(new Error("suggestion boom"))

    await expect(
      processJob(await makeJob("media.ingest", { meetingId: meeting.id }))
    ).resolves.toMatchObject({ suggestedSpeakers: 0 })
    expect((await mocks.repository.getMeeting(meeting.id))?.status).toBe("completed")
    warn.mockRestore()
  })

  it("imports a Meet transcript as meet-sourced speakers and refreshes with its timeline", async () => {
    const meeting = await seedMeeting()
    const meet = await import("@/lib/google/meet-artifacts")
    const meetTimeline = [{ name: "דנה כהן", startMs: 3_000, endMs: 7_000 }]
    const meetSpeakers = [
      { label: "דנה כהן", kind: "anonymous" as const },
      { label: "Ran Levi", kind: "signedin" as const, userId: "users/222" },
    ]

    vi.mocked(meet.importMeetTranscriptArtifactsForMeeting).mockResolvedValue({
      meetingId: meeting.id,
      artifactIds: ["art_1"],
      transcriptSegments: [
        { id: "e1", speaker: "דנה כהן", startMs: 3_000, endMs: 7_000, text: "שלום לכולם", source: "meet" },
        { id: "e2", speaker: "Ran Levi", startMs: 8_000, endMs: 9_000, text: "Hi", source: "meet" },
      ],
      importedEntries: 2,
      importedSmartNotes: 0,
      meetTimeline,
      meetSpeakers,
    })
    const recordConfirmed = vi.spyOn(mocks.repository, "recordConfirmedSpeaker")

    await processJob(
      await makeJob("artifact.import", { meetingId: meeting.id, subject: "ops@example.com" })
    )

    const speakers = await mocks.repository.listMeetingSpeakers(meeting.id)

    expect(speakers.map((speaker) => [speaker.label, speaker.source])).toEqual([
      ["דנה כהן", "meet"],
      ["Ran Levi", "meet"],
    ])
    expect(mocks.refreshSuggestions).toHaveBeenCalledWith(expect.anything(), meeting.id, {
      meetTimeline,
      meetIdentities: meetSpeakers,
    })
    expect(mocks.transcribe).not.toHaveBeenCalled()
    // Automatic import never writes workspace speaker memory.
    expect(recordConfirmed).not.toHaveBeenCalled()
    expect(await mocks.repository.listSpeakerProfiles()).toEqual([])
  })

  it("re-summarizing a worded transcript never rewrites its text", async () => {
    const { meeting } = await seedWithAsset()

    await processJob(await makeJob("media.ingest", { meetingId: meeting.id }))
    const replaceSegments = vi.spyOn(mocks.repository, "replaceTranscriptSegments")
    const replaceTranscript = vi.spyOn(mocks.repository, "replaceTranscript")
    const before = (await mocks.repository.getMeeting(meeting.id))?.transcript

    await processJob(await makeJob("meeting.summarize", { meetingId: meeting.id, mode: "summary" }))

    expect(replaceSegments).not.toHaveBeenCalled()
    expect(replaceTranscript).not.toHaveBeenCalled()
    expect((await mocks.repository.getMeeting(meeting.id))?.transcript).toEqual(before)
  })
})

describe("processJob webhook payloads respect meeting visibility", () => {
  async function seedPrivateMeeting() {
    return mocks.repository.createMeeting({
      title: "Board compensation review",
      source: "upload",
      language: "he",
      startedAt: "2026-04-23T09:00:00.000Z",
      visibility: "private",
      ownerUserId: "usr_owner",
    })
  }

  it("sends full payloads for workspace meetings", async () => {
    const meeting = await seedMeeting()
    await addAsset(meeting.id, "meetings/a/first.m4a")

    await processJob(await makeJob("media.ingest", { meetingId: meeting.id }))

    expect(eventsNamed("summary.created")[0].data).toMatchObject({
      meetingId: meeting.id,
      title: "Weekly sync",
    })
    expect(eventsNamed("action_item.created")[0].data).toMatchObject({
      title: "Send deck",
    })
  })

  it("sends minimal payloads without title, tags or action items for private meetings", async () => {
    const meeting = await seedPrivateMeeting()
    await addAsset(meeting.id, "meetings/a/first.m4a")

    await processJob(await makeJob("media.ingest", { meetingId: meeting.id }))

    const summary = eventsNamed("summary.created")[0]
    expect(summary.data).toEqual({
      meetingId: meeting.id,
      workspace_id: "ws_1",
      visibility: "private",
    })
    const [item] = eventsNamed("action_item.created")
    expect(item.data).toEqual({
      meetingId: meeting.id,
      actionItemId: "t1",
      workspace_id: "ws_1",
      visibility: "private",
    })
    expect(eventsNamed("meeting.completed")[0].data).toEqual({
      meetingId: meeting.id,
      workspace_id: "ws_1",
      visibility: "private",
    })
    const serialized = JSON.stringify(mocks.deliverWebhookEvent.mock.calls)
    expect(serialized).not.toContain("Board compensation review")
    expect(serialized).not.toContain("Send deck")
  })

  it("strips the error text from meeting.process_failed for private meetings", async () => {
    const meeting = await seedPrivateMeeting()
    await addAsset(meeting.id, "meetings/a/first.m4a")
    mocks.transcribe.mockRejectedValue(new Error("ASR failed on Board compensation review"))
    const job = await makeJob("media.ingest", { meetingId: meeting.id }, { attemptsMade: 2 })

    await expect(processJob(job)).rejects.toThrow()

    const [failure] = eventsNamed("meeting.process_failed")
    expect(failure.data).toEqual({
      meetingId: meeting.id,
      jobId: job.data.jobRecordId,
      jobName: "media.ingest",
      attempts: 3,
      permanent: false,
      workspace_id: "ws_1",
      visibility: "private",
    })
  })
})

describe("processJob media preparation (M4)", () => {
  afterEach(() => {
    delete process.env.MEETSUM_MEDIA_PREPARE
  })

  it("queues media.prepare for the processed original without failing on enqueue errors", async () => {
    const meeting = await seedMeeting()
    const asset = await addAsset(meeting.id, "meetings/a/first.m4a")

    await processJob(await makeJob("media.ingest", { meetingId: meeting.id }))

    expect(mocks.enqueue).toHaveBeenCalledWith("media.prepare", {
      meetingId: meeting.id,
      workspaceId: "ws_1",
      assetId: asset.id,
    })

    mocks.enqueue.mockRejectedValueOnce(new Error("redis down"))
    await expect(
      processJob(await makeJob("media.ingest", { meetingId: meeting.id }))
    ).resolves.toMatchObject({ assetId: asset.id })
  })

  it("does not queue preparation when MEETSUM_MEDIA_PREPARE=false", async () => {
    process.env.MEETSUM_MEDIA_PREPARE = "false"
    const meeting = await seedMeeting()
    await addAsset(meeting.id, "meetings/a/first.m4a")

    await processJob(await makeJob("media.ingest", { meetingId: meeting.id }))

    expect(mocks.enqueue).not.toHaveBeenCalledWith("media.prepare", expect.anything())
  })

  it("never transcribes a playback rendition, even when it is the newest asset", async () => {
    const meeting = await seedMeeting()
    const original = await addAsset(meeting.id, "meetings/a/original.wav")
    const playback = await mocks.repository.createMediaAsset({
      meetingId: meeting.id,
      storageKey: "meetings/a/derived/playback.m4a",
      contentType: "audio/mp4",
      sizeBytes: 50,
      kind: "playback",
      derivedFromAssetId: original.id,
    })

    await processJob(await makeJob("meeting.transcribe", { meetingId: meeting.id }))
    expect(mocks.transcribe.mock.calls[0][0].media.storageKey).toBe(original.storageKey)

    await expect(
      processJob(await makeJob("meeting.transcribe", { meetingId: meeting.id, assetId: playback.id }))
    ).rejects.toBeInstanceOf(UnrecoverableError)
    await expect(
      processJob(
        await makeJob("meeting.transcribe", {
          meetingId: meeting.id,
          storageKey: playback.storageKey,
        })
      )
    ).resolves.toMatchObject({ assetId: original.id })
  })

  it("runs media.prepare without touching the meeting status", async () => {
    const meeting = await seedMeeting()
    const asset = await addAsset(meeting.id, "meetings/a/first.m4a")
    await mocks.repository.updateMeetingStatus(meeting.id, "completed")
    mocks.prepare.mockResolvedValue({ status: "prepared", assetId: asset.id, playback: "passthrough" })

    const result = await processJob(
      await makeJob("media.prepare", { meetingId: meeting.id, workspaceId: "ws_1", assetId: asset.id })
    )

    expect(result).toMatchObject({ status: "prepared" })
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: meeting.id, assetId: asset.id, force: false })
    )
    expect((await mocks.repository.getMeeting(meeting.id))?.status).toBe("completed")
  })

  it("stores prepare_error and audits only on the final failed attempt; never fails the meeting", async () => {
    const meeting = await seedMeeting()
    const asset = await addAsset(meeting.id, "meetings/a/first.m4a")
    await mocks.repository.updateMeetingStatus(meeting.id, "completed")
    const updatePreparation = vi
      .spyOn(mocks.repository, "updateMediaAssetPreparation")
      .mockResolvedValue(asset)
    mocks.prepare.mockRejectedValue(new Error("ffmpeg exploded"))
    const data = { meetingId: meeting.id, workspaceId: "ws_1", assetId: asset.id }

    await expect(
      processJob(await makeJob("media.prepare", data, { attempts: 2, attemptsMade: 0 }))
    ).rejects.toThrow("ffmpeg exploded")
    expect(updatePreparation).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()

    await expect(
      processJob(await makeJob("media.prepare", data, { attempts: 2, attemptsMade: 1 }))
    ).rejects.toThrow("ffmpeg exploded")
    expect(updatePreparation).toHaveBeenCalledWith(asset.id, {
      prepareError: "ffmpeg exploded",
    })
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_1",
        action: "media.prepare.failed",
        targetId: asset.id,
      })
    )
    expect((await mocks.repository.getMeeting(meeting.id))?.status).toBe("completed")
    expect(eventsNamed("meeting.process_failed")).toHaveLength(0)
  })

  it("fails media.prepare permanently when the meeting is gone", async () => {
    const { MediaPreparePermanentError } = await import("@/lib/media/prepare")
    mocks.prepare.mockRejectedValue(new MediaPreparePermanentError("Meeting not found: m_x"))

    await expect(
      processJob(
        await makeJob("media.prepare", { meetingId: "m_x", workspaceId: "ws_1", assetId: "a_1" })
      )
    ).rejects.toBeInstanceOf(UnrecoverableError)
  })

  it("storage.delete deletes the keys and retries when some objects fail", async () => {
    const keys = ["meetings/m/a.m4a", "meetings/m/derived/a.peaks.v1.json"]

    await expect(
      processJob(await makeJob("storage.delete", { workspaceId: "ws_1", keys }))
    ).resolves.toEqual({ deleted: 2 })
    expect(mocks.deleteObjects).toHaveBeenCalledWith(keys)

    mocks.deleteObjects.mockResolvedValueOnce({
      deleted: [keys[0]],
      failed: [{ key: keys[1], error: "SlowDown" }],
    })
    const failure = await processJob(
      await makeJob("storage.delete", { workspaceId: "ws_1", keys }, { attempts: 5 })
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(UnrecoverableError)
    expect((failure as Error).message).toBe("1 of 2 object(s) could not be deleted")
    await expect(
      processJob(await makeJob("storage.delete", { workspaceId: "ws_1", keys: "nope" }))
    ).rejects.toBeInstanceOf(UnrecoverableError)
  })

  it("transcript cleanup keeps edited segments and asks to preserve edits", async () => {
    const meeting = await seedMeeting()
    const base = (await mocks.repository.getMeeting(meeting.id))!
    const transcript = [
      { id: "s1", speaker: "Speaker 1", startMs: 0, endMs: 1000, text: "נתחיל בבקשה" },
      { id: "s2", speaker: "Speaker 1", startMs: 1000, endMs: 1500, text: "נתחיל בבקשה" },
      {
        id: "s3",
        speaker: "Speaker 1",
        startMs: 1500,
        endMs: 2500,
        text: "נתחיל בבקשה",
        source: "edited",
      },
      { id: "s4", speaker: "Speaker 1", startMs: 2500, endMs: 3000, text: "סיכום" },
    ]
    vi.spyOn(mocks.repository, "getMeeting").mockResolvedValue({ ...base, transcript })
    const replaceTranscript = vi
      .spyOn(mocks.repository, "replaceTranscript")
      .mockResolvedValue({ segments: [], speakers: [] })

    await processJob(
      await makeJob("meeting.summarize", { meetingId: meeting.id, mode: "transcript-cleanup" })
    )

    expect(replaceTranscript).toHaveBeenCalledTimes(1)
    const [, input, options] = replaceTranscript.mock.calls[0]
    expect(options).toEqual({ preserveEdited: true })
    expect(input.segments.map((segment) => segment.id)).toEqual(["s1", "s3", "s4"])
  })
})

describe("processJob intelligence wiring (M5)", () => {
  it("enqueues meeting.analyze after the summary", async () => {
    const meeting = await seedMeeting()
    await addAsset(meeting.id, "meetings/a/first.m4a")

    await processJob(await makeJob("media.ingest", { meetingId: meeting.id }))

    expect(mocks.enqueue).toHaveBeenCalledWith("meeting.analyze", {
      meetingId: meeting.id,
      workspaceId: "ws_1",
    })
  })

  it("keeps the job green when the analyze enqueue fails", async () => {
    const meeting = await seedMeeting()
    await addAsset(meeting.id, "meetings/a/first.m4a")
    mocks.enqueue.mockImplementation(async (name: string) => {
      if (name === "meeting.analyze") throw new Error("redis down")
      return { id: "job" }
    })

    await expect(
      processJob(await makeJob("media.ingest", { meetingId: meeting.id }))
    ).resolves.toMatchObject({ meetingId: meeting.id })
  })

  it("passes payload templateKey and language through to the pipeline", async () => {
    const meeting = await seedMeeting()
    await addAsset(meeting.id, "meetings/a/first.m4a")
    const job = await makeJob("media.ingest", {
      meetingId: meeting.id,
      templateKey: "sales",
      language: "en",
    })

    await processJob(job)

    expect(mocks.summarize.mock.calls[0][1]).toMatchObject({
      templateKey: "sales",
      language: "en",
      jobId: job.data.jobRecordId,
    })
  })

  it("applies the AI title to a generic title (generic_only)", async () => {
    const meeting = await mocks.repository.createMeeting({
      title: "Untitled meeting",
      source: "upload",
      language: "he",
      startedAt: "2026-04-23T09:00:00.000Z",
    })
    const applyAiTitle = vi.fn().mockResolvedValue(true)
    Object.assign(mocks.repository, { applyAiTitle })
    await addAsset(meeting.id, "meetings/a/first.m4a")
    mocks.summarize.mockResolvedValue({ ...intelligenceWith([]), title: "סנכרון שבועי" })

    await processJob(await makeJob("media.ingest", { meetingId: meeting.id }))

    expect(applyAiTitle).toHaveBeenCalledWith(meeting.id, "סנכרון שבועי")
  })

  it("keeps a specific title under generic_only", async () => {
    const meeting = await seedMeeting()
    const applyAiTitle = vi.fn().mockResolvedValue(true)
    Object.assign(mocks.repository, { applyAiTitle })
    await addAsset(meeting.id, "meetings/a/first.m4a")
    mocks.summarize.mockResolvedValue({ ...intelligenceWith([]), title: "סנכרון שבועי" })

    await processJob(await makeJob("media.ingest", { meetingId: meeting.id }))

    expect(applyAiTitle).not.toHaveBeenCalled()
  })

  it("does not fail the job when applying the title fails", async () => {
    const meeting = await mocks.repository.createMeeting({
      title: "recording.m4a",
      source: "upload",
      language: "he",
      startedAt: "2026-04-23T09:00:00.000Z",
    })
    Object.assign(mocks.repository, {
      applyAiTitle: vi.fn().mockRejectedValue(new Error("db down")),
    })
    await addAsset(meeting.id, "meetings/a/first.m4a")
    mocks.summarize.mockResolvedValue({ ...intelligenceWith([]), title: "Title" })

    await expect(
      processJob(await makeJob("media.ingest", { meetingId: meeting.id }))
    ).resolves.toMatchObject({ meetingId: meeting.id })
  })
})
