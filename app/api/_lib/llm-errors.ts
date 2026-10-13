import { NextResponse } from "next/server"

import { LlmError } from "@/lib/ai/llm/types"

/**
 * HTTP answer for a failed on-demand LLM generation (M5 prep / follow-up):
 * 503 when no provider is configured, 502 for provider failures. The message
 * is generic; provider details stay in `ai_runs`.
 */
export function llmErrorResponse(error: unknown): Response {
  if (error instanceof LlmError) {
    return NextResponse.json(
      { error: error.kind === "config" ? "llm_not_configured" : "llm_failed", kind: error.kind },
      { status: error.kind === "config" ? 503 : 502 }
    )
  }

  throw error
}
