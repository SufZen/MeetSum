/**
 * Comment and reaction persistence (M5 C3/C4). Server-only.
 *
 * - Comments need a signed-in user principal (member scope); API keys never
 *   comment or react.
 * - Every target is validated against the meeting (lib/comments/targets.ts).
 * - Reads and writes are workspace-scoped and gated by the caller's scoped
 *   meeting repository; on Postgres the SQL also carries `meetingScopeSql`,
 *   so private meetings stay private.
 * - Bodies are plain text (≤ 4000 chars), rendered escaped by the UI.
 *   Mentions survive only for workspace members and create notifications.
 */
import {
  getCollabBackend,
  nowIso,
  toIso,
  type CollabBackend,
  type StoredComment,
  type StoredReaction,
} from "@/lib/clips/db"
import { listClips } from "@/lib/clips/store"
import { sanitizeMentions } from "@/lib/comments/mentions"
import { anchorForTarget, buildTargetIndex, type TargetIndex } from "@/lib/comments/targets"
import {
  COMMENT_MAX_LENGTH,
  REACTION_EMOJIS,
  type CommentAnchor,
  type CommentListResult,
  type CommentTargetType,
  type CommentThread,
  type CreateCommentInput,
  type MeetingComment,
  type ReactionEmoji,
  type ReactionSummary,
  type ReactionTargetType,
} from "@/lib/comments/types"
import type { MeetingRecord, MeetingRepository, RepoScope } from "@/lib/meetings/repository"
import { meetingScopeSql } from "@/lib/meetings/scope-sql"
import { enqueueNotification } from "@/lib/notifications/enqueue"
import { roleRank } from "@/lib/workspaces/constants"
import { createId } from "@/lib/workspaces/tokens"

/** Comments require a signed-in user principal. */
export type CommentStoreContext = {
  scope: RepoScope
  userId: string
  /** Scoped meeting repository: the visibility gate (transcript, intelligence). */
  meetings: Pick<MeetingRepository, "getMeeting">
  /** Member user ids of the scope's workspace (mention validation). */
  listMemberIds?: (workspaceId: string) => Promise<ReadonlySet<string>>
  backend?: CollabBackend
}

export type CommentErrorCode =
  | "not_found"
  | "user_required"
  | "invalid_target"
  | "invalid_parent"
  | "invalid_body"
  | "invalid_emoji"
  | "forbidden"

export class CommentError extends Error {
  constructor(readonly code: CommentErrorCode) {
    super(code)
    this.name = "CommentError"
  }

  get status(): number {
    if (this.code === "not_found") return 404
    if (this.code === "user_required" || this.code === "forbidden") return 403
    return 400
  }
}

export const COMMENT_TARGET_TYPES: readonly CommentTargetType[] = [
  "segment",
  "summary_item",
  "action_item",
  "clip",
  "chapter",
  "meeting",
]

export const REACTION_TARGET_TYPES: readonly ReactionTargetType[] = [
  "segment",
  "summary_item",
  "action_item",
  "clip",
  "chapter",
  "comment",
]

export function isReactionEmoji(value: unknown): value is ReactionEmoji {
  return typeof value === "string" && (REACTION_EMOJIS as readonly string[]).includes(value)
}

/** Plain text: control characters (except newline/tab) removed, trimmed. */
export function normalizeCommentBody(value: unknown): string {
  if (typeof value !== "string") throw new CommentError("invalid_body")

  const body = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g, "")
    .trim()

  if (!body || Array.from(body).length > COMMENT_MAX_LENGTH) throw new CommentError("invalid_body")
  return body
}

function memberScope(ctx: CommentStoreContext) {
  if (ctx.scope.kind !== "member" || ctx.scope.userId !== ctx.userId) {
    throw new CommentError("user_required")
  }
  return ctx.scope
}

async function backendOf(ctx: CommentStoreContext): Promise<CollabBackend> {
  return ctx.backend ?? getCollabBackend()
}

