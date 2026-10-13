import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

import { DEFAULT_ASR_GLOSSARY, transcribeWithRouter } from "@/lib/ai/asr"
import type { AsrGlossary, AsrProviderId, AsrRequest, AsrResult } from "@/lib/ai/asr/types"
import {
  DEFAULT_DER_COLLAR_MS,
  detectTurnsFormat,
  parseTurns,
  type SpeakerTurn,
} from "@/lib/ai/asr-eval/der"
import {
  DEFAULT_ASR_EVAL_MANIFEST_PATH,
  parseAsrEvalManifest,
  resolveManifestPath,
  type AsrEvalSample,
} from "@/lib/ai/asr-eval/manifest"
import {
  buildAsrEvalReport,
  evaluateSample,
  type AsrEvalReport,
  type SampleMetrics,
} from "@/lib/ai/asr-eval/report"
import { parseAsrGlossary } from "@/lib/settings/asr-glossary"

/** Orchestration for `scripts/evaluate-hebrew-asr.ts` (M3 C4). */

export type EvalEnv = Record<string, string | undefined>

export const DEFAULT_EVAL_PROVIDERS: AsrProviderId[] = [
  "runpod-ivrit",
  "soniox",
  "local-whisper-chunked",
]

export type AsrEvalOptions = {
  manifestPath: string
  providers?: string[]
  sample?: string
  collarMs: number
  replayDir?: string
  outputJson?: string
  outputMd?: string
}

export type AsrEvalDeps = {
  env?: EvalEnv
  now?: () => Date
  gitSha?: () => string | null
  transcribe?: (provider: string, request: AsrRequest) => Promise<AsrResult>
}

/** Non-secret settings per provider that are worth recording in a report. */
const PROVIDER_SETTING_KEYS: Record<string, string[]> = {
  "runpod-ivrit": [
    "RUNPOD_ASR_WORKER",
    "RUNPOD_ASR_MODEL",
    "RUNPOD_ASR_MODEL_MULTILINGUAL",
    "RUNPOD_ASR_ENGINE",
  ],
  soniox: ["SONIOX_MODEL"],
  "local-whisper-chunked": ["LOCAL_TRANSCRIPTION_MODEL", "LOCAL_TRANSCRIPTION_CHUNK_MS"],
  "gemini-legacy": ["GOOGLE_GEMINI_AUDIO_MODEL"],
}
const COMMON_SETTING_KEYS = ["MEETSUM_ASR_HOTWORDS_MAX_CHARS", "MEETSUM_ASR_USE_INITIAL_PROMPT"]

