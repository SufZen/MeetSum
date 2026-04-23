import type { Queryable } from "@/lib/db/client"
import type {
  CreateMeetingInput,
  MeetingAnswer,
  MeetingRecord,
  MeetingRepository,
} from "@/lib/meetings/repository"

type MeetingRow = {
  id: string
  title: string
  source: MeetingRecord["source"]
  language: string
  status: MeetingRecord["status"]
  retention: MeetingRecord["retention"]
  started_at: string | Date
  participants: string[]
}

function mapMeetingRow(row: MeetingRow): MeetingRecord {
  const participants =
    typeof row.participants === "string"
      ? (JSON.parse(row.participants) as string[])
      : (row.participants ?? [])

  return {
    id: row.id,
    title: row.title,
    source: row.source,
    language: row.language,
    status: row.status,
    retention: row.retention,
    startedAt:
      row.started_at instanceof Date
        ? row.started_at.toISOString()
        : row.started_at,
    participants,
  }
}

export function createPostgresMeetingRepository(
  client: Queryable
): MeetingRepository {
  return {
    async listMeetings() {
      const result = await client.query(`
        select id, title, source, language, status, retention, started_at, participants
        from meetings
        order by started_at desc
      `)

      return result.rows.map((row) => mapMeetingRow(row as MeetingRow))
    },

    async getMeeting(id: string) {
      const result = await client.query(
        `
          select id, title, source, language, status, retention, started_at, participants
          from meetings
          where id = $1
          limit 1
        `,
        [id]
      )

      const row = result.rows[0] as MeetingRow | undefined

      return row ? mapMeetingRow(row) : undefined
    },

    async createMeeting(input: CreateMeetingInput) {
      const result = await client.query(
        `
          insert into meetings (
            id, title, source, language, status, retention, started_at, participants
          )
          values ($6, $1, $2, $3, 'created', 'audio', $4, $5::jsonb)
          returning id, title, source, language, status, retention, started_at, participants
        `,
        [
          input.title,
          input.source,
          input.language,
          input.startedAt,
          JSON.stringify(input.participants ?? []),
          `meet_${crypto.randomUUID()}`,
        ]
      )

      return mapMeetingRow(result.rows[0] as MeetingRow)
    },

    async searchMeetings(query: string) {
      const result = await client.query(
        `
          select id, title, source, language, status, retention, started_at, participants
          from meetings
          where title ilike $1
          order by started_at desc
        `,
        [`%${query}%`]
      )

      return result.rows.map((row) => mapMeetingRow(row as MeetingRow))
    },

    async askMeetingMemory(
      meetingId: string,
      question: string
    ): Promise<MeetingAnswer> {
      void question

      const meeting = await this.getMeeting(meetingId)

      if (!meeting) {
        throw new Error(`Meeting not found: ${meetingId}`)
      }

      return {
        answer: "No summary is available for this meeting yet.",
        citations: [],
      }
    },
  }
}