async function defaultMemberIds(workspaceId: string): Promise<ReadonlySet<string>> {
  const { getWorkspaceStore } = await import("@/lib/workspaces/store")
  const members = await getWorkspaceStore().listMembers(workspaceId)

  return new Set(members.map((member) => member.userId))
}

async function visibleMeeting(ctx: CommentStoreContext, meetingId: string) {
  if (!meetingId) return undefined

  const meeting = await ctx.meetings.getMeeting(meetingId)

  return meeting && (meeting.workspaceId ?? ctx.scope.workspaceId) === ctx.scope.workspaceId
    ? meeting
    : undefined
}

async function targetIndexFor(ctx: CommentStoreContext, meeting: MeetingRecord): Promise<TargetIndex> {
  const clips =
    (await listClips(
      { scope: ctx.scope, actorUserId: ctx.userId, meetings: { getMeeting: async () => meeting } },
      meeting.id
    )) ?? []

  return buildTargetIndex(meeting, clips)
}

/* ------------------------------------------------------------ rows */

const COMMENT_COLUMNS = `c.id, c.workspace_id, c.meeting_id, c.target_type, c.target_id,
  c.parent_id, c.author_user_id, c.body, c.mentions, c.anchor, c.resolved_at,
  c.resolved_by_user_id, c.edited_at, c.deleted_at, c.created_at`

type CommentRow = {
  id: string
  workspace_id: string
  meeting_id: string
  target_type: CommentTargetType
  target_id: string
  parent_id: string | null
  author_user_id: string
  body: string
  mentions: string[] | null
  anchor: CommentAnchor | string | null
  resolved_at: string | Date | null
  resolved_by_user_id: string | null
  edited_at: string | Date | null
  deleted_at: string | Date | null
  created_at: string | Date
}

function parseAnchor(value: CommentRow["anchor"]): CommentAnchor {
  const raw = typeof value === "string" ? (JSON.parse(value) as unknown) : value
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}

  return {
    ...(typeof record.startMs === "number" ? { startMs: record.startMs } : {}),
    ...(typeof record.quote === "string" ? { quote: record.quote } : {}),
  }
}

function mapComment(row: CommentRow): StoredComment {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    meetingId: row.meeting_id,
    targetType: row.target_type,
    targetId: row.target_id,
    ...(row.parent_id ? { parentId: row.parent_id } : {}),
    authorUserId: row.author_user_id,
    body: row.body,
    mentions: row.mentions ?? [],
    anchor: parseAnchor(row.anchor),
    ...(row.resolved_at ? { resolvedAt: toIso(row.resolved_at) } : {}),
    ...(row.resolved_by_user_id ? { resolvedByUserId: row.resolved_by_user_id } : {}),
    ...(row.edited_at ? { editedAt: toIso(row.edited_at) } : {}),
    ...(row.deleted_at ? { deletedAt: toIso(row.deleted_at) } : {}),
    createdAt: toIso(row.created_at) ?? nowIso(),
  }
}

/**
 * Wire shape. A deleted comment keeps only its place in the thread: no body,
 * mentions, anchor quote, author, resolver or edit metadata.
 */
function toWire(comment: StoredComment, orphaned = false): MeetingComment {
  if (comment.deletedAt) {
    return {
      id: comment.id,
      workspaceId: comment.workspaceId,
      meetingId: comment.meetingId,
      targetType: comment.targetType,
      targetId: comment.targetId,
      ...(comment.parentId ? { parentId: comment.parentId } : {}),
      authorUserId: "",
      body: "",
      mentions: [],
      anchor: {},
      deletedAt: comment.deletedAt,
      createdAt: comment.createdAt,
      ...(orphaned ? { orphaned: true } : {}),
    }
  }

  return { ...comment, ...(orphaned ? { orphaned: true } : {}) }
}

