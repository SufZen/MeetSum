import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it, vi } from "vitest"

import { normalizeTranscriptForWer } from "@/lib/ai/asr-evaluation"
import {
  describeEvalError,
  evaluateSample,
  renderAsrEvalMarkdown,
} from "@/lib/ai/asr-eval/report"
import { parseAsrEvalArgs, runAsrEvaluation } from "@/lib/ai/asr-eval/run"
import { AsrError, type AsrRequest, type AsrResult } from "@/lib/ai/asr/types"

const FIXTURES = "tests/fixtures/asr/eval"

const fixedDeps = {
  now: () => new Date("2026-10-13T00:00:00.000Z"),
  gitSha: () => "0000000000000000000000000000000000000000",
  env: {},
}

/** Every token (≥3 chars) of every reference and recorded hypothesis. */
function transcriptTokens() {
  const tokens = new Set<string>()
  const add = (text: string) =>
    normalizeTranscriptForWer(text)
      .filter((token) => token.length >= 3)
      .forEach((token) => tokens.add(token))
  const references = path.join(FIXTURES, "references")

  for (const file of readdirSync(references).filter((name) => name.endsWith(".txt"))) {
    add(readFileSync(path.join(references, file), "utf8"))
  }
  for (const file of readdirSync(FIXTURES).filter((name) => /\.(runpod-ivrit|soniox)\.json$/.test(name))) {
    const recorded = JSON.parse(readFileSync(path.join(FIXTURES, file), "utf8")) as Partial<AsrResult>

    for (const segment of recorded.segments ?? []) add(segment.text)
  }

  return tokens
}

function leakedTokens(output: string) {
  const outputTokens = new Set(normalizeTranscriptForWer(output))

  return [...transcriptTokens()].filter((token) => outputTokens.has(token))
}

const sample = {
  id: "s1",
  audioPath: "a.wav",
  referencePath: "a.txt",
  language: "he",
  tags: ["t"],
}

function result(overrides: Partial<AsrResult> = {}): AsrResult {
  return {
    provider: "runpod-ivrit",
    model: "m",
    language: "he",
    durationMs: 3_600_000,
    segments: [
      { startMs: 0, endMs: 1000, text: "שלום עולם", speaker: "Speaker 1", turnIndex: 0, words: [] },
    ],
    speakers: [{ label: "Speaker 1", talkTimeMs: 1000, wordCount: 2, segmentCount: 1, firstStartMs: 0 }],
    diarization: "provider",
    cost: { usd: 0.5, basis: "gpu_seconds" },
    timings: { totalMs: 360_000 },
    glossaryReplacements: 0,
    warnings: [],
    ...overrides,
  }
}

describe("evaluateSample", () => {
  it("computes WER, CER, RTF and cost per audio hour", () => {
    const metrics = evaluateSample({
      sample,
      provider: "runpod-ivrit",
      reference: "שלום עולם",
      glossaryTerms: [],
      collarMs: 250,
      result: result(),
    })

    expect(metrics).toMatchObject({
      wer: 0,
      cer: 0,
      latinWer: null,
      termRecall: null,
      der: null,
      rtf: 0.1,
      costPerHourUsd: 0.5,
      speakers: 1,
      diarization: "provider",
    })
    expect(metrics).not.toHaveProperty("error")
  })

  it("falls back to wall-clock time for RTF and computes DER with turns", () => {
    const metrics = evaluateSample({
      sample,
      provider: "p",
      reference: "שלום עולם",
      referenceTurns: [{ speaker: "dana", startMs: 0, endMs: 1000 }],
      glossaryTerms: [],
      collarMs: 0,
      result: result({ timings: {}, durationMs: 10_000 }),
      elapsedMs: 5_000,
    })

    expect(metrics.rtf).toBe(0.5)
    expect(metrics.der).toBe(0)
    expect(metrics.refSpeechMs).toBe(1000)
  })

  it("records a short error without metrics", () => {
    const metrics = evaluateSample({
      sample,
      provider: "soniox",
      reference: "שלום",
      glossaryTerms: [],
      collarMs: 250,
      error: new AsrError("Soniox returned 429\nbody: secret transcript", "rate_limit", "soniox", true),
    })

    expect(metrics.error).toBe("rate_limit: Soniox returned 429")
    expect(metrics.wer).toBeNull()
  })

  it("truncates long error messages", () => {
    expect(describeEvalError(new Error("x".repeat(300)))).toHaveLength("Error: ".length + 120)
    expect(describeEvalError("nope")).toBe("unknown error")
  })
})

