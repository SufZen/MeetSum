import { describe, expect, it } from "vitest"

import { buildMeetingIntelligence, type SmartTask } from "@/lib/intelligence"
import {
  createInMemoryMeetingRepository,
  type CreateMeetingInput,
} from "@/lib/meetings/repository"

describe("meeting repository", () => {
  it("creates audio-first meetings with searchable summaries", async () => {
    const repository = createInMemoryMeetingRepository()
    const input: CreateMeetingInput = {
      title: "Hebrew strategy review",
      source: "upload",
      language: "he",
      startedAt: "2026-04-23T09:00:00.000Z",
      participants: ["Ran", "Maya"],
    }

    const meeting = await repository.createMeeting(input)

    expect(meeting).toMatchObject({
      title: "Hebrew strategy review",
      source: "upload",
      language: "he",
      status: "created",
      retention: "audio",
    })
    expect(await repository.searchMeetings("strategy")).toHaveLength(1)
  })

  it("stores desktop capture metadata on uploaded media assets", async () => {
    const repository = createInMemoryMeetingRepository()
    const meeting = await repository.createMeeting({
      title: "Desktop recording",
      source: "desktop_recorder",
      language: "he",
      startedAt: "2026-07-05T09:00:00.000Z",
      participants: [],
    })

    const asset = await repository.createMediaAsset({
      meetingId: meeting.id,
      storageKey: "meetings/desktop/audio.wav",
      filename: "audio.wav",
      contentType: "audio/wav",
      sizeBytes: 12000,
      retention: "audio",
      source: "desktop_capture",
      metadata: {
        sampleRate: 48000,
        durationMs: 90000,
        localTranscription: {
          provider: "parakeet",
          model: "parakeet-tdt-0.6b-v3-int8",
        },
      },
    })

    const updated = await repository.getMeeting(meeting.id)

    expect(asset).toMatchObject({
      source: "desktop_capture",
      metadata: {
        sampleRate: 48000,
        durationMs: 90000,
      },
    })
    expect(updated?.mediaAssets?.[0]).toMatchObject(asset)
    expect(updated?.status).toBe("media_uploaded")
  })

  it("answers questions from transcript and summary context", async () => {
    const repository = createInMemoryMeetingRepository([
      {
        id: "meet_1",
        title: "RealizeOS integration",
        source: "google_meet",
        language: "he",
        status: "completed",
        retention: "audio",
        startedAt: "2026-04-23T09:00:00.000Z",
        participants: ["Ran", "Codex"],
        summary: {
          overview: "RealizeOS should receive meeting context after summaries.",
          decisions: ["Send summaries through the outbound API first."],
          actionItems: [
            {
              id: "act_1",
              title: "Create RealizeOS webhook connector",
              owner: "Ran",
              status: "open",
            },
          ],
        },
        transcript: [
          {
            id: "seg_1",
            speaker: "Ran",
            startMs: 0,
            endMs: 4200,
            text: "We need RealizeOS to receive context from every meeting.",
          },
        ],
      },
    ])

    const answer = await repository.askMeetingMemory(
      "meet_1",
      "What should RealizeOS receive?"
    )

    expect(answer.answer).toContain("meeting context")
    expect(answer.citations).toEqual([
      {
        meetingId: "meet_1",
        segmentId: "seg_1",
        startMs: 0,
      },
    ])
  })

  it("persists intelligence, tags, language metadata, contexts, and suggested agent runs", async () => {
    const repository = createInMemoryMeetingRepository([
      {
        id: "meet_2",
        title: "Hebrew automation review",
        source: "google_meet",
        language: "he",
        status: "completed",
        retention: "audio",
        startedAt: "2026-04-23T09:00:00.000Z",
        participants: ["Ran", "Maya"],
        transcript: [
          {
            id: "seg_1",
            speaker: "Ran",
            startMs: 0,
            endMs: 5200,
            text: "צריך לשלוח את הסיכום ל-RealizeOS וליצור משימה דחופה.",
          },
        ],
      },
    ])

    const context = await repository.createContext({
      name: "RealizeOS",
      description: "Business context memory room",
    })

    await repository.linkMeetingContext("meet_2", context.id)
    const intelligence = await repository.runMeetingIntelligence("meet_2")
    const suggestion = await repository.createSuggestedAgentRun({
      meetingId: "meet_2",
      target: "realizeos",
      payload: { contextId: context.id },
    })

    const meeting = await repository.getMeeting("meet_2")

    expect(intelligence.languageMetadata.primaryLanguage).toBe("he")
    expect(meeting?.tags).toEqual(
      expect.arrayContaining(["hebrew", "follow-up-needed", "urgent"])
    )
    expect(meeting?.contexts?.[0]).toMatchObject({ name: "RealizeOS" })
    expect(meeting?.suggestedAgentRuns?.[0]).toEqual(suggestion)
  })

  it("returns paged meeting lists with filtering, sorting, and totals", async () => {
    const repository = createInMemoryMeetingRepository([
      {
        id: "meet_completed",
        title: "Completed strategy call",
        source: "google_meet",
        language: "en",
        status: "completed",
        retention: "audio",
        startedAt: "2026-04-23T09:00:00.000Z",
        participants: ["Ran"],
        tags: ["operations"],
      },
      {
        id: "meet_processing",
        title: "Processing upload",
        source: "upload",
        language: "he",
        status: "transcribing",
        retention: "audio",
        startedAt: "2026-04-24T09:00:00.000Z",
        participants: ["Ran"],
      },
      {
        id: "meet_upcoming",
        title: "Future calendar event",
        source: "google_meet",
        language: "en",
        status: "scheduled",
        retention: "audio",
        startedAt: "2099-04-24T09:00:00.000Z",
        participants: ["Ran"],
      },
    ])

    const firstPage = await repository.listMeetingsPage({
      limit: 2,
      offset: 0,
      sort: "smart",
      status: "all",
    })

    expect(firstPage.page).toMatchObject({
      limit: 2,
      offset: 0,
      total: 3,
      hasMore: true,
    })
    expect(firstPage.meetings.map((meeting) => meeting.id)).toEqual([
      "meet_completed",
      "meet_processing",
    ])

    const processing = await repository.listMeetingsPage({
      limit: 5,
      status: "processing",
    })

    expect(processing.meetings.map((meeting) => meeting.id)).toEqual([
      "meet_processing",
    ])

    const searched = await repository.listMeetingsPage({
      limit: 5,
      query: "strategy",
    })

    expect(searched.meetings.map((meeting) => meeting.id)).toEqual([
      "meet_completed",
    ])
  })

  it("preserves user-edited and done action items when intelligence is regenerated", async () => {
    const repository = createInMemoryMeetingRepository([
      {
        id: "meet_tasks",
        title: "Tasks",
        source: "upload",
        language: "en",
        status: "completed",
        retention: "audio",
        startedAt: "2026-04-23T09:00:00.000Z",
        participants: [],
      },
    ])
    const first = buildMeetingIntelligence({
      id: "meet_tasks",
      title: "Tasks",
      source: "upload",
      language: "en",
      status: "completed",
      retention: "audio",
      startedAt: "2026-04-23T09:00:00.000Z",
      participants: [],
    })
    const task = (id: string, title: string): SmartTask => ({
      id,
      title,
      status: "open",
      priority: "normal",
      confidence: 0.8,
      sourceQuote: title,
      sourceStartMs: 0,
      kind: "explicit",
    })

    await repository.upsertMeetingIntelligence("meet_tasks", {
      ...first,
      actionItems: [
        task("t1", "Send proposal"),
        task("t2", "Book venue"),
        task("t3", "Prepare budget"),
        task("t4", "Old idea"),
      ],
    })
    const renamed = await repository.updateActionItem("t1", {
      title: "Send signed proposal to Dana",
    })
    await repository.updateActionItem("t2", { status: "done" })

    expect(renamed.editedByUser).toBe(true)

    const persisted = await repository.upsertMeetingIntelligence("meet_tasks", {
      ...first,
      actionItems: [
        task("n1", "Send proposal"),
        task("n2", "Book venue"),
        task("n3", "Prepare budget"),
        task("n4", "Brand new task"),
      ],
    })
    const meeting = await repository.getMeeting("meet_tasks")
    const items = meeting?.summary?.actionItems ?? []

    expect(items.map((item) => item.id)).toEqual(["t1", "t2", "t3", "n4"])
    expect(items[0]).toMatchObject({ title: "Send signed proposal to Dana", editedByUser: true })
    expect(items[1]).toMatchObject({ status: "done" })
    expect(items[1].completedAt).toBeTruthy()
    expect(persisted.actionItems.map((item) => item.id)).toEqual(["t1", "t2", "t3", "n4"])
  })

  it("creates externally sourced meetings idempotently", async () => {
    const repository = createInMemoryMeetingRepository()
    const input = {
      title: "Zoom call",
      source: "zoom" as const,
      language: "en",
      startedAt: "2026-04-23T09:00:00.000Z",
      externalSource: "zoom",
      externalId: "uuid-123",
    }

    const first = await repository.createMeetingIfAbsent(input)
    const second = await repository.createMeetingIfAbsent(input)

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.meeting.id).toBe(first.meeting.id)
    expect((await repository.findMeetingByExternalId("zoom", "uuid-123"))?.id).toBe(
      first.meeting.id
    )
    expect(await repository.findMeetingByExternalId("teams", "uuid-123")).toBeUndefined()
  })

  it("scopes media asset source lookups to a meeting when requested", async () => {
    const repository = createInMemoryMeetingRepository()
    const meetingA = await repository.createMeeting({
      title: "A",
      source: "desktop_recorder",
      language: "en",
      startedAt: "2026-04-23T09:00:00.000Z",
    })
    const meetingB = await repository.createMeeting({
      title: "B",
      source: "desktop_recorder",
      language: "en",
      startedAt: "2026-04-23T10:00:00.000Z",
    })
    const asset = await repository.createMediaAsset({
      meetingId: meetingA.id,
      storageKey: "meetings/a/audio.wav",
      contentType: "audio/wav",
      sizeBytes: 10,
      source: "desktop_capture",
      sourceFileId: "capture-1",
    })

    expect(
      (await repository.findMediaAssetBySourceFile?.("desktop_capture", "capture-1"))?.id
    ).toBe(asset.id)
    expect(
      await repository.findMediaAssetBySourceFile?.("desktop_capture", "capture-1", {
        meetingId: meetingB.id,
      })
    ).toBeUndefined()
    expect(
      (
        await repository.findMediaAssetBySourceFile?.("desktop_capture", "capture-1", {
          meetingId: meetingA.id,
        })
      )?.id
    ).toBe(asset.id)
  })

  it("discards only meetings without transcript or summary", async () => {
    const repository = createInMemoryMeetingRepository()
    const empty = await repository.createMeeting({
      title: "Empty",
      source: "upload",
      language: "en",
      startedAt: "2026-04-23T09:00:00.000Z",
    })
    const transcribed = await repository.createMeeting({
      title: "Transcribed",
      source: "upload",
      language: "en",
      startedAt: "2026-04-23T09:00:00.000Z",
    })
    const job = await repository.createJob({ name: "media.ingest", meetingId: empty.id })

    await repository.replaceTranscriptSegments(transcribed.id, [
      { id: "seg_1", speaker: "A", startMs: 0, endMs: 1000, text: "hello" },
    ])

    expect(await repository.discardMeeting(transcribed.id)).toBe(false)
    expect(await repository.getMeeting(transcribed.id)).toBeDefined()
    expect(await repository.discardMeeting(empty.id)).toBe(true)
    expect(await repository.getMeeting(empty.id)).toBeUndefined()
    expect((await repository.getJob(job.id))?.meetingId).toBeUndefined()
    expect(await repository.discardMeeting("missing")).toBe(false)
  })
})
