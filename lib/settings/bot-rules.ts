import { getBotConfig } from "@/lib/bot/config"
import {
  BOT_AUTO_JOIN_MODES,
  BOT_LANGUAGE_MODES,
  type BotAutoJoinMode,
  type BotLanguageMode,
  type BotRules,
  type BotRulesPatch,
  DEFAULT_BOT_RULES,
} from "@/lib/bot/types"
import { getDatabasePool } from "@/lib/db/client"

/**
 * Workspace bot auto-join rules, stored in workspace_settings(key='botRules')
 * with the same memory/postgres pattern as app-settings.ts / asr-glossary.ts
 * (M7 A4). Values are validated and clamped; auto-join cannot be enabled
 * until an admin acknowledges the recording-consent notice.
 */

export const BOT_RULES_SETTING_KEY = "botRules"

export const BOT_RULES_LIMITS = {
  joinLeadSeconds: { min: 0, max: 600 },
  minAttendees: { min: 1, max: 50 },
  botName: { min: 1, max: 60 },
  consentMessage: { min: 1, max: 500 },
  skipTitlePatterns: { maxItems: 20, maxChars: 100 },
  internalDomains: { maxItems: 50 },
} as const

export type BotRulesActor = { userId?: string; apiKeyId?: string }

export type BotRulesFieldError = { path: string; message: string }

/**
 * Route → 400: `{code:"consent_ack_required"}` or `{code:"validation_failed",
 * fields:{path: message}}` (the shape lib/bot/service.ts maps).
 */
export class BotRulesValidationError extends Error {
  readonly code: "validation_failed" | "consent_ack_required"
  readonly errors: BotRulesFieldError[]
  /** Per-field messages keyed by dotted path; absent for consent_ack_required. */
  readonly fields?: Record<string, string>

  constructor(code: BotRulesValidationError["code"], errors: BotRulesFieldError[]) {
    super(code === "consent_ack_required" ? "consent_ack_required" : "Invalid bot rules")
    this.name = "BotRulesValidationError"
    this.code = code
    this.errors = errors
    if (code === "validation_failed") {
      this.fields = Object.fromEntries(errors.map((error) => [error.path || "body", error.message]))
    }
  }
}

const URL_LIKE = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|co|il|us|me|app|ly|link|info|biz)\b)/i
const DOMAIN = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function defaults(): BotRules {
  return {
    ...DEFAULT_BOT_RULES,
    botName: getBotConfig().botName || DEFAULT_BOT_RULES.botName,
    consentMessage: { ...DEFAULT_BOT_RULES.consentMessage },
    skipTitlePatterns: [...DEFAULT_BOT_RULES.skipTitlePatterns],
    internalDomains: [...DEFAULT_BOT_RULES.internalDomains],
  }
}

function clone(rules: BotRules): BotRules {
  return {
    ...rules,
    consentMessage: { ...rules.consentMessage },
    skipTitlePatterns: [...rules.skipTitlePatterns],
    internalDomains: [...rules.internalDomains],
  }
}

function clampInt(value: unknown, path: string, limits: { min: number; max: number }, errors: BotRulesFieldError[]) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push({ path, message: "must be a number" })
    return undefined
  }

  return Math.min(limits.max, Math.max(limits.min, Math.round(value)))
}

function text(value: unknown, path: string, limits: { min: number; max: number }, errors: BotRulesFieldError[]) {
  if (typeof value !== "string") {
    errors.push({ path, message: "must be a string" })
    return undefined
  }

  const normalized = value.normalize("NFC").trim()

  if (normalized.length < limits.min || normalized.length > limits.max) {
    errors.push({ path, message: `must be ${limits.min}-${limits.max} characters` })
    return undefined
  }

  return normalized
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string, errors: BotRulesFieldError[]) {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T

  errors.push({ path, message: `must be one of ${allowed.join(", ")}` })
  return undefined
}

function consentMessage(value: unknown, path: string, errors: BotRulesFieldError[]) {
  const message = text(value, path, BOT_RULES_LIMITS.consentMessage, errors)

  if (message !== undefined && URL_LIKE.test(message)) {
    errors.push({ path, message: "must not contain URLs" })
    return undefined
  }

  return message
}