async function loadComment(
  backend: CollabBackend,
  scope: RepoScope,
  commentId: string
): Promise<StoredComment | undefined> {
  if (!commentId) return undefined

  if (backend.kind === "memory") {
    const comment = backend.db.comments.get(commentId)

    return comment && comment.workspaceId === scope.workspaceId ? comment : undefined
  }

  const values: unknown[] = [commentId, scope.workspaceId]
  const visible = meetingScopeSql(scope, "m", values)
  const result = await backend.client.query(
    `
      select ${COMMENT_COLUMNS}
      from comments c
      join meetings m on m.id = c.meeting_id
      where c.id = $1 and c.workspace_id = $2 and m.workspace_id = c.workspace_id and ${visible}
      limit 1
    `,
    values
  )
  const row = result.rows[0] as CommentRow | undefined

  return row ? mapComment(row) : undefined
}

/** A live comment the caller can see (meeting gate included), or not_found. */
async function requireComment(ctx: CommentStoreContext, commentId: string) {
  const backend = await backendOf(ctx)
  const comment = await loadComment(backend, ctx.scope, commentId)

  if (!comment || comment.deletedAt) throw new CommentError("not_found")

  const meeting = await visibleMeeting(ctx, comment.meetingId)

  if (!meeting) throw new CommentError("not_found")
  return { backend, comment, meeting }
}

/* ------------------------------------------------------------ list */

export async function listMeetingComments(
  ctx: CommentStoreContext,
  meetingId: string
): Promise<CommentListResult & { viewerUserId: string }> {
  // Comment threads are user-to-user conversation: like writing, reading
  // requires a signed-in member (API keys get `user_required`).
  const scope = memberScope(ctx)
  const meeting = await visibleMeeting(ctx, meetingId)

  if (!meeting) throw new CommentError("not_found")

  const backend = await backendOf(ctx)
  let comments: StoredComment[]
  let reactions: StoredReaction[]

  if (backend.kind === "memory") {
    comments = [...backend.db.comments.values()].filter(
      (comment) => comment.meetingId === meetingId && comment.workspaceId === scope.workspaceId
    )
    reactions = backend.db.reactions.filter(
      (reaction) => reaction.meetingId === meetingId && reaction.workspaceId === scope.workspaceId
    )
  } else {
    const values: unknown[] = [meetingId, scope.workspaceId]
    const visible = meetingScopeSql(scope, "m", values)
    const result = await backend.client.query(
      `
        select ${COMMENT_COLUMNS}
        from comments c
        join meetings m on m.id = c.meeting_id
        where c.meeting_id = $1 and c.workspace_id = $2 and m.workspace_id = c.workspace_id
          and ${visible}
        order by c.created_at asc
      `,
      values
    )
    const reactionValues: unknown[] = [meetingId, scope.workspaceId]
    const reactionVisible = meetingScopeSql(scope, "m", reactionValues)
    const reactionResult = await backend.client.query(
      `
        select r.target_type, r.target_id, r.user_id, r.emoji
        from reactions r
        join meetings m on m.id = r.meeting_id
        where r.meeting_id = $1 and r.workspace_id = $2 and m.workspace_id = r.workspace_id
          and ${reactionVisible}
      `,
      reactionValues
    )

    comments = (result.rows as CommentRow[]).map(mapComment)
    reactions = (
      reactionResult.rows as Array<{
        target_type: ReactionTargetType
        target_id: string
        user_id: string
        emoji: string
      }>
    ).map((row) => ({
      workspaceId: scope.workspaceId,
      meetingId,
      targetType: row.target_type,
      targetId: row.target_id,
      userId: row.user_id,
      emoji: row.emoji,
      createdAt: "",
    }))
  }

  comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  const index = await targetIndexFor(ctx, meeting)
  const roots = comments.filter((comment) => !comment.parentId)
  const repliesByParent = new Map<string, StoredComment[]>()

  for (const comment of comments) {
    if (!comment.parentId || comment.deletedAt) continue

    const list = repliesByParent.get(comment.parentId) ?? []

    list.push(comment)
    repliesByParent.set(comment.parentId, list)
  }

  const threads: Record<string, CommentThread[]> = {}

  for (const root of roots) {
    const replies = repliesByParent.get(root.id) ?? []

    // A deleted root without replies disappears; with replies it stays as a tombstone.
    if (root.deletedAt && !replies.length) continue

    const orphaned = anchorForTarget(index, root.targetType, root.targetId) === undefined
    const key = `${root.targetType}:${root.targetId}`

    ;(threads[key] ??= []).push({
      ...toWire(root, orphaned),
      replies: replies.map((reply) => toWire(reply)),
    })
  }

  const liveCommentIds = new Set(comments.filter((c) => !c.deletedAt).map((c) => c.id))
  const counts = new Map<string, ReactionSummary>()

  for (const reaction of reactions) {
    if (!isReactionEmoji(reaction.emoji)) continue
    if (reaction.targetType === "comment" && !liveCommentIds.has(reaction.targetId)) continue

    const key = `${reaction.targetType}\u0000${reaction.targetId}\u0000${reaction.emoji}`
    const current = counts.get(key) ?? {
      targetType: reaction.targetType,
      targetId: reaction.targetId,
      emoji: reaction.emoji,
      count: 0,
      mine: false,
    }

    current.count += 1
    if (reaction.userId === ctx.userId) current.mine = true
    counts.set(key, current)
  }

  return { threads, reactions: [...counts.values()], viewerUserId: ctx.userId }
}

