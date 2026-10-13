import type { AuthContext } from "@/lib/auth/authz"
import { getBotConfig } from "@/lib/bot/config"
import { LiveTranscriptHub, type LiveSubscriber } from "@/lib/bot/live/hub"
import { botDisabled, botError } from "@/lib/bot/service"
import { formatSseComment, formatSseEvent, SSE_HEADERS } from "@/lib/bot/sse"
import { getBotSessionStore } from "@/lib/bot/store"
import { isTerminalBotStatus } from "@/lib/bot/types"
import { getBotProvider } from "@/lib/bot/vexa/client"

/**
 * GET /api/meetings/[id]/bot/live (M7 B8). Only with
 * MEETSUM_LIVE_TRANSCRIPT=true and a session with transcription enabled;
 * otherwise 404 `live_unavailable`. The draft is ASR text from Vexa; the
 * final transcript always comes from our router after the call.
 */

export const LIVE_KEEPALIVE_MS = 15_000

let hub: LiveTranscriptHub | undefined

export function getLiveTranscriptHub(): LiveTranscriptHub {
  if (!hub) {
    const config = getBotConfig()

    hub = new LiveTranscriptHub({
      provider: getBotProvider,
      store: getBotSessionStore,
      pollMs: config.live.pollMs,
      maxStreams: config.live.maxStreams,
    })
  }

  return hub
}

/** Test hook. */
export function setLiveTranscriptHub(next: LiveTranscriptHub | undefined) {
  hub = next
}

export async function openLiveTranscriptStream(
  request: Request,
  ctx: AuthContext,
  meetingId: string,
  options: { keepAliveMs?: number } = {}
): Promise<Response> {
  const config = getBotConfig()

  if (!config.enabled) return botDisabled()

  const meeting = await ctx.meetings.getMeeting(meetingId, { includeTranscript: false })

  if (!meeting) return botError("not_found", 404)
  if (!config.live.enabled) return botError("live_unavailable", 404)

  const sessions = await getBotSessionStore().listForMeeting(ctx.workspace.id, meeting.id)
  const session = sessions.find(
    (item) => !isTerminalBotStatus(item.status) && item.transcribeEnabled && item.vexaMeetingId
  )

  if (!session?.vexaMeetingId) return botError("live_unavailable", 404)

  const encoder = new TextEncoder()
  const subscription: { unsubscribe?: () => void } = {}
  let keepAlive: ReturnType<typeof setInterval> | undefined
  let closed = false
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined

  const cleanup = () => {
    if (closed) return
    closed = true
    if (keepAlive) clearInterval(keepAlive)
    subscription.unsubscribe?.()
    try {
      controllerRef?.close()
    } catch {
      // already closed
    }
  }

  const subscriber: LiveSubscriber = {
    send(event) {
      if (closed) return
      controllerRef?.enqueue(
        encoder.encode(
          formatSseEvent(event.event, event.data, event.event === "segment" ? event.data.id : undefined)
        )
      )
    },
    close: cleanup,
  }
  const liveHub = getLiveTranscriptHub()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller
      controller.enqueue(encoder.encode(formatSseComment("connected")))
      keepAlive = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(formatSseComment()))
      }, options.keepAliveMs ?? LIVE_KEEPALIVE_MS)
    },
    cancel: cleanup,
  })

  subscription.unsubscribe = liveHub.subscribe(
    { id: session.id, workspaceId: session.workspaceId, vexaMeetingId: session.vexaMeetingId },
    subscriber
  )

  if (!subscription.unsubscribe) {
    closed = true
    if (keepAlive) clearInterval(keepAlive)
    await stream.cancel().catch(() => undefined)
    return botError("live_unavailable", 429)
  }

  request.signal?.addEventListener("abort", cleanup, { once: true })

  return new Response(stream, { status: 200, headers: { ...SSE_HEADERS } })
}
