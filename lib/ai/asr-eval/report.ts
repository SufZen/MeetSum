import {
  calculateCharErrorRate,
  calculateWordErrorRate,
  latinTokenWer,
  termRecall,
} from "@/lib/ai/asr-evaluation"
import { computeDer, type SpeakerTurn } from "@/lib/ai/asr-eval/der"
import type { AsrEvalSample } from "@/lib/ai/asr-eval/manifest"
import type { AsrResult } from "@/lib/ai/asr/types"

/**
 * ASR eval metrics and report (M3 C4). Everything here is numbers, ids,
 * tags and provider settings: the report NEVER contains transcript text
 * (reference or hypothesis), so it can be committed and shared.
 */

export type SampleEvalInput = {
  sample: AsrEvalSample
  provider: string
  /** Reference transcript text (used for metrics only, never reported). */
  reference: string
  referenceTurns?: SpeakerTurn[]
  glossaryTerms: string[]
  collarMs: number
  result?: AsrResult
  error?: unknown
  /** Wall-clock processing time when not recorded in result timings. */
  elapsedMs?: number
}

export type SampleMetrics = {
  sampleId: string
  provider: string
  model: string | null
  tags: string[]
  language: string
  durationMs: number | null
  wer: number | null
  cer: number | null
  latinWer: number | null
  termRecall: number | null
  der: number | null
  rtf: number | null
  costUsd: number | null
  costPerHourUsd: number | null
  speakers: number | null
  diarization: string | null
  referenceWords: number
  referenceChars: number
  latinReferenceWords: number
  termsExpected: number
  termsFound: number
  refSpeechMs: number
  derErrorMs: number
  error?: string
}

export type ProviderAggregate = {
  provider: string
  samples: number
  errors: number
  /** Word-weighted over successful samples. */
  wer: number | null
  cer: number | null
  latinWer: number | null
  termRecall: number | null
  /** Reference-speech-weighted over samples with reference turns. */
  der: number | null
  rtf: number | null
  /** Total cost / total audio hours. */
  costPerHourUsd: number | null
}

export type AsrEvalReportMeta = {
  generatedAt: string
  gitSha: string | null
  manifestPath: string
  manifestSha256: string
  mode: "live" | "replay"
  synthetic: boolean
  collarMs: number
  replayDir?: string
  providerSettings: Record<string, Record<string, string>>
}

export type AsrEvalReport = AsrEvalReportMeta & {
  tagCounts: Record<string, number>
  sampleCount: number
  aggregates: ProviderAggregate[]
  samples: SampleMetrics[]
}

/** Error kind + first line of the message, truncated: no payload dumps. */
export function describeEvalError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error"

  const kind = "kind" in error && typeof error.kind === "string" ? error.kind : error.name
  const firstLine = error.message.split(/\r?\n/)[0] ?? ""
  const message = firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine

  return message ? `${kind}: ${message}` : kind
}

function processingMs(result: AsrResult, elapsedMs?: number) {
  const timings = result.timings ?? {}
  const recorded = timings.totalMs ?? timings.total

  return typeof recorded === "number" && recorded > 0 ? recorded : elapsedMs
}