/* ------------------------------------------------------------ write */

async function notifyForComment(
  ctx: CommentStoreContext,
  backend: CollabBackend,
  comment: StoredComment,
  mentioned: readonly string[],
  parent?: StoredComment
) {
  const payload = {
    meetingId: comment.meetingId,
    commentId: comment.id,
    targetType: comment.targetType,
    targetId: comment.targetId,
    ...(comment.parentId ? { parentId: comment.parentId } : {}),
  }
  const notified = new Set<string>()

  for (const userId of mentioned) {
    if (userId === ctx.userId || notified.has(userId)) continue
    notified.add(userId)
    await enqueueNotification(
      { workspaceId: comment.workspaceId, userId, kind: "mention", payload, actorUserId: ctx.userId },
      backend
    )
  }

  if (parent && parent.authorUserId !== ctx.userId && !notified.has(parent.authorUserId)) {
    await enqueueNotification(
      {
        workspaceId: comment.workspaceId,
        userId: parent.authorUserId,
        kind: "reply",
        payload,
        actorUserId: ctx.userId,
      },
      backend
    )
  }
}

export async function createComment(
  ctx: CommentStoreContext,
  meetingId: string,
  input: CreateCommentInput
): Promise<MeetingComment> {
  const scope = memberScope(ctx)

  if (!COMMENT_TARGET_TYPES.includes(input.targetType) || typeof input.targetId !== "string") {
    throw new CommentError("invalid_target")
  }

  const body = normalizeCommentBody(input.body)
  const meeting = await visibleMeeting(ctx, meetingId)

  if (!meeting) throw new CommentError("not_found")

  const backend = await backendOf(ctx)
  const index = await targetIndexFor(ctx, meeting)
  const anchor = anchorForTarget(index, input.targetType, input.targetId)

  if (!anchor) throw new CommentError("invalid_target")

  let parent: StoredComment | undefined

  if (input.parentId !== undefined) {
    parent = await loadComment(backend, scope, input.parentId)

    if (
      !parent ||
      parent.deletedAt ||
      parent.parentId ||
      parent.meetingId !== meetingId ||
      parent.targetType !== input.targetType ||
      parent.targetId !== input.targetId
    ) {
      throw new CommentError("invalid_parent")
    }
  }

  const memberIds = await (ctx.listMemberIds ?? defaultMemberIds)(scope.workspaceId)
  const sanitized = sanitizeMentions(body, memberIds)
  const comment: StoredComment = {
    id: createId("cmt"),
    workspaceId: scope.workspaceId,
    meetingId,
    targetType: input.targetType,
    targetId: input.targetId,
    ...(parent ? { parentId: parent.id } : {}),
    authorUserId: ctx.userId,
    body: sanitized.body,
    mentions: sanitized.mentions,
    anchor,
    createdAt: nowIso(),
  }

  if (backend.kind === "memory") {
    backend.db.comments.set(comment.id, comment)
  } else {
    const values: unknown[] = [
      comment.id,
      comment.targetType,
      comment.targetId,
      comment.parentId ?? null,
      comment.authorUserId,
      comment.body,
      comment.mentions,
      JSON.stringify(comment.anchor),
      meetingId,
      scope.workspaceId,
    ]
    const visible = meetingScopeSql(scope, "m", values)
    const result = await backend.client.query(
      `
        insert into comments (
          id, workspace_id, meeting_id, target_type, target_id, parent_id,
          author_user_id, body, mentions, anchor
        )
        select $1, m.workspace_id, m.id, $2, $3, $4, $5, $6, $7::text[], $8::jsonb
        from meetings m
        where m.id = $9 and m.workspace_id = $10 and ${visible}
        returning id, created_at
      `,
      values
    )
    const row = result.rows[0] as { id: string; created_at: string | Date } | undefined

    if (!row) throw new CommentError("not_found")
    comment.createdAt = toIso(row.created_at) ?? comment.createdAt
  }

  await notifyForComment(ctx, backend, comment, comment.mentions, parent)
  return toWire(comment)
}