function stringList(
  value: unknown,
  path: string,
  maxItems: number,
  item: (raw: unknown, itemPath: string) => string | undefined,
  errors: BotRulesFieldError[]
) {
  if (!Array.isArray(value)) {
    errors.push({ path, message: "must be an array" })
    return undefined
  }
  if (value.length > maxItems) {
    errors.push({ path, message: `must have at most ${maxItems} items` })
    return undefined
  }

  const before = errors.length
  const result: string[] = []

  value.forEach((raw, index) => {
    const parsed = item(raw, `${path}.${index}`)

    if (parsed !== undefined && !result.includes(parsed)) result.push(parsed)
  })

  return errors.length > before ? undefined : result
}

function domain(raw: unknown, path: string, errors: BotRulesFieldError[]) {
  if (typeof raw !== "string") {
    errors.push({ path, message: "must be a string" })
    return undefined
  }

  const value = raw.trim().toLowerCase().replace(/^@/, "")

  if (!DOMAIN.test(value)) {
    errors.push({ path, message: "must be a domain" })
    return undefined
  }

  return value
}

/**
 * Validates a patch over `current` (unknown keys are ignored). Numbers are
 * clamped; wrong types, out-of-range text and URLs in consent messages are
 * field errors.
 */
export function applyBotRulesPatch(
  current: BotRules,
  patch: unknown,
  actor: BotRulesActor = {},
  now: Date = new Date()
): { ok: true; rules: BotRules } | { ok: false; error: BotRulesValidationError } {
  if (!isRecord(patch)) {
    return { ok: false, error: new BotRulesValidationError("validation_failed", [{ path: "", message: "must be an object" }]) }
  }

  const errors: BotRulesFieldError[] = []
  const next = clone(current)

  if (patch.autoJoin !== undefined) {
    const value = oneOf<BotAutoJoinMode>(patch.autoJoin, BOT_AUTO_JOIN_MODES, "autoJoin", errors)

    if (value) next.autoJoin = value
  }
  if (patch.joinLeadSeconds !== undefined) {
    const value = clampInt(patch.joinLeadSeconds, "joinLeadSeconds", BOT_RULES_LIMITS.joinLeadSeconds, errors)

    if (value !== undefined) next.joinLeadSeconds = value
  }
  if (patch.minAttendees !== undefined) {
    const value = clampInt(patch.minAttendees, "minAttendees", BOT_RULES_LIMITS.minAttendees, errors)

    if (value !== undefined) next.minAttendees = value
  }
  if (patch.botName !== undefined) {
    const value = text(patch.botName, "botName", BOT_RULES_LIMITS.botName, errors)

    if (value !== undefined) next.botName = value.replace(/\s+/g, " ")
  }
  if (patch.consentEnabled !== undefined) {
    if (typeof patch.consentEnabled === "boolean") next.consentEnabled = patch.consentEnabled
    else errors.push({ path: "consentEnabled", message: "must be a boolean" })
  }
  if (patch.consentMessage !== undefined) {
    if (!isRecord(patch.consentMessage)) {
      errors.push({ path: "consentMessage", message: "must be an object" })
    } else {
      for (const language of ["he", "en"] as const) {
        const raw = patch.consentMessage[language]

        if (raw === undefined) continue

        const value = consentMessage(raw, `consentMessage.${language}`, errors)

        if (value !== undefined) next.consentMessage[language] = value
      }
    }
  }
  if (patch.languageMode !== undefined) {
    const value = oneOf<BotLanguageMode>(patch.languageMode, BOT_LANGUAGE_MODES, "languageMode", errors)

    if (value) next.languageMode = value
  }
  if (patch.skipTitlePatterns !== undefined) {
    const { maxItems, maxChars } = BOT_RULES_LIMITS.skipTitlePatterns
    const value = stringList(
      patch.skipTitlePatterns,
      "skipTitlePatterns",
      maxItems,
      (raw, path) => text(raw, path, { min: 1, max: maxChars }, errors),
      errors
    )

    if (value) next.skipTitlePatterns = value
  }
  if (patch.internalDomains !== undefined) {
    const value = stringList(
      patch.internalDomains,
      "internalDomains",
      BOT_RULES_LIMITS.internalDomains.maxItems,
      (raw, path) => domain(raw, path, errors),
      errors
    )

    if (value) next.internalDomains = value
  }
  if (patch.acknowledgeConsent !== undefined && typeof patch.acknowledgeConsent !== "boolean") {
    errors.push({ path: "acknowledgeConsent", message: "must be a boolean" })
  }

  if (errors.length) return { ok: false, error: new BotRulesValidationError("validation_failed", errors) }

  if (patch.acknowledgeConsent === true) {
    next.consentAcknowledgedAt = now.toISOString()
    next.consentAcknowledgedByUserId = actor.userId ?? null
  }

  if (next.autoJoin !== "off" && !next.consentAcknowledgedAt) {
    return {
      ok: false,
      error: new BotRulesValidationError("consent_ack_required", [
        { path: "acknowledgeConsent", message: "recording consent must be acknowledged before enabling auto-join" },
      ]),
    }
  }

  return { ok: true, rules: next }
}

