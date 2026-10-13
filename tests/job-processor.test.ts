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
}))

vi.mock("@/lib/meetings/store", () => ({
  meetingRepository: new Proxy(
    {},
    {
      get(_target, property) {
        const value = Reflect.get(mocks.repository, property, mocks.repository)
        return typeof value === "function" ? value.bind(mocks.repository) : value
      },
    }
  ),
}))

vi.mock("@/lib/ai/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/providers")>()

  return {
    ...actual,
    createTranscriptionProvider: () => ({
      id: "local-whisper",
      model: "ivrit-ai",
      transcribe: mocks.transcribe,
      getLastRun: () =>
        mocks.transcriptionRun ?? { provider: "local-whisper", model: "ivrit-ai" },
    }),
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
  syncMeetArtifacts: vi.fn(),
}))

vi.mock("@/lib/google/services", () => ({
  pollCalendar: vi.fn(),
  pollDrive: vi.fn(),
  pollGmail: vi.fn(),
}))

vi.mock("@/lib/integrations/realizeos", () => ({
  exportMeetingToRealizeOS: vi.fn(),
}))

const { processJob } = await import("@/lib/jobs/processor")
const { TranscriptionUnavailableError } = await import("@/lib/ai/providers")

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
  mocks.transcribe.mockReset().mockResolvedValue([
    { id: "seg_1", speaker: "Ran", startMs: 0, endMs: 1000, text: "שלום", confidence: 0.9 },
  ])
  mocks.summarize.mockReset().mockResolvedValue(intelligenceWith([task("t1", "Send deck")]))
  mocks.query.mockReset().mockResolvedValue({ rows: [] })
  mocks.deliverWebhookEvent.mockReset().mockResolvedValue({ delivered: 0 })
  mocks.processWebhookDeliveryJob.mockReset()
  mocks.importPlatformRecording.mockReset()
  mocks.renewTeamsSubscriptions.mockReset()
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
    const transcribedMeeting = mocks.transcribe.mock.calls[0][0]
    expect(transcribedMeeting.mediaAssets[0].id).toBe(target.id)
    expect(transcribedMeeting.mediaAssets).toHaveLength(2)

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
      platform: "zoom",
      captureEvent,
    })
    expect(mocks.transcribe.mock.calls[0][0].mediaAssets[0].storageKey).toBe(
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
    const job = await makeJob("media.ingest", { meetingId: "meet_missing" })

    await expect(processJob(job)).rejects.toBeInstanceOf(UnrecoverableError)
    expect((await mocks.repository.getJob(String(job.data.jobRecordId)))?.status).toBe("failed")
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
      { eventName: "summary.created", data: { meetingId: "m1" } },
      { createRecord: false }
    )

    await processJob(job)

    expect(mocks.deliverWebhookEvent).toHaveBeenCalledWith({
      eventName: "summary.created",
      data: { meetingId: "m1" },
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
