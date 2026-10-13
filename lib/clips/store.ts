/**
 * Clip persistence and clip shares (M5 C1/C2). Server-only.
 *
 * Every read and write is workspace-scoped and gated twice: the caller's
 * scoped meeting repository must see the meeting (M2 visibility, private
 * meetings included) and, on Postgres, the SQL itself carries
 * `meetingScopeSql`. An invisible or foreign clip behaves like a missing one.
 */
import {
  getCollabBackend,
  nowIso,
  toIso,
  type CollabBackend,
  type StoredClip,
  type StoredClipShare,
} from "@/lib/clips/db"
import { clipMaxMs, resolveClipRange } from "@/lib/clips/range"
import type { ClipRenderStatus, ClipShareView, CreateClipInput, MeetingClip } from "@/lib/clips/types"
import type { Queryable } from "@/lib/db/client"
import type {
  MeetingRecord,
  MeetingRepository,
  MeetingShare,
  RepoScope,
} from "@/lib/meetings/repository"
import { meetingScopeSql } from "@/lib/meetings/scope-sql"
import { createId } from "@/lib/workspaces/tokens"

/** Who is acting on clips: the request scope plus the signed-in user. */
export type ClipStoreContext = {
  scope: RepoScope
  actorUserId?: string
  /** Scoped meeting repository: the visibility gate (and the transcript). */
  meetings: Pick<MeetingRepository, "getMeeting">
  env?: Record<string, string | undefined>
}

/** The clip (or its meeting) does not exist or is not visible. */
export class ClipNotFoundError extends Error {
  constructor() {
    super("Clip not found")
    this.name = "ClipNotFoundError"
  }
}

/**
 * Live (non-deleted) clips one user may have in one meeting: a member can
 * never exhaust the meeting for everyone else. Deleting frees quota.
 */
export const MAX_CLIPS_PER_USER_PER_MEETING = 50
/** Meeting-wide safety net (live clips of all users). */
export const MAX_CLIPS_PER_MEETING = 500

/** A clip quota is full (route → 429 `clip_limit_reached`). */
export class ClipLimitError extends Error {
  constructor(readonly scope: "user" | "meeting") {
    super("clip_limit_reached")
    this.name = "ClipLimitError"
  }
}

/** The quota could not be checked (lock/count failed): route → 503. */
export class ClipQuotaUnavailableError extends Error {
  constructor() {
    super("quota_unavailable")
    this.name = "ClipQuotaUnavailableError"
  }
}

/** No user behind the principal (e.g. an API key without a creator): route → 403. */
export class ClipOwnerRequiredError extends Error {
  constructor() {
    super("clip_owner_required")
    this.name = "ClipOwnerRequiredError"
  }
}

function assertClipQuota(meetingLive: number, userLive: number) {
  if (userLive >= MAX_CLIPS_PER_USER_PER_MEETING) throw new ClipLimitError("user")
  if (meetingLive >= MAX_CLIPS_PER_MEETING) throw new ClipLimitError("meeting")
}

type PoolLike = Queryable & { connect?: () => Promise<Queryable & { release: () => void }> }

/** BEGIN/COMMIT on a dedicated connection (test fakes without `connect` run as-is). */
async function inTransaction<T>(client: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const pool = client as PoolLike

  if (typeof pool.connect !== "function") return fn(client)

  const connection = await pool.connect()

  try {
    await connection.query("begin")
    const result = await fn(connection)

    await connection.query("commit")
    return result
  } catch (error) {
    await connection.query("rollback").catch(() => undefined)
    throw error
  } finally {
    connection.release()
  }
}

/** A clip of a private meeting cannot be shared. */
export class ClipShareError extends Error {
  constructor(readonly code: "meeting_private") {
    super(code)
    this.name = "ClipShareError"
  }
}

export type ClipAccess = { clip: MeetingClip; meeting: MeetingRecord }

const CLIP_COLUMNS = `c.id, c.workspace_id, c.meeting_id, c.title, c.start_ms, c.end_ms,
  c.segment_ids, c.transcript_excerpt, c.render_status, c.storage_key, c.render_error,
  c.created_by_user_id, c.created_at, c.updated_at`

