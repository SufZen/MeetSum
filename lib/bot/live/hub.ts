import type { BotLiveEvent, BotLiveSegmentEvent } from "@/lib/bot/api-types"
import { redactBotError } from "@/lib/bot/redact"
import type { BotSessionStore } from "@/lib/bot/store"
import { isTerminalBotStatus, type BotStatus, type BotStatusReason } from "@/lib/bot/types"
import type { BotProvider, VexaTranscriptSegment } from "@/lib/bot/vexa/types"
import { getLogger } from "@/lib/log"

const log = getLogger({ component: "bot" })

/**
 * Live transcript fan-out (M7 B8, flag-gated). One shared in-process poller
 * per bot session calls `getTranscript` every MEETSUM_LIVE_POLL_MS and
 * pushes upserts keyed by `segment_id` to every subscriber; it stops as soon
 * as the last subscriber leaves, and ends all streams when the session turns
 * terminal. At most `maxStreams` subscribers per process.
 */

export type LiveSubscriber = {
  send(event: BotLiveEvent): void
  close(): void
}

export type LiveSessionRef = {
  id: string
  workspaceId: string
  vexaMeetingId: string
}

export type LiveHubOptions = {
  provider: () => BotProvider
  store: () => BotSessionStore
  pollMs: number
  maxStreams: number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}

type Poller = {
  session: LiveSessionRef
  subscribers: Set<LiveSubscriber>
  handle: unknown
  segments: Map<string, string>
  status?: string
  busy: boolean
}

export function toLiveSegment(segment: VexaTranscriptSegment): BotLiveSegmentEvent {
  return {
    id: segment.segmentId,
    speaker: segment.speaker?.trim() || null,
    text: segment.text,
    startMs: Math.max(0, Math.round(segment.start * 1000)),
    endMs: Math.max(0, Math.round(segment.end * 1000)),
    language: segment.language ?? null,
    final: segment.completed === true,
  }
}

export class LiveTranscriptHub {
  private readonly pollers = new Map<string, Poller>()
  private readonly options: LiveHubOptions

  constructor(options: LiveHubOptions) {
    this.options = options
  }

  get streamCount(): number {
    let count = 0

    for (const poller of this.pollers.values()) count += poller.subscribers.size
    return count
  }

  get pollerCount(): number {
    return this.pollers.size
  }

  /** Undefined when the process is at `maxStreams`. */
  subscribe(session: LiveSessionRef, subscriber: LiveSubscriber): (() => void) | undefined {
    if (this.streamCount >= this.options.maxStreams) return undefined

    let poller = this.pollers.get(session.id)

    if (!poller) {
      const created: Poller = {
        session,
        subscribers: new Set(),
        handle: undefined,
        segments: new Map(),
        busy: false,
      }
      const every = this.options.setInterval ?? ((fn, ms) => setInterval(fn, ms))

      created.handle = every(() => void this.tick(created), this.options.pollMs)
      this.pollers.set(session.id, created)
      poller = created
      void this.tick(created)
    } else {
      // Replay what this poller already knows to the new subscriber.
      void this.tick(poller, subscriber)
    }

    poller.subscribers.add(subscriber)

    const target = poller

    return () => this.unsubscribe(target, subscriber)
  }

  private unsubscribe(poller: Poller, subscriber: LiveSubscriber) {
    poller.subscribers.delete(subscriber)
    if (!poller.subscribers.size) this.stop(poller)
  }

  private stop(poller: Poller) {
    if (this.pollers.get(poller.session.id) !== poller) return

    const clear = this.options.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout))

    clear(poller.handle)
    this.pollers.delete(poller.session.id)
  }

  private emit(poller: Poller, event: BotLiveEvent, only?: LiveSubscriber) {
    for (const subscriber of only ? [only] : poller.subscribers) {
      try {
        subscriber.send(event)
      } catch {
        this.unsubscribe(poller, subscriber)
      }
    }
  }

  /** One poll: status first (end on terminal), then segment upserts. */
  async tick(poller: Poller, replayTo?: LiveSubscriber): Promise<void> {
    if (poller.busy && !replayTo) return
    if (!replayTo) poller.busy = true

    try {
      const session = await this.options
        .store()
        .get(poller.session.id, { workspaceId: poller.session.workspaceId })

      if (!session) {
        this.end(poller, { status: "failed", statusReason: "unknown" })
        return
      }

      const statusEvent = {
        status: session.status as BotStatus,
        statusReason: session.statusReason as BotStatusReason | null,
      }

      if (replayTo || poller.status !== session.status) {
        if (!replayTo) poller.status = session.status
        this.emit(poller, { event: "status", data: statusEvent }, replayTo)
      }

      const transcript = await this.options.provider().getTranscript(poller.session.vexaMeetingId)

      for (const segment of transcript.segments) {
        const live = toLiveSegment(segment)
        const signature = `${live.text}|${live.endMs}|${live.final}|${live.speaker ?? ""}`

        if (replayTo || poller.segments.get(live.id) !== signature) {
          if (!replayTo) poller.segments.set(live.id, signature)
          this.emit(poller, { event: "segment", data: live }, replayTo)
        }
      }

      if (isTerminalBotStatus(session.status)) this.end(poller, statusEvent)
    } catch (error) {
      log.warn({ error: redactBotError(error) }, "[bot] live transcript poll failed")
    } finally {
      if (!replayTo) poller.busy = false
    }
  }

  private end(poller: Poller, data: { status: BotStatus; statusReason: BotStatusReason | null }) {
    this.emit(poller, { event: "end", data })

    for (const subscriber of [...poller.subscribers]) {
      try {
        subscriber.close()
      } catch {
        // already closed
      }
    }

    poller.subscribers.clear()
    this.stop(poller)
  }
}
