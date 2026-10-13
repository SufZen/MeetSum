/**
 * Streaming chat over the M5 router task `chat` (Gemini first by default,
 * Claude when preferred; fallback only before the first delta).
 * docs/parity/m6.md, C1; owner: Package C.
 *
 * STEP 0 STUB: no streaming provider; always throws `LlmError("config")`.
 */
import { LlmError, type LlmStreamEvent, type LlmStreamRequest } from "@/lib/ai/llm/types"

export async function* streamText(req: LlmStreamRequest): AsyncGenerator<LlmStreamEvent> {
  void req

  throw new LlmError("Streaming chat is not implemented yet", "config", "none", false)
}