export async function editComment(
  ctx: CommentStoreContext,
  commentId: string,
  body: string
): Promise<MeetingComment> {
  const scope = memberScope(ctx)
  const text = normalizeCommentBody(body)
  const { backend, comment } = await requireComment(ctx, commentId)

  if (comment.authorUserId !== ctx.userId) throw new CommentError("forbidden")

  const memberIds = await (ctx.listMemberIds ?? defaultMemberIds)(scope.workspaceId)
  const sanitized = sanitizeMentions(text, memberIds)
  const editedAt = nowIso()
  const updated: StoredComment = {
    ...comment,
    body: sanitized.body,
    mentions: sanitized.mentions,
    editedAt,
  }

  if (backend.kind === "memory") {
    backend.db.comments.set(commentId, updated)
  } else {
    const values: unknown[] = [commentId, scope.workspaceId, ctx.userId, updated.body, updated.mentions]
    const visible = meetingScopeSql(scope, "m", values)
    const result = await backend.client.query(
      `
        update comments c set body = $4, mentions = $5::text[], edited_at = now()
        from meetings m
        where c.id = $1 and c.workspace_id = $2 and c.author_user_id = $3
          and c.deleted_at is null and m.id = c.meeting_id and ${visible}
        returning c.id
      `,
      values
    )

    if (!result.rows.length) throw new CommentError("not_found")
  }

  const added = updated.mentions.filter((userId) => !comment.mentions.includes(userId))

  await notifyForComment(ctx, backend, updated, added)
  return toWire(updated)
}

/** Soft delete by the author, or by an admin/owner. */
export async function deleteComment(ctx: CommentStoreContext, commentId: string): Promise<boolean> {
  const scope = memberScope(ctx)
  const { backend, comment } = await requireComment(ctx, commentId)
  const admin = roleRank(scope.role) >= roleRank("admin")

  if (comment.authorUserId !== ctx.userId && !admin) throw new CommentError("forbidden")

  if (backend.kind === "memory") {
    backend.db.comments.set(commentId, { ...comment, deletedAt: nowIso() })
    return true
  }

  const values: unknown[] = [commentId, scope.workspaceId]
  const visible = meetingScopeSql(scope, "m", values)
  const result = await backend.client.query(
    `
      update comments c set deleted_at = now()
      from meetings m
      where c.id = $1 and c.workspace_id = $2 and c.deleted_at is null
        and m.id = c.meeting_id and ${visible}
      returning c.id
    `,
    values
  )

  return result.rows.length > 0
}

