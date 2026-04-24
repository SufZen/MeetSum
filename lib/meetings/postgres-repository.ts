import type { Queryable } from "@/lib/db/client"
import type {
  ActionItem,
  CreateContextInput,
  CreateMeetingInput,
  JobRecord,
  JobStatus,
  MediaAsset,
  MeetingAnswer,
  MeetingContext,
  MeetingRecord,
  MeetingRepository,
  SuggestedAgentRun,
} from "@/lib/meetings/repository"
import {
  buildMeetingIntelligence,
  type MeetingIntelligence,
  type MeetingTag,
} from "@/lib/intelligence"
import type { MeetingStatus } from "@/lib/meetings/state"

type MeetingRow = {
  id: string
  title: string
  source: MeetingRecord["source"]
  language: string
  status: MeetingRecord["status"]
  retention: MeetingRecord["retention"]
  started_at: string | Date
  participants: string[] | string
  language_metadata?: MeetingRecord["languageMetadata"]
}

type TranscriptRow = {
  id: string
  speaker_label: string | null
  start_ms: number
  end_ms: number
  text: string
  confidence: string | number | null
  language: string | null
}

type SummaryRow = {
  id: string
  overview: string
  language: string
  model_provider: string | null
}

type SummarySectionRow = {
  kind: string
  content: unknown
}

type ActionItemRow = {
  id: string
  title: string
  owner: string | null
  status: ActionItem["status"]
  due_date: string | Date | null
  priority: ActionItem["priority"]
  confidence: string | number | null
  source_quote: string | null
  source_start_ms: number | null
  kind: ActionItem["kind"]
}

type TagRow = { name: MeetingTag }
type IntelligenceRunRow = { output: MeetingIntelligence }

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

type MediaAssetRow = {
  id: string
  meeting_id: string
  storage_key: string
  filename: string | null
  content_type: string
  size_bytes: string | number
  retention: MediaAsset["retention"]
  created_at: string | Date
}

type JobRow = {
  id: string
  name: string
  status: JobStatus
  meeting_id: string | null
  payload: Record<string, unknown> | null
  result: Record<string, unknown> | null
  error: string | null
  attempts: number
  created_at: string | Date
  updated_at: string | Date
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value
}

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.map(String) : []
    } catch {
      return []
    }
  }

  return []
}

function mapMeetingRow(row: MeetingRow): MeetingRecord {
  return {
    id: row.id,
    title: row.title,
    source: row.source,
    language: row.language,
    status: row.status,
    retention: row.retention,
    startedAt: toIso(row.started_at),
    participants: parseJsonArray(row.participants),
    languageMetadata: row.language_metadata,
  }
}

function mapActionItem(row: ActionItemRow): ActionItem {
  return {
    id: row.id,
    title: row.title,
    owner: row.owner ?? undefined,
    status: row.status,
    dueDate: row.due_date ? toIso(row.due_date) : undefined,
    priority: row.priority,
    confidence:
      row.confidence === null ? undefined : Number(row.confidence),
    sourceQuote: row.source_quote ?? undefined,
    sourceStartMs: row.source_start_ms ?? undefined,
    kind: row.kind,
  }
}

function mapMediaAsset(row: MediaAssetRow): MediaAsset {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    storageKey: row.storage_key,
    filename: row.filename ?? undefined,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    retention: row.retention,
    createdAt: toIso(row.created_at),
  }
}

function mapJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    meetingId: row.meeting_id ?? undefined,
    payload: row.payload ?? {},
    result: row.result ?? {},
    error: row.error ?? undefined,
    attempts: row.attempts,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }
}

