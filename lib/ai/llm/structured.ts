/**
 * Shared structured-output parsing for every provider (A1/A2): JSON parse,
 * `stripNulls`, zod validation, the request's semantic `validate()`, and one
 * repair retry with the errors fed back. A second failure is
 * `LlmError("invalid_output")`.
 */
import { addUsage } from "@/lib/ai/llm/pricing"
import { stripNulls } from "@/lib/ai/llm/schema"
import {
  LlmError,
  type LlmProviderId,
  type LlmStructuredRequest,
  type LlmUsage,
} from "@/lib/ai/llm/types"

export type RawCompletion = {
  text: string
  usage: LlmUsage
  stopReason?: string
  /** Model that actually answered (server-side fallback may substitute). */
  model?: string
}

export type ParsedCompletion<T> = {
  value: T
  usage: LlmUsage
  stopReason?: string
  model?: string
}

const MAX_REPAIR_ERRORS = 12

function stripJsonFence(value: string): string {
  const trimmed = value.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)

  return fenced ? fenced[1] : trimmed
}

/**
 * `JSON.parse` error without its message (V8 quotes the offending input):
 * the error name and, when known, the position.
 */
function jsonErrorSummary(error: unknown): string {
  const name = error instanceof Error ? error.name || "Error" : "Error"
  const position = error instanceof Error ? /position (\d+)/.exec(error.message)?.[1] : undefined

  return position ? `${name} at position ${position}` : name
}

export type ParseStructuredResult<T> =
  | { ok: true; value: T }
  | {
      ok: false
      /** Detailed errors for the repair instruction (sent back to the model only). */
      errors: string[]
      /** Loggable summary: never contains model output or transcript text. */
      logSummary: string
    }

/** Parses and validates one completion; returns the value or error list. */
export function parseStructured<T>(
  req: Pick<LlmStructuredRequest<T>, "schema" | "validate">,
  text: string
): ParseStructuredResult<T> {
  let json: unknown

  try {
    json = JSON.parse(stripJsonFence(text))
  } catch (error) {
    const summary = jsonErrorSummary(error)

    return { ok: false, errors: [`Output is not valid JSON (${summary})`], logSummary: `invalid JSON (${summary})` }
  }

  const parsed = req.schema.zod.safeParse(stripNulls(json))

  if (!parsed.success) {
    const paths = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"} ${issue.code}`
    )

    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`
      ),
      logSummary: `schema: ${paths.slice(0, 3).join("; ")}${paths.length > 3 ? ` (+${paths.length - 3})` : ""}`,
    }
  }

  const semanticErrors = req.validate?.(parsed.data) ?? []

  return semanticErrors.length
    ? {
        ok: false,
        errors: semanticErrors,
        // Semantic messages quote model output (e.g. unknown ids): count only.
        logSummary: `${semanticErrors.length} rule violation${semanticErrors.length === 1 ? "" : "s"}`,
      }
    : { ok: true, value: parsed.data }
}

/** Instruction suffix for the repair retry. */
export function repairInstruction(errors: string[]): string {
  return [
    "The previous response did not match the required JSON schema or rules:",
    ...errors.slice(0, MAX_REPAIR_ERRORS).map((error) => `- ${error}`),
    "Return the complete corrected JSON object only.",
  ].join("\n")
}

/**
 * Runs `call` (one provider request), parsing its output; on parse or
 * validation errors calls once more with a repair instruction.
 */
export async function completeWithRepair<T>(
  req: Pick<LlmStructuredRequest<T>, "schema" | "validate">,
  provider: LlmProviderId,
  call: (repair?: string) => Promise<RawCompletion>
): Promise<ParsedCompletion<T>> {
  const first = await call()
  const firstParsed = parseStructured(req, first.text)

  if (firstParsed.ok) {
    return { value: firstParsed.value, usage: first.usage, stopReason: first.stopReason, model: first.model }
  }

  const second = await call(repairInstruction(firstParsed.errors))
  const usage = addUsage(first.usage, second.usage)
  const secondParsed = parseStructured(req, second.text)

  if (secondParsed.ok) {
    return { value: secondParsed.value, usage, stopReason: second.stopReason, model: second.model }
  }

  // The message lands in logs and ai_runs.error: summary only, no model text.
  const error = new LlmError(
    `Invalid structured output after repair: ${secondParsed.logSummary}`,
    "invalid_output",
    provider,
    false
  )

  Object.assign(error, { usage })
  throw error
}
