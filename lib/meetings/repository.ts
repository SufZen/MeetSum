import type { MeetingStatus } from "@/lib/meetings/state"
import {
  buildMeetingIntelligence,
  type MeetingIntelligence,
  type MeetingLanguageMetadata,
  type MeetingTag,
  type SmartTask,
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
      const actionItems: SmartTask[] = intelligence.actionItems
      const updatedMeeting: MeetingRecord = {
        ...meeting,
        intelligence,
        languageMetadata: intelligence.languageMetadata,
        tags: intelligence.tags,
        summary: {
          overview: intelligence.overview,
          decisions: intelligence.decisions,
          actionItems,
        },
      }

      meetings.set(meetingId, updatedMeeting)
      return intelligence
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
