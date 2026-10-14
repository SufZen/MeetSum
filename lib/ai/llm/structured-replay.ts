/**
 * Structured LLM replay for the e2e (docs/parity/m10.md, "Structured LLM
 * replay"). Same switch as the Ask stream replay: active only when
 * `MEETSUM_LLM_REPLAY_DIR` is set AND `NODE_ENV !== "production"`.
 *
 * A recording is `<dir>/<task>/<fixtureId>.json`:
 *
 *   { "fixtureId": "he-en-30s", "marker": "<text from the transcript>", "output": { ... } }
 *
 * `task` is the router task (`summary`, `title_tags_type`, ...). The
 * fixture is found by its `marker`, a phrase of the ASR fixture's speech that
 * must appear in the request's transcript (`sharedContext`): the fixture id is
 * carried by the transcript itself, not by a prompt hash, so prompt edits
 * don't break the e2e. Exactly one recording must match.
 *
 * The output goes through the same `parseStructured` (zod + the request's
 * semantic `validate`) as live output, plus a citation check (every segment
 * alias it cites must be one the prompt presented), so a bad fixture fails
 * like a bad model would. A missing recording is a hard `LlmError`: it is
 * never answered from a template. This is pipeline wiring evidence, not
 * quality evidence.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { isReplayEnabled } from "@/lib/ai/llm/stream-replay"
import { parseStructured } from "@/lib/ai/llm/structured"
import { LlmError, type LlmResult, type LlmStructuredRequest } from "@/lib/ai/llm/types"

type Env = Record<string, string | undefined>

/** ai_runs model of a replayed call (the provider slot is `gemini`, cost 0). */
export const STRUCTURED_REPLAY_MODEL = "replay"

export type StructuredRecording = {
  fixtureId: string
  marker: string
  output: unknown
}

const TASK_PATTERN = /^[a-z_]{1,40}$/
const ALIAS_PATTERN = /\[(s\d+)\s/g

export function isStructuredReplayEnabled(env: Env = process.env): boolean {
  return isReplayEnabled(env)
}

function readRecordings(dir: string, task: string): Array<StructuredRecording & { file: string }> {
  if (!TASK_PATTERN.test(task)) return []

  const taskDir = path.join(dir, task)

  if (!existsSync(taskDir)) return []

  return readdirSync(taskDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const file = path.join(taskDir, name)
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<StructuredRecording>

      if (typeof parsed.fixtureId !== "string" || typeof parsed.marker !== "string" || !parsed.marker.trim() || parsed.output === undefined) {
        throw new LlmError(`Replay recording ${task}/${name} is malformed`, "invalid_output", "gemini", false)
      }
      if (`${parsed.fixtureId}.json` !== name) {
        throw new LlmError(`Replay recording ${task}/${name} has fixtureId ${parsed.fixtureId}`, "invalid_output", "gemini", false)
      }
      return { fixtureId: parsed.fixtureId, marker: parsed.marker, output: parsed.output, file }
    })
}

/** Segment aliases (`s3`) the prompt presented. */
export function presentedAliases(sharedContext: string | undefined): Set<string> {
  return new Set([...(sharedContext ?? "").matchAll(ALIAS_PATTERN)].map((match) => match[1]!))
}

/** Every `refs[]`, `startRef` and `sourceRef` string in the output. */
export function citedAliases(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) citedAliases(item, found)
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === "refs" && Array.isArray(item)) found.push(...item.filter((ref): ref is string => typeof ref === "string"))
      else if ((key === "startRef" || key === "sourceRef") && typeof item === "string") found.push(item)
      else citedAliases(item, found)
    }
  }
  return found
}

/**
 * Answers a structured request from its recording. Throws `LlmError`
 * (`config` when no recording matches, `invalid_output` when the recording
 * fails validation or cites an alias the prompt never presented).
 */
export async function replayStructured<T>(req: LlmStructuredRequest<T>, env: Env = process.env): Promise<LlmResult<T>> {
  if (!isStructuredReplayEnabled(env)) throw new Error("Structured replay is disabled")

  const startedAt = Date.now()
  const dir = env.MEETSUM_LLM_REPLAY_DIR!.trim()
  const context = req.sharedContext ?? ""
  const matches = readRecordings(dir, req.task).filter((recording) => context.includes(recording.marker))

  if (matches.length !== 1) {
    // Hard error: the replay dir is set, so no silent heuristic answer.
    throw new LlmError(
      matches.length
        ? `Replay: ${matches.length} recordings match this ${req.task} request (${matches.map((match) => match.fixtureId).join(", ")})`
        : `Replay: no recording under ${req.task}/ matches this transcript`,
      "config",
      "gemini",
      false
    )
  }

  const recording = matches[0]!
  const parsed = parseStructured(req, JSON.stringify(recording.output))

  if (!parsed.ok) {
    throw new LlmError(`Replay ${req.task}/${recording.fixtureId}: ${parsed.logSummary}`, "invalid_output", "gemini", false)
  }

  const presented = presentedAliases(context)
  const unknown = citedAliases(parsed.value).filter((alias) => !presented.has(alias))

  if (unknown.length) {
    throw new LlmError(
      `Replay ${req.task}/${recording.fixtureId}: cites ${unknown.length} segment alias(es) the prompt did not present`,
      "invalid_output",
      "gemini",
      false
    )
  }

  const latencyMs = Date.now() - startedAt

  return {
    value: parsed.value,
    provider: "gemini",
    model: STRUCTURED_REPLAY_MODEL,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0,
    latencyMs,
    attempts: [{ provider: "gemini", model: STRUCTURED_REPLAY_MODEL, ok: true, latencyMs }],
    fallbackUsed: false,
  }
}
