import type { Queryable } from "@/lib/db/client"
import type {
  ActionItem,
  CreateContextInput,
  CreateMeetingInput,
  ExportRecord,
  JobRecord,
  JobStatus,
  MediaAsset,
  MeetingAnswer,
  MeetingContext,
  MeetingListOptions,
  MeetingListSortMode,
  MeetingParticipant,
  MeetingRecord,
  MeetingRepository,
  MeetingShare,
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
  is_favorite?: boolean
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
  color?: string | null
  kind?: MeetingContext["kind"] | null
  created_at: string | Date
}

type ParticipantRow = {
  id: string
  meeting_id: string
  name: string
  email: string | null
  role: MeetingParticipant["role"]
  source: MeetingParticipant["source"]
  attendance_status: MeetingParticipant["attendanceStatus"]
  speaker_label: string | null
  confidence: string | number | null
  created_at: string | Date
  updated_at: string | Date
}

type MeetingShareRow = {
  id: string
  meeting_id: string
  token: string
  visibility: MeetingShare["visibility"]
  revoked: boolean
  expires_at: string | Date | null
  included_sections: string[] | string
  created_by: string | null
  created_at: string | Date
  updated_at: string | Date
}

type ExportRecordRow = {
  id: string
  meeting_id: string
  format: ExportRecord["format"]
  status: ExportRecord["status"]
  metadata: Record<string, unknown> | null
  created_at: string | Date
}

type SuggestedAgentRunRow = {
  id: string
  meeting_id: string
  target: SuggestedAgentRun["target"]
  payload: Record<string, unknown> | null
  response: Record<string, unknown> | null
  status: SuggestedAgentRun["status"]
  last_error: string | null
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
  max_attempts: number
  retry_of_job_id: string | null
  started_at: string | Date | null
  completed_at: string | Date | null
  created_at: string | Date
  updated_at: string | Date
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

function normalizeLimit(value?: number) {
  if (!value || !Number.isFinite(value)) return 50

  return Math.max(1, Math.min(Math.trunc(value), 100))
}

function normalizeOffset(value?: number) {
  if (!value || !Number.isFinite(value)) return 0

  return Math.max(0, Math.trunc(value))
}

function normalizeSort(value?: MeetingListSortMode): MeetingListSortMode {
  if (
    value === "recent" ||
    value === "oldest" ||
    value === "title" ||
    value === "status"
  ) {
    return value
  }

  return "smart"
}

function buildMeetingListClauses(options: MeetingListOptions) {
  const clauses: string[] = []
  const values: unknown[] = []

  if (options.status && options.status !== "all") {
    if (options.status === "usable") {
      clauses.push(
        `m.status in ('completed', 'indexing', 'summarizing', 'transcribing', 'media_uploaded', 'failed')`
      )
    } else if (options.status === "upcoming") {
      clauses.push(`m.status = 'scheduled' and m.started_at > now()`)
    } else if (options.status === "processing") {
      clauses.push(
        `m.status in ('indexing', 'summarizing', 'transcribing', 'media_uploaded')`
      )
    } else {
      values.push(options.status)
      clauses.push(`m.status = $${values.length}`)
    }
  }

  if (options.query?.trim()) {
    values.push(`%${options.query.trim()}%`)
    const queryIndex = values.length

    clauses.push(`
      (
        m.title ilike $${queryIndex}
        or m.source::text ilike $${queryIndex}
        or m.language ilike $${queryIndex}
        or exists (
          select 1 from transcript_segments ts
          where ts.meeting_id = m.id and ts.text ilike $${queryIndex}
        )
        or exists (
          select 1 from summaries s
          where s.meeting_id = m.id and s.overview ilike $${queryIndex}
        )
        or exists (
          select 1 from action_items ai
          where ai.meeting_id = m.id and ai.title ilike $${queryIndex}
        )
        or exists (
          select 1
          from meeting_tags mt
          join tags t on t.id = mt.tag_id
          where mt.meeting_id = m.id and t.name ilike $${queryIndex}
        )
      )
    `)
  }

  return {
    whereSql: clauses.length ? `where ${clauses.join(" and ")}` : "",
    values,
  }
}

function meetingOrderSql(sort: MeetingListSortMode) {
  if (sort === "recent") return `m.started_at desc, m.created_at desc`
  if (sort === "oldest") return `m.started_at asc, m.created_at asc`
  if (sort === "title") return `lower(m.title) asc, m.started_at desc`
  if (sort === "status") return `m.status asc, m.started_at desc`

  return `
    case
      when m.status in ('completed', 'indexing', 'summarizing', 'transcribing', 'media_uploaded', 'failed') then 0
      when m.status = 'scheduled' and m.started_at > now() then 2
      else 1
    end asc,
    coalesce(recent_job.last_job_at, recent_import.imported_at, m.created_at, m.started_at) desc,
    m.started_at desc
  `
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
    isFavorite: row.is_favorite ?? false,
    languageMetadata: row.language_metadata,
  }
}

