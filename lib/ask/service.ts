/**
 * AskMeetSum: retrieval or full-transcript context, streamed answer with
 * mandatory citations, threads (docs/parity/m6.md, C2-C5; owner: Package C).
 *
 * STEP 0 STUB: yields one `error internal` event; `askOnce` returns an error.
 */
import type { AuthContext } from "@/lib/auth/authz"
import type { AskJsonResponse, AskRequest, AskStreamEvent } from "@/lib/ask/types"

export async function* askStream(
  ctx: AuthContext,
  req: AskRequest,
  signal?: AbortSignal
): AsyncGenerator<AskStreamEvent> {
  void ctx
  void req
  void signal

  yield { type: "error", code: "internal", message: "AskMeetSum is not available yet" }
}

export async function askOnce(
  ctx: AuthContext,
  req: AskRequest,
  signal?: AbortSignal
): Promise<AskJsonResponse> {
  void ctx
  void signal

  return {
    threadId: null,
    status: "error",
    content: "",
    citations: [],
    grounded: false,
    language: req.language ?? "he",
  }
}
