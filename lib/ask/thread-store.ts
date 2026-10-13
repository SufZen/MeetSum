/**
 * Per-user, per-workspace Ask threads (docs/parity/m6.md, C4; owner:
 * Package C). API-key principals are stateless: no store.
 *
 * STEP 0 STUB: user principals get a store whose methods throw.
 */
import type { AuthContext } from "@/lib/auth/authz"
import type { AskScope, ThreadMessage, ThreadSummary } from "@/lib/ask/types"

export type ThreadPatch = { title?: string | null; archived?: boolean }

export type ThreadStore = {
  listThreads(opts?: { scope?: AskScope; archived?: boolean; limit?: number }): Promise<ThreadSummary[]>
  createThread(input: { scope: AskScope; title?: string | null; language?: string }): Promise<ThreadSummary>
  getThread(id: string): Promise<{ thread: ThreadSummary; messages: ThreadMessage[] } | null>
  updateThread(id: string, patch: ThreadPatch): Promise<ThreadSummary | null>
  deleteThread(id: string): Promise<boolean>
  setFeedback(messageId: string, feedback: -1 | 1 | null): Promise<boolean>
}

function notImplemented(): never {
  throw new Error("Ask threads are not implemented yet")
}

export function createThreadStore(ctx: AuthContext): ThreadStore | null {
  if (ctx.principal !== "user" || !ctx.user) return null

  return {
    listThreads: async () => notImplemented(),
    createThread: async () => notImplemented(),
    getThread: async () => notImplemented(),
    updateThread: async () => notImplemented(),
    deleteThread: async () => notImplemented(),
    setFeedback: async () => notImplemented(),
  }
}