/** Resolve / reopen a thread (member and up). */
export async function resolveComment(
  ctx: CommentStoreContext,
  commentId: string,
  resolved: boolean
): Promise<MeetingComment> {
  const scope = memberScope(ctx)

  if (roleRank(scope.role) < roleRank("member")) throw new CommentError("forbidden")

  const { backend, comment } = await requireComment(ctx, commentId)
  const updated: StoredComment = { ...comment }

  if (resolved) {
    updated.resolvedAt = nowIso()
    updated.resolvedByUserId = ctx.userId
  } else {
    delete updated.resolvedAt
    delete updated.resolvedByUserId
  }

  if (backend.kind === "memory") {
    backend.db.comments.set(commentId, updated)
  } else {
    const values: unknown[] = [commentId, scope.workspaceId, resolved ? ctx.userId : null]
    const visible = meetingScopeSql(scope, "m", values)
    const result = await backend.client.query(
      `
        update comments c
        set resolved_at = case when $3::text is null then null else now() end,
            resolved_by_user_id = $3
        from meetings m
        where c.id = $1 and c.workspace_id = $2 and c.deleted_at is null
          and m.id = c.meeting_id and ${visible}
        returning c.id
      `,
      values
    )

    if (!result.rows.length) throw new CommentError("not_found")
  }

  return toWire(updated)
}

/** Toggles a reaction; returns whether it is now set. */
export async function toggleReaction(
  ctx: CommentStoreContext,
  input: {
    meetingId: string
    targetType: ReactionTargetType
    targetId: string
    emoji: ReactionEmoji
  }
): Promise<{ active: boolean }> {
  const scope = memberScope(ctx)

  if (!isReactionEmoji(input.emoji)) throw new CommentError("invalid_emoji")
  if (!REACTION_TARGET_TYPES.includes(input.targetType) || typeof input.targetId !== "string") {
    throw new CommentError("invalid_target")
  }

  const meeting = await visibleMeeting(ctx, input.meetingId)

  if (!meeting) throw new CommentError("not_found")

  const backend = await backendOf(ctx)

  if (input.targetType === "comment") {
    const comment = await loadComment(backend, scope, input.targetId)

    if (!comment || comment.deletedAt || comment.meetingId !== input.meetingId) {
      throw new CommentError("invalid_target")
    }
  } else if (!anchorForTarget(await targetIndexFor(ctx, meeting), input.targetType, input.targetId)) {
    throw new CommentError("invalid_target")
  }

  if (backend.kind === "memory") {
    const index = backend.db.reactions.findIndex(
      (reaction) =>
        reaction.workspaceId === scope.workspaceId &&
        reaction.meetingId === input.meetingId &&
        reaction.targetType === input.targetType &&
        reaction.targetId === input.targetId &&
        reaction.userId === ctx.userId &&
        reaction.emoji === input.emoji
    )

    if (index >= 0) {
      backend.db.reactions.splice(index, 1)
      return { active: false }
    }

    backend.db.reactions.push({
      workspaceId: scope.workspaceId,
      meetingId: input.meetingId,
      targetType: input.targetType,
      targetId: input.targetId,
      userId: ctx.userId,
      emoji: input.emoji,
      createdAt: nowIso(),
    })
    return { active: true }
  }

  const removed = await backend.client.query(
    `
      delete from reactions
      where target_type = $1 and target_id = $2 and user_id = $3 and emoji = $4
        and meeting_id = $5 and workspace_id = $6
      returning target_id
    `,
    [input.targetType, input.targetId, ctx.userId, input.emoji, input.meetingId, scope.workspaceId]
  )

  if (removed.rows.length) return { active: false }

  const values: unknown[] = [
    input.targetType,
    input.targetId,
    ctx.userId,
    input.emoji,
    input.meetingId,
    scope.workspaceId,
  ]
  const visible = meetingScopeSql(scope, "m", values)
  const inserted = await backend.client.query(
    `
      insert into reactions (workspace_id, meeting_id, target_type, target_id, user_id, emoji)
      select m.workspace_id, m.id, $1, $2, $3, $4
      from meetings m
      where m.id = $5 and m.workspace_id = $6 and ${visible}
      on conflict (workspace_id, meeting_id, target_type, target_id, user_id, emoji) do nothing
      returning target_id
    `,
    values
  )

  return { active: inserted.rows.length > 0 }
}
