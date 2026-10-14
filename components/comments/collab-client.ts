"use client"

/**
 * Client data layer for M5 comments, reactions and clips. One shared,
 * per-meeting comments snapshot (useSyncExternalStore) so many
 * CommentAnchors / ReactionBars on a page share a single request; it
 * refetches on window focus and every 15 s while anything is subscribed and
 * the tab is visible. The subscribe function is stable per meeting, so a
 * re-render never resubscribes (an inline subscribe used to refetch on
 * every render: a request storm).
 */
import { useParams } from "next/navigation"
import { useMemo, useSyncExternalStore } from "react"

import { useOptionalI18n } from "@/components/i18n-provider"

import type { ClipWire, CreateClipInput } from "@/lib/clips/types"
import type {
  CommentListResult,
  CommentTargetType,
  CommentThread,
  ReactionEmoji,
  ReactionSummary,
  ReactionTargetType,
} from "@/lib/comments/types"
import { formatMessage } from "@/lib/i18n/messages"
import type { clipsMessagesEn } from "@/lib/i18n/m5/clips"
import type { commentsMessagesEn } from "@/lib/i18n/m5/comments"

/** Poll interval while subscribed and the tab is visible. */
export const COLLAB_REFRESH_MS = 15_000
/** A first subscriber reuses a snapshot younger than this. */
const FRESH_MS = 5_000

/* ------------------------------------------------------------ strings */

/**
 * The clip and comment keys. They come from the route's `I18nProvider`
 * (`app/[locale]` passes the whole dictionary, which includes both modules),
 * so the message modules never ship in client JS (M10 C).
 */
export type CollabStrings = typeof clipsMessagesEn & typeof commentsMessagesEn

function documentLocale(): string | undefined {
  return typeof document === "undefined" ? undefined : document.documentElement.lang
}

/** Clip/comment strings for the current route locale (`/[locale]/…`). */
export function useCollabStrings(locale?: string): { t: CollabStrings; locale: "he" | "en" } {
  const i18n = useOptionalI18n()
  const params = useParams<{ locale?: string }>()
  const resolved = locale ?? i18n?.locale ?? params?.locale ?? documentLocale() ?? "en"
  const he = resolved === "he" || resolved.startsWith("he-")
  const messages = i18n?.messages

  return useMemo(() => ({ t: (messages ?? {}) as CollabStrings, locale: he ? "he" : "en" }), [he, messages])
}

export { formatMessage }

/* ------------------------------------------------------------ http */

export class CollabRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined
  ) {
    super(code ?? `HTTP ${status}`)
    this.name = "CollabRequestError"
  }
}

async function request<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers: init?.json !== undefined ? { "content-type": "application/json" } : init?.headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  })
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>

  if (!response.ok) {
    const code =
      typeof body.reason === "string"
        ? body.reason
        : typeof body.error === "string"
          ? body.error
          : undefined

    throw new CollabRequestError(response.status, code)
  }
  return body as T
}

const meetingPath = (meetingId: string) => `/api/meetings/${encodeURIComponent(meetingId)}`

export type CommentsSnapshot = CommentListResult & {
  viewerUserId: string
  authors: Record<string, { name: string }>
}

export const collabApi = {
  listComments: (meetingId: string) =>
    request<CommentsSnapshot>(`${meetingPath(meetingId)}/comments`),
  createComment: (
    meetingId: string,
    input: { targetType: CommentTargetType; targetId: string; body: string; parentId?: string }
  ) => request(`${meetingPath(meetingId)}/comments`, { method: "POST", json: input }),
  editComment: (commentId: string, body: string) =>
    request(`/api/comments/${encodeURIComponent(commentId)}`, { method: "PATCH", json: { body } }),
  resolveComment: (commentId: string, resolved: boolean) =>
    request(`/api/comments/${encodeURIComponent(commentId)}`, {
      method: "PATCH",
      json: { resolved },
    }),
  deleteComment: (commentId: string) =>
    request(`/api/comments/${encodeURIComponent(commentId)}`, { method: "DELETE" }),
  toggleReaction: (input: {
    meetingId: string
    targetType: ReactionTargetType
    targetId: string
    emoji: ReactionEmoji
  }) => request<{ active: boolean }>("/api/reactions", { method: "POST", json: input }),
  listMembers: () =>
    request<{ members: Array<{ userId: string; name: string | null; email: string }> }>(
      "/api/workspaces/current/members"
    ),
  listClips: (meetingId: string) => request<{ clips: ClipWire[] }>(`${meetingPath(meetingId)}/clips`),
  createClip: (meetingId: string, input: CreateClipInput) =>
    request<{ clip: ClipWire }>(`${meetingPath(meetingId)}/clips`, { method: "POST", json: input }),
  deleteClip: (clipId: string) =>
    request(`/api/clips/${encodeURIComponent(clipId)}`, { method: "DELETE" }),
  shareClip: (clipId: string) =>
    request<{ url: string }>(`/api/clips/${encodeURIComponent(clipId)}/share`, { method: "POST" }),
}

