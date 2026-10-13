/**
 * Storage backend for the M5 collaboration stores (clips, clip shares,
 * comments, reactions, notifications). Postgres in production; the demo /
 * test backend keeps rows in memory (like the in-memory meeting repository).
 * Server-only.
 */
import type { MeetingClip } from "@/lib/clips/types"
import type { CommentAnchor, CommentTargetType, ReactionTargetType } from "@/lib/comments/types"
import type { Queryable } from "@/lib/db/client"

export type StoredClip = MeetingClip & { deletedAt?: string }

export type StoredClipShare = {
  id: string
  meetingId: string
  clipId: string
  token: string
  revoked: boolean
  expiresAt?: string
  createdBy?: string
  createdAt: string
  updatedAt: string
}

export type StoredComment = {
  id: string
  workspaceId: string
  meetingId: string
  targetType: CommentTargetType
  targetId: string
  parentId?: string
  authorUserId: string
  body: string
  mentions: string[]
  anchor: CommentAnchor
  resolvedAt?: string
  resolvedByUserId?: string
  editedAt?: string
  deletedAt?: string
  createdAt: string
}

export type StoredReaction = {
  workspaceId: string
  meetingId: string
  targetType: ReactionTargetType
  targetId: string
  userId: string
  emoji: string
  createdAt: string
}

export type StoredNotification = {
  id: string
  workspaceId: string
  userId: string
  kind: string
  payload: Record<string, unknown>
  readAt?: string
  createdAt: string
}

export type CollabMemoryDb = {
  clips: Map<string, StoredClip>
  clipShares: Map<string, StoredClipShare>
  comments: Map<string, StoredComment>
  reactions: StoredReaction[]
  notifications: StoredNotification[]
}

export type CollabBackend =
  | { kind: "postgres"; client: Queryable }
  | { kind: "memory"; db: CollabMemoryDb }

export function createCollabMemoryDb(): CollabMemoryDb {
  return {
    clips: new Map(),
    clipShares: new Map(),
    comments: new Map(),
    reactions: [],
    notifications: [],
  }
}

let override: CollabBackend | undefined
let memory: CollabMemoryDb | undefined

/** Resolved at call time so `next build` never needs DATABASE_URL. */
export async function getCollabBackend(): Promise<CollabBackend> {
  if (override) return override

  if (process.env.MEETSUM_STORAGE === "postgres") {
    const { getDatabasePool } = await import("@/lib/db/client")

    return { kind: "postgres", client: getDatabasePool() }
  }

  memory ??= createCollabMemoryDb()
  return { kind: "memory", db: memory }
}

/** Tests: force a backend (undefined restores env-based selection). */
export function setCollabBackendForTesting(backend: CollabBackend | undefined) {
  override = backend
  if (!backend) memory = undefined
}

export function toIso(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  if (value instanceof Date) return value.toISOString()

  const parsed = new Date(String(value))

  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}

export function nowIso(): string {
  return new Date().toISOString()
}
