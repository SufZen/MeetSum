/**
 * Replay chat stream for the e2e (docs/parity/m6.md, C1). Active only when
 * `MEETSUM_LLM_REPLAY_DIR` is set AND `NODE_ENV !== "production"`.
 *
 * A recording is `<dir>/<key>.json` = `{ "deltas": string[] }` with
 * `key = sha256(promptVersion | system texts | messages)`. Without a
 * recording it answers with a deterministic template citing the first two
 * aliases found in the prompt (or `<<NO_ANSWER>>` when there are none).
 * No network, no keys, no cost.
 */
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"

import type { LlmStreamEvent, LlmStreamRequest } from "@/lib/ai/llm/types"

type Env = Record<string, string | undefined>

export const REPLAY_MODEL = "replay"

export function isReplayEnabled(env: Env = process.env): boolean {
  return Boolean(env.MEETSUM_LLM_REPLAY_DIR?.trim()) && env.NODE_ENV !== "production"
}

export function replayKey(req: Pick<LlmStreamRequest, "ctx" | "system" | "messages">): string {
  return createHash("sha256")
    .update(
      [
        req.ctx.promptVersion,
        req.system.map((block) => block.text).join("\n\u0000\n"),
        JSON.stringify(req.messages.map((message) => [message.role, message.content])),
      ].join("|")
    )
    .digest("hex")
}

const ALIAS_LINE = /\[((?:s|a)\d+)[\s\]]/g

/** Aliases offered in the final user message (passages), else the system prompt. */
function offeredAliases(req: LlmStreamRequest): string[] {
  const last = req.messages.at(-1)?.content ?? ""
  const passages = last.includes("<passage") ? last.slice(0, last.lastIndexOf("<question>")) : ""
  const sources = [passages, ...req.system.map((block) => block.text)]
  const found: string[] = []

  for (const source of sources) {
    for (const match of source.matchAll(ALIAS_LINE)) {
      if (!found.includes(match[1])) found.push(match[1])
      if (found.length >= 2) return found
    }
  }
  return found
}

/** Deterministic answer used when no recording exists. */
export function templateAnswer(req: LlmStreamRequest): string {
  const [first, second] = offeredAliases(req)

  if (!first) return "<<NO_ANSWER>>"
  if (req.language === "en") {
    return second
      ? `According to the meetings, this was discussed [${first}]. More details came up later [${second}].`
      : `According to the meetings, this was discussed [${first}].`
  }
  return second
    ? `לפי הפגישות, הנושא נדון [${first}]. פרטים נוספים עלו בהמשך [${second}].`
    : `לפי הפגישות, הנושא נדון [${first}].`
}

async function recordedDeltas(dir: string, key: string): Promise<string[] | undefined> {
  if (!/^[0-9a-f]{64}$/.test(key)) return undefined
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, `${key}.json`), "utf8")) as { deltas?: unknown }

    return Array.isArray(parsed.deltas) && parsed.deltas.every((delta) => typeof delta === "string")
      ? (parsed.deltas as string[])
      : undefined
  } catch {
    return undefined
  }
}

function chunksOf(text: string, size = 6): string[] {
  const chunks: string[] = []

  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size))
  return chunks
}

export async function* replayStream(req: LlmStreamRequest, env: Env = process.env): AsyncGenerator<LlmStreamEvent> {
  if (!isReplayEnabled(env)) throw new Error("Replay stream is disabled")

  const startedAt = Date.now()
  const deltas = (await recordedDeltas(env.MEETSUM_LLM_REPLAY_DIR!.trim(), replayKey(req))) ?? chunksOf(templateAnswer(req))

  yield { type: "start", provider: "heuristic", model: REPLAY_MODEL }

  let text = ""

  for (const delta of deltas) {
    if (req.signal?.aborted) return
    text += delta
    yield { type: "delta", text: delta }
    // Paced like a real stream so the UI (and Stop) can be exercised.
    await new Promise((resolve) => setTimeout(resolve, Number(env.MEETSUM_LLM_REPLAY_DELAY_MS ?? 40)))
  }

  yield {
    type: "done",
    provider: "heuristic",
    model: REPLAY_MODEL,
    text,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0,
    latencyMs: Date.now() - startedAt,
    attempts: [{ provider: "heuristic", model: REPLAY_MODEL, ok: true, latencyMs: Date.now() - startedAt }],
  }
}
