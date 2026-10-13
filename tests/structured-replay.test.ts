/**
 * M10 A: structured LLM replay (docs/parity/m10.md, "Structured LLM replay").
 * Refused in production, a missing recording throws, the zod schema, the
 * request's `validate` and the citation check apply, and the committed
 * he-en-30s recordings pass the real summary/title schemas.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

import { replayStructured, citedAliases, isStructuredReplayEnabled, presentedAliases } from "@/lib/ai/llm/structured-replay"
import { LlmError, type LlmStructuredRequest } from "@/lib/ai/llm/types"
import { BUILT_IN_TEMPLATES } from "@/lib/ai/templates/builtins"
import { buildSummarySchema, titleTagsTypeSchema, validateSummaryOutput } from "@/lib/ai/templates/schema"
import { formatTranscriptForPrompt } from "@/lib/intelligence/transcript-format"
import type { TranscriptSegment } from "@/lib/meetings/repository"
import { FIXTURE_SENTENCES } from "@/scripts/e2e/make-audio-fixture"

const COMMITTED = path.join("tests", "fixtures", "e2e", "llm-replay")
const dev = (dir: string) => ({ MEETSUM_LLM_REPLAY_DIR: dir, NODE_ENV: "development" })
let dir: string

/** The prompt transcript the pipeline builds from the fake-ASR segments. */
const transcript = formatTranscriptForPrompt(
  FIXTURE_SENTENCES.map(
    (sentence, index): TranscriptSegment => ({
      id: `seg_${index}`,
      speaker: "Speaker 1",
      startMs: sentence.start * 1000,
      endMs: sentence.end * 1000,
      text: sentence.text,
    })
  ),
  []
)

const schema = z.object({ answer: z.string(), refs: z.array(z.string()) })

function request(overrides: Partial<LlmStructuredRequest<z.infer<typeof schema>>> = {}): LlmStructuredRequest<z.infer<typeof schema>> {
  return {
    task: "judge",
    ctx: { workspaceId: "w1", meetingId: "m1", promptVersion: "test" },
    language: "he",
    sharedContext: "[s1 00:00 Speaker 1] שלום MARKER-ONE\n[s2 00:05 Speaker 1] עוד שורה",
    instructions: "x",
    schema: { name: "judge", zod: schema },
    ...overrides,
  }
}

async function record(task: string, fixtureId: string, body: unknown) {
  await mkdir(path.join(dir, task), { recursive: true })
  await writeFile(path.join(dir, task, `${fixtureId}.json`), JSON.stringify(body))
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "structured-replay-"))
  await record("judge", "one", { fixtureId: "one", marker: "MARKER-ONE", output: { answer: "כן", refs: ["s1"] } })
  await record("chat", "bad-cite", { fixtureId: "bad-cite", marker: "MARKER-ONE", output: { answer: "כן", refs: ["s9"] } })
  await record("sentiment", "bad-shape", { fixtureId: "bad-shape", marker: "MARKER-ONE", output: { answer: 3 } })
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("switch", () => {
  it("is refused in production and off without the dir", async () => {
    expect(isStructuredReplayEnabled({ MEETSUM_LLM_REPLAY_DIR: dir, NODE_ENV: "production" })).toBe(false)
    expect(isStructuredReplayEnabled({ NODE_ENV: "development" })).toBe(false)
    expect(isStructuredReplayEnabled(dev(dir))).toBe(true)
    await expect(replayStructured(request(), { MEETSUM_LLM_REPLAY_DIR: dir, NODE_ENV: "production" })).rejects.toThrow(/disabled/)
  })
})

describe("replay", () => {
  it("answers from the recording whose marker is in the transcript", async () => {
    const result = await replayStructured(request(), dev(dir))

    expect(result.value).toEqual({ answer: "כן", refs: ["s1"] })
    expect(result.provider).not.toBe("heuristic")
    expect(result.model).toBe("replay")
    expect(result.costUsd).toBe(0)
    expect(result.fallbackUsed).toBe(false)
  })

  it("throws (no template fallback) when no recording matches", async () => {
    const error = await replayStructured(request({ sharedContext: "[s1 00:00 A] something else" }), dev(dir)).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).kind).toBe("config")
    await expect(replayStructured(request({ task: "follow_up" }), dev(dir))).rejects.toThrow(/no recording/)
  })

  it("applies the zod schema", async () => {
    await expect(replayStructured(request({ task: "sentiment" }), dev(dir))).rejects.toMatchObject({ kind: "invalid_output" })
  })

  it("applies the request's semantic validate()", async () => {
    await expect(replayStructured(request({ validate: () => ["nope"] }), dev(dir))).rejects.toMatchObject({ kind: "invalid_output" })
  })

  it("rejects citations of aliases the prompt never presented", async () => {
    await expect(replayStructured(request({ task: "chat" }), dev(dir))).rejects.toThrow(/did not present/)
  })

  it("collects refs, startRef and sourceRef", () => {
    expect(citedAliases({ a: [{ refs: ["s1", "s2"] }], chapters: [{ startRef: "s3" }], actionItems: [{ sourceRef: "s4" }] })).toEqual([
      "s1",
      "s2",
      "s3",
      "s4",
    ])
    expect([...presentedAliases("[s1 00:00 A] x\n[s12 01:00 B] y")]).toEqual(["s1", "s12"])
  })
})

describe("committed he-en-30s recordings", () => {
  it("the summary passes the hebrew_business schema, validate() and the citation check", async () => {
    const template = BUILT_IN_TEMPLATES.hebrew_business
    const result = await replayStructured(
      {
        task: "summary",
        ctx: { workspaceId: "w1", meetingId: "m1", promptVersion: "test" },
        language: "he",
        sharedContext: transcript.text,
        instructions: "x",
        schema: { name: "meeting_summary", zod: buildSummarySchema(template) as never },
        validate: validateSummaryOutput(template) as never,
      },
      dev(COMMITTED)
    )

    expect((result.value as { decisions: unknown[] }).decisions.length).toBeGreaterThan(0)
  })

  it("the title recording passes the title schema and classifies the meeting as general", async () => {
    const result = await replayStructured(
      {
        task: "title_tags_type",
        ctx: { workspaceId: "w1", meetingId: "m1", promptVersion: "test" },
        language: "he",
        sharedContext: transcript.text,
        instructions: "x",
        schema: { name: "meeting_title_tags_type", zod: titleTagsTypeSchema },
      },
      dev(COMMITTED)
    )

    expect(result.value.meetingType).toBe("general")
  })
})