export function evaluateSample(input: SampleEvalInput): SampleMetrics {
  const wer = calculateWordErrorRate(input.reference, "")
  const cer = calculateCharErrorRate(input.reference, "")
  const latin = latinTokenWer(input.reference, "")
  const terms = termRecall(input.reference, "", input.glossaryTerms)
  const base: SampleMetrics = {
    sampleId: input.sample.id,
    provider: input.provider,
    model: null,
    tags: input.sample.tags,
    language: input.sample.language,
    durationMs: null,
    wer: null,
    cer: null,
    latinWer: null,
    termRecall: null,
    der: null,
    rtf: null,
    costUsd: null,
    costPerHourUsd: null,
    speakers: null,
    diarization: null,
    referenceWords: wer.referenceWords,
    referenceChars: cer.referenceChars,
    latinReferenceWords: latin.referenceWords,
    termsExpected: terms.expected,
    termsFound: 0,
    refSpeechMs: 0,
    derErrorMs: 0,
  }

  if (!input.result) {
    return { ...base, error: describeEvalError(input.error ?? new Error("no result")) }
  }

  const result = input.result
  const hypothesis = result.segments.map((segment) => segment.text).join(" ")
  const hypothesisTerms = termRecall(input.reference, hypothesis, input.glossaryTerms)
  const latinWer = latinTokenWer(input.reference, hypothesis)
  const durationMs = result.durationMs > 0 ? result.durationMs : null
  const elapsed = processingMs(result, input.elapsedMs)
  const costUsd = result.cost?.usd ?? null
  let der: ReturnType<typeof computeDer> | undefined

  if (input.referenceTurns?.length) {
    der = computeDer(
      input.referenceTurns,
      result.segments.map((segment) => ({
        speaker: segment.speaker,
        startMs: segment.startMs,
        endMs: segment.endMs,
      })),
      { collarMs: input.collarMs }
    )
  }

  return {
    ...base,
    model: result.model,
    durationMs,
    wer: calculateWordErrorRate(input.reference, hypothesis).wer,
    cer: calculateCharErrorRate(input.reference, hypothesis).cer,
    latinWer: latinWer.referenceWords ? latinWer.wer : null,
    termRecall: hypothesisTerms.recall,
    termsFound: hypothesisTerms.found,
    der: der ? der.der : null,
    refSpeechMs: der?.refSpeechMs ?? 0,
    derErrorMs: der ? der.missMs + der.falseAlarmMs + der.confusionMs : 0,
    rtf: durationMs && elapsed ? elapsed / durationMs : null,
    costUsd,
    costPerHourUsd: durationMs && costUsd !== null ? costUsd / (durationMs / 3_600_000) : null,
    speakers: result.speakers.length,
    diarization: result.diarization,
  }
}

function weighted(rows: SampleMetrics[], value: (row: SampleMetrics) => number | null, weight: (row: SampleMetrics) => number) {
  let total = 0
  let sum = 0

  for (const row of rows) {
    const v = value(row)
    const w = weight(row)

    if (v === null || !w) continue
    total += w
    sum += v * w
  }

  return total ? sum / total : null
}

function aggregate(provider: string, rows: SampleMetrics[]): ProviderAggregate {
  const ok = rows.filter((row) => !row.error)
  const termsExpected = ok.reduce((sum, row) => sum + row.termsExpected, 0)
  const refSpeechMs = ok.reduce((sum, row) => sum + row.refSpeechMs, 0)
  const rtfs = ok.map((row) => row.rtf).filter((rtf): rtf is number => rtf !== null)
  const costed = ok.filter((row) => row.costUsd !== null && row.durationMs)
  const costHours = costed.reduce((sum, row) => sum + (row.durationMs ?? 0) / 3_600_000, 0)

  return {
    provider,
    samples: rows.length,
    errors: rows.length - ok.length,
    wer: weighted(ok, (row) => row.wer, (row) => row.referenceWords),
    cer: weighted(ok, (row) => row.cer, (row) => row.referenceChars),
    latinWer: weighted(ok, (row) => row.latinWer, (row) => row.latinReferenceWords),
    termRecall: termsExpected
      ? ok.reduce((sum, row) => sum + row.termsFound, 0) / termsExpected
      : null,
    der: refSpeechMs ? ok.reduce((sum, row) => sum + row.derErrorMs, 0) / refSpeechMs : null,
    rtf: rtfs.length ? rtfs.reduce((sum, rtf) => sum + rtf, 0) / rtfs.length : null,
    costPerHourUsd: costHours
      ? costed.reduce((sum, row) => sum + (row.costUsd ?? 0), 0) / costHours
      : null,
  }
}

export function buildAsrEvalReport(
  meta: AsrEvalReportMeta,
  samples: AsrEvalSample[],
  rows: SampleMetrics[]
): AsrEvalReport {
  const tagCounts: Record<string, number> = {}

  for (const sample of samples) {
    for (const tag of sample.tags) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1
  }

  const providers = [...new Set(rows.map((row) => row.provider))]

  return {
    ...meta,
    tagCounts: Object.fromEntries(Object.entries(tagCounts).sort(([a], [b]) => a.localeCompare(b))),
    sampleCount: samples.length,
    aggregates: providers.map((provider) =>
      aggregate(provider, rows.filter((row) => row.provider === provider))
    ),
    samples: rows,
  }
}

/* ------------------------------------------------------------- markdown */

const DASH = "—"

function pct(value: number | null) {
  return value === null ? DASH : `${(value * 100).toFixed(1)}%`
}

function num(value: number | null, digits = 2) {
  return value === null ? DASH : value.toFixed(digits)
}

