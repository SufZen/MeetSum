/**
 * Platform event payload builders (docs/parity/m8.md, C4). Owner: Package C.
 *
 * - `platformEventPayload` is the v1 builder: today's payload unchanged, so
 *   v1 webhook deliveries stay byte-for-byte the same.
 * - `buildWebhookPayloadV2` (pure) and `resolveWebhookPayloadV2` (re-reads
 *   the meeting, and the clip for `clip.created`) build the catalog v2
 *   payloads. They are visibility-aware: a private meeting, or one whose
 *   visibility cannot be read, gets the minimal payload (ids,
 *   `workspace_id`, `visibility: "private"`), the same rule as the
 *   processor's `platformEventData`, applied to every v2 event.
 */
import type { MeetingClip } from "@/lib/clips/types"
import { isRtlLanguage } from "@/lib/integrations/bidi"
import type { MeetingRecord, MeetingRepository } from "@/lib/meetings/repository"
import { WEBHOOK_EVENTS_V2, type WebhookEventV2 } from "@/lib/platform/event-catalog"
import { MEETING_SCOPED_EVENTS, PRIVATE_PAYLOAD_KEYS } from "@/lib/platform/event-schemas"
import type { PlatformEventName } from "@/lib/platform/events"
import { buildSegmentLink } from "@/lib/player/deep-link"

export function platformEventPayload(
  name: PlatformEventName,
  data: Record<string, unknown>
): Record<string, unknown> {
  void name

  return data
}

const PRIVATE_KEYS = new Set<string>(PRIVATE_PAYLOAD_KEYS)

/** Ids plus `workspace_id` and `visibility: "private"`; nothing else. */
export function minimalPrivatePayload(
  workspaceId: string,
  data: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...Object.fromEntries(
      Object.entries(data).filter(([key, value]) => PRIVATE_KEYS.has(key) && value !== undefined && value !== null)
    ),
    workspace_id: workspaceId,
    visibility: "private",
  }
}

export function isWebhookEventV2(name: string): name is WebhookEventV2 {
  return (WEBHOOK_EVENTS_V2 as readonly string[]).includes(name)
}

function isMeetingScoped(name: WebhookEventV2): boolean {
  return MEETING_SCOPED_EVENTS.includes(name)
}

/** Drops undefined and null values (optional fields are absent, never null). */
function compact(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null))
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function int(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined
}

function appOrigin(env: NodeJS.ProcessEnv): string {
  return (env.NEXT_PUBLIC_APP_URL?.trim() || env.MEETINGS_APP_URL?.trim() || "").replace(/\/+$/, "")
}

function linkLocale(meeting: Pick<MeetingRecord, "language">): string {
  return isRtlLanguage(meeting.language) ? "he" : "en"
}

/** App link to a meeting (no `t`), or to a moment in it. */
function meetingUrl(meeting: MeetingRecord, env: NodeJS.ProcessEnv, ms?: number): string {
  const link = buildSegmentLink({ origin: appOrigin(env), locale: linkLocale(meeting), meetingId: meeting.id, ms: ms ?? 0 })

  if (ms !== undefined) return link

  const [path, query = ""] = link.split("?")
  const params = new URLSearchParams(query)

  params.delete("t")

  return `${path}?${params.toString()}`
}

export type WebhookPayloadV2Context = {
  workspaceId: string
  /**
   * The meeting re-read just before delivery. `undefined` (missing,
   * invisible or unreadable) fails closed: the minimal private payload.
   */
  meeting?: MeetingRecord
  /** The clip, for `clip.created`. */
  clip?: Pick<MeetingClip, "title" | "startMs" | "endMs">
  env?: NodeJS.ProcessEnv
}

/**
 * The v2 data of an event from its v1/raw data and the re-read meeting.
 * Pure. Never adds content to a private meeting's payload.
 */
