/**
 * LLM entry point (owner: Package A). Step 0 stubs: no provider is wired yet,
 * so every call fails with a `config` error and callers keep their current
 * (Gemini/heuristic) paths.
 */
import {
  LlmError,
  type LlmResult,
  type LlmStatus,
  type LlmStructuredRequest,
} from "@/lib/ai/llm/types"

export * from "@/lib/ai/llm/types"

export async function generateStructured<T>(
  req: LlmStructuredRequest<T>
): Promise<LlmResult<T>> {
  throw new LlmError(
    `generateStructured(${req.task}): not implemented (M5)`,
    "config",
    "none",
    false
  )
}

export function getLlmStatus(): LlmStatus {
  throw new LlmError("getLlmStatus: not implemented (M5)", "config", "none", false)
}