type ClipRow = {
  id: string
  workspace_id: string
  meeting_id: string
  title: string
  start_ms: number | string
  end_ms: number | string
  segment_ids: string[] | null
  transcript_excerpt: string | null
  render_status: ClipRenderStatus
  storage_key: string | null
  render_error: string | null
  created_by_user_id: string | null
  created_at: string | Date
  updated_at: string | Date
}

function mapClip(row: ClipRow): MeetingClip {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    meetingId: row.meeting_id,
    title: row.title,
    startMs: Number(row.start_ms),
    endMs: Number(row.end_ms),
    segmentIds: row.segment_ids ?? [],
    ...(row.transcript_excerpt ? { transcriptExcerpt: row.transcript_excerpt } : {}),
    renderStatus: row.render_status,
    ...(row.storage_key ? { storageKey: row.storage_key } : {}),
    ...(row.render_error ? { renderError: row.render_error } : {}),
    ...(row.created_by_user_id ? { createdByUserId: row.created_by_user_id } : {}),
    createdAt: toIso(row.created_at) ?? nowIso(),
    updatedAt: toIso(row.updated_at) ?? nowIso(),
  }
}

function publicClip(stored: StoredClip): MeetingClip {
  const { deletedAt: _deletedAt, ...clip } = stored

  void _deletedAt
  return clip
}

function scopedClipSql(scope: RepoScope, values: unknown[], where: string) {
  const visible = meetingScopeSql(scope, "m", values)

  return `
    select ${CLIP_COLUMNS}
    from meeting_clips c
    join meetings m on m.id = c.meeting_id
    where c.workspace_id = m.workspace_id and c.deleted_at is null and ${visible} and ${where}
  `
}

async function backendOf(): Promise<CollabBackend> {
  return getCollabBackend()
}

/** Visible meeting through the caller's scoped repository, or undefined. */
async function visibleMeeting(
  ctx: ClipStoreContext,
  meetingId: string,
  includeTranscript: boolean
): Promise<MeetingRecord | undefined> {
  if (!meetingId) return undefined

  const meeting = await ctx.meetings.getMeeting(meetingId, { includeTranscript })

  return meeting && (meeting.workspaceId ?? ctx.scope.workspaceId) === ctx.scope.workspaceId
    ? meeting
    : undefined
}

export async function createClip(
  ctx: ClipStoreContext,
  meetingId: string,
  input: CreateClipInput
): Promise<MeetingClip> {
  const meeting = await visibleMeeting(ctx, meetingId, true)

  if (!meeting) throw new ClipNotFoundError()

  const range = resolveClipRange(input, {
    segments: meeting.transcript ?? [],
    durationMs: meeting.durationMs,
    maxMs: clipMaxMs(ctx.env),
  })
  // The per-user quota needs a user: API keys count under their creator, and
  // a principal with no user behind it cannot create clips (fail closed).
  const actorUserId = ctx.actorUserId

  if (!actorUserId) throw new ClipOwnerRequiredError()

  const id = createId("clip")
  const backend = await backendOf()

  if (backend.kind === "memory") {
    // Count and insert run in the same synchronous step (no await between):
    // concurrent requests cannot overshoot.
    const live = [...backend.db.clips.values()].filter(
      (clip) => clip.meetingId === meetingId && clip.workspaceId === ctx.scope.workspaceId && !clip.deletedAt
    )

    assertClipQuota(live.length, live.filter((clip) => clip.createdByUserId === actorUserId).length)

    const now = nowIso()
    const clip: StoredClip = {
      id,
      workspaceId: ctx.scope.workspaceId,
      meetingId,
      title: range.title,
      startMs: range.startMs,
      endMs: range.endMs,
      segmentIds: range.segmentIds,
      ...(range.transcriptExcerpt ? { transcriptExcerpt: range.transcriptExcerpt } : {}),
      renderStatus: "pending",
      createdByUserId: actorUserId,
      createdAt: now,
      updatedAt: now,
    }

    backend.db.clips.set(id, clip)
    return publicClip(clip)
  }

  return inTransaction(backend.client, async (tx) => {
    // Serialize clip creation per meeting so count + insert are atomic:
    // concurrent requests queue on the lock and each counts after the
    // previous insert committed (READ COMMITTED takes a new snapshot per
    // statement). Any failure of the lock or the count rejects the create.
    let counts: { meeting_live?: unknown; user_live?: unknown } | undefined

    try {
      await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`meeting_clips:${meetingId}`])

      const count = await tx.query(
        `select coalesce(count(*), 0)::int as meeting_live,
                coalesce(count(*) filter (where created_by_user_id = $3), 0)::int as user_live
           from meeting_clips
          where meeting_id = $1 and workspace_id = $2 and deleted_at is null`,
        [meetingId, ctx.scope.workspaceId, actorUserId]
      )

      counts = count.rows[0] as typeof counts
    } catch {
      throw new ClipQuotaUnavailableError()
    }

    const asCount = (value: unknown) =>
      typeof value === "number" || (typeof value === "string" && value.trim() !== "") ? Number(value) : Number.NaN
    const meetingLive = asCount(counts?.meeting_live)
    const userLive = asCount(counts?.user_live)

    // No row or a non-numeric count is not "zero": fail closed.
    if (!counts || !Number.isFinite(meetingLive) || !Number.isFinite(userLive)) {
      throw new ClipQuotaUnavailableError()
    }

    assertClipQuota(meetingLive, userLive)

    return insertClipRow(tx, ctx, meetingId, id, range, actorUserId)
  })
}

