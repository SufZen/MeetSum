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
  color?: string
  kind?: "room" | "project" | "client" | "topic"
  createdAt: string
}

export type MeetingParticipant = {
  id: string
  meetingId: string
  name: string
  email?: string
  role: "organizer" | "attendee" | "speaker" | "unknown"
  source: "calendar" | "transcript" | "manual" | "meet" | "drive"
  attendanceStatus: "accepted" | "declined" | "tentative" | "needs_action" | "unknown"
  speakerLabel?: string
  confidence?: number
  createdAt: string
  updatedAt: string
}

export type MeetingShare = {
  id: string
  meetingId: string
  token: string
  visibility: "public"
  revoked: boolean
  expiresAt?: string
  includedSections: string[]
  createdBy?: string
  createdAt: string
  updatedAt: string
}

export type ExportRecord = {
  id: string
  meetingId: string
  format: "pdf" | "markdown" | "docx" | "notion"
  status: "created" | "queued" | "sent" | "failed"
  metadata: Record<string, unknown>
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
  response?: Record<string, unknown>
  status: "suggested" | "queued" | "sent" | "failed"
  lastError?: string
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
  startedAt?: string
  completedAt?: string
  retryable?: boolean
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
  participantDetails?: MeetingParticipant[]
  isFavorite?: boolean
  summary?: MeetingSummary
  transcript?: TranscriptSegment[]
  tags?: MeetingTag[]
  languageMetadata?: MeetingLanguageMetadata
  contexts?: MeetingContext[]
  intelligence?: MeetingIntelligence
  suggestedAgentRuns?: SuggestedAgentRun[]
  mediaAssets?: MediaAsset[]
}

export type MeetingListSortMode = "smart" | "recent" | "oldest" | "title" | "status"

export type MeetingListStatusFilter =
  | "all"
  | "usable"
  | "upcoming"
  | "processing"
  | "favorites"
  | MeetingStatus

export type MeetingListOptions = {
  limit?: number
  offset?: number
  query?: string
  status?: MeetingListStatusFilter | string
  sort?: MeetingListSortMode
}

export type MeetingListPage = {
  meetings: MeetingRecord[]
  page: {
    limit: number
    offset: number
    total: number
    hasMore: boolean
  }
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
  listMeetings: (options?: MeetingListOptions) => Promise<MeetingRecord[]>
  listMeetingsPage: (options?: MeetingListOptions) => Promise<MeetingListPage>
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
    patch: Partial<
      Pick<
        JobRecord,
        "status" | "result" | "error" | "attempts" | "startedAt" | "completedAt"
      >
    >
  ) => Promise<JobRecord>
  getJob: (id: string) => Promise<JobRecord | undefined>
  listJobs: (filters?: { meetingId?: string; status?: JobStatus }) => Promise<JobRecord[]>
  searchMeetings: (
    query: string,
    options?: { limit?: number }
  ) => Promise<MeetingRecord[]>
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
  listRooms: () => Promise<Array<MeetingContext & { meetingCount: number }>>
  listMeetingsByContext: (contextId: string) => Promise<MeetingRecord[]>
  updateMeetingTags: (meetingId: string, tags: string[]) => Promise<MeetingRecord>
  updateMeetingFavorite: (meetingId: string, favorite: boolean) => Promise<MeetingRecord>
  createMeetingShare: (input: {
    meetingId: string
    createdBy?: string
    includedSections?: string[]
  }) => Promise<MeetingShare>
  updateMeetingShare: (
    meetingId: string,
    patch: { revoked?: boolean; regenerate?: boolean; includedSections?: string[] }
  ) => Promise<MeetingShare>
  getShareByToken: (
    token: string
  ) => Promise<{ share: MeetingShare; meeting: MeetingRecord } | undefined>
  listMeetingParticipants: (meetingId: string) => Promise<MeetingParticipant[]>
  updateMeetingParticipant: (
    participantId: string,
    patch: Partial<Pick<MeetingParticipant, "name" | "email" | "role" | "attendanceStatus" | "speakerLabel">>
  ) => Promise<MeetingParticipant>
  assignSpeakerToParticipant: (
    meetingId: string,
    speakerLabel: string,
    participantId: string
  ) => Promise<MeetingParticipant>
  createExportRecord: (input: {
    meetingId: string
    format: ExportRecord["format"]
    metadata?: Record<string, unknown>
  }) => Promise<ExportRecord>
  approveAgentRun: (id: string) => Promise<SuggestedAgentRun>
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

