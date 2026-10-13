import { BOT_PLATFORMS, type BotPlatform, DEFAULT_BOT_NAME } from "@/lib/bot/types"
import { VexaError } from "@/lib/bot/vexa/types"

/**
 * M7 bot configuration (docs/parity/m7.md "Env vars"). Owned by Package A.
 * With MEETSUM_BOT_ENABLED unset or false every bot surface is off: the bot
 * worker is not started, calendar hooks are no-ops, bot routes 404
 * `bot_disabled` (the webhook 503) and the UI hides bot controls.
 */

type Env = Record<string, string | undefined>

export type BotConfig = {
  enabled: boolean
  vexa: {
    apiUrl?: string
    apiKey?: string
    webhookSecret?: string
    webhookUrl?: string
    webhookAllowBearer: boolean
    webhookToleranceSeconds: number
    timeoutMs: number
    streamTimeoutMs: number
    version: string
  }
  botName: string
  accountEmail?: string
  platforms: BotPlatform[]
  authenticated: boolean
  calendarInvite: boolean
  internalDomains: string[]
  defaultLeadSeconds: number
  lateJoinMaxMinutes: number
  leftAloneMs: number
  awaitingAdmissionTimeoutMinutes: number
  transcribe: boolean
  maxConcurrent: number
  maxConcurrentPerWorkspace: number
  joinRatePerHour: number
  reconcileSeconds: number
  staleMinutes: number
  workerConcurrency: number
  finalizeAttempts: number
  artifactRetentionHours: number
  live: { enabled: boolean; pollMs: number; maxStreams: number }
}

function text(env: Env, name: string): string | undefined {
  const value = env[name]?.trim()

  return value ? value : undefined
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const value = text(env, name)?.toLowerCase()

  if (value === undefined) return fallback
  if (["1", "true", "yes", "on"].includes(value)) return true
  if (["0", "false", "no", "off"].includes(value)) return false
  return fallback
}

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
  const value = text(env, name)
  const parsed = value === undefined ? Number.NaN : Number(value)

  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

function list(env: Env, name: string): string[] {
  return (text(env, name) ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

function platforms(env: Env): BotPlatform[] {
  const raw = text(env, "MEETSUM_BOT_PLATFORMS")

  if (raw === undefined) return [...BOT_PLATFORMS]

  const allowed = new Set<string>(BOT_PLATFORMS)

  return [...new Set(list(env, "MEETSUM_BOT_PLATFORMS"))].filter(
    (item): item is BotPlatform => allowed.has(item)
  )
}

export function getBotConfig(env: Env = process.env): BotConfig {
  return {
    enabled: bool(env, "MEETSUM_BOT_ENABLED", false),
    vexa: {
      apiUrl: text(env, "VEXA_API_URL"),
      apiKey: text(env, "VEXA_API_KEY"),
      webhookSecret: text(env, "VEXA_WEBHOOK_SECRET"),
      webhookUrl: text(env, "VEXA_WEBHOOK_URL"),
      webhookAllowBearer: bool(env, "VEXA_WEBHOOK_ALLOW_BEARER", false),
      webhookToleranceSeconds: int(env, "VEXA_WEBHOOK_TOLERANCE_SECONDS", 300, 30, 3600),
      timeoutMs: int(env, "VEXA_TIMEOUT_MS", 10_000, 1_000, 120_000),
      streamTimeoutMs: int(env, "VEXA_STREAM_TIMEOUT_MS", 1_800_000, 10_000, 4 * 3_600_000),
      version: text(env, "VEXA_VERSION") ?? "0.12.28",
    },
    botName: (text(env, "MEETSUM_BOT_NAME") ?? DEFAULT_BOT_NAME).slice(0, 60),
    accountEmail: text(env, "MEETSUM_BOT_ACCOUNT_EMAIL")?.toLowerCase(),
    platforms: platforms(env),
    authenticated: bool(env, "MEETSUM_BOT_AUTHENTICATED", true),
    calendarInvite: bool(env, "MEETSUM_BOT_CALENDAR_INVITE", false),
    internalDomains: list(env, "MEETSUM_BOT_INTERNAL_DOMAINS"),
    defaultLeadSeconds: int(env, "MEETSUM_BOT_DEFAULT_LEAD_SECONDS", 60, 0, 600),
    lateJoinMaxMinutes: int(env, "MEETSUM_BOT_LATE_JOIN_MAX_MINUTES", 30, 0, 240),
    leftAloneMs: int(env, "MEETSUM_BOT_LEFT_ALONE_MS", 600_000, 60_000, 4 * 3_600_000),
    awaitingAdmissionTimeoutMinutes: int(
      env,
      "MEETSUM_BOT_AWAITING_ADMISSION_TIMEOUT_MINUTES",
      15,
      1,
      120
    ),
    transcribe: bool(env, "MEETSUM_BOT_TRANSCRIBE", false),
    maxConcurrent: int(env, "MEETSUM_BOT_MAX_CONCURRENT", 2, 1, 100),
    maxConcurrentPerWorkspace: int(env, "MEETSUM_BOT_MAX_CONCURRENT_PER_WORKSPACE", 2, 1, 100),
    joinRatePerHour: int(env, "MEETSUM_BOT_JOIN_RATE_PER_HOUR", 20, 1, 1000),
    reconcileSeconds: int(env, "MEETSUM_BOT_RECONCILE_SECONDS", 120, 15, 3600),
    staleMinutes: int(env, "MEETSUM_BOT_STALE_MINUTES", 10, 1, 240),
    workerConcurrency: int(env, "MEETSUM_BOT_WORKER_CONCURRENCY", 4, 1, 32),
    finalizeAttempts: int(env, "MEETSUM_BOT_FINALIZE_ATTEMPTS", 8, 1, 50),
    artifactRetentionHours: int(env, "MEETSUM_VEXA_ARTIFACT_RETENTION_HOURS", 72, 1, 24 * 90),
    live: {
      enabled: bool(env, "MEETSUM_LIVE_TRANSCRIPT", false),
      pollMs: int(env, "MEETSUM_LIVE_POLL_MS", 2000, 500, 60_000),
      maxStreams: int(env, "MEETSUM_LIVE_MAX_STREAMS", 20, 1, 1000),
    },
  }
}

export function isBotEnabled(env: Env = process.env): boolean {
  return bool(env, "MEETSUM_BOT_ENABLED", false)
}

/**
 * Validates the Vexa connection settings (boot-time check, A1/SSRF rules):
 * an http(s) base URL with no userinfo, query or fragment, and an API key of
 * at least 16 characters. Throws VexaError("config") without echoing values.
 */
export function assertVexaConfig(config: BotConfig = getBotConfig()): {
  baseUrl: string
  apiKey: string
} {
  const { apiUrl, apiKey } = config.vexa

  if (!apiUrl) throw new VexaError("config", "VEXA_API_URL is not set")

  let url: URL

  try {
    url = new URL(apiUrl)
  } catch {
    throw new VexaError("config", "VEXA_API_URL is not a valid URL")
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new VexaError("config", "VEXA_API_URL must use http or https")
  }
  if (url.username || url.password) {
    throw new VexaError("config", "VEXA_API_URL must not contain credentials")
  }
  if (url.search || url.hash || apiUrl.includes("?") || apiUrl.includes("#")) {
    throw new VexaError("config", "VEXA_API_URL must not contain a query or fragment")
  }
  if (!apiKey || apiKey.length < 16) {
    throw new VexaError("config", "VEXA_API_KEY must be at least 16 characters")
  }

  return { baseUrl: url.toString().replace(/\/+$/, ""), apiKey }
}
