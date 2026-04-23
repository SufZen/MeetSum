import type { MeetingStatus } from "@/lib/meetings/state"

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
  }
}
