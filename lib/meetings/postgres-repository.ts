import type { Queryable } from "@/lib/db/client"
import type {
  CreateContextInput,
  CreateMeetingInput,
  MeetingAnswer,
  MeetingContext,
  MeetingRecord,
  MeetingRepository,
  SuggestedAgentRun,
} from "@/lib/meetings/repository"
import {
  buildMeetingIntelligence,
  type MeetingIntelligence,
} from "@/lib/intelligence"

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

type IntelligenceRunRow = {
  output: MeetingIntelligence
}

type ContextRow = {
  id: string
  name: string
  description: string | null
  created_at: string | Date
}

type SuggestedAgentRunRow = {
  id: string
  meeting_id: string
  target: SuggestedAgentRun["target"]
  payload: Record<string, unknown> | null
  status: SuggestedAgentRun["status"]
  created_at: string | Date
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

    async getMeetingIntelligence(meetingId: string) {
      const result = await client.query(
        `
          select output
          from intelligence_runs
          where meeting_id = $1
          order by created_at desc
          limit 1
        `,
        [meetingId]
      )

      return (result.rows[0] as IntelligenceRunRow | undefined)?.output
    },

    async runMeetingIntelligence(meetingId: string) {
      const meeting = await this.getMeeting(meetingId)

      if (!meeting) {
        throw new Error(`Meeting not found: ${meetingId}`)
      }

      const intelligence = buildMeetingIntelligence(meeting)

      await client.query(
        `
          insert into intelligence_runs (id, meeting_id, provider, model, input, output, status)
          values ($1, $2, 'local', 'heuristic-v1', $3::jsonb, $4::jsonb, 'completed')
        `,
        [
          `intel_${crypto.randomUUID()}`,
          meetingId,
          JSON.stringify({ transcriptSegments: meeting.transcript?.length ?? 0 }),
          JSON.stringify(intelligence),
        ]
      )
      await client.query(
        `
          update meetings
          set language_metadata = $2::jsonb
          where id = $1
        `,
        [meetingId, JSON.stringify(intelligence.languageMetadata)]
      )

      return intelligence
    },

    async listContexts(): Promise<MeetingContext[]> {
      const result = await client.query(`
        select id, name, description, created_at
        from contexts
        order by name asc
      `)

      return result.rows.map((row) => {
        const context = row as ContextRow

        return {
        id: context.id,
        name: context.name,
        description: context.description ?? undefined,
        createdAt:
          context.created_at instanceof Date
            ? context.created_at.toISOString()
            : context.created_at,
        }
      })
    },

    async createContext(input: CreateContextInput): Promise<MeetingContext> {
      const result = await client.query(
        `
          insert into contexts (id, name, description)
          values ($1, $2, $3)
          returning id, name, description, created_at
        `,
        [`ctx_${crypto.randomUUID()}`, input.name, input.description ?? null]
      )
      const row = result.rows[0] as ContextRow

      return {
        id: row.id,
        name: row.name,
        description: row.description ?? undefined,
        createdAt:
          row.created_at instanceof Date
            ? row.created_at.toISOString()
            : row.created_at,
      }
    },

    async linkMeetingContext(meetingId: string, contextId: string) {
      await client.query(
        `
          insert into meeting_contexts (meeting_id, context_id)
          values ($1, $2)
          on conflict do nothing
        `,
        [meetingId, contextId]
      )

      const meeting = await this.getMeeting(meetingId)

      if (!meeting) {
        throw new Error(`Meeting not found: ${meetingId}`)
      }

      return meeting
    },

    async createSuggestedAgentRun(input): Promise<SuggestedAgentRun> {
      const result = await client.query(
        `
          insert into suggested_agent_runs (id, meeting_id, target, payload, status)
          values ($1, $2, $3, $4::jsonb, 'suggested')
          returning id, meeting_id, target, payload, status, created_at
        `,
        [
          `agent_suggestion_${crypto.randomUUID()}`,
          input.meetingId,
          input.target,
          JSON.stringify(input.payload),
        ]
      )
      const row = result.rows[0] as SuggestedAgentRunRow

      return {
        id: row.id,
        meetingId: row.meeting_id,
        target: row.target,
        payload: row.payload ?? {},
        status: row.status,
        createdAt:
          row.created_at instanceof Date
            ? row.created_at.toISOString()
            : row.created_at,
      }
    },
  }
}
