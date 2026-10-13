import type { BotSession } from "@/lib/bot/types"

/**
 * Bot dispatcher (M7 A6): delayed `bot.dispatch` jobs, rank/rev-guarded
 * dispatch, conflict adoption and capacity re-delay. Step 0 stubs throw.
 */

function notImplemented(name: string): never {
  throw new Error(`${name} not implemented (M7)`)
}

export async function scheduleDispatch(session: BotSession): Promise<void> {
  void session
  notImplemented("scheduleDispatch")
}

export async function runDispatch(input: { sessionId: string; rev: number }): Promise<void> {
  void input
  notImplemented("runDispatch")
}

/** Join now / Send bot: dispatch immediately. */
export async function dispatchNow(sessionId: string): Promise<BotSession> {
  void sessionId
  return notImplemented("dispatchNow")
}
