/**
 * Shared system prompt (cached prefix) for every provider: preamble, style
 * guide and the transcript block. It depends only on the output language and
 * `sharedContext`, never on the task, a timestamp or an id, so it is
 * byte-identical across tasks of the same meeting and language (prompt-cache
 * hits on Claude; implicit caching on Gemini).
 */
import { dataBlock } from "@/lib/ai/prompts/data-block"
import { getStyleGuide } from "@/lib/ai/prompts/style-guide"
import { buildPreamble } from "@/lib/ai/policy"
import type { LlmStructuredRequest } from "@/lib/ai/llm/types"

export function buildSharedSystem(
  req: Pick<LlmStructuredRequest<unknown>, "language" | "sharedContext">
): string {
  const parts = [buildPreamble(req.language), getStyleGuide(req.language)].filter(Boolean)

  // The transcript is data: `<` is neutralized so it can't close the block.
  if (req.sharedContext) parts.push(dataBlock("transcript", req.sharedContext))
  return parts.join("\n\n")
}

/** User-turn text: task instructions plus an optional repair note. */
export function buildUserInstructions(instructions: string, repair?: string): string {
  return repair ? `${instructions}\n\n${repair}` : instructions
}
