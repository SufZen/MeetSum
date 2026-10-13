import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setChatStreamersForTesting, streamText } from "@/lib/ai/llm/stream"
import { isReplayEnabled, replayKey, templateAnswer } from "@/lib/ai/llm/stream-replay"
import type { LlmStreamEvent, LlmStreamRequest } from "@/lib/ai/llm/types"

/** Replay stream for the e2e (docs/parity/m6.md, C1 tests). */

const ENV_KEYS = ["MEETSUM_LLM_REPLAY_DIR", "MEETSUM_LLM_REPLAY_DELAY_MS", "NODE_ENV", "MEETSUM_STORAGE"]
const saved: Record<string, string | undefined> = {}
let dir: string

function request(overrides: Partial<LlmStreamRequest> = {}): LlmStreamRequest {
  return {
    task: "chat",
    ctx: { workspaceId: "ws_1", promptVersion: "m6.ask.1" },
    language: "he",
    preference: "auto",
    system: [{ text: "instructions", cache: true }],
    messages: [
      {
        role: "user",
        content: '<passages>\n<passage meeting="x" date="01.10.2026" kind="transcript">\n[s1 00:01 דנה] א\n[s2 00:05 רון] ב\n</passage>\n</passages>\n\n<question>\nמה?\n</question>',
      },
    ],
    ...overrides,
  }
}

async function collect(stream: AsyncIterable<LlmStreamEvent>) {
  const events: LlmStreamEvent[] = []

  for await (const event of stream) events.push(event)
  return events
}

beforeEach(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  dir = await mkdtemp(path.join(tmpdir(), "meetsum-replay-"))
  process.env.MEETSUM_LLM_REPLAY_DIR = dir
  process.env.MEETSUM_LLM_REPLAY_DELAY_MS = "0"
  ;(process.env as Record<string, string>).NODE_ENV = "test"
  delete process.env.MEETSUM_STORAGE
})

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else (process.env as Record<string, string>)[key] = saved[key]!
  }
  setChatStreamersForTesting(undefined)
  await rm(dir, { recursive: true, force: true })
})

describe("replay stream", () => {
  it("plays back recorded deltas keyed by prompt version, system and messages", async () => {
    const req = request()

    await writeFile(path.join(dir, `${replayKey(req)}.json`), JSON.stringify({ deltas: ["הוקלט ", "[s2]."] }))

    const events = await collect(streamText(req))

    expect(events.filter((event) => event.type === "delta").map((event) => (event as { text: string }).text)).toEqual([
      "הוקלט ",
      "[s2].",
    ])
    expect(events.at(-1)).toMatchObject({ type: "done", text: "הוקלט [s2].", model: "replay", costUsd: 0 })
  })

  it("uses a different key when the question changes", () => {
    const other = request({ messages: [{ role: "user", content: "<question>אחרת</question>" }] })

    expect(replayKey(other)).not.toBe(replayKey(request()))
  })

  it("falls back to a template citing the first two aliases, in the request language", async () => {
    const events = await collect(streamText(request()))
    const done = events.at(-1) as Extract<LlmStreamEvent, { type: "done" }>

    expect(done.text).toBe("לפי הפגישות, הנושא נדון [s1]. פרטים נוספים עלו בהמשך [s2].")
    expect(templateAnswer(request({ language: "en" }))).toContain("[s1]")
    expect(templateAnswer(request({ messages: [{ role: "user", content: "<question>q</question>" }], system: [{ text: "x" }] }))).toBe(
      "<<NO_ANSWER>>"
    )
  })

  it("never calls a real provider while active", async () => {
    const stream = vi.fn()

    setChatStreamersForTesting({
      gemini: { id: "gemini", isConfigured: () => true, stream },
      anthropic: { id: "anthropic", isConfigured: () => true, stream },
    })
    await collect(streamText(request()))
    expect(stream).not.toHaveBeenCalled()
  })

  it("refuses to activate in production", () => {
    expect(isReplayEnabled({ MEETSUM_LLM_REPLAY_DIR: dir, NODE_ENV: "production" })).toBe(false)
    expect(isReplayEnabled({ MEETSUM_LLM_REPLAY_DIR: dir, NODE_ENV: "development" })).toBe(true)
    expect(isReplayEnabled({ NODE_ENV: "development" })).toBe(false)
  })

  it("uses the real providers in production even with a replay dir", async () => {
    ;(process.env as Record<string, string>).NODE_ENV = "production"

    const stream = vi.fn(async function* () {
      yield { type: "delta" as const, text: "real [s1]" }
      yield { type: "final" as const, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    })

    setChatStreamersForTesting({
      gemini: { id: "gemini", isConfigured: () => true, stream },
      anthropic: { id: "anthropic", isConfigured: () => false, stream },
    })

    const events = await collect(streamText(request()))

    expect(stream).toHaveBeenCalledTimes(1)
    expect(events.at(-1)).toMatchObject({ type: "done", provider: "gemini" })
  })
})
