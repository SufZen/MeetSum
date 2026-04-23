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

export type MeetingRepository = ReturnType<typeof createInMemoryMeetingRepository>

function normalize(value: string): string {
  return value.toLowerCase()
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

export function createInMemoryMeetingRepository(initialMeetings: MeetingRecord[] = []) {
  const meetings = new Map<string, MeetingRecord>(
    initialMeetings.map((meeting) => [meeting.id, meeting]),
  )

  return {
    listMeetings(): MeetingRecord[] {
      return [...meetings.values()].sort((a, b) =>
        b.startedAt.localeCompare(a.startedAt),
      )
    },

    getMeeting(id: string): MeetingRecord | undefined {
      return meetings.get(id)
    },

    createMeeting(input: CreateMeetingInput): MeetingRecord {
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

    searchMeetings(query: string): MeetingRecord[] {
      const needle = normalize(query)

      return this.listMeetings().filter((meeting) => {
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

    askMeetingMemory(meetingId: string, question: string): MeetingAnswer {
      const meeting = meetings.get(meetingId)

      if (!meeting) {
        throw new Error(`Meeting not found: ${meetingId}`)
      }

      const normalizedQuestion = normalize(question)
      const transcriptMatch = meeting.transcript?.find((segment) =>
        normalize(segment.text).includes(
          normalizedQuestion.includes("realizeos") ? "realizeos" : "",
        ),
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
