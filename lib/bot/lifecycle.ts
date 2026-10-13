import type { BotEventSource, BotSessionPatch, BotSessionStore } from "@/lib/bot/store"
import type { BotSession, BotSessionRecord, BotStatus, BotStatusReason } from "@/lib/bot/types"
import type { VexaMeeting, VexaServiceProvenance } from "@/lib/bot/vexa/types"

/**
 * Pure Vexa-status lifecycle (M7 B2), shared by the webhook and reconcile.
 * Step 0 stubs return no-ops.
 */

export type BotStatusChange = { status: BotStatus; reason: BotStatusReason | null }

export type MapVexaStatusContext = {
  /** Vexa failure/completion reason (zoom_requires_rtms, evicted, ...). */
  reason?: string | null
  provenance?: VexaServiceProvenance
  /** The session reached `active` before this event. */
  wasActive: boolean
}

export type BotSideEffect = "enqueue_finalize" | "enqueue_consent" | "notify"

/** Maps a Vexa status to ours (Model table); undefined = ignore (idle, scheduled). */
export function mapVexaStatus(
  vexaStatus: string,
  context: MapVexaStatusContext
): BotStatusChange | undefined {
  void vexaStatus
  void context

  return undefined
}

export function applyBotStatus(
  session: BotSession,
  next: BotStatusChange
): { patch: BotSessionPatch; sideEffects: BotSideEffect[] } {
  void session
  void next

  return { patch: {}, sideEffects: [] }
}

/** Applies a Vexa meeting snapshot (webhook or poll) through store.transition. */
export async function applyVexaSnapshot(
  store: BotSessionStore,
  session: BotSessionRecord,
  vexaMeeting: VexaMeeting,
  source: BotEventSource
): Promise<{ applied: boolean; session: BotSessionRecord; sideEffects: BotSideEffect[] }> {
  void store
  void vexaMeeting
  void source

  return { applied: false, session, sideEffects: [] }
}