async function insertClipRow(
  client: Queryable,
  ctx: ClipStoreContext,
  meetingId: string,
  id: string,
  range: ReturnType<typeof resolveClipRange>,
  actorUserId: string
): Promise<MeetingClip> {
  const values: unknown[] = [
    id,
    range.title,
    range.startMs,
    range.endMs,
    range.segmentIds,
    range.transcriptExcerpt ?? null,
    actorUserId,
    meetingId,
  ]
  const visible = meetingScopeSql(ctx.scope, "m", values)
  const result = await client.query(
    `
      insert into meeting_clips (
        id, workspace_id, meeting_id, title, start_ms, end_ms, segment_ids,
        transcript_excerpt, render_status, created_by_user_id
      )
      select $1, m.workspace_id, m.id, $2, $3, $4, $5::text[], $6, 'pending', $7
      from meetings m
      where m.id = $8 and ${visible}
        -- Quota guard in the insert itself (defence in depth, NULL-safe).
        and coalesce((select count(*) from meeting_clips q
                      where q.meeting_id = m.id and q.workspace_id = m.workspace_id
                        and q.deleted_at is null), 0) < ${MAX_CLIPS_PER_MEETING}
        and coalesce((select count(*) from meeting_clips q
                      where q.meeting_id = m.id and q.workspace_id = m.workspace_id
                        and q.deleted_at is null and q.created_by_user_id = $7), 0) < ${MAX_CLIPS_PER_USER_PER_MEETING}
      returning id, workspace_id, meeting_id, title, start_ms, end_ms, segment_ids,
        transcript_excerpt, render_status, storage_key, render_error,
        created_by_user_id, created_at, updated_at
    `,
    values
  )
  const row = result.rows[0] as ClipRow | undefined

  if (!row) throw new ClipNotFoundError()
  return mapClip(row)
}

/** Live clips of a visible meeting (by start), or undefined when invisible. */
export async function listClips(
  ctx: ClipStoreContext,
  meetingId: string
): Promise<MeetingClip[] | undefined> {
  const meeting = await visibleMeeting(ctx, meetingId, false)

  if (!meeting) return undefined

  const backend = await backendOf()

  if (backend.kind === "memory") {
    return [...backend.db.clips.values()]
      .filter(
        (clip) =>
          clip.meetingId === meetingId &&
          clip.workspaceId === ctx.scope.workspaceId &&
          !clip.deletedAt
      )
      .sort((a, b) => a.startMs - b.startMs || a.createdAt.localeCompare(b.createdAt))
      .map(publicClip)
  }

  const values: unknown[] = [meetingId, ctx.scope.workspaceId]
  const result = await backend.client.query(
    `${scopedClipSql(ctx.scope, values, "c.meeting_id = $1 and c.workspace_id = $2")}
     order by c.start_ms asc, c.created_at asc`,
    values
  )

  return (result.rows as ClipRow[]).map(mapClip)
}