function usd(value: number | null) {
  return value === null ? DASH : `$${value.toFixed(3)}`
}

function duration(ms: number | null) {
  if (ms === null) return DASH

  const seconds = Math.round(ms / 1000)

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

function cell(value: string) {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
}

function table(header: string[], rows: string[][]) {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n")
}

export function renderAsrEvalMarkdown(report: AsrEvalReport): string {
  const lines: string[] = []

  if (report.synthetic) {
    lines.push(
      "# Hebrew ASR evaluation — Pending real clips/keys",
      "",
      "> **Pending real clips/keys.** No real recordings or provider keys were used. Re-run with",
      "> `npm run asr:evaluate -- --output-md docs/parity/asr-eval.md` once the clip set in",
      "> `.secrets/asr-eval/manifest.json` and the RunPod/Soniox keys are available.",
      ">",
      "> **SYNTHETIC run.** The numbers below come from recorded synthetic fixtures",
      `> (\`--replay ${report.replayDir ?? ""}\`) and only prove that the harness works.`,
      "> They say nothing about real accuracy, cost or speed.",
      ""
    )
  } else {
    lines.push("# Hebrew ASR evaluation", "")
  }

  const tags = Object.entries(report.tagCounts)
    .map(([tag, count]) => `${tag} ×${count}`)
    .join(", ")

  lines.push(
    table(
      ["Field", "Value"],
      [
        ["Generated", report.generatedAt],
        ["Git SHA", report.gitSha ? `\`${report.gitSha}\`` : DASH],
        ["Manifest", `\`${report.manifestPath}\``],
        ["Manifest SHA-256", `\`${report.manifestSha256}\``],
        ["Mode", report.synthetic ? `${report.mode} (synthetic)` : report.mode],
        ["DER collar", `${report.collarMs} ms`],
        ["Samples", String(report.sampleCount)],
        ["Tags", tags || DASH],
      ]
    ),
    "",
    "## Aggregate",
    "",
    "WER/CER are word/character-weighted, DER is reference-speech-weighted, cost per hour is total cost over total audio hours.",
    "",
    table(
      ["Provider", "Samples", "Errors", "WER", "CER", "Latin WER", "Term recall", "DER", "RTF", "Cost / audio h"],
      report.aggregates.map((row) => [
        row.provider,
        String(row.samples),
        String(row.errors),
        pct(row.wer),
        pct(row.cer),
        pct(row.latinWer),
        pct(row.termRecall),
        pct(row.der),
        num(row.rtf, 3),
        usd(row.costPerHourUsd),
      ])
    ),
    "",
    "## Per sample",
    "",
    table(
      ["Sample", "Tags", "Provider", "Model", "Duration", "WER", "CER", "Latin WER", "Term recall", "DER", "Speakers", "RTF", "Cost / audio h", "Error"],
      report.samples.map((row) => [
        row.sampleId,
        row.tags.join(", ") || DASH,
        row.provider,
        row.model ?? DASH,
        duration(row.durationMs),
        pct(row.wer),
        pct(row.cer),
        pct(row.latinWer),
        pct(row.termRecall),
        pct(row.der),
        row.speakers === null ? DASH : `${row.speakers} (${row.diarization ?? DASH})`,
        num(row.rtf, 3),
        usd(row.costPerHourUsd),
        row.error ?? "",
      ])
    ),
    "",
    "## Provider settings",
    ""
  )

  const settings = Object.entries(report.providerSettings)

  if (settings.length) {
    lines.push(
      table(
        ["Provider", "Settings"],
        settings.map(([provider, values]) => [
          provider,
          Object.entries(values)
            .map(([key, value]) => `\`${key}=${value}\``)
            .join(", ") || DASH,
        ])
      )
    )
  } else {
    lines.push("None recorded.")
  }

  lines.push(
    "",
    "## Method",
    "",
    "- Text normalization: NFKC, niqqud removed, geresh/gershayim/quotes inside words dropped, maqaf/hyphen/slash split words, other punctuation removed, lowercase.",
    "- Latin WER counts only tokens with Latin letters; term recall counts glossary-term occurrences in the reference reproduced in canonical form.",
    `- DER: 10 ms frames, ${report.collarMs} ms collar around reference boundaries, overlap counted per reference speaker, optimal (Hungarian) speaker mapping.`,
    "- RTF = processing time / audio duration. This report never contains transcript text.",
    ""
  )

  return lines.join("\n")
}
