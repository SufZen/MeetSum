import { describe, expect, it } from "vitest"

import { buildMeetingIntelligence, type SmartTask } from "@/lib/intelligence"
import {
  createInMemoryMeetingDatabase,
  createInMemoryMeetingRepository,
  type CreateMeetingInput,
  type TranscriptSegment,
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

  describe("M5 action items, template and titles (in-memory)", () => {
    const meetingInput = {
      id: "meet_m5",
      title: "Untitled",
      source: "upload" as const,
      language: "he",
      status: "completed" as const,
      retention: "audio" as const,
      // Thursday 15.10.2026 in Jerusalem.
      startedAt: "2026-10-15T09:00:00.000Z",
      participants: ["dana@example.com"],
      workspaceId: "ws_a",
    }
    const aiTask = (id: string, title: string, extra: Partial<SmartTask> = {}): SmartTask => ({
      id,
      title,
      status: "open",
      priority: "normal",
      confidence: 0.8,
      sourceQuote: title,
      sourceStartMs: 0,
      kind: "explicit",
      ...extra,
    })
    const system = { kind: "system", workspaceId: "ws_a" } as const

    it("stamps AI items with meeting and workspace ids", async () => {
      const repository = createInMemoryMeetingRepository([meetingInput], system)
      const persisted = await repository.upsertMeetingIntelligence("meet_m5", {
        ...buildMeetingIntelligence(meetingInput),
        actionItems: [aiTask("t1", "לשלוח הצעה", { dueOn: "2026-10-18", dueSource: "parser" })],
      })

      expect(persisted.actionItems[0]).toMatchObject({
        meetingId: "meet_m5",
        workspaceId: "ws_a",
        dueOn: "2026-10-18",
        dueSource: "parser",
      })
    })

    it("creates, edits and deletes user tasks; user owner/due survive regeneration", async () => {
      const repository = createInMemoryMeetingRepository([meetingInput], system)
      const intelligence = buildMeetingIntelligence(meetingInput)

      await repository.upsertMeetingIntelligence("meet_m5", {
        ...intelligence,
        actionItems: [aiTask("t1", "לשלוח הצעה", { owner: "יוסי", dueOn: "2026-11-01", dueSource: "ai" })],
      })
      const edited = await repository.updateActionItem("t1", {
        ownerText: "דנה",
        dueText: "עד יום ראשון",
      })

      expect(edited).toMatchObject({
        owner: "דנה",
        ownerText: "דנה",
        dueOn: "2026-10-18",
        dueText: "עד יום ראשון",
        dueSource: "user",
        dueDate: "2026-10-18T12:00:00.000Z",
        editedByUser: true,
      })

      const created = await repository.createActionItem(
        "meet_m5",
        { title: "לתאם פגישה", dueText: "סוף החודש" },
        { userId: "user_me" }
      )

      expect(created).toMatchObject({
        origin: "user",
        editedByUser: true,
        dueOn: "2026-10-31",
        createdByUserId: "user_me",
        workspaceId: "ws_a",
        meetingId: "meet_m5",
      })

      await repository.upsertMeetingIntelligence("meet_m5", {
        ...intelligence,
        actionItems: [aiTask("n1", "לשלוח הצעה", { owner: "יוסי", dueOn: "2026-11-01" })],
      })

      const items = (await repository.getMeeting("meet_m5"))?.summary?.actionItems ?? []

      expect(items.map((item) => item.id)).toEqual(["t1", created.id])
      expect(items[0]).toMatchObject({ ownerText: "דנה", dueOn: "2026-10-18", dueSource: "user" })

      expect(await repository.deleteActionItem(created.id)).toBe(true)
      expect(await repository.deleteActionItem(created.id)).toBe(false)
    })

    it("does not mark a status-only change as a content edit, and clears due with null", async () => {
      const repository = createInMemoryMeetingRepository([meetingInput], system)

      await repository.upsertMeetingIntelligence("meet_m5", {
        ...buildMeetingIntelligence(meetingInput),
        actionItems: [aiTask("t1", "x", { dueOn: "2026-10-20", dueSource: "ai" })],
      })

      expect((await repository.updateActionItem("t1", { status: "done" })).editedByUser).toBe(false)
      expect(await repository.updateActionItem("t1", { dueOn: null })).toMatchObject({
        dueOn: undefined,
        dueSource: undefined,
        dueDate: undefined,
        editedByUser: true,
      })
    })

    it("sets the template and never lets an AI title overwrite a user title", async () => {
      const repository = createInMemoryMeetingRepository([meetingInput], system)

      expect((await repository.setMeetingTemplate("meet_m5", "hebrew_business")).templateKey).toBe(
        "hebrew_business"
      )
      expect((await repository.setMeetingTemplate("meet_m5", null)).templateKey).toBeUndefined()

      expect(await repository.applyAiTitle("meet_m5", "עדכון סטטוס")).toBe(true)
      expect((await repository.getMeeting("meet_m5"))).toMatchObject({
        title: "עדכון סטטוס",
        titleSource: "ai",
      })

      await repository.setMeetingTitle("meet_m5", "השם שלי", "user")
      expect(await repository.applyAiTitle("meet_m5", "כותרת אחרת")).toBe(false)
      expect((await repository.getMeeting("meet_m5"))?.title).toBe("השם שלי")
      expect(await repository.applyAiTitle("missing", "x")).toBe(false)
    })

    it("treats a rename as a user title that AI titles never overwrite", async () => {
      const repository = createInMemoryMeetingRepository([meetingInput], system)

      expect(await repository.applyAiTitle("meet_m5", "כותרת AI")).toBe(true)
      expect((await repository.renameMeeting("meet_m5", "שם ידני")).titleSource).toBe("user")
      expect(await repository.applyAiTitle("meet_m5", "כותרת AI חדשה")).toBe(false)
      expect((await repository.getMeeting("meet_m5"))?.title).toBe("שם ידני")
    })
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

describe("in-memory speaker data layer (M3)", () => {
  async function seedDiarized() {
    const repository = createInMemoryMeetingRepository()
    const meeting = await repository.createMeeting({
      title: "סנכרון שבועי",
      source: "upload",
      language: "he",
      startedAt: "2026-10-01T09:00:00.000Z",
      participants: ["dana@example.com", "Ran"],
    })
    const segments: TranscriptSegment[] = [
      {
        id: "seg_1",
        speaker: "Speaker 1",
        startMs: 0,
        endMs: 2_000,
        text: "שלום, אני דנה",
        language: "he",
        words: [
          { startMs: 0, endMs: 600, text: "שלום," },
          { startMs: 700, endMs: 1_200, text: "אני" },
          { startMs: 1_300, endMs: 2_000, text: "דנה" },
        ],
      },
      {
        id: "seg_2",
        speaker: "Speaker 2",
        startMs: 2_500,
        endMs: 4_000,
        text: "היי דנה",
        language: "he",
        words: [
          { startMs: 2_500, endMs: 3_000, text: "היי" },
          { startMs: 3_100, endMs: 4_000, text: "דנה" },
        ],
      },
      {
        id: "seg_3",
        speaker: "Speaker 1",
        startMs: 4_500,
        endMs: 6_000,
        text: "נתחיל",
        language: "he",
        words: [{ startMs: 4_500, endMs: 6_000, text: "נתחיל" }],
      },
    ]
    const written = await repository.replaceTranscript(meeting.id, {
      segments,
      speakers: [
        { label: "Speaker 1", talkTimeMs: 3_500, wordCount: 4, segmentCount: 2, firstStartMs: 0 },
        { label: "Speaker 2", talkTimeMs: 1_500, wordCount: 2, segmentCount: 1, firstStartMs: 2_500 },
      ],
      asrRunId: "airun_1",
    })

    return { repository, meeting, written, segments }
  }

  it("stores one speaker per label with words, turn indexes and no label participants", async () => {
    const { repository, meeting, written } = await seedDiarized()
    const stored = await repository.getMeeting(meeting.id)

    expect(written.speakers.map((speaker) => [speaker.label, speaker.mappingStatus])).toEqual([
      ["Speaker 1", "unmapped"],
      ["Speaker 2", "unmapped"],
    ])
    expect(stored?.speakers).toHaveLength(2)
    expect(stored?.transcript?.map((segment) => segment.turnIndex)).toEqual([0, 1, 2])
    expect(stored?.transcript?.[0].words).toHaveLength(3)
    expect(stored?.transcript?.every((segment) => segment.speakerId)).toBe(true)
    expect(
      (await repository.listMeetingParticipants(meeting.id)).some((participant) =>
        /^Speaker \d+$/.test(participant.name)
      )
    ).toBe(false)
  })

  it("names segments through the participant link without rewriting text or words", async () => {
    const { repository, meeting, written, segments } = await seedDiarized()
    const dana = (await repository.listMeetingParticipants(meeting.id)).find(
      (participant) => participant.email === "dana@example.com"
    )!
    const speaker1 = written.speakers.find((speaker) => speaker.label === "Speaker 1")!

    const updated = await repository.updateMeetingSpeaker(meeting.id, speaker1.id, {
      participantId: dana.id,
      mappingStatus: "confirmed",
    })
    const stored = await repository.getMeeting(meeting.id)

    expect(updated).toMatchObject({ displayName: "dana", mappingStatus: "confirmed" })
    expect(updated.confirmedAt).toBeTruthy()
    expect(stored?.transcript?.map((segment) => segment.speaker)).toEqual([
      "dana",
      "Speaker 2",
      "dana",
    ])
    expect(stored?.transcript?.map((segment) => segment.text)).toEqual(
      segments.map((segment) => segment.text)
    )
    expect(stored?.transcript?.map((segment) => segment.words)).toEqual(
      segments.map((segment) => segment.words)
    )
  })

  it("assignSpeakerToParticipant maps the speaker row instead of rewriting segments", async () => {
    const { repository, meeting, segments } = await seedDiarized()
    const ran = (await repository.listMeetingParticipants(meeting.id)).find(
      (participant) => participant.name === "Ran"
    )!

    await repository.assignSpeakerToParticipant(meeting.id, "Speaker 2", ran.id)

    const speakers = await repository.listMeetingSpeakers(meeting.id)
    const stored = await repository.getMeeting(meeting.id)

    expect(speakers.find((speaker) => speaker.label === "Speaker 2")).toMatchObject({
      participantId: ran.id,
      mappingStatus: "confirmed",
      displayName: "Ran",
    })
    expect(stored?.transcript?.[1]).toMatchObject({ speaker: "Ran", text: segments[1].text })
  })

  it("rejects a participant of another meeting", async () => {
    const { repository, meeting, written } = await seedDiarized()
    const other = await repository.createMeeting({
      title: "Other",
      source: "upload",
      language: "en",
      startedAt: "2026-10-01T09:00:00.000Z",
      participants: ["Eve"],
    })
    const [eve] = await repository.listMeetingParticipants(other.id)

    await expect(
      repository.updateMeetingSpeaker(meeting.id, written.speakers[0].id, {
        participantId: eve.id,
      })
    ).rejects.toThrow("Participant not found")
    await expect(
      repository.updateMeetingSpeaker(other.id, written.speakers[0].id, { displayName: "X" })
    ).rejects.toThrow("Speaker not found")
  })

  it("merges speakers: repoints segments, sums stats, recomputes turns, keeps text/words", async () => {
    const { repository, meeting, written, segments } = await seedDiarized()
    const [speaker1, speaker2] = written.speakers

    const merged = await repository.mergeMeetingSpeakers(meeting.id, speaker2.id, speaker1.id)
    const stored = await repository.getMeeting(meeting.id)

    expect(merged).toMatchObject({
      id: speaker1.id,
      talkTimeMs: 5_000,
      wordCount: 6,
      segmentCount: 3,
    })
    expect(stored?.speakers?.map((speaker) => speaker.id)).toEqual([speaker1.id])
    expect(stored?.transcript?.map((segment) => segment.turnIndex)).toEqual([0, 0, 0])
    expect(stored?.transcript?.map((segment) => [segment.text, segment.words])).toEqual(
      segments.map((segment) => [segment.text, segment.words])
    )
  })

  it("re-ASR resets confirmed mappings; legacy rewrites and Meet re-imports keep them", async () => {
    const { repository, meeting, written, segments } = await seedDiarized()
    const [speaker1] = written.speakers

    await repository.updateMeetingSpeaker(meeting.id, speaker1.id, {
      displayName: "Dana",
      mappingStatus: "confirmed",
    })

    // Legacy path re-writes the same transcript read back from the meeting.
    const readBack = (await repository.getMeeting(meeting.id))!.transcript!
    await repository.replaceTranscriptSegments(meeting.id, readBack)
    expect(
      (await repository.listMeetingSpeakers(meeting.id)).find((s) => s.id === speaker1.id)
    ).toMatchObject({ mappingStatus: "confirmed", displayName: "Dana" })

    await repository.replaceTranscript(meeting.id, {
      segments,
      speakers: [{ label: "Speaker 1", talkTimeMs: 1, wordCount: 1, segmentCount: 1 }],
    })
    const afterReasr = await repository.listMeetingSpeakers(meeting.id)

    expect(afterReasr.find((s) => s.label === "Speaker 1")).toMatchObject({
      id: speaker1.id,
      mappingStatus: "unmapped",
      displayName: undefined,
    })

    const meetSegments = segments.map((segment) => ({
      ...segment,
      speaker: segment.speaker === "Speaker 1" ? "Dana Cohen" : "Ran Levi",
      source: "meet",
    }))
    const meetStats = [
      { label: "Dana Cohen", source: "meet", talkTimeMs: 1, wordCount: 1, segmentCount: 1 },
      { label: "Ran Levi", source: "meet", talkTimeMs: 1, wordCount: 1, segmentCount: 1 },
    ]
    const imported = await repository.replaceTranscript(meeting.id, {
      segments: meetSegments,
      speakers: meetStats,
    })
    const danaSpeaker = imported.speakers.find((s) => s.label === "Dana Cohen")!

    await repository.updateMeetingSpeaker(meeting.id, danaSpeaker.id, { mappingStatus: "confirmed" })
    await repository.replaceTranscript(meeting.id, { segments: meetSegments, speakers: meetStats })

    expect(
      (await repository.listMeetingSpeakers(meeting.id)).find((s) => s.label === "Dana Cohen")
    ).toMatchObject({ id: danaSpeaker.id, mappingStatus: "confirmed" })
    // Labels without segments are gone.
    expect(
      (await repository.listMeetingSpeakers(meeting.id)).map((speaker) => speaker.label)
    ).toEqual(["Dana Cohen", "Ran Levi"])
  })

  it("never lets suggestions overwrite confirmed or rejected speakers", async () => {
    const { repository, meeting, written } = await seedDiarized()
    const [speaker1, speaker2] = written.speakers
    const suggestion = {
      name: "Dana",
      score: 0.8,
      reasons: [],
      computedAt: "2026-10-13T00:00:00.000Z",
    }

    await repository.updateMeetingSpeaker(meeting.id, speaker1.id, { mappingStatus: "rejected" })
    const result = await repository.setSpeakerSuggestions(meeting.id, [
      { speakerId: speaker1.id, suggestion, mappingStatus: "suggested" },
      { speakerId: speaker2.id, suggestion, mappingStatus: "suggested" },
    ])

    expect(result.find((s) => s.id === speaker1.id)).toMatchObject({ mappingStatus: "rejected" })
    expect(result.find((s) => s.id === speaker1.id)?.suggestion).toBeUndefined()
    expect(result.find((s) => s.id === speaker2.id)).toMatchObject({
      mappingStatus: "suggested",
      suggestion,
    })
  })

  it("records confirmed speakers as workspace profiles (email, then name; aliases; running mean)", async () => {
    const { repository, meeting, written } = await seedDiarized()
    const [speaker1, speaker2] = written.speakers

    const first = await repository.recordConfirmedSpeaker({
      meetingId: meeting.id,
      speakerId: speaker1.id,
      participant: { name: "Dana Cohen" },
      aliases: ["דנה"],
      embedding: [1, 0],
      embeddingModel: "pyannote",
    })
    const second = await repository.recordConfirmedSpeaker({
      meetingId: meeting.id,
      speakerId: speaker2.id,
      participant: { name: " dana  cohen" },
      aliases: ["Dana", "דנה"],
      embedding: [0, 1],
      embeddingModel: "pyannote",
    })

    expect(second.id).toBe(first.id)
    expect(second).toMatchObject({
      confirmedCount: 2,
      aliases: ["דנה", "Dana"],
      voiceEmbedding: [0.5, 0.5],
      displayName: "dana cohen",
    })
    expect(await repository.listSpeakerProfiles()).toHaveLength(1)
    expect(
      (await repository.listMeetingSpeakers(meeting.id)).every(
        (speaker) => speaker.profileId === first.id
      )
    ).toBe(true)

    const byEmail = await repository.recordConfirmedSpeaker({
      meetingId: meeting.id,
      speakerId: speaker1.id,
      participant: { name: "Dana Cohen", email: "DANA@example.com" },
      aliases: [],
    })

    expect(byEmail.id).not.toBe(first.id)
    expect(byEmail.email).toBe("dana@example.com")
  })

  it("keeps speakers and profiles inside the workspace scope", async () => {
    const db = createInMemoryMeetingDatabase()
    const wsA = createInMemoryMeetingRepository(db, { kind: "system", workspaceId: "ws_a" })
    const wsB = createInMemoryMeetingRepository(db, { kind: "system", workspaceId: "ws_b" })
    const meeting = await wsA.createMeeting({
      title: "A",
      source: "upload",
      language: "en",
      startedAt: "2026-10-01T09:00:00.000Z",
    })
    const { speakers } = await wsA.replaceTranscript(meeting.id, {
      segments: [{ id: "s1", speaker: "Speaker 1", startMs: 0, endMs: 1, text: "hi" }],
      speakers: [],
    })

    await wsA.recordConfirmedSpeaker({
      meetingId: meeting.id,
      speakerId: speakers[0].id,
      participant: { name: "Dana" },
      aliases: [],
    })

    await expect(wsB.listMeetingSpeakers(meeting.id)).rejects.toThrow("Meeting not found")
    await expect(
      wsB.updateMeetingSpeaker(meeting.id, speakers[0].id, { displayName: "x" })
    ).rejects.toThrow("Meeting not found")
    expect(await wsB.listSpeakerProfiles()).toEqual([])
    expect(await wsA.listSpeakerProfiles()).toHaveLength(1)
  })
})