function normalizeListLimit(value?: number) {
  if (!value || !Number.isFinite(value)) return 50

  return Math.max(1, Math.min(Math.trunc(value), 100))
}

function normalizeListOffset(value?: number) {
  if (!value || !Number.isFinite(value)) return 0

  return Math.max(0, Math.trunc(value))
}

function meetingMatchesStatus(meeting: MeetingRecord, status?: string) {
  if (!status || status === "all") return true
  if (status === "usable") {
    return [
      "completed",
      "indexing",
      "summarizing",
      "transcribing",
      "media_uploaded",
      "failed",
    ].includes(meeting.status)
  }
  if (status === "upcoming") {
    return meeting.status === "scheduled" && new Date(meeting.startedAt).getTime() > Date.now()
  }
  if (status === "processing") {
    return ["indexing", "summarizing", "transcribing", "media_uploaded"].includes(
      meeting.status
    )
  }
  if (status === "favorites") {
    return meeting.isFavorite === true
  }

  return meeting.status === status
}

function meetingMatchesQuery(meeting: MeetingRecord, query?: string) {
  const needle = query?.trim().toLowerCase()

  if (!needle) return true

  const searchable = [
    meeting.title,
    meeting.source,
    meeting.language,
    meeting.summary?.overview,
    ...(meeting.summary?.decisions ?? []),
    ...(meeting.summary?.actionItems.map((item) => item.title) ?? []),
    ...(meeting.tags ?? []),
    ...(meeting.contexts?.map((context) => context.name) ?? []),
    ...(meeting.transcript?.map((segment) => segment.text) ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()

  return searchable.includes(needle)
}

function sortMeetings(meetings: MeetingRecord[], mode: MeetingListSortMode = "smart") {
  const rank: Record<string, number> = {
    completed: 0,
    indexing: 1,
    summarizing: 1,
    transcribing: 1,
    media_uploaded: 2,
    media_found: 3,
    failed: 4,
    scheduled: 6,
    created: 7,
  }
  const now = Date.now()

  return [...meetings].sort((left, right) => {
    const leftTime = new Date(left.startedAt).getTime()
    const rightTime = new Date(right.startedAt).getTime()

    if (mode === "recent") return rightTime - leftTime
    if (mode === "oldest") return leftTime - rightTime
    if (mode === "title") return left.title.localeCompare(right.title)
    if (mode === "status") {
      const statusCompare = left.status.localeCompare(right.status)
      if (statusCompare !== 0) return statusCompare
      return rightTime - leftTime
    }

    const leftFuture = left.status === "scheduled" && leftTime > now
    const rightFuture = right.status === "scheduled" && rightTime > now
    const leftRank = leftFuture ? 8 : (rank[left.status] ?? 5)
    const rightRank = rightFuture ? 8 : (rank[right.status] ?? 5)

    if (leftRank !== rightRank) return leftRank - rightRank
    return rightTime - leftTime
  })
}

export function createInMemoryMeetingRepository(
  initialMeetings: MeetingRecord[] = []
): MeetingRepository {
  const meetings = new Map<string, MeetingRecord>(
    initialMeetings.map((meeting) => [
      meeting.id,
      { isFavorite: false, ...meeting },
    ])
  )
  const contexts = new Map<string, MeetingContext>()
  const jobs = new Map<string, JobRecord>()
  const shares = new Map<string, MeetingShare>()
  const participants = new Map<string, MeetingParticipant>()
  const exportRecords = new Map<string, ExportRecord>()
  const suggestedRuns = new Map<string, SuggestedAgentRun>()

  function ensureParticipants(meeting: MeetingRecord): MeetingParticipant[] {
    const existing = [...participants.values()].filter(
      (participant) => participant.meetingId === meeting.id
    )

    if (existing.length) return existing

    const now = new Date().toISOString()
    const sourceParticipants = meeting.participants.length
      ? meeting.participants.map((participant, index) => ({
          name: participant,
          role: index === 0 ? ("organizer" as const) : ("attendee" as const),
          source: "calendar" as const,
        }))
      : [
          ...new Set((meeting.transcript ?? []).map((segment) => segment.speaker)),
        ].map((speaker) => ({
          name: speaker,
          role: "speaker" as const,
          source: "transcript" as const,
        }))

    return sourceParticipants.map((participant) => {
      const participantName = participant.name
      const email = participantName.includes("@") ? participantName : undefined
      const name = email ? participantName.split("@")[0] : participantName
      const record: MeetingParticipant = {
        id: createId("participant"),
        meetingId: meeting.id,
        name,
        email,
        role: participant.role,
        source: participant.source,
        attendanceStatus: "unknown",
        confidence: 0.6,
        speakerLabel: participant.source === "transcript" ? participant.name : undefined,
        createdAt: now,
        updatedAt: now,
      }

      participants.set(record.id, record)
      return record
    })
  }

  function hydrate(meeting: MeetingRecord): MeetingRecord {
    return {
      ...meeting,
      participantDetails: ensureParticipants(meeting),
    }
  }

  return {
    async listMeetings(options?: MeetingListOptions): Promise<MeetingRecord[]> {
      return (await this.listMeetingsPage(options)).meetings
    },

    async listMeetingsPage(options: MeetingListOptions = {}): Promise<MeetingListPage> {
      const limit = normalizeListLimit(options.limit)
      const offset = normalizeListOffset(options.offset)
      const filtered = [...meetings.values()]
        .filter((meeting) => meetingMatchesStatus(meeting, options.status))
        .filter((meeting) => meetingMatchesQuery(meeting, options.query))
      const sorted = sortMeetings(filtered, options.sort)
      const pageMeetings = sorted.slice(offset, offset + limit).map(hydrate)

      return {
        meetings: pageMeetings,
        page: {
          limit,
          offset,
          total: sorted.length,
          hasMore: offset + pageMeetings.length < sorted.length,
        },
      }
    },

    async getMeeting(id: string): Promise<MeetingRecord | undefined> {
      const meeting = meetings.get(id)

      return meeting ? hydrate(meeting) : undefined
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
        isFavorite: false,
      }

      meetings.set(meeting.id, meeting)
      ensureParticipants(meeting)
      return hydrate(meeting)
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
      return hydrate(updated)
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
        retryable: false,
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
        startedAt:
          patch.startedAt ??
          (patch.status === "active" ? new Date().toISOString() : job.startedAt),
        completedAt:
          patch.completedAt ??
          (patch.status === "completed" || patch.status === "failed"
            ? new Date().toISOString()
            : job.completedAt),
        retryable:
          patch.status === "failed"
            ? (patch.attempts ?? job.attempts) < job.maxAttempts
            : job.retryable,
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

    async searchMeetings(
      query: string,
      options?: { limit?: number }
    ): Promise<MeetingRecord[]> {
      return (
        await this.listMeetingsPage({
          query: normalize(query),
          limit: options?.limit,
          sort: "recent",
        })
      ).meetings
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
      return hydrate(updatedMeeting)
    },

    async listRooms(): Promise<Array<MeetingContext & { meetingCount: number }>> {
      return [...contexts.values()]
        .map((context) => ({
          ...context,
          meetingCount: [...meetings.values()].filter((meeting) =>
            meeting.contexts?.some((item) => item.id === context.id)
          ).length,
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    },

    async listMeetingsByContext(contextId: string): Promise<MeetingRecord[]> {
      return [...meetings.values()]
        .filter((meeting) =>
          meeting.contexts?.some((context) => context.id === contextId)
        )
        .sort(
          (a, b) =>
            new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
        )
        .map(hydrate)
    },

    async updateMeetingTags(meetingId, tags): Promise<MeetingRecord> {
      const meeting = meetings.get(meetingId)

      if (!meeting) {
        throw new Error(`Meeting not found: ${meetingId}`)
      }

      const normalizedTags = [...new Set(tags.map((tag) => tag.trim()))].filter(
        Boolean
      ) as MeetingTag[]
      const updatedMeeting = { ...meeting, tags: normalizedTags }

      meetings.set(meetingId, updatedMeeting)
      return hydrate(updatedMeeting)
    },

    async updateMeetingFavorite(meetingId, favorite): Promise<MeetingRecord> {
      const meeting = meetings.get(meetingId)

      if (!meeting) {
        throw new Error(`Meeting not found: ${meetingId}`)
      }

      const updatedMeeting = { ...meeting, isFavorite: favorite }

      meetings.set(meetingId, updatedMeeting)
      return hydrate(updatedMeeting)
    },

    async createMeetingShare(input): Promise<MeetingShare> {
      const meeting = meetings.get(input.meetingId)

      if (!meeting) {
        throw new Error(`Meeting not found: ${input.meetingId}`)
      }

      const existing = [...shares.values()].find(
        (share) => share.meetingId === input.meetingId && !share.revoked
      )

      if (existing) return existing

      const now = new Date().toISOString()
      const share: MeetingShare = {
        id: createId("share"),
        meetingId: input.meetingId,
        token: crypto.randomUUID().replaceAll("-", ""),
        visibility: "public",
        revoked: false,
        includedSections: input.includedSections ?? [
          "summary",
          "decisions",
          "action_items",
          "transcript",
          "participants",
        ],
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
      }

      shares.set(share.id, share)
      return share
    },

    async updateMeetingShare(meetingId, patch): Promise<MeetingShare> {
      const existing = [...shares.values()]
        .filter((share) => share.meetingId === meetingId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]

      if (patch.regenerate) {
        if (existing) {
          shares.set(existing.id, {
            ...existing,
            revoked: true,
            updatedAt: new Date().toISOString(),
          })
        }

        return this.createMeetingShare({
          meetingId,
          includedSections: patch.includedSections,
        })
      }

      if (!existing) {
        return this.createMeetingShare({
          meetingId,
          includedSections: patch.includedSections,
        })
      }

      const updated: MeetingShare = {
        ...existing,
        revoked: patch.revoked ?? existing.revoked,
        includedSections: patch.includedSections ?? existing.includedSections,
        updatedAt: new Date().toISOString(),
      }

      shares.set(existing.id, updated)
      return updated
    },

    async getShareByToken(token) {
      const share = [...shares.values()].find(
        (item) => item.token === token && !item.revoked
      )
      const expired =
        share?.expiresAt && new Date(share.expiresAt).getTime() < Date.now()

      if (!share || expired) return undefined

      const meeting = meetings.get(share.meetingId)

      return meeting ? { share, meeting: hydrate(meeting) } : undefined
    },

    async listMeetingParticipants(meetingId) {
      const meeting = meetings.get(meetingId)

      if (!meeting) throw new Error(`Meeting not found: ${meetingId}`)
      return ensureParticipants(meeting)
    },

    async updateMeetingParticipant(participantId, patch) {
      const participant = participants.get(participantId)

      if (!participant) {
        throw new Error(`Participant not found: ${participantId}`)
      }

      const updated: MeetingParticipant = {
        ...participant,
        ...patch,
        updatedAt: new Date().toISOString(),
      }

      participants.set(participantId, updated)
      return updated
    },

    async assignSpeakerToParticipant(meetingId, speakerLabel, participantId) {
      const participant = participants.get(participantId)
      const meeting = meetings.get(meetingId)

      if (!participant || participant.meetingId !== meetingId || !meeting) {
        throw new Error(`Participant not found: ${participantId}`)
      }

      const updatedParticipant = await this.updateMeetingParticipant(participantId, {
        speakerLabel,
      })
      const updatedTranscript = (meeting.transcript ?? []).map((segment) =>
        segment.speaker === speakerLabel
          ? { ...segment, speaker: updatedParticipant.name }
          : segment
      )

      meetings.set(meetingId, { ...meeting, transcript: updatedTranscript })
      return updatedParticipant
    },

    async createExportRecord(input): Promise<ExportRecord> {
      const meeting = meetings.get(input.meetingId)

      if (!meeting) {
        throw new Error(`Meeting not found: ${input.meetingId}`)
      }

      const record: ExportRecord = {
        id: createId("export"),
        meetingId: input.meetingId,
        format: input.format,
        status: "created",
        metadata: input.metadata ?? {},
        createdAt: new Date().toISOString(),
      }

      exportRecords.set(record.id, record)
      return record
    },

    async approveAgentRun(id): Promise<SuggestedAgentRun> {
      const run = suggestedRuns.get(id)

      if (!run) {
        throw new Error(`Agent run not found: ${id}`)
      }

      const updated = { ...run, status: "queued" as const }

      suggestedRuns.set(id, updated)
      return updated
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
        response: {},
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
      suggestedRuns.set(suggestion.id, suggestion)
      return suggestion
    },
  }
}
