import type { MeetingStatus } from "@/lib/meetings/state"
import {
  buildMeetingIntelligence,
  type MeetingIntelligence,
  type MeetingLanguageMetadata,
  type MeetingTag,
} from "@/lib/intelligence"

export type MeetingSource =
  | "upload"
  | "pwa_recorder"
  | "google_meet"
  | "desktop_recorder"
  | "meeting_bot"

export type ActionItem = {
  id: string
  title: string
  owner?: string
  status: "open" | "done"
  dueDate?: string
  priority?: "low" | "normal" | "high" | "urgent"
  confidence?: number
  sourceQuote?: string
  sourceStartMs?: number
  kind?: "explicit" | "inferred"
}

export type TranscriptSegment = {
  id: string
  speaker: string
  startMs: number
  endMs: number
  text: string
  confidence?: number
  language?: string
}

export type MeetingSummary = {
  overview: string
  decisions: string[]
  actionItems: ActionItem[]
}

export type MeetingContext = {
  id: string
  name: string
  description?: string
  createdAt: string
}

export type CreateContextInput = {
  name: string
  description?: string
}

export type SuggestedAgentRun = {
  id: string
  meetingId: string
  target: "realizeos" | "n8n" | "mcp" | "webhook"
  payload: Record<string, unknown>
  status: "suggested" | "queued" | "sent" | "failed"
  createdAt: string
}

export type MediaAsset = {
  id: string
  meetingId: string
  storageKey: string
  filename?: string
  contentType: string
  sizeBytes: number
  retention: "audio" | "video"
  createdAt: string
}

export type JobStatus = "queued" | "active" | "completed" | "failed"

export type JobRecord = {
  id: string
  name: string
  status: JobStatus
  meetingId?: string
  payload: Record<string, unknown>
  result: Record<string, unknown>
  error?: string
  attempts: number
  maxAttempts: number
  retryOfJobId?: string
  createdAt: string
  updatedAt: string
}

export type MeetingRecord = {
  id: string
  title: string
  source: MeetingSource
  language: string
  status: MeetingStatus
  retention: "audio" | "video"
  startedAt: string
  participants: string[]
  summary?: MeetingSummary
  transcript?: TranscriptSegment[]
  tags?: MeetingTag[]
  languageMetadata?: MeetingLanguageMetadata
  contexts?: MeetingContext[]
  intelligence?: MeetingIntelligence
  suggestedAgentRuns?: SuggestedAgentRun[]
  mediaAssets?: MediaAsset[]
}

export type CreateMeetingInput = {
  title: string
  source: MeetingSource
  language: string
  startedAt: string
  participants?: string[]
}

export type MeetingAnswer = {
  answer: string
  citations: Array<{
    meetingId: string
    segmentId: string
    startMs: number
  }>
}

export type MeetingRepository = {
  listMeetings: () => Promise<MeetingRecord[]>
  getMeeting: (id: string) => Promise<MeetingRecord | undefined>
  createMeeting: (input: CreateMeetingInput) => Promise<MeetingRecord>
  updateMeetingStatus: (
    id: string,
    status: MeetingStatus
  ) => Promise<MeetingRecord>
  createMediaAsset: (input: {
    meetingId: string
    storageKey: string
    filename?: string
    contentType: string
    sizeBytes: number
    retention?: "audio" | "video"
  }) => Promise<MediaAsset>
  replaceTranscriptSegments: (
    meetingId: string,
    segments: TranscriptSegment[]
  ) => Promise<TranscriptSegment[]>
  upsertMeetingIntelligence: (
    meetingId: string,
    intelligence: MeetingIntelligence,
    provider?: string,
    model?: string
  ) => Promise<MeetingIntelligence>
  updateActionItem: (
    id: string,
    patch: Partial<Pick<ActionItem, "status" | "title" | "owner" | "dueDate" | "priority">>
  ) => Promise<ActionItem>
  createJob: (input: {
    id?: string
    name: string
    meetingId?: string
    payload?: Record<string, unknown>
    status?: JobStatus
    retryOfJobId?: string
  }) => Promise<JobRecord>
  updateJob: (
    id: string,
    patch: Partial<Pick<JobRecord, "status" | "result" | "error" | "attempts">>
  ) => Promise<JobRecord>
  getJob: (id: string) => Promise<JobRecord | undefined>
  listJobs: (filters?: { meetingId?: string; status?: JobStatus }) => Promise<JobRecord[]>
  searchMeetings: (query: string) => Promise<MeetingRecord[]>
  askMeetingMemory: (
    meetingId: string,
    question: string
  ) => Promise<MeetingAnswer>
  getMeetingIntelligence: (
    meetingId: string
  ) => Promise<MeetingIntelligence | undefined>
  runMeetingIntelligence: (meetingId: string) => Promise<MeetingIntelligence>
  listContexts: () => Promise<MeetingContext[]>
  createContext: (input: CreateContextInput) => Promise<MeetingContext>
  linkMeetingContext: (
    meetingId: string,
    contextId: string
  ) => Promise<MeetingRecord>
  createSuggestedAgentRun: (input: {
    meetingId: string
    target: SuggestedAgentRun["target"]
    payload: Record<string, unknown>
  }) => Promise<SuggestedAgentRun>
}