function mapParticipant(row: ParticipantRow): MeetingParticipant {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    name: row.name,
    email: row.email ?? undefined,
    role: row.role,
    source: row.source,
    attendanceStatus: row.attendance_status,
    speakerLabel: row.speaker_label ?? undefined,
    confidence: row.confidence === null ? undefined : Number(row.confidence),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }
}

function mapMeetingShare(row: MeetingShareRow): MeetingShare {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    token: row.token,
    visibility: row.visibility,
    revoked: row.revoked,
    expiresAt: row.expires_at ? toIso(row.expires_at) : undefined,
    includedSections: parseJsonArray(row.included_sections),
    createdBy: row.created_by ?? undefined,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }
}

function mapExportRecord(row: ExportRecordRow): ExportRecord {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    format: row.format,
    status: row.status,
    metadata: row.metadata ?? {},
    createdAt: toIso(row.created_at),
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
    maxAttempts: row.max_attempts,
    retryOfJobId: row.retry_of_job_id ?? undefined,
    startedAt: row.started_at ? toIso(row.started_at) : undefined,
    completedAt: row.completed_at ? toIso(row.completed_at) : undefined,
    retryable: row.status === "failed" && row.attempts < row.max_attempts,
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
      participantsResult,
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
          select c.id, c.name, c.description, c.color, c.kind, c.created_at
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
          select id, meeting_id, target, payload, response, status, last_error, created_at
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
      client.query(
        `
          select id, meeting_id, name, email, role, source, attendance_status,
                 speaker_label, confidence, created_at, updated_at
          from meeting_participants
          where meeting_id = $1
          order by
            case role when 'organizer' then 0 when 'attendee' then 1 else 2 end,
            name asc
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
    const participantDetails =
      (participantsResult.rows as ParticipantRow[]).map(mapParticipant)

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
        color: context.color ?? undefined,
        kind: context.kind ?? undefined,
        createdAt: toIso(context.created_at),
      })),
      intelligence,
      suggestedAgentRuns: (suggestedRunsResult.rows as SuggestedAgentRunRow[]).map(
        (run) => ({
          id: run.id,
          meetingId: run.meeting_id,
          target: run.target,
          payload: run.payload ?? {},
          response: run.response ?? {},
          status: run.status,
          lastError: run.last_error ?? undefined,
          createdAt: toIso(run.created_at),
        })
      ),
      mediaAssets: (mediaAssetsResult.rows as MediaAssetRow[]).map(mapMediaAsset),
      participantDetails:
        participantDetails.length > 0
          ? participantDetails
          : base.participants.map((participant, index) => ({
              id: `derived_${base.id}_${index}`,
              meetingId: base.id,
              name: participant.includes("@")
                ? participant.split("@")[0]
                : participant,
              email: participant.includes("@") ? participant : undefined,
              role: index === 0 ? "organizer" : "attendee",
              source: "calendar",
              attendanceStatus: "unknown",
              confidence: 0.4,
              createdAt: base.startedAt,
              updatedAt: base.startedAt,
            })),
    }
  }

  return {
    async listMeetings(options: MeetingListOptions = {}) {
      return (await this.listMeetingsPage(options)).meetings
    },

    async listMeetingsPage(options: MeetingListOptions = {}) {
      const limit = normalizeLimit(options.limit)
      const offset = normalizeOffset(options.offset)
      const sort = normalizeSort(options.sort)
      const { whereSql, values } = buildMeetingListClauses(options)
      const countResult = await client.query(
        `
          select count(*)::int as total
          from meetings m
          ${whereSql}
        `,
        values
      )
      const total = Number((countResult.rows[0] as { total?: number }).total ?? 0)
      const limitIndex = values.length + 1
      const offsetIndex = values.length + 2
      const result = await client.query(
        `
        select m.id, m.title, m.source, m.language, m.status, m.retention, m.started_at,
               m.participants, m.is_favorite, m.language_metadata
        from meetings m
        left join lateral (
          select max(j.created_at) as last_job_at
          from jobs j
          where j.meeting_id = m.id
        ) recent_job on true
        left join lateral (
          select max(df.imported_at) as imported_at
          from meeting_drive_files mdf
          join drive_files df on df.id = mdf.drive_file_id
          where mdf.meeting_id = m.id
        ) recent_import on true
        ${whereSql}
        order by ${meetingOrderSql(sort)}
        limit $${limitIndex}
        offset $${offsetIndex}
      `,
        [...values, limit, offset]
      )

      const bases = result.rows.map((row) => mapMeetingRow(row as MeetingRow))
      const meetings = await Promise.all(
        bases.map((meeting) => hydrateMeeting(meeting))
      )

      return {
        meetings,
        page: {
          limit,
          offset,
          total,
          hasMore: offset + meetings.length < total,
        },
      }
    },

    async getMeeting(id: string) {
      const result = await client.query(
        `
          select id, title, source, language, status, retention, started_at,
                 participants, is_favorite, language_metadata
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
          returning id, title, source, language, status, retention, started_at,
                    participants, is_favorite, language_metadata
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

      const meeting = mapMeetingRow(result.rows[0] as MeetingRow)
      const now = new Date().toISOString()

      for (const [index, participant] of (input.participants ?? []).entries()) {
        const email = participant.includes("@") ? participant : null
        const name = email ? participant.split("@")[0] : participant

        await client.query(
          `
            insert into meeting_participants (
              id, meeting_id, name, email, role, source, attendance_status,
              confidence, created_at, updated_at
            )
            values ($1, $2, $3, $4, $5, 'calendar', 'unknown', 0.6, $6, $6)
            on conflict do nothing
          `,
          [
            createId("participant"),
            meeting.id,
            name,
            email,
            index === 0 ? "organizer" : "attendee",
            now,
          ]
        )
      }

      return hydrateMeeting(meeting)
    },

    async updateMeetingStatus(id: string, status: MeetingStatus) {
      const result = await client.query(
        `
          update meetings
          set status = $2
          where id = $1
          returning id, title, source, language, status, retention, started_at,
                    participants, is_favorite, language_metadata
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
          insert into jobs (id, name, status, meeting_id, payload, retry_of_job_id)
          values ($1, $2, $3, $4, $5::jsonb, $6)
          on conflict (id) do update
            set status = excluded.status,
                payload = excluded.payload,
                updated_at = now()
          returning id, name, status, meeting_id, payload, result, error,
                    attempts, max_attempts, retry_of_job_id, started_at,
                    completed_at, created_at, updated_at
        `,
        [
          nowId,
          input.name,
          input.status ?? "queued",
          input.meetingId ?? null,
          JSON.stringify(input.payload ?? {}),
          input.retryOfJobId ?? null,
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
              started_at = case
                when $2 = 'active' then coalesce(started_at, now())
                else started_at
              end,
              completed_at = case
                when $2 in ('completed', 'failed') then now()
                else completed_at
              end,
              updated_at = now()
          where id = $1
          returning id, name, status, meeting_id, payload, result, error,
                    attempts, max_attempts, retry_of_job_id, started_at,
                    completed_at, created_at, updated_at
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
                 attempts, max_attempts, retry_of_job_id, started_at,
                 completed_at, created_at, updated_at
          from jobs
          where id = $1
          limit 1
        `,
        [id]
      )

      return result.rows[0] ? mapJob(result.rows[0] as JobRow) : undefined
    },

    async listJobs(filters = {}) {
      const clauses: string[] = []
      const values: unknown[] = []

      if (filters.meetingId) {
        values.push(filters.meetingId)
        clauses.push(`meeting_id = $${values.length}`)
      }
      if (filters.status) {
        values.push(filters.status)
        clauses.push(`status = $${values.length}`)
      }

      const result = await client.query(
        `
          select id, name, status, meeting_id, payload, result, error,
                 attempts, max_attempts, retry_of_job_id, started_at,
                 completed_at, created_at, updated_at
          from jobs
          ${clauses.length ? `where ${clauses.join(" and ")}` : ""}
          order by created_at desc
          limit 100
        `,
        values
      )

      return result.rows.map((row) => mapJob(row as JobRow))
    },

    async searchMeetings(query: string, options: { limit?: number } = {}) {
      return (
        await this.listMeetingsPage({
          query,
          limit: options.limit,
          sort: "recent",
        })
      ).meetings
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
        select id, name, description, color, kind, created_at
        from contexts
        order by name asc
      `)

      return (result.rows as ContextRow[]).map((context) => ({
        id: context.id,
        name: context.name,
        description: context.description ?? undefined,
        color: context.color ?? undefined,
        kind: context.kind ?? undefined,
        createdAt: toIso(context.created_at),
      }))
    },

    async createContext(input: CreateContextInput): Promise<MeetingContext> {
      const result = await client.query(
        `
          insert into contexts (id, name, description)
          values ($1, $2, $3)
          returning id, name, description, color, kind, created_at
        `,
        [createId("ctx"), input.name, input.description ?? null]
      )
      const row = result.rows[0] as ContextRow

      return {
        id: row.id,
        name: row.name,
        description: row.description ?? undefined,
        color: row.color ?? undefined,
        kind: row.kind ?? undefined,
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

    async listRooms(): Promise<Array<MeetingContext & { meetingCount: number }>> {
      const result = await client.query(`
        select c.id, c.name, c.description, c.color, c.kind, c.created_at,
               count(mc.meeting_id)::int as meeting_count
        from contexts c
        left join meeting_contexts mc on mc.context_id = c.id
        group by c.id, c.name, c.description, c.color, c.kind, c.created_at
        order by c.name asc
      `)

      return result.rows.map((row) => {
        const context = row as ContextRow & { meeting_count: number }

        return {
          id: context.id,
          name: context.name,
          description: context.description ?? undefined,
          color: context.color ?? undefined,
          kind: context.kind ?? undefined,
          createdAt: toIso(context.created_at),
          meetingCount: Number(context.meeting_count ?? 0),
        }
      })
    },

    async updateMeetingTags(meetingId: string, tags: string[]) {
      const meeting = await this.getMeeting(meetingId)

      if (!meeting) throw new Error(`Meeting not found: ${meetingId}`)

      const normalizedTags = [...new Set(tags.map((tag) => tag.trim()))].filter(
        Boolean
      )

      await client.query(`delete from meeting_tags where meeting_id = $1`, [
        meetingId,
      ])

      for (const tag of normalizedTags) {
        const tagId = `tag_${tag.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`

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
            values ($1, coalesce((select id from tags where name = $2), $3))
            on conflict do nothing
          `,
          [meetingId, tag, tagId]
        )
      }

      const updated = await this.getMeeting(meetingId)

      if (!updated) throw new Error(`Meeting not found: ${meetingId}`)
      return updated
    },

    async updateMeetingFavorite(meetingId: string, favorite: boolean) {
      const result = await client.query(
        `
          update meetings
          set is_favorite = $2, updated_at = now()
          where id = $1
          returning id, title, source, language, status, retention, started_at,
                    participants, is_favorite, language_metadata
        `,
        [meetingId, favorite]
      )
      const row = result.rows[0] as MeetingRow | undefined

      if (!row) throw new Error(`Meeting not found: ${meetingId}`)
      return hydrateMeeting(mapMeetingRow(row))
    },

    async createMeetingShare(input): Promise<MeetingShare> {
      const existing = await client.query(
        `
          select id, meeting_id, token, visibility, revoked, expires_at,
                 included_sections, created_by, created_at, updated_at
          from meeting_shares
          where meeting_id = $1 and revoked = false
          order by created_at desc
          limit 1
        `,
        [input.meetingId]
      )

      if (existing.rows[0]) {
        return mapMeetingShare(existing.rows[0] as MeetingShareRow)
      }

      const result = await client.query(
        `
          insert into meeting_shares (
            id, meeting_id, token, included_sections, created_by
          )
          values ($1, $2, $3, $4::jsonb, $5)
          returning id, meeting_id, token, visibility, revoked, expires_at,
                    included_sections, created_by, created_at, updated_at
        `,
        [
          createId("share"),
          input.meetingId,
          crypto.randomUUID().replaceAll("-", ""),
          JSON.stringify(
            input.includedSections ?? [
              "summary",
              "decisions",
              "action_items",
              "transcript",
              "participants",
            ]
          ),
          input.createdBy ?? null,
        ]
      )

      return mapMeetingShare(result.rows[0] as MeetingShareRow)
    },

    async updateMeetingShare(meetingId, patch): Promise<MeetingShare> {
      const existing = await client.query(
        `
          select id, meeting_id, token, visibility, revoked, expires_at,
                 included_sections, created_by, created_at, updated_at
          from meeting_shares
          where meeting_id = $1
          order by created_at desc
          limit 1
        `,
        [meetingId]
      )
      const current = existing.rows[0] as MeetingShareRow | undefined

      if (patch.regenerate) {
        if (current) {
          await client.query(
            `update meeting_shares set revoked = true, updated_at = now() where id = $1`,
            [current.id]
          )
        }

        return this.createMeetingShare({
          meetingId,
          includedSections: patch.includedSections,
        })
      }

      if (!current) {
        return this.createMeetingShare({
          meetingId,
          includedSections: patch.includedSections,
        })
      }

      const result = await client.query(
        `
          update meeting_shares
          set revoked = coalesce($2, revoked),
              included_sections = coalesce($3::jsonb, included_sections),
              updated_at = now()
          where id = $1
          returning id, meeting_id, token, visibility, revoked, expires_at,
                    included_sections, created_by, created_at, updated_at
        `,
        [
          current.id,
          patch.revoked ?? null,
          patch.includedSections
            ? JSON.stringify(patch.includedSections)
            : null,
        ]
      )

      return mapMeetingShare(result.rows[0] as MeetingShareRow)
    },

    async getShareByToken(token) {
      const result = await client.query(
        `
          select id, meeting_id, token, visibility, revoked, expires_at,
                 included_sections, created_by, created_at, updated_at
          from meeting_shares
          where token = $1 and revoked = false
          limit 1
        `,
        [token]
      )
      const row = result.rows[0] as MeetingShareRow | undefined
      const share = row ? mapMeetingShare(row) : undefined
      const expired =
        share?.expiresAt && new Date(share.expiresAt).getTime() < Date.now()

      if (!share || expired) return undefined

      const meeting = await this.getMeeting(share.meetingId)

      return meeting ? { share, meeting } : undefined
    },

    async listMeetingParticipants(meetingId) {
      const meeting = await this.getMeeting(meetingId)

      if (!meeting) throw new Error(`Meeting not found: ${meetingId}`)
      if (meeting.participantDetails?.length) return meeting.participantDetails

      return []
    },

    async updateMeetingParticipant(participantId, patch) {
      const result = await client.query(
        `
          update meeting_participants
          set name = coalesce($2, name),
              email = coalesce($3, email),
              role = coalesce($4, role),
              attendance_status = coalesce($5, attendance_status),
              speaker_label = coalesce($6, speaker_label),
              updated_at = now()
          where id = $1
          returning id, meeting_id, name, email, role, source, attendance_status,
                    speaker_label, confidence, created_at, updated_at
        `,
        [
          participantId,
          patch.name ?? null,
          patch.email ?? null,
          patch.role ?? null,
          patch.attendanceStatus ?? null,
          patch.speakerLabel ?? null,
        ]
      )
      const row = result.rows[0] as ParticipantRow | undefined

      if (!row) throw new Error(`Participant not found: ${participantId}`)
      return mapParticipant(row)
    },

    async assignSpeakerToParticipant(meetingId, speakerLabel, participantId) {
      const participant = await this.updateMeetingParticipant(participantId, {
        speakerLabel,
      })

      if (participant.meetingId !== meetingId) {
        throw new Error(`Participant not found: ${participantId}`)
      }

      await client.query(
        `
          update speakers
          set display_name = $3
          where meeting_id = $1 and label = $2
        `,
        [meetingId, speakerLabel, participant.name]
      )

      return participant
    },

    async createExportRecord(input): Promise<ExportRecord> {
      const result = await client.query(
        `
          insert into export_records (id, meeting_id, format, status, metadata)
          values ($1, $2, $3, 'created', $4::jsonb)
          returning id, meeting_id, format, status, metadata, created_at
        `,
        [
          createId("export"),
          input.meetingId,
          input.format,
          JSON.stringify(input.metadata ?? {}),
        ]
      )

      return mapExportRecord(result.rows[0] as ExportRecordRow)
    },

    async approveAgentRun(id): Promise<SuggestedAgentRun> {
      const result = await client.query(
        `
          update suggested_agent_runs
          set status = 'queued'
          where id = $1
          returning id, meeting_id, target, payload, response, status,
                    last_error, created_at
        `,
        [id]
      )
      const row = result.rows[0] as SuggestedAgentRunRow | undefined

      if (!row) throw new Error(`Agent run not found: ${id}`)
      return {
        id: row.id,
        meetingId: row.meeting_id,
        target: row.target,
        payload: row.payload ?? {},
        response: row.response ?? {},
        status: row.status,
        lastError: row.last_error ?? undefined,
        createdAt: toIso(row.created_at),
      }
    },

    async createSuggestedAgentRun(input): Promise<SuggestedAgentRun> {
      const result = await client.query(
        `
          insert into suggested_agent_runs (id, meeting_id, target, payload, status)
          values ($1, $2, $3, $4::jsonb, 'suggested')
          returning id, meeting_id, target, payload, response, status,
                    last_error, created_at
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
        response: row.response ?? {},
        status: row.status,
        lastError: row.last_error ?? undefined,
        createdAt: toIso(row.created_at),
      }
    },
  }
}