async function findClipRow(
  backend: CollabBackend,
  scope: RepoScope,
  clipId: string
): Promise<MeetingClip | undefined> {
  if (backend.kind === "memory") {
    const clip = backend.db.clips.get(clipId)

    return clip && clip.workspaceId === scope.workspaceId && !clip.deletedAt
      ? publicClip(clip)
      : undefined
  }

  const values: unknown[] = [clipId, scope.workspaceId]
  const result = await backend.client.query(
    `${scopedClipSql(scope, values, "c.id = $1 and c.workspace_id = $2")} limit 1`,
    values
  )
  const row = result.rows[0] as ClipRow | undefined

  return row ? mapClip(row) : undefined
}

/** A visible clip and its meeting (no transcript), or undefined. */
export async function getClipAccess(
  ctx: ClipStoreContext,
  clipId: string,
  options: { includeTranscript?: boolean } = {}
): Promise<ClipAccess | undefined> {
  if (!clipId) return undefined

  const clip = await findClipRow(await backendOf(), ctx.scope, clipId)

  if (!clip) return undefined

  const meeting = await visibleMeeting(ctx, clip.meetingId, options.includeTranscript ?? false)

  return meeting ? { clip, meeting } : undefined
}

export async function getClip(
  ctx: ClipStoreContext,
  clipId: string
): Promise<MeetingClip | undefined> {
  return (await getClipAccess(ctx, clipId))?.clip
}

export async function renameClip(
  ctx: ClipStoreContext,
  clipId: string,
  title: string
): Promise<MeetingClip> {
  const access = await getClipAccess(ctx, clipId)

  if (!access) throw new ClipNotFoundError()

  const backend = await backendOf()

  if (backend.kind === "memory") {
    const stored = backend.db.clips.get(clipId)

    if (!stored) throw new ClipNotFoundError()

    const updated: StoredClip = { ...stored, title, updatedAt: nowIso() }

    backend.db.clips.set(clipId, updated)
    return publicClip(updated)
  }

  const values: unknown[] = [clipId, ctx.scope.workspaceId, title]
  const visible = meetingScopeSql(ctx.scope, "m", values)
  const result = await backend.client.query(
    `
      update meeting_clips c set title = $3, updated_at = now()
      from meetings m
      where c.id = $1 and c.workspace_id = $2 and m.id = c.meeting_id
        and c.deleted_at is null and ${visible}
      returning ${CLIP_COLUMNS}
    `,
    values
  )
  const row = result.rows[0] as ClipRow | undefined

  if (!row) throw new ClipNotFoundError()
  return mapClip(row)
}

/** Soft delete (and revoke its shares); true when a visible clip was deleted. */
export async function deleteClip(ctx: ClipStoreContext, clipId: string): Promise<boolean> {
  const access = await getClipAccess(ctx, clipId)

  if (!access) return false

  const backend = await backendOf()

  if (backend.kind === "memory") {
    const stored = backend.db.clips.get(clipId)

    if (!stored) return false

    const now = nowIso()

    backend.db.clips.set(clipId, { ...stored, deletedAt: now, updatedAt: now })
    for (const share of backend.db.clipShares.values()) {
      if (share.clipId === clipId && !share.revoked) {
        backend.db.clipShares.set(share.id, { ...share, revoked: true, updatedAt: now })
      }
    }
    return true
  }

  const values: unknown[] = [clipId, ctx.scope.workspaceId]
  const visible = meetingScopeSql(ctx.scope, "m", values)
  const result = await backend.client.query(
    `
      update meeting_clips c set deleted_at = now(), updated_at = now()
      from meetings m
      where c.id = $1 and c.workspace_id = $2 and m.id = c.meeting_id
        and c.deleted_at is null and ${visible}
      returning c.id
    `,
    values
  )

  if (!result.rows.length) return false

  await backend.client.query(
    `update meeting_shares set revoked = true, updated_at = now()
     where clip_id = $1 and scope = 'clip' and revoked = false`,
    [clipId]
  )
  return true
}