function normalize(value: string): string {
  return value.toLowerCase()
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

export function createInMemoryMeetingRepository(
  initialMeetings: MeetingRecord[] = []
): MeetingRepository {
  const meetings = new Map<string, MeetingRecord>(
    initialMeetings.map((meeting) => [meeting.id, meeting])
  )
  const contexts = new Map<string, MeetingContext>()
  const jobs = new Map<string, JobRecord>()

  return {
    async listMeetings(): Promise<MeetingRecord[]> {
      return [...meetings.values()].sort((a, b) =>
        b.startedAt.localeCompare(a.startedAt)
      )
    },

    async getMeeting(id: string): Promise<MeetingRecord | undefined> {
      return meetings.get(id)
    },

    async createMeeting(input: CreateMeetingInput): Promise<MeetingRecord> {
      const meeting: MeetingRecord = {
        id: createId("meet"),
        title: input.title,
        source: input.source,
        language: input.language,
        status: "created",
        retention: "audio",
        startedAt: input.startedAt,
        participants: input.participants ?? [],
      }

      meetings.set(meeting.id, meeting)
      return meeting
    },

    async updateMeetingStatus(
      id: string,
      status: MeetingStatus
    ): Promise<MeetingRecord> {
      const meeting = meetings.get(id)

      if (!meeting) {
        throw new Error(`Meeting not found: ${id}`)
      }

      const updated = { ...meeting, status }

      meetings.set(id, updated)
      return updated
    },

    async createMediaAsset(input): Promise<MediaAsset> {
      const meeting = meetings.get(input.meetingId)

      if (!meeting) {
        throw new Error(`Meeting not found: ${input.meetingId}`)
      }

      const asset: MediaAsset = {
        id: createId("asset"),
        meetingId: input.meetingId,
        storageKey: input.storageKey,
        filename: input.filename,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        retention: input.retention ?? "audio",
        createdAt: new Date().toISOString(),
      }
      const updated = {
        ...meeting,
        mediaAssets: [...(meeting.mediaAssets ?? []), asset],
        status: "media_uploaded" as const,
      }

      meetings.set(meeting.id, updated)
      return asset
    },

    async replaceTranscriptSegments(
      meetingId: string,
      segments: TranscriptSegment[]
    ): Promise<TranscriptSegment[]> {
      const meeting = meetings.get(meetingId)

      if (!meeting) {
        throw new Error(`Meeting not found: ${meetingId}`)
      }

      meetings.set(meetingId, { ...meeting, transcript: segments })
      return segments
    },

    async upsertMeetingIntelligence(
      meetingId: string,
      intelligence: MeetingIntelligence
    ): Promise<MeetingIntelligence> {
      const meeting = meetings.get(meetingId)

      if (!meeting) {
        throw new Error(`Meeting not found: ${meetingId}`)
      }

      const updatedMeeting: MeetingRecord = {
        ...meeting,
        status: "completed",
        intelligence,
        languageMetadata: intelligence.languageMetadata,
        tags: intelligence.tags,
        summary: {
          overview: intelligence.overview,
          decisions: intelligence.decisions,
          actionItems: intelligence.actionItems,
        },
      }

      meetings.set(meetingId, updatedMeeting)
      return intelligence
    },

    async updateActionItem(id, patch): Promise<ActionItem> {
      for (const meeting of meetings.values()) {
        const actionItems = meeting.summary?.actionItems ?? []
        const index = actionItems.findIndex((item) => item.id === id)

        if (index >= 0) {
          const updatedItem = { ...actionItems[index], ...patch }
          const updatedActionItems = [...actionItems]

          updatedActionItems[index] = updatedItem
          meetings.set(meeting.id, {
            ...meeting,
            summary: meeting.summary
              ? { ...meeting.summary, actionItems: updatedActionItems }
              : undefined,
            intelligence: meeting.intelligence
              ? {
                  ...meeting.intelligence,
                  actionItems: meeting.intelligence.actionItems.map((item) =>
                    item.id === id ? { ...item, ...patch } : item
                  ),
                }
              : undefined,
          })
          return updatedItem
        }
      }

      throw new Error(`Action item not found: ${id}`)
    },

    async createJob(input): Promise<JobRecord> {
      const now = new Date().toISOString()
      const job: JobRecord = {
        id: input.id ?? createId("job"),
        name: input.name,
        status: input.status ?? "queued",
        meetingId: input.meetingId,
        payload: input.payload ?? {},
        result: {},
        attempts: 0,
        maxAttempts: 3,
        retryOfJobId: input.retryOfJobId,
        createdAt: now,
        updatedAt: now,
      }

      jobs.set(job.id, job)
      return job
    },

    async updateJob(id, patch): Promise<JobRecord> {
      const job = jobs.get(id)

      if (!job) {
        throw new Error(`Job not found: ${id}`)
      }

      const updated = {
        ...job,
        ...patch,
        updatedAt: new Date().toISOString(),
      }

      jobs.set(id, updated)
      return updated
    },

    async getJob(id): Promise<JobRecord | undefined> {
      return jobs.get(id)
    },

    async listJobs(filters = {}): Promise<JobRecord[]> {
      return [...jobs.values()]
        .filter((job) =>
          filters.meetingId ? job.meetingId === filters.meetingId : true
        )
        .filter((job) => (filters.status ? job.status === filters.status : true))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    },

    async searchMeetings(query: string): Promise<MeetingRecord[]> {
      const needle = normalize(query)
      const allMeetings = await this.listMeetings()

      return allMeetings.filter((meeting) => {
        const searchable = [
          meeting.title,
          meeting.summary?.overview,
          ...(meeting.summary?.decisions ?? []),
          ...(meeting.summary?.actionItems.map((item) => item.title) ?? []),
          ...(meeting.transcript?.map((segment) => segment.text) ?? []),
        ]
          .filter(Boolean)
          .join(" ")

        return normalize(searchable).includes(needle)
      })
    },

    async askMeetingMemory(
      meetingId: string,
      question: string
    ): Promise<MeetingAnswer> {
      const meeting = meetings.get(meetingId)

      if (!meeting) {
        throw new Error(`Meeting not found: ${meetingId}`)
      }

      const normalizedQuestion = normalize(question)
      const transcriptMatch = meeting.transcript?.find((segment) =>
        normalize(segment.text).includes(
          normalizedQuestion.includes("realizeos") ? "realizeos" : ""
        )
      )

      const answer =
        meeting.summary?.overview ??
        transcriptMatch?.text ??
        "No summary is available for this meeting yet."

      return {
        answer,
        citations: transcriptMatch
          ? [
              {
                meetingId,
                segmentId: transcriptMatch.id,
                startMs: transcriptMatch.startMs,
              },
            ]
          : [],
      }
    },

    async getMeetingIntelligence(
      meetingId: string
    ): Promise<MeetingIntelligence | undefined> {
      return meetings.get(meetingId)?.intelligence
    },

    async runMeetingIntelligence(
      meetingId: string
    ): Promise<MeetingIntelligence> {
      const meeting = meetings.get(meetingId)

      if (!meeting) {
        throw new Error(`Meeting not found: ${meetingId}`)
      }

      const intelligence = buildMeetingIntelligence(meeting)

      return this.upsertMeetingIntelligence(meetingId, intelligence)
    },

    async listContexts(): Promise<MeetingContext[]> {
      return [...contexts.values()].sort((a, b) =>
        a.name.localeCompare(b.name)
      )
    },

    async createContext(input: CreateContextInput): Promise<MeetingContext> {
      const context: MeetingContext = {
        id: createId("ctx"),
        name: input.name,
        description: input.description,
        createdAt: new Date().toISOString(),
      }

      contexts.set(context.id, context)
      return context
    },

    async linkMeetingContext(
      meetingId: string,
      contextId: string
    ): Promise<MeetingRecord> {
      const meeting = meetings.get(meetingId)
      const context = contexts.get(contextId)

      if (!meeting) {
        throw new Error(`Meeting not found: ${meetingId}`)
      }
      if (!context) {
        throw new Error(`Context not found: ${contextId}`)
      }

      const nextContexts = [
        ...(meeting.contexts ?? []).filter((item) => item.id !== context.id),
        context,
      ]
      const updatedMeeting = { ...meeting, contexts: nextContexts }

      meetings.set(meetingId, updatedMeeting)
      return updatedMeeting
    },

    async createSuggestedAgentRun(input): Promise<SuggestedAgentRun> {
      const meeting = meetings.get(input.meetingId)

      if (!meeting) {
        throw new Error(`Meeting not found: ${input.meetingId}`)
      }

      const suggestion: SuggestedAgentRun = {
        id: createId("agent_suggestion"),
        meetingId: input.meetingId,
        target: input.target,
        payload: input.payload,
        status: "suggested",
        createdAt: new Date().toISOString(),
      }
      const updatedMeeting = {
        ...meeting,
        suggestedAgentRuns: [
          ...(meeting.suggestedAgentRuns ?? []),
          suggestion,
        ],
      }

      meetings.set(input.meetingId, updatedMeeting)
      return suggestion
    },
  }
}