/** A stored value read tolerantly: invalid fields fall back to the defaults. */
export function parseStoredBotRules(value: unknown): BotRules {
  const base = defaults()

  if (!isRecord(value)) return base

  const { consentAcknowledgedAt, consentAcknowledgedByUserId, ...fields } = value
  let merged = clone(base)

  merged.consentAcknowledgedAt =
    typeof consentAcknowledgedAt === "string" && Number.isFinite(Date.parse(consentAcknowledgedAt))
      ? consentAcknowledgedAt
      : null
  merged.consentAcknowledgedByUserId =
    typeof consentAcknowledgedByUserId === "string" ? consentAcknowledgedByUserId : null

  for (const [key, field] of Object.entries(fields)) {
    // Without a stored acknowledgment an "on" autoJoin is rejected: stays off.
    const single = applyBotRulesPatch(merged, { [key]: field })

    if (single.ok) merged = single.rules
  }

  return merged
}

const memoryRules = new Map<string, BotRules>()

function usesPostgres(env: NodeJS.ProcessEnv = process.env) {
  return env.MEETSUM_STORAGE === "postgres"
}

/** The workspace's effective rules (defaults when unset; auto-join off). */
export async function getBotRules(workspaceId: string): Promise<BotRules> {
  if (!usesPostgres()) {
    const stored = memoryRules.get(workspaceId)

    return stored ? clone(stored) : defaults()
  }

  const result = await getDatabasePool().query(
    "select value from workspace_settings where workspace_id = $1 and key = $2",
    [workspaceId, BOT_RULES_SETTING_KEY]
  )
  const row = result.rows[0] as { value?: unknown } | undefined

  return parseStoredBotRules(row?.value)
}

/**
 * Validates, clamps and saves a patch. Enabling auto-join requires the
 * recording-consent acknowledgment (`consent_ack_required`); sending
 * `acknowledgeConsent: true` stamps the time and the actor.
 */
export async function updateBotRules(
  workspaceId: string,
  patch: BotRulesPatch | unknown,
  actor: BotRulesActor,
  options: { now?: Date } = {}
): Promise<BotRules> {
  const current = await getBotRules(workspaceId)
  const result = applyBotRulesPatch(current, patch, actor, options.now)

  if (!result.ok) throw result.error

  if (!usesPostgres()) {
    memoryRules.set(workspaceId, clone(result.rules))
    return clone(result.rules)
  }

  await getDatabasePool().query(
    `
      insert into workspace_settings (workspace_id, key, value, updated_at)
      values ($1, $2, $3::jsonb, now())
      on conflict (workspace_id, key) do update
        set value = excluded.value,
            updated_at = now()
    `,
    [workspaceId, BOT_RULES_SETTING_KEY, JSON.stringify(result.rules)]
  )

  return result.rules
}

/** Test helper: forget in-memory rules. */
export function resetBotRulesMemory() {
  memoryRules.clear()
}