const SHARE_COLUMNS = `s.id, s.meeting_id, s.token, s.revoked, s.expires_at, s.created_by,
  s.created_at, s.updated_at`

type ShareRow = {
  id: string
  meeting_id: string
  token: string
  revoked: boolean
  expires_at: string | Date | null
  created_by: string | null
  created_at: string | Date
  updated_at: string | Date
}

function shareFromRow(row: ShareRow): MeetingShare {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    token: row.token,
    visibility: "public",
    revoked: row.revoked,
    ...(row.expires_at ? { expiresAt: toIso(row.expires_at) } : {}),
    includedSections: [],
    ...(row.created_by ? { createdBy: row.created_by } : {}),
    createdAt: toIso(row.created_at) ?? nowIso(),
    updatedAt: toIso(row.updated_at) ?? nowIso(),
  }
}

function shareFromStored(share: StoredClipShare): MeetingShare {
  return {
    id: share.id,
    meetingId: share.meetingId,
    token: share.token,
    visibility: "public",
    revoked: share.revoked,
    ...(share.expiresAt ? { expiresAt: share.expiresAt } : {}),
    includedSections: [],
    ...(share.createdBy ? { createdBy: share.createdBy } : {}),
    createdAt: share.createdAt,
    updatedAt: share.updatedAt,
  }
}

/** Same generator as meeting shares: 128 random bits, hex. */
function createShareToken() {
  return crypto.randomUUID().replaceAll("-", "")
}

function isActiveShare(share: { revoked: boolean; expiresAt?: string }, now = Date.now()) {
  return !share.revoked && !(share.expiresAt && Date.parse(share.expiresAt) <= now)
}

/**
 * Creates (or returns the active) `meeting_shares` row with `scope='clip'`.
 * It never changes the meeting's visibility, and a clip of a private
 * meeting cannot be shared. `includedSections` is empty, so even a share
 * lookup that ignored the scope would expose no meeting section.
 */
export async function createClipShare(
  ctx: ClipStoreContext,
  clipId: string
): Promise<MeetingShare> {
  const access = await getClipAccess(ctx, clipId)

  if (!access) throw new ClipNotFoundError()
  if ((access.meeting.visibility ?? "workspace") === "private") {
    throw new ClipShareError("meeting_private")
  }

  const backend = await backendOf()
  const createdBy = ctx.actorUserId

  if (backend.kind === "memory") {
    const existing = [...backend.db.clipShares.values()].find(
      (share) => share.clipId === clipId && isActiveShare(share)
    )

    if (existing) return shareFromStored(existing)

    const now = nowIso()
    const share: StoredClipShare = {
      id: createId("share"),
      meetingId: access.clip.meetingId,
      clipId,
      token: createShareToken(),
      revoked: false,
      ...(createdBy ? { createdBy } : {}),
      createdAt: now,
      updatedAt: now,
    }

    backend.db.clipShares.set(share.id, share)
    return shareFromStored(share)
  }

  const existing = await backend.client.query(
    `
      select ${SHARE_COLUMNS}
      from meeting_shares s
      join meeting_clips c on c.id = s.clip_id
      where s.clip_id = $1 and s.scope = 'clip' and c.workspace_id = $2
        and s.revoked = false and (s.expires_at is null or s.expires_at > now())
      order by s.created_at desc
      limit 1
    `,
    [clipId, ctx.scope.workspaceId]
  )

  if (existing.rows[0]) return shareFromRow(existing.rows[0] as ShareRow)

  const values: unknown[] = [
    createId("share"),
    createShareToken(),
    createdBy ?? null,
    clipId,
    ctx.scope.workspaceId,
  ]
  const visible = meetingScopeSql(ctx.scope, "m", values)
  const result = await backend.client.query(
    `
      insert into meeting_shares (id, meeting_id, token, included_sections, created_by, scope, clip_id)
      select $1, c.meeting_id, $2, '[]'::jsonb, $3, 'clip', c.id
      from meeting_clips c
      join meetings m on m.id = c.meeting_id
      where c.id = $4 and c.workspace_id = $5 and m.workspace_id = c.workspace_id
        and c.deleted_at is null and m.visibility <> 'private' and ${visible}
      returning id, meeting_id, token, revoked, expires_at, created_by, created_at, updated_at
    `,
    values
  )
  const row = result.rows[0] as ShareRow | undefined

  if (!row) throw new ClipShareError("meeting_private")
  return shareFromRow(row)
}