function flag(argv: string[], name: string) {
  const index = argv.indexOf(name)

  if (index < 0) return undefined

  const value = argv[index + 1]

  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`)
  }

  return value
}

function list(value: string | undefined) {
  const items = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean)

  return items?.length ? items : undefined
}

export function parseAsrEvalArgs(
  argv: string[],
  env: EvalEnv = process.env
): AsrEvalOptions {
  const replayDir = flag(argv, "--replay")
  const collar = flag(argv, "--collar")
  const collarMs = collar === undefined ? DEFAULT_DER_COLLAR_MS : Number(collar)

  if (!Number.isFinite(collarMs) || collarMs < 0) {
    throw new Error("--collar must be a non-negative number of milliseconds")
  }

  const replayManifest = replayDir ? path.join(replayDir, "manifest.json") : undefined
  const manifestPath =
    flag(argv, "--manifest") ??
    (replayManifest && existsSync(replayManifest) ? replayManifest : undefined) ??
    env.MEETSUM_ASR_EVAL_MANIFEST ??
    DEFAULT_ASR_EVAL_MANIFEST_PATH

  return {
    manifestPath,
    providers: list(flag(argv, "--providers")) ?? list(env.MEETSUM_ASR_EVAL_PROVIDERS),
    sample: flag(argv, "--sample"),
    collarMs,
    replayDir,
    outputJson: flag(argv, "--output-json") ?? flag(argv, "--output"),
    outputMd: flag(argv, "--output-md"),
  }
}

function contentType(audioPath: string) {
  const extension = path.extname(audioPath).toLowerCase()
  const types: Record<string, string> = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".mp4": "video/mp4",
    ".webm": "audio/webm",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".flac": "audio/flac",
  }

  return types[extension] ?? "application/octet-stream"
}

async function loadGlossary(manifestPath: string, sample: AsrEvalSample): Promise<AsrGlossary> {
  if (!sample.glossaryPath) return DEFAULT_ASR_GLOSSARY

  const parsed = parseAsrGlossary(
    JSON.parse(await readFile(resolveManifestPath(manifestPath, sample.glossaryPath), "utf8"))
  )

  if (!parsed.ok) {
    throw new Error(
      `Invalid glossary for sample '${sample.id}': ${parsed.errors
        .map((error) => `${error.path} ${error.message}`)
        .join("; ")}`
    )
  }

  return parsed.glossary
}

async function loadTurns(manifestPath: string, sample: AsrEvalSample): Promise<SpeakerTurn[] | undefined> {
  if (!sample.referenceTurnsPath) return undefined

  const file = resolveManifestPath(manifestPath, sample.referenceTurnsPath)
  const text = await readFile(file, "utf8")

  return parseTurns(text, detectTurnsFormat(file, text))
}

type ReplayEntry = { result?: AsrResult; error?: Error; synthetic: boolean }

/** Replay files are `<replayDir>/<sampleId>.<provider>.json`. */
async function replayProviders(replayDir: string, samples: AsrEvalSample[]) {
  const files = await readdir(replayDir)
  const providers = new Set<string>()

  for (const sample of samples) {
    for (const file of files) {
      if (file.startsWith(`${sample.id}.`) && file.endsWith(".json")) {
        providers.add(file.slice(sample.id.length + 1, -".json".length))
      }
    }
  }

  return [...providers].sort()
}

async function readReplay(replayDir: string, sampleId: string, provider: string): Promise<ReplayEntry> {
  const file = path.join(replayDir, `${sampleId}.${provider}.json`)

  if (!existsSync(file)) {
    return { error: new Error(`no recorded result for ${provider}`), synthetic: false }
  }

  const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
  const synthetic = raw._synthetic === true

  if (raw.error && typeof raw.error === "object") {
    const recorded = raw.error as { kind?: string; message?: string }
    const error = Object.assign(new Error(recorded.message ?? "recorded failure"), {
      kind: recorded.kind ?? "unknown",
    })

    return { error, synthetic }
  }

  return { result: raw as unknown as AsrResult, synthetic }
}

function defaultTranscribe(env: EvalEnv) {
  return (provider: string, request: AsrRequest) =>
    transcribeWithRouter(request, {
      // One-provider chain: measure each provider on its own, no fallback.
      env: { ...env, MEETSUM_ASR_CHAIN: provider, MEETSUM_ASR_CHAIN_NON_HE: provider } as unknown as NodeJS.ProcessEnv,
    })
}

function readGitSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() || null
  } catch {
    return null
  }
}

function providerSettings(
  providers: string[],
  rows: SampleMetrics[],
  env: EvalEnv,
  live: boolean
) {
  return Object.fromEntries(
    providers.map((provider) => {
      const settings: Record<string, string> = {}
      const models = [
        ...new Set(rows.filter((row) => row.provider === provider && row.model).map((row) => row.model)),
      ]

      if (models.length) settings.model = models.join(" / ")
      if (live) {
        for (const key of [...(PROVIDER_SETTING_KEYS[provider] ?? []), ...COMMON_SETTING_KEYS]) {
          const value = env[key]

          if (value) settings[key] = value
        }
      }

      return [provider, settings]
    })
  )
}

export async function runAsrEvaluation(
  options: AsrEvalOptions,
  deps: AsrEvalDeps = {}
): Promise<AsrEvalReport> {
  const env = deps.env ?? process.env
  const manifestBytes = await readFile(path.resolve(options.manifestPath))
  const manifest = parseAsrEvalManifest(JSON.parse(manifestBytes.toString("utf8")))
  const samples = options.sample
    ? manifest.samples.filter((sample) => sample.id === options.sample)
    : manifest.samples

  if (!samples.length) {
    throw new Error(
      options.sample ? `Sample '${options.sample}' not found in manifest` : "No samples in manifest"
    )
  }

  const providers =
    options.providers ??
    (options.replayDir ? await replayProviders(options.replayDir, samples) : DEFAULT_EVAL_PROVIDERS)

  if (!providers.length) throw new Error("No ASR eval providers selected")

  const transcribe = deps.transcribe ?? defaultTranscribe(env)
  const rows: SampleMetrics[] = []
  let synthetic = manifest.synthetic

  for (const sample of samples) {
    const reference = await readFile(resolveManifestPath(options.manifestPath, sample.referencePath), "utf8")
    const referenceTurns = await loadTurns(options.manifestPath, sample)
    const glossary = await loadGlossary(options.manifestPath, sample)
    const glossaryTerms = glossary.terms.map((term) => term.term)

    for (const provider of providers) {
      let result: AsrResult | undefined
      let error: unknown
      let elapsedMs: number | undefined

      if (options.replayDir) {
        const replay = await readReplay(options.replayDir, sample.id, provider)

        result = replay.result
        error = replay.error
        synthetic ||= replay.synthetic
      } else {
        const startedAt = Date.now()

        try {
          const audioPath = resolveManifestPath(options.manifestPath, sample.audioPath)

          result = await transcribe(provider, {
            language: sample.language,
            media: { kind: "file", path: audioPath, contentType: contentType(audioPath) },
            glossary,
            diarize: true,
          })
        } catch (caught) {
          error = caught
        }
        elapsedMs = Date.now() - startedAt
      }

      rows.push(
        evaluateSample({
          sample,
          provider,
          reference,
          referenceTurns,
          glossaryTerms,
          collarMs: options.collarMs,
          result,
          error,
          elapsedMs,
        })
      )
    }
  }

  return buildAsrEvalReport(
    {
      generatedAt: (deps.now?.() ?? new Date()).toISOString(),
      gitSha: (deps.gitSha ?? readGitSha)(),
      manifestPath: options.manifestPath.split(path.sep).join("/"),
      manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
      mode: options.replayDir ? "replay" : "live",
      synthetic,
      collarMs: options.collarMs,
      replayDir: options.replayDir?.split(path.sep).join("/"),
      providerSettings: providerSettings(providers, rows, env, !options.replayDir),
    },
    samples,
    rows
  )
}