describe("parseAsrEvalArgs", () => {
  it("reads flags and defaults", () => {
    expect(parseAsrEvalArgs([], {})).toMatchObject({
      manifestPath: ".secrets/asr-eval/manifest.json",
      collarMs: 250,
    })
    expect(
      parseAsrEvalArgs(
        ["--providers", "soniox, runpod-ivrit", "--sample", "a", "--collar", "100", "--output-md", "out.md", "--output-json", "out.json"],
        {}
      )
    ).toMatchObject({
      providers: ["soniox", "runpod-ivrit"],
      sample: "a",
      collarMs: 100,
      outputMd: "out.md",
      outputJson: "out.json",
    })
  })

  it("uses the replay directory manifest when present", () => {
    expect(parseAsrEvalArgs(["--replay", FIXTURES], {}).manifestPath).toBe(
      path.join(FIXTURES, "manifest.json")
    )
  })

  it("rejects bad values", () => {
    expect(() => parseAsrEvalArgs(["--collar", "-1"], {})).toThrow(/--collar/)
    expect(() => parseAsrEvalArgs(["--sample"], {})).toThrow(/requires a value/)
  })
})

describe("replay report", () => {
  it("scores the synthetic fixtures without keys or network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const report = await runAsrEvaluation(
      parseAsrEvalArgs(["--replay", FIXTURES], {}),
      fixedDeps
    )

    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
    expect(report).toMatchObject({ mode: "replay", synthetic: true, sampleCount: 3 })
    expect(report.aggregates.map((row) => row.provider)).toEqual(["runpod-ivrit", "soniox"])
    expect(report.samples).toHaveLength(6)
    expect(report.tagCounts).toEqual({
      "2-speakers": 2,
      "latin-terms": 1,
      hebrew: 2,
      meeting: 1,
      mixed: 1,
      short: 1,
    })

    const short = report.samples.find(
      (row) => row.sampleId === "he-short-01" && row.provider === "soniox"
    )

    expect(short?.error).toBe("timeout: Soniox transcription timed out")

    const runpodIntro = report.samples.find(
      (row) => row.sampleId === "he-intro-01" && row.provider === "runpod-ivrit"
    )

    expect(runpodIntro?.der).toBe(0)
    expect(runpodIntro?.wer).toBeGreaterThan(0)

    const soniox = report.aggregates.find((row) => row.provider === "soniox")

    expect(soniox?.errors).toBe(1)
    expect(soniox?.termRecall).toBeCloseTo(1 / 3)
  })

  it("never writes transcript text into the markdown or JSON report", async () => {
    const report = await runAsrEvaluation(
      parseAsrEvalArgs(["--replay", FIXTURES], {}),
      fixedDeps
    )
    const markdown = renderAsrEvalMarkdown(report)

    expect(transcriptTokens().size).toBeGreaterThan(20)
    expect(leakedTokens(markdown)).toEqual([])
    expect(leakedTokens(JSON.stringify(report))).toEqual([])
    expect(markdown).toContain("Pending real clips/keys")
    expect(markdown).toContain("SYNTHETIC")
    // The manifest hash depends on checkout line endings; pin its shape only.
    expect(report.manifestSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(markdown.replace(report.manifestSha256, "<sha256>")).toMatchSnapshot()
  })

  it("runs live mode through the injected transcriber, one provider at a time", async () => {
    const transcribe = vi.fn<(provider: string, request: AsrRequest) => Promise<AsrResult>>(async (provider) => result({ provider: provider as AsrResult["provider"], durationMs: 11_000 }))
    const report = await runAsrEvaluation(
      {
        manifestPath: path.join(FIXTURES, "manifest.json"),
        providers: ["runpod-ivrit"],
        sample: "he-intro-01",
        collarMs: 250,
      },
      { ...fixedDeps, transcribe, env: { RUNPOD_ASR_MODEL: "ivrit", RUNPOD_API_KEY: "secret-key" } }
    )

    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(transcribe.mock.calls[0][1]).toMatchObject({
      language: "he",
      diarize: true,
      media: { kind: "file", contentType: "audio/wav" },
    })
    expect(report.mode).toBe("live")
    expect(report.providerSettings["runpod-ivrit"]).toEqual({ model: "m", RUNPOD_ASR_MODEL: "ivrit" })
    expect(JSON.stringify(report)).not.toContain("secret-key")
  })
})