/* ------------------------------------------------------------ comments store */

type Entry = {
  snapshot?: CommentsSnapshot
  error?: CollabRequestError
  listeners: Set<() => void>
  timer?: ReturnType<typeof setInterval>
  onFocus?: () => void
  /** Last successful load (ms). */
  loadedAt?: number
  inflight?: Promise<void>
  state: CommentsState
}

export type CommentsState = {
  status: "loading" | "ready" | "error"
  snapshot?: CommentsSnapshot
  error?: CollabRequestError
}

const entries = new Map<string, Entry>()
const LOADING: CommentsState = { status: "loading" }

function entryFor(meetingId: string): Entry {
  let entry = entries.get(meetingId)

  if (!entry) {
    entry = { listeners: new Set(), state: LOADING }
    entries.set(meetingId, entry)
  }
  return entry
}

function emit(entry: Entry) {
  entry.state = entry.snapshot
    ? { status: "ready", snapshot: entry.snapshot, error: entry.error }
    : entry.error
      ? { status: "error", error: entry.error }
      : LOADING
  for (const listener of entry.listeners) listener()
}

/** (Re)loads a meeting's comments; concurrent calls share one request. */
export function refreshComments(meetingId: string): Promise<void> {
  const entry = entryFor(meetingId)

  entry.inflight ??= collabApi
    .listComments(meetingId)
    .then((snapshot) => {
      entry.snapshot = snapshot
      entry.error = undefined
      entry.loadedAt = Date.now()
    })
    .catch((error: unknown) => {
      entry.error =
        error instanceof CollabRequestError ? error : new CollabRequestError(0, "network")
    })
    .finally(() => {
      entry.inflight = undefined
      emit(entry)
    })

  return entry.inflight
}

function isVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden"
}

function subscribe(meetingId: string, listener: () => void) {
  const entry = entryFor(meetingId)
  const first = entry.listeners.size === 0

  entry.listeners.add(listener)

  if (first) {
    const fresh = entry.loadedAt !== undefined && Date.now() - entry.loadedAt < FRESH_MS

    if (!fresh) void refreshComments(meetingId)
    entry.timer = setInterval(() => {
      // Paused while the tab is hidden.
      if (isVisible()) void refreshComments(meetingId)
    }, COLLAB_REFRESH_MS)
    entry.onFocus = () => void refreshComments(meetingId)
    if (typeof window !== "undefined") window.addEventListener("focus", entry.onFocus)
  }

  return () => {
    entry.listeners.delete(listener)
    if (entry.listeners.size > 0) return
    if (entry.timer) clearInterval(entry.timer)
    entry.timer = undefined
    if (entry.onFocus && typeof window !== "undefined") window.removeEventListener("focus", entry.onFocus)
    entry.onFocus = undefined
  }
}

const subscribers = new Map<string, (listener: () => void) => () => void>()
const getSnapshots = new Map<string, () => CommentsState>()

/** Stable `useSyncExternalStore` subscribe function of a meeting. */
export function commentsSubscriber(meetingId: string): (listener: () => void) => () => void {
  let subscriber = subscribers.get(meetingId)

  if (!subscriber) {
    subscriber = (listener) => subscribe(meetingId, listener)
    subscribers.set(meetingId, subscriber)
  }
  return subscriber
}

function commentsSnapshotGetter(meetingId: string): () => CommentsState {
  let getter = getSnapshots.get(meetingId)

  if (!getter) {
    getter = () => entryFor(meetingId).state
    getSnapshots.set(meetingId, getter)
  }
  return getter
}

const serverSnapshot = () => LOADING

/** Shared comments snapshot of a meeting (refetch on focus / every 15 s). */
export function useMeetingComments(meetingId: string): CommentsState {
  return useSyncExternalStore(commentsSubscriber(meetingId), commentsSnapshotGetter(meetingId), serverSnapshot)
}

/** Tests: forget every meeting's snapshot, timers and subscribers. */
export function resetCommentsStoreForTesting() {
  for (const entry of entries.values()) if (entry.timer) clearInterval(entry.timer)
  entries.clear()
  subscribers.clear()
  getSnapshots.clear()
}

export function threadsFor(
  snapshot: CommentsSnapshot | undefined,
  targetType: CommentTargetType,
  targetId: string
): CommentThread[] {
  return snapshot?.threads[`${targetType}:${targetId}`] ?? []
}

export function reactionsFor(
  snapshot: CommentsSnapshot | undefined,
  targetType: ReactionTargetType,
  targetId: string
): ReactionSummary[] {
  return (snapshot?.reactions ?? []).filter(
    (reaction) => reaction.targetType === targetType && reaction.targetId === targetId
  )
}

/** Live comments (roots + replies) on one target. */
export function commentCount(threads: readonly CommentThread[]): number {
  return threads.reduce(
    (sum, thread) => sum + (thread.deletedAt ? 0 : 1) + thread.replies.length,
    0
  )
}

export function authorName(snapshot: CommentsSnapshot | undefined, userId: string): string {
  return snapshot?.authors[userId]?.name ?? "—"
}