/* ------------------------------------------------------------ public tokens */

type ClipMeetingFacts = Pick<
  MeetingRecord,
  "title" | "startedAt" | "language" | "visibility" | "workspaceId"
> & { primaryLanguage?: string }

export type ClipShareLookupDeps = {
  backend?: CollabBackend
  /** Meeting facts for the memory backend (system scope of the clip's workspace). */
  loadMeeting?: (workspaceId: string, meetingId: string) => Promise<ClipMeetingFacts | undefined>
  publicSharingEnabled?: (workspaceId: string) => Promise<boolean>
  now?: () => number
}

/** `scope='clip'` tokens resolve here and never as meeting shares. */
export type ClipShareLookup =
  | { kind: "clip"; view: ClipShareView }
  /** A clip token whose gate failed (revoked, expired, deleted, private…). */
  | { kind: "clip_unavailable" }
  /** Not a clip token (possibly a meeting share). */
  | { kind: "not_clip" }

async function defaultLoadMeeting(
  workspaceId: string,
  meetingId: string
): Promise<ClipMeetingFacts | undefined> {
  const { getSystemMeetingRepository } = await import("@/lib/meetings/store")
  const meeting = await getSystemMeetingRepository(workspaceId).getMeeting(meetingId, {
    includeTranscript: false,
  })

  return meeting
    ? {
        title: meeting.title,
        startedAt: meeting.startedAt,
        language: meeting.language,
        visibility: meeting.visibility,
        workspaceId: meeting.workspaceId,
        primaryLanguage: meeting.languageMetadata?.primaryLanguage,
      }
    : undefined
}

async function defaultPublicSharingEnabled(workspaceId: string) {
  const { getAppSettings } = await import("@/lib/settings/app-settings")

  return (await getAppSettings(workspaceId)).publicSharingEnabled
}

type ClipShareTokenRow = ClipRow & {
  share_revoked: boolean
  share_expires_at: string | Date | null
  share_scope: string
  clip_deleted_at: string | Date | null
  meeting_title: string
  meeting_started_at: string | Date
  meeting_language: string
  meeting_visibility: string | null
  meeting_workspace_id: string
  meeting_primary_language: string | null
}

function viewLanguage(facts: { language: string; primaryLanguage?: string | null }) {
  return facts.primaryLanguage || facts.language
}

/**
 * Resolves a share token as a clip share. Every gate failure is the same
 * `clip_unavailable` (the routes answer 404): the share must be active and
 * unexpired, the clip not deleted, the meeting not private, and the
 * workspace must allow public sharing.
 */