export function createPostgresMeetingRepository(
  client: Queryable
): MeetingRepository {
  async function hydrateMeeting(base: MeetingRecord): Promise<MeetingRecord> {
    const [
      transcriptResult,
      summaryResult,
      actionItemsResult,
      tagsResult,
      contextsResult,
      intelligenceResult,
      suggestedRunsResult,
      mediaAssetsResult,
    ] = await Promise.all([
      client.query(
        `
          select
            ts.id,
            coalesce(s.display_name, s.label) as speaker_label,
            ts.start_ms,
            ts.end_ms,
            ts.text,
            ts.confidence,
            ts.language
          from transcript_segments ts
          left join speakers s on s.id = ts.speaker_id
          where ts.meeting_id = $1
          order by ts.start_ms asc
        `,
        [base.id]
      ),
      client.query(
        `
          select id, overview, language, model_provider
          from summaries
          where meeting_id = $1
          order by created_at desc
          limit 1
        `,
        [base.id]
      ),
      client.query(
        `
          select id, title, owner, status, due_date, priority, confidence,
                 source_quote, source_start_ms, kind
          from action_items
          where meeting_id = $1
          order by created_at asc, id asc
        `,
        [base.id]
      ),
      client.query(
        `
          select t.name
          from meeting_tags mt
          join tags t on t.id = mt.tag_id
          where mt.meeting_id = $1
          order by t.name asc
        `,
        [base.id]
      ),
      client.query(
        `
          select c.id, c.name, c.description, c.created_at
          from meeting_contexts mc
          join contexts c on c.id = mc.context_id
          where mc.meeting_id = $1
          order by c.name asc
        `,
        [base.id]
      ),
      client.query(
        `
          select output
          from intelligence_runs
          where meeting_id = $1 and status = 'completed'
          order by created_at desc
          limit 1
        `,
        [base.id]
      ),
      client.query(
        `
          select id, meeting_id, target, payload, status, created_at
          from suggested_agent_runs
          where meeting_id = $1
          order by created_at desc
        `,
        [base.id]
      ),
      client.query(
        `
          select id, meeting_id, storage_key, filename, content_type,
                 size_bytes, retention, created_at
          from media_assets
          where meeting_id = $1
          order by created_at desc
        `,
        [base.id]
      ),
    ])

    const transcript = (transcriptResult.rows as TranscriptRow[]).map(
      (segment) => ({
        id: segment.id,
        speaker: segment.speaker_label ?? "Speaker",
        startMs: segment.start_ms,
        endMs: segment.end_ms,
        text: segment.text,
        confidence:
          segment.confidence === null ? undefined : Number(segment.confidence),
        language: segment.language ?? undefined,
      })
    )

    const latestSummary = summaryResult.rows[0] as SummaryRow | undefined
    let decisions: string[] = []

    if (latestSummary) {
      const sectionResult = await client.query(
        `
          select kind, content
          from summary_sections
          where summary_id = $1
          order by id asc
        `,
        [latestSummary.id]
      )
      const sections = sectionResult.rows as SummarySectionRow[]
      const decisionsSection = sections.find(
        (section) => section.kind === "decisions"
      )

      decisions = parseJsonArray(decisionsSection?.content)
    }

    const actionItems = (actionItemsResult.rows as ActionItemRow[]).map(
      mapActionItem
    )
    const intelligence = (intelligenceResult.rows[0] as
      | IntelligenceRunRow
      | undefined)?.output

    return {
      ...base,
      transcript,
      summary: latestSummary
        ? {
            overview: latestSummary.overview,
            decisions,
            actionItems,
          }
        : undefined,
      tags: (tagsResult.rows as TagRow[]).map((row) => row.name),
      contexts: (contextsResult.rows as ContextRow[]).map((context) => ({
        id: context.id,
        name: context.name,
        description: context.description ?? undefined,
        createdAt: toIso(context.created_at),
      })),
      intelligence,
      suggestedAgentRuns: (suggestedRunsResult.rows as SuggestedAgentRunRow[]).map(
        (run) => ({
          id: run.id,
          meetingId: run.meeting_id,
          target: run.target,
          payload: run.payload ?? {},
          status: run.status,
          createdAt: toIso(run.created_at),
        })
      ),
      mediaAssets: (mediaAssetsResult.rows as MediaAssetRow[]).map(mapMediaAsset),
    }
  }

  return {
    async listMeetings() {
      const result = await client.query(`
        select id, title, source, language, status, retention, started_at,
               participants, language_metadata
        from meetings
        order by started_at desc
      `)

      const bases = result.rows.map((row) => mapMeetingRow(row as MeetingRow))
      return Promise.all(bases.map((meeting) => hydrateMeeting(meeting)))
    },

    async getMeeting(id: string) {
      const result = await client.query(
        `
          select id, title, source, language, status, retention, started_at,
                 participants, language_metadata
          from meetings
          where id = $1
          limit 1
        `,
        [id]
      )

      const row = result.rows[0] as MeetingRow | undefined

      return row ? hydrateMeeting(mapMeetingRow(row)) : undefined
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
          createId("meet"),
        ]
      )

      return mapMeetingRow(result.rows[0] as MeetingRow)
    },

    async updateMeetingStatus(id: string, status: MeetingStatus) {
      const result = await client.query(
        `
          update meetings
          set status = $2
          where id = $1
          returning id, title, source, language, status, retention, started_at,
                    participants, language_metadata
        `,
        [id, status]
      )
      const row = result.rows[0] as MeetingRow | undefined

      if (!row) throw new Error(`Meeting not found: ${id}`)
      return hydrateMeeting(mapMeetingRow(row))
    },

    async createMediaAsset(input) {
      const result = await client.query(
        `
          insert into media_assets (
            id, meeting_id, storage_key, filename, content_type, size_bytes, retention
          )
          values ($1, $2, $3, $4, $5, $6, $7)
          returning id, meeting_id, storage_key, filename, content_type,
                    size_bytes, retention, created_at
        `,
        [
          createId("asset"),
          input.meetingId,
          input.storageKey,
          input.filename ?? null,
          input.contentType,
          input.sizeBytes,
          input.retention ?? "audio",
        ]
      )

      await client.query(`update meetings set status = 'media_uploaded' where id = $1`, [
        input.meetingId,
      ])

      return mapMediaAsset(result.rows[0] as MediaAssetRow)
    },

    async replaceTranscriptSegments(meetingId, segments) {
      await client.query(`delete from transcript_segments where meeting_id = $1`, [
        meetingId,
      ])
      await client.query(`delete from speakers where meeting_id = $1`, [meetingId])

      const speakerIds = new Map<string, string>()

      for (const segment of segments) {
        let speakerId = speakerIds.get(segment.speaker)

        if (!speakerId) {
          speakerId = createId("speaker")
          speakerIds.set(segment.speaker, speakerId)
          await client.query(
            `
              insert into speakers (id, meeting_id, label, display_name)
              values ($1, $2, $3, $3)
            `,
            [speakerId, meetingId, segment.speaker]
          )
        }

        await client.query(
          `
            insert into transcript_segments (
              id, meeting_id, speaker_id, start_ms, end_ms, text, confidence, language
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8)
          `,
          [
            segment.id || createId("seg"),
            meetingId,
            speakerId,
            segment.startMs,
            segment.endMs,
            segment.text,
            segment.confidence ?? null,
            segment.language ?? null,
          ]
        )
      }

      return segments
    },

    async upsertMeetingIntelligence(
      meetingId,
      intelligence,
      provider = "local",
      model = "heuristic-v1"
    ) {
      const runId = createId("intel")

      await client.query(
        `
          insert into intelligence_runs (id, meeting_id, provider, model, input, output, status)
          values ($1, $2, $3, $4, '{}'::jsonb, $5::jsonb, 'completed')
        `,
        [runId, meetingId, provider, model, JSON.stringify(intelligence)]
      )
      await client.query(
        `
          update meetings
          set language_metadata = $2::jsonb, status = 'completed'
          where id = $1
        `,
        [meetingId, JSON.stringify(intelligence.languageMetadata)]
      )

      const summaryResult = await client.query(
        `
          insert into summaries (
            id, meeting_id, overview, language, model_provider, intelligence_run_id
          )
          values ($1, $2, $3, $4, $5, $6)
          returning id
        `,
        [
          createId("summary"),
          meetingId,
          intelligence.overview,
          intelligence.languageMetadata.primaryLanguage,
          provider,
          runId,
        ]
      )
      const summaryId = (summaryResult.rows[0] as { id: string }).id

      await client.query(
        `
          insert into summary_sections (id, summary_id, kind, content)
          values ($1, $2, 'decisions', $3::jsonb)
        `,
        [createId("section"), summaryId, JSON.stringify(intelligence.decisions)]
      )
      await client.query(`delete from action_items where meeting_id = $1`, [
        meetingId,
      ])

      for (const item of intelligence.actionItems) {
        await client.query(
          `
            insert into action_items (
              id, meeting_id, title, owner, status, due_date, priority,
              confidence, source_quote, source_start_ms, kind
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          `,
          [
            item.id || createId("act"),
            meetingId,
            item.title,
            item.owner ?? null,
            item.status,
            item.dueDate ?? null,
            item.priority,
            item.confidence,
            item.sourceQuote,
            item.sourceStartMs,
            item.kind,
          ]
        )
      }

      await client.query(`delete from meeting_tags where meeting_id = $1`, [
        meetingId,
      ])
      for (const tag of intelligence.tags) {
        const tagId = `tag_${tag}`
        await client.query(
          `
            insert into tags (id, name)
            values ($1, $2)
            on conflict (name) do nothing
          `,
          [tagId, tag]
        )
        await client.query(
          `
            insert into meeting_tags (meeting_id, tag_id)
            values (
              $1,
              coalesce((select id from tags where name = $2), $3)
            )
            on conflict do nothing
          `,
          [meetingId, tag, tagId]
        )
      }

      return intelligence
    },

    async updateActionItem(id, patch) {
      const result = await client.query(
        `
          update action_items
          set title = coalesce($2, title),
              owner = coalesce($3, owner),
              status = coalesce($4, status),
              due_date = coalesce($5, due_date),
              priority = coalesce($6, priority),
              updated_at = now()
          where id = $1
          returning id, title, owner, status, due_date, priority, confidence,
                    source_quote, source_start_ms, kind
        `,
        [
          id,
          patch.title ?? null,
          patch.owner ?? null,
          patch.status ?? null,
          patch.dueDate ?? null,
          patch.priority ?? null,
        ]
      )
      const row = result.rows[0] as ActionItemRow | undefined

      if (!row) throw new Error(`Action item not found: ${id}`)
      return mapActionItem(row)
    },

    async createJob(input) {
      const nowId = input.id ?? createId("job")
      const result = await client.query(
        `
          insert into jobs (id, name, status, meeting_id, payload)
          values ($1, $2, $3, $4, $5::jsonb)
          on conflict (id) do update
            set status = excluded.status,
                payload = excluded.payload,
                updated_at = now()
          returning id, name, status, meeting_id, payload, result, error,
                    attempts, created_at, updated_at
        `,
        [
          nowId,
          input.name,
          input.status ?? "queued",
          input.meetingId ?? null,
          JSON.stringify(input.payload ?? {}),
        ]
      )

      return mapJob(result.rows[0] as JobRow)
    },

    async updateJob(id, patch) {
      const result = await client.query(
        `
          update jobs
          set status = coalesce($2, status),
              result = coalesce($3::jsonb, result),
              error = $4,
              attempts = coalesce($5, attempts),
              updated_at = now()
          where id = $1
          returning id, name, status, meeting_id, payload, result, error,
                    attempts, created_at, updated_at
        `,
        [
          id,
          patch.status ?? null,
          patch.result ? JSON.stringify(patch.result) : null,
          patch.error ?? null,
          patch.attempts ?? null,
        ]
      )
      const row = result.rows[0] as JobRow | undefined

      if (!row) throw new Error(`Job not found: ${id}`)
      return mapJob(row)
    },

    async getJob(id) {
      const result = await client.query(
        `
          select id, name, status, meeting_id, payload, result, error,
                 attempts, created_at, updated_at
          from jobs
          where id = $1
          limit 1
        `,
        [id]
      )

      return result.rows[0] ? mapJob(result.rows[0] as JobRow) : undefined
    },

    async searchMeetings(query: string) {
      const result = await client.query(
        `
          select distinct m.id, m.title, m.source, m.language, m.status,
                 m.retention, m.started_at, m.participants, m.language_metadata
          from meetings m
          left join transcript_segments ts on ts.meeting_id = m.id
          left join summaries s on s.meeting_id = m.id
          left join action_items ai on ai.meeting_id = m.id
          where m.title ilike $1
             or ts.text ilike $1
             or s.overview ilike $1
             or ai.title ilike $1
          order by m.started_at desc
        `,
        [`%${query}%`]
      )

      const bases = result.rows.map((row) => mapMeetingRow(row as MeetingRow))
      return Promise.all(bases.map((meeting) => hydrateMeeting(meeting)))
    },

    async askMeetingMemory(
      meetingId: string,
      question: string
    ): Promise<MeetingAnswer> {
      const meeting = await this.getMeeting(meetingId)

      if (!meeting) {
        throw new Error(`Meeting not found: ${meetingId}`)
      }

      const normalizedQuestion = question.toLowerCase()
      const tokens = normalizedQuestion
        .split(/\s+/)
        .filter((token) => token.length > 3)
      const transcriptMatch = meeting.transcript?.find((segment) =>
        tokens.some((token) => segment.text.toLowerCase().includes(token))
      )

      return {
        answer:
          meeting.intelligence?.overview ??
          meeting.summary?.overview ??
          transcriptMatch?.text ??
          "No summary is available for this meeting yet.",
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

      await this.updateMeetingStatus(meetingId, "summarizing")
      const intelligence = buildMeetingIntelligence(meeting)

      await this.updateMeetingStatus(meetingId, "indexing")
      return this.upsertMeetingIntelligence(meetingId, intelligence)
    },

    async listContexts(): Promise<MeetingContext[]> {
      const result = await client.query(`
        select id, name, description, created_at
        from contexts
        order by name asc
      `)

      return (result.rows as ContextRow[]).map((context) => ({
        id: context.id,
        name: context.name,
        description: context.description ?? undefined,
        createdAt: toIso(context.created_at),
      }))
    },

    async createContext(input: CreateContextInput): Promise<MeetingContext> {
      const result = await client.query(
        `
          insert into contexts (id, name, description)
          values ($1, $2, $3)
          returning id, name, description, created_at
        `,
        [createId("ctx"), input.name, input.description ?? null]
      )
      const row = result.rows[0] as ContextRow

      return {
        id: row.id,
        name: row.name,
        description: row.description ?? undefined,
        createdAt: toIso(row.created_at),
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
          createId("agent_suggestion"),
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
        createdAt: toIso(row.created_at),
      }
    },
  }
}
