import type { BotProvider } from "@/lib/bot/vexa/types"

/**
 * Idempotent recording import after a bot session completes (M7 B4): stream
 * the Vexa audio into object storage, create the `meeting_bot` media asset,
 * move the meeting to `media_found` and enqueue exactly one `media.ingest`.
 * Step 0 stub throws.
 */

export type FinalizeBotSessionInput = {
  sessionId: string
  workspaceId: string
  provider?: BotProvider
  /** Injected object storage for tests (defaults to lib/storage). */
  storage?: unknown
  /** True on the last BullMQ attempt (missing recording -> `no_recording`). */
  finalAttempt?: boolean
}

export type FinalizeBotSessionResult =
  | { status: "imported"; assetId: string; ingestJobId: string }
  | { status: "skipped"; reason: "already_imported" | "meeting_deleted" }
  | { status: "missing" }

export async function finalizeBotSession(
  input: FinalizeBotSessionInput
): Promise<FinalizeBotSessionResult> {
  void input
  throw new Error("finalizeBotSession not implemented (M7)")
}