export async function lookupClipShare(
  token: string,
  deps: ClipShareLookupDeps = {}
): Promise<ClipShareLookup> {
  if (!token || !/^[A-Za-z0-9_-]{8,128}$/.test(token)) return { kind: "not_clip" }

  const backend = deps.backend ?? (await backendOf())
  const now = deps.now?.() ?? Date.now()
  let clip: MeetingClip
  let facts: ClipMeetingFacts

  if (backend.kind === "memory") {
    const share = [...backend.db.clipShares.values()].find((item) => item.token === token)

    if (!share) return { kind: "not_clip" }
    if (!isActiveShare(share, now)) return { kind: "clip_unavailable" }

    const stored = backend.db.clips.get(share.clipId)

    if (!stored || stored.deletedAt) return { kind: "clip_unavailable" }

    const loaded = await (deps.loadMeeting ?? defaultLoadMeeting)(
      stored.workspaceId,
      stored.meetingId
    )

    if (!loaded || (loaded.workspaceId && loaded.workspaceId !== stored.workspaceId)) {
      return { kind: "clip_unavailable" }
    }
    clip = publicClip(stored)
    facts = loaded
  } else {
    const result = await backend.client.query(
      `
        select ${CLIP_COLUMNS},
               s.revoked as share_revoked, s.expires_at as share_expires_at,
               s.scope as share_scope, c.deleted_at as clip_deleted_at,
               m.title as meeting_title, m.started_at as meeting_started_at,
               m.language as meeting_language, m.visibility as meeting_visibility,
               m.workspace_id as meeting_workspace_id,
               m.language_metadata->>'primaryLanguage' as meeting_primary_language
        from meeting_shares s
        join meeting_clips c on c.id = s.clip_id
        join meetings m on m.id = c.meeting_id and m.workspace_id = c.workspace_id
        where s.token = $1 and s.scope = 'clip'
        limit 1
      `,
      [token]
    )
    const row = result.rows[0] as ClipShareTokenRow | undefined

    if (!row) return { kind: "not_clip" }

    const expiresAt = toIso(row.share_expires_at)

    if (!isActiveShare({ revoked: row.share_revoked, expiresAt }, now) || row.clip_deleted_at) {
      return { kind: "clip_unavailable" }
    }
    clip = mapClip(row)
    facts = {
      title: row.meeting_title,
      startedAt: toIso(row.meeting_started_at) ?? "",
      language: row.meeting_language,
      visibility: (row.meeting_visibility ?? "workspace") as ClipMeetingFacts["visibility"],
      workspaceId: row.meeting_workspace_id,
      primaryLanguage: row.meeting_primary_language ?? undefined,
    }
  }

  if ((facts.visibility ?? "workspace") === "private") return { kind: "clip_unavailable" }

  try {
    const enabled = await (deps.publicSharingEnabled ?? defaultPublicSharingEnabled)(
      clip.workspaceId
    )

    if (!enabled) return { kind: "clip_unavailable" }
  } catch {
    return { kind: "clip_unavailable" }
  }

  return {
    kind: "clip",
    view: {
      clip,
      meeting: {
        title: facts.title,
        startedAt: facts.startedAt,
        language: viewLanguage(facts),
      },
    },
  }
}

/** Active, unexpired clip share of a live clip in a non-private meeting. */
export async function getClipShareByToken(
  token: string,
  deps: ClipShareLookupDeps = {}
): Promise<ClipShareView | undefined> {
  const result = await lookupClipShare(token, deps)

  return result.kind === "clip" ? result.view : undefined
}

/* ------------------------------------------------------------ worker */

/** Clip of `workspaceId` for the render job (system scope; live clips only). */
export async function getClipForRender(
  workspaceId: string,
  clipId: string,
  backend?: CollabBackend
): Promise<MeetingClip | undefined> {
  return findClipRow(backend ?? (await backendOf()), { kind: "system", workspaceId }, clipId)
}

export async function setClipRenderResult(
  workspaceId: string,
  clipId: string,
  result: { status: ClipRenderStatus; storageKey?: string; error?: string },
  backend?: CollabBackend
): Promise<void> {
  const target = backend ?? (await backendOf())

  if (target.kind === "memory") {
    const stored = target.db.clips.get(clipId)

    if (!stored || stored.workspaceId !== workspaceId) return

    const { storageKey: _key, renderError: _error, ...rest } = stored

    void _key
    void _error
    target.db.clips.set(clipId, {
      ...rest,
      renderStatus: result.status,
      ...(result.storageKey ? { storageKey: result.storageKey } : {}),
      ...(result.error ? { renderError: result.error } : {}),
      updatedAt: nowIso(),
    })
    return
  }

  await (target.client as Queryable).query(
    `
      update meeting_clips
      set render_status = $3, storage_key = $4, render_error = $5, updated_at = now()
      where id = $1 and workspace_id = $2
    `,
    [clipId, workspaceId, result.status, result.storageKey ?? null, result.error ?? null]
  )
}
