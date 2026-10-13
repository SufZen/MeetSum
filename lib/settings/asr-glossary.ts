import { DEFAULT_ASR_GLOSSARY } from "@/lib/ai/asr/default-glossary"
import { getDatabasePool } from "@/lib/db/client"
import type { AsrGlossary, GlossaryTerm } from "@/lib/ai/asr/types"

/**
 * Workspace ASR glossary, stored as `workspace_settings.asrGlossary` (M3) and
 * merged over the built-in DEFAULT_ASR_GLOSSARY.
 */

export const ASR_GLOSSARY_SETTING_KEY = "asrGlossary"

export const ASR_GLOSSARY_LIMITS = {
  maxTerms: 300,
  maxChars: 64,
  maxAliases: 10,
} as const

export type AsrGlossaryFieldError = {
  /** Dotted path of the offending field, e.g. `terms.3.aliases.1`. */
  path: string
  message: string
}

export type ParseAsrGlossaryResult =
  | { ok: true; glossary: AsrGlossary }
  | { ok: false; errors: AsrGlossaryFieldError[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseText(
  value: unknown,
  path: string,
  errors: AsrGlossaryFieldError[]
): string | undefined {
  if (typeof value !== "string") {
    errors.push({ path, message: "must be a string" })
    return undefined
  }

  const text = value.normalize("NFC").trim().replace(/\s+/gu, " ")

  if (!text) {
    errors.push({ path, message: "must not be empty" })
    return undefined
  }
  if (text.length > ASR_GLOSSARY_LIMITS.maxChars) {
    errors.push({
      path,
      message: `must be at most ${ASR_GLOSSARY_LIMITS.maxChars} characters`,
    })
    return undefined
  }

  return text
}

function parseTerm(
  value: unknown,
  path: string,
  errors: AsrGlossaryFieldError[]
): GlossaryTerm | undefined {
  if (!isRecord(value)) {
    errors.push({ path, message: "must be an object" })
    return undefined
  }

  const before = errors.length
  const term = parseText(value.term, `${path}.term`, errors)
  const aliases: string[] = []
  const rawAliases = value.aliases ?? []

  if (!Array.isArray(rawAliases)) {
    errors.push({ path: `${path}.aliases`, message: "must be an array" })
  } else if (rawAliases.length > ASR_GLOSSARY_LIMITS.maxAliases) {
    errors.push({
      path: `${path}.aliases`,
      message: `must have at most ${ASR_GLOSSARY_LIMITS.maxAliases} aliases`,
    })
  } else {
    rawAliases.forEach((alias, index) => {
      const text = parseText(alias, `${path}.aliases.${index}`, errors)

      if (text && text !== term && !aliases.includes(text)) aliases.push(text)
    })
  }

  const hotword = value.hotword ?? true

  if (typeof hotword !== "boolean") {
    errors.push({ path: `${path}.hotword`, message: "must be a boolean" })
  }
  if (value.caseSensitive !== undefined && typeof value.caseSensitive !== "boolean") {
    errors.push({ path: `${path}.caseSensitive`, message: "must be a boolean" })
  }
  if (errors.length > before || !term) return undefined

  const parsed: GlossaryTerm = { term, aliases, hotword: hotword as boolean }

  if (value.caseSensitive !== undefined) parsed.caseSensitive = value.caseSensitive as boolean
  return parsed
}

/**
 * Validates a glossary payload: `{version: 1, terms: [{term, aliases[],
 * hotword, caseSensitive?}]}` with at most 300 terms, 64 characters per
 * term/alias and 10 aliases per term. Strings are trimmed and
 * whitespace-collapsed; duplicate aliases are dropped; duplicate terms
 * (case-insensitive) are errors. `version` and `hotword` default to 1/true.
 */
export function parseAsrGlossary(value: unknown): ParseAsrGlossaryResult {
  const errors: AsrGlossaryFieldError[] = []

  if (!isRecord(value)) {
    return { ok: false, errors: [{ path: "", message: "must be an object" }] }
  }
  if (value.version !== undefined && value.version !== 1) {
    errors.push({ path: "version", message: "must be 1" })
  }
  if (!Array.isArray(value.terms)) {
    errors.push({ path: "terms", message: "must be an array" })
    return { ok: false, errors }
  }
  if (value.terms.length > ASR_GLOSSARY_LIMITS.maxTerms) {
    errors.push({
      path: "terms",
      message: `must have at most ${ASR_GLOSSARY_LIMITS.maxTerms} terms`,
    })
    return { ok: false, errors }
  }

  const terms: GlossaryTerm[] = []
  const seen = new Set<string>()

  value.terms.forEach((raw, index) => {
    const term = parseTerm(raw, `terms.${index}`, errors)

    if (!term) return

    const key = term.term.toLocaleLowerCase()

    if (seen.has(key)) {
      errors.push({ path: `terms.${index}.term`, message: "is a duplicate" })
      return
    }

    seen.add(key)
    terms.push(term)
  })

  return errors.length ? { ok: false, errors } : { ok: true, glossary: { version: 1, terms } }
}

/** Raised by `updateAsrGlossary` for an invalid payload (route → 400). */
export class AsrGlossaryValidationError extends Error {
  readonly errors: AsrGlossaryFieldError[]

  constructor(errors: AsrGlossaryFieldError[]) {
    super("Invalid ASR glossary")
    this.name = "AsrGlossaryValidationError"
    this.errors = errors
  }
}

function cloneGlossary(glossary: AsrGlossary): AsrGlossary {
  return {
    version: 1,
    terms: glossary.terms.map((term) => ({ ...term, aliases: [...term.aliases] })),
  }
}

const EMPTY_GLOSSARY: AsrGlossary = { version: 1, terms: [] }

/** In-memory (non-postgres) workspace glossaries, keyed by workspace id. */
const memoryGlossaries = new Map<string, AsrGlossary>()

function usesPostgres(env: NodeJS.ProcessEnv = process.env) {
  return env.MEETSUM_STORAGE === "postgres"
}

/**
 * Defaults first, then workspace terms: a workspace term replaces the default
 * with the same term (case-insensitive) in place; new terms are appended.
 */
export function mergeWorkspaceGlossary(
  defaults: AsrGlossary,
  workspace: AsrGlossary
): AsrGlossary {
  const terms: GlossaryTerm[] = defaults.terms.map((term) => ({
    ...term,
    aliases: [...term.aliases],
  }))
  const index = new Map(terms.map((term, position) => [term.term.toLocaleLowerCase(), position]))

  for (const term of workspace.terms) {
    const key = term.term.toLocaleLowerCase()
    const copy = { ...term, aliases: [...term.aliases] }
    const position = index.get(key)

    if (position === undefined) {
      index.set(key, terms.length)
      terms.push(copy)
    } else {
      terms[position] = copy
    }
  }

  return { version: 1, terms }
}

/**
 * The workspace's own glossary setting (without defaults). A stored value
 * that no longer validates is ignored (empty), never fatal for ASR.
 */
export async function getWorkspaceAsrGlossary(workspaceId: string): Promise<AsrGlossary> {
  if (!usesPostgres()) {
    return cloneGlossary(memoryGlossaries.get(workspaceId) ?? EMPTY_GLOSSARY)
  }

  const result = await getDatabasePool().query(
    "select value from workspace_settings where workspace_id = $1 and key = $2",
    [workspaceId, ASR_GLOSSARY_SETTING_KEY]
  )
  const row = result.rows[0] as { value?: unknown } | undefined

  if (!row) return cloneGlossary(EMPTY_GLOSSARY)

  const parsed = parseAsrGlossary(row.value)

  return parsed.ok ? parsed.glossary : cloneGlossary(EMPTY_GLOSSARY)
}

/** Effective glossary of a workspace: DEFAULT_ASR_GLOSSARY merged with its setting. */
export async function getAsrGlossary(workspaceId: string): Promise<AsrGlossary> {
  return mergeWorkspaceGlossary(DEFAULT_ASR_GLOSSARY, await getWorkspaceAsrGlossary(workspaceId))
}

/**
 * Validates and stores a workspace glossary (`workspace_settings.asrGlossary`).
 * Throws AsrGlossaryValidationError with field errors when invalid. Returns
 * the stored (normalized) workspace glossary.
 */
export async function updateAsrGlossary(
  workspaceId: string,
  glossary: unknown
): Promise<AsrGlossary> {
  const parsed = parseAsrGlossary(glossary)

  if (!parsed.ok) throw new AsrGlossaryValidationError(parsed.errors)

  if (!usesPostgres()) {
    memoryGlossaries.set(workspaceId, cloneGlossary(parsed.glossary))
    return cloneGlossary(parsed.glossary)
  }

  await getDatabasePool().query(
    `
      insert into workspace_settings (workspace_id, key, value, updated_at)
      values ($1, $2, $3::jsonb, now())
      on conflict (workspace_id, key) do update
        set value = excluded.value,
            updated_at = now()
    `,
    [workspaceId, ASR_GLOSSARY_SETTING_KEY, JSON.stringify(parsed.glossary)]
  )

  return parsed.glossary
}