export function buildWebhookPayloadV2(
  name: WebhookEventV2,
  data: Record<string, unknown>,
  context: WebhookPayloadV2Context
): Record<string, unknown> {
  const env = context.env ?? process.env

  if (name === "bot.status_changed") {
    return compact({
      sessionId: str(data.sessionId),
      meetingId: str(data.meetingId),
      status: str(data.status) ?? "unknown",
      reason: str(data.reason),
    })
  }

  if (name === "integration.delivery.failed") {
    return compact({
      deliveryId: str(data.deliveryId),
      provider: str(data.provider) ?? "unknown",
      meetingId: str(data.meetingId),
      reason: str(data.reason) ?? "failed",
    })
  }

  if (!isMeetingScoped(name)) return compact(data)

  const meeting = context.meeting
  const visibility = meeting && meeting.id === data.meetingId ? (meeting.visibility ?? "workspace") : "private"

  if (data.visibility === "private" || !meeting || visibility === "private") {
    return minimalPrivatePayload(context.workspaceId, data)
  }

  switch (name) {
    case "meeting.completed":
      return compact({
        meetingId: meeting.id,
        title: str(data.title) ?? meeting.title,
        mode: str(data.mode),
        startedAt: meeting.startedAt,
        durationMs: int(meeting.durationMs),
        language: meeting.language,
        participantCount: meeting.participantDetails?.length ?? meeting.participants.length,
        actionItemCount: meeting.summary?.actionItems.length ?? 0,
        overview: str(meeting.summary?.overview) ?? str(meeting.intelligence?.overview),
        url: meetingUrl(meeting, env),
        visibility,
      })
    case "summary.created":
      return compact({
        meetingId: meeting.id,
        title: str(data.title) ?? meeting.title,
        mode: str(data.mode),
        tags: Array.isArray(data.tags) ? data.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
        url: meetingUrl(meeting, env),
        visibility,
      })
    case "action_item.created":
      return compact({
        meetingId: meeting.id,
        actionItemId: str(data.actionItemId),
        title: str(data.title) ?? "",
        owner: str(data.owner),
        priority: str(data.priority),
        url: meetingUrl(meeting, env),
        visibility,
      })
    case "action_item.updated": {
      const item = meeting.summary?.actionItems.find((candidate) => candidate.id === data.actionItemId)

      return compact({
        meetingId: meeting.id,
        actionItemId: str(data.actionItemId),
        changed: Array.isArray(data.changed) ? data.changed.filter((field): field is string => typeof field === "string") : [],
        title: item?.title ?? str(data.title) ?? "",
        owner: str(item?.owner),
        status: item?.status ?? "open",
        dueDate: str(item?.dueOn) ?? str(item?.dueDate),
        priority: item?.priority,
        url: meetingUrl(meeting, env, item?.sourceStartMs),
        visibility,
      })
    }
    case "clip.created": {
      const startMs = int(context.clip?.startMs ?? data.startMs) ?? 0

      return compact({
        meetingId: meeting.id,
        clipId: str(data.clipId),
        title: str(context.clip?.title) ?? str(data.title),
        startMs,
        endMs: int(context.clip?.endMs ?? data.endMs) ?? startMs,
        url: meetingUrl(meeting, env, startMs),
        visibility,
      })
    }
    default:
      // meeting.process_failed, realizeos.export.*: the v1 fields plus visibility.
      return compact({ ...data, visibility })
  }
}

export type WebhookPayloadScope = {
  workspaceId: string
  /** Scoped repository of the request that emitted the event, if any. */
  repo?: Pick<MeetingRepository, "getMeeting">
}

export type WebhookPayloadLoaders = {
  loadMeeting?(workspaceId: string, meetingId: string): Promise<MeetingRecord | undefined>
  loadClip?(workspaceId: string, clipId: string): Promise<MeetingClip | undefined>
  env?: NodeJS.ProcessEnv
}

async function defaultLoadMeeting(workspaceId: string, meetingId: string) {
  const { getSystemMeetingRepository } = await import("@/lib/meetings/store")

  return getSystemMeetingRepository(workspaceId).getMeeting(meetingId)
}

async function defaultLoadClip(workspaceId: string, clipId: string) {
  const { getClipForRender } = await import("@/lib/clips/store")

  return getClipForRender(workspaceId, clipId)
}

/**
 * Re-reads the meeting (and clip) and builds the v2 data. Any read failure
 * fails closed (minimal private payload); it never throws.
 */
export async function resolveWebhookPayloadV2(
  name: WebhookEventV2,
  data: Record<string, unknown>,
  scope: WebhookPayloadScope,
  loaders: WebhookPayloadLoaders = {}
): Promise<Record<string, unknown>> {
  const meetingId = str(data.meetingId)
  let meeting: MeetingRecord | undefined
  let clip: MeetingClip | undefined

  if (meetingId && isMeetingScoped(name) && data.visibility !== "private") {
    try {
      meeting = scope.repo
        ? await scope.repo.getMeeting(meetingId)
        : await (loaders.loadMeeting ?? defaultLoadMeeting)(scope.workspaceId, meetingId)
    } catch {
      meeting = undefined
    }
    if (meeting && meeting.workspaceId && meeting.workspaceId !== scope.workspaceId) meeting = undefined
  }

  const clipId = str(data.clipId)

  if (name === "clip.created" && meeting && clipId) {
    try {
      clip = await (loaders.loadClip ?? defaultLoadClip)(scope.workspaceId, clipId)
    } catch {
      clip = undefined
    }
    if (clip && clip.meetingId !== meetingId) clip = undefined
  }

  return buildWebhookPayloadV2(name, data, {
    workspaceId: scope.workspaceId,
    ...(meeting ? { meeting } : {}),
    ...(clip ? { clip } : {}),
    ...(loaders.env ? { env: loaders.env } : {}),
  })
}
