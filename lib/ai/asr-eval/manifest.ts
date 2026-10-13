import path from "node:path"

/**
 * ASR eval manifest (M3 C3). Version 2 adds diarization references, tags and
 * per-sample glossaries; version 1 (`{samples}` without `version`) is still
 * accepted and upgraded. Real clips live outside the repo (default
 * `.secrets/asr-eval/manifest.json`); paths resolve relative to the manifest.
 */

export const DEFAULT_ASR_EVAL_MANIFEST_PATH = ".secrets/asr-eval/manifest.json"

export type AsrEvalSample = {
  id: string
  audioPath: string
  /** Plain-text reference transcript. */
  referencePath: string
  /** Reference speaker turns (RTTM, JSON or Audacity labels) for DER. */
  referenceTurnsPath?: string
  language: string
  tags: string[]
  /** Glossary JSON (`{version:1, terms}`) used for term recall. */
  glossaryPath?: string
  notes?: string
}

export type AsrEvalManifest = {
  version: 2
  /** True for checked-in synthetic fixtures (never real recordings). */
  synthetic: boolean
  samples: AsrEvalSample[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid ASR eval manifest: ${label} is required`)
  }

  return value.trim()
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined

  return requiredString(value, label)
}

function parseTags(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string" || !tag.trim())) {
    throw new Error(`Invalid ASR eval manifest: ${label} must be an array of strings`)
  }

  return [...new Set(value.map((tag: string) => tag.trim()))]
}

/** Validates a v1 or v2 manifest and returns it as v2. */
export function parseAsrEvalManifest(value: unknown): AsrEvalManifest {
  if (!isRecord(value)) throw new Error("Invalid ASR eval manifest: must be an object")

  const version = value.version ?? 1

  if (version !== 1 && version !== 2) {
    throw new Error(`Invalid ASR eval manifest: unsupported version ${String(version)}`)
  }
  if (!Array.isArray(value.samples) || value.samples.length === 0) {
    throw new Error("Invalid ASR eval manifest: samples must be a non-empty array")
  }

  const ids = new Set<string>()
  const samples = value.samples.map((raw, index): AsrEvalSample => {
    const label = `samples[${index}]`

    if (!isRecord(raw)) throw new Error(`Invalid ASR eval manifest: ${label} must be an object`)

    const id = requiredString(raw.id, `${label}.id`)

    if (ids.has(id)) throw new Error(`Invalid ASR eval manifest: duplicate sample id '${id}'`)
    ids.add(id)

    const sample: AsrEvalSample = {
      id,
      audioPath: requiredString(raw.audioPath, `${label}.audioPath`),
      referencePath: requiredString(raw.referencePath, `${label}.referencePath`),
      language: optionalString(raw.language, `${label}.language`) ?? "he",
      tags: version === 2 ? parseTags(raw.tags, `${label}.tags`) : [],
    }
    const notes = optionalString(raw.notes, `${label}.notes`)

    if (version === 2) {
      const turns = optionalString(raw.referenceTurnsPath, `${label}.referenceTurnsPath`)
      const glossary = optionalString(raw.glossaryPath, `${label}.glossaryPath`)

      if (turns) sample.referenceTurnsPath = turns
      if (glossary) sample.glossaryPath = glossary
    }
    if (notes) sample.notes = notes

    return sample
  })

  return { version: 2, synthetic: value._synthetic === true, samples }
}

/** Resolves a manifest-relative path. */
export function resolveManifestPath(manifestPath: string, value: string): string {
  return path.isAbsolute(value) ? value : path.join(path.dirname(path.resolve(manifestPath)), value)
}
