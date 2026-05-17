import { readFile } from "node:fs/promises"
import path from "node:path"

import { createGeminiClient, isGeminiConfigured } from "@/lib/ai/providers"
import { calculateWordErrorRate } from "@/lib/ai/asr-evaluation"

type EvalSample = {
  id: string
  audioPath: string
  referencePath: string
  language?: string
  notes?: string
}

type EvalManifest = {
  samples: EvalSample[]
}

type ProviderResult = {
  provider: string
  model: string
  text: string
  latencyMs: number
}

const DEFAULT_MANIFEST_PATH = ".secrets/asr-eval/manifest.json"

function parseArgs() {
  const manifestIndex = process.argv.indexOf("--manifest")

  return {
    manifestPath:
      manifestIndex >= 0
        ? process.argv[manifestIndex + 1]
        : process.env.MEETSUM_ASR_EVAL_MANIFEST ?? DEFAULT_MANIFEST_PATH,
  }
}

function requireString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid ASR eval manifest: ${label} is required`)
  }

  return value
}

async function loadManifest(manifestPath: string): Promise<{
  manifest: EvalManifest
  baseDir: string
}> {
  const absolutePath = path.resolve(manifestPath)
  const parsed = JSON.parse(await readFile(absolutePath, "utf8")) as EvalManifest

  if (!Array.isArray(parsed.samples) || parsed.samples.length === 0) {
    throw new Error("Invalid ASR eval manifest: samples must be a non-empty array")
  }

  parsed.samples = parsed.samples.map((sample, index) => ({
    id: requireString(sample.id, `samples[${index}].id`),
    audioPath: requireString(sample.audioPath, `samples[${index}].audioPath`),
    referencePath: requireString(
      sample.referencePath,
      `samples[${index}].referencePath`
    ),
    language: sample.language ?? "he",
    notes: sample.notes,
  }))

  return {
    manifest: parsed,
    baseDir: path.dirname(absolutePath),
  }
}

function resolveSamplePath(baseDir: string, value: string) {
  return path.isAbsolute(value) ? value : path.join(baseDir, value)
}

function getEnabledProviders() {
  const requested = process.env.MEETSUM_ASR_EVAL_PROVIDERS
    ?.split(",")
    .map((provider) => provider.trim())
    .filter(Boolean)

  if (requested?.length) return requested

  return [
    process.env.LOCAL_TRANSCRIPTION_URL ? "local-whisper" : undefined,
    isGeminiConfigured() ? "gemini" : undefined,
  ].filter((provider): provider is string => Boolean(provider))
}

function getMimeType(audioPath: string) {
  const extension = path.extname(audioPath).toLowerCase()

  if (extension === ".wav") return "audio/wav"
  if (extension === ".mp3") return "audio/mpeg"
  if (extension === ".m4a") return "audio/mp4"
  if (extension === ".mp4") return "video/mp4"
  if (extension === ".webm") return "audio/webm"

  return "application/octet-stream"
}

async function runLocalWhisper(sample: EvalSample, audioPath: string) {
  const baseUrl = process.env.LOCAL_TRANSCRIPTION_URL?.replace(/\/+$/, "")

  if (!baseUrl) {
    throw new Error("LOCAL_TRANSCRIPTION_URL is required for local-whisper eval")
  }

  const model =
    process.env.LOCAL_TRANSCRIPTION_MODEL ?? "ivrit-ai/whisper-large-v3-turbo-ct2"
  const startedAt = Date.now()
  const bytes = await readFile(audioPath)
  const formData = new FormData()

  formData.set("file", new Blob([bytes], { type: getMimeType(audioPath) }), path.basename(audioPath))
  formData.set("model", model)
  formData.set("language", sample.language ?? "he")
  formData.set("response_format", "json")

  const response = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
    method: "POST",
    body: formData,
  })

  if (!response.ok) {
    throw new Error(
      `local-whisper failed for ${sample.id}: ${response.status} ${await response.text()}`
    )
  }

  const contentType = response.headers.get("content-type") ?? ""
  const body = contentType.includes("application/json")
    ? ((await response.json()) as { text?: string })
    : { text: await response.text() }

  return {
    provider: "local-whisper",
    model,
    text: body.text?.trim() ?? "",
    latencyMs: Date.now() - startedAt,
  } satisfies ProviderResult
}

async function runGemini(sample: EvalSample, audioPath: string) {
  if (!isGeminiConfigured()) {
    throw new Error("Gemini is not configured for ASR eval")
  }

  const model = process.env.GOOGLE_GEMINI_AUDIO_MODEL ?? "gemini-2.5-flash"
  const startedAt = Date.now()
  const bytes = await readFile(audioPath)
  const ai = createGeminiClient()
  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [
          {
            text: [
              "Transcribe this meeting audio faithfully.",
              "Return only transcript text, no markdown, no summary.",
              `Language hint: ${sample.language ?? "he"}`,
            ].join("\n"),
          },
          {
            inlineData: {
              mimeType: getMimeType(audioPath),
              data: bytes.toString("base64"),
            },
          },
        ],
      },
    ],
  })

  return {
    provider: "gemini",
    model,
    text: response.text?.trim() ?? "",
    latencyMs: Date.now() - startedAt,
  } satisfies ProviderResult
}

async function runProvider(sample: EvalSample, audioPath: string, provider: string) {
  if (provider === "local-whisper") return runLocalWhisper(sample, audioPath)
  if (provider === "gemini") return runGemini(sample, audioPath)

  throw new Error(`Unsupported ASR eval provider: ${provider}`)
}

async function main() {
  const { manifestPath } = parseArgs()
  const { manifest, baseDir } = await loadManifest(manifestPath)
  const providers = getEnabledProviders()

  if (providers.length === 0) {
    throw new Error(
      "No ASR eval providers configured. Set LOCAL_TRANSCRIPTION_URL, GOOGLE_GEMINI_API_KEY, or MEETSUM_ASR_EVAL_PROVIDERS."
    )
  }

  const rows: Array<Record<string, string | number>> = []

  for (const sample of manifest.samples) {
    const audioPath = resolveSamplePath(baseDir, sample.audioPath)
    const referencePath = resolveSamplePath(baseDir, sample.referencePath)
    const reference = await readFile(referencePath, "utf8")

    for (const provider of providers) {
      const result = await runProvider(sample, audioPath, provider)
      const wer = calculateWordErrorRate(reference, result.text)

      rows.push({
        sample: sample.id,
        provider: result.provider,
        model: result.model,
        wer: Number(wer.wer.toFixed(4)),
        substitutions: wer.substitutions,
        insertions: wer.insertions,
        deletions: wer.deletions,
        referenceWords: wer.referenceWords,
        latencyMs: result.latencyMs,
      })
    }
  }

  console.table(rows)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
