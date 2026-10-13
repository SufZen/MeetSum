import { z } from "zod"

import { assertVexaConfig, getBotConfig } from "@/lib/bot/config"
import { redactBotError, scrubSecrets } from "@/lib/bot/redact"
import { BOT_PLATFORMS, type BotPlatform } from "@/lib/bot/types"
import {
  type BotChatResult,
  type BotProvider,
  VexaError,
  type VexaActiveBot,
  type VexaBotRequest,
  type VexaBotResult,
  type VexaClientOptions,
  type VexaErrorKind,
  type VexaMeeting,
  type VexaRecording,
  type VexaRecordingMaster,
  type VexaServiceProvenance,
  type VexaTranscript,
  type VexaTranscriptSegment,
  type VexaWebhookConfig,
  type VexaWebhookInfo,
} from "@/lib/bot/vexa/types"

export { VexaError } from "@/lib/bot/vexa/types"
export type { BotProvider, VexaClientOptions } from "@/lib/bot/vexa/types"

/**
 * Vexa v0.12.28 HTTP client (M7 Package A1), the only module under lib/bot
 * that calls fetch. SSRF rules: the base URL comes only from env (validated by
 * assertVexaConfig), paths are built from validated enums/regexes, fetch uses
 * `redirect:"error"`, and no URL taken from a response is ever fetched
 * (`raw_url` is surfaced only when it is on the base URL's origin).
 */

export const VEXA_NATIVE_ID_PATTERN = /^[A-Za-z0-9:._@%-]{3,300}$/
const VEXA_ID_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/
const BODY_PREVIEW = 300
const BASE_BACKOFF_MS = 500
const MAX_RETRY_AFTER_MS = 30_000
const CONCURRENCY_BODY = /concurren|max(?:imum)?[ _-]?(?:concurrent|bots|running)|bot limit|limit (?:reached|exceeded)|capacity|too many/i

const idValue = z.union([z.string(), z.number()]).transform((value) => String(value))
const optionalText = z.string().nullish().transform((value) => value ?? undefined)
const optionalNumber = z.number().nullish().transform((value) => value ?? undefined)

const botResponseSchema = z.looseObject({
  id: idValue.nullish(),
  meeting_id: idValue.nullish(),
  status: optionalText,
  meeting: z.looseObject({ id: idValue.nullish(), status: optionalText }).nullish(),
})

const provenanceSchema = z
  .looseObject({
    bot_admitted_at: optionalText,
    bot_departed_at: optionalText,
    bot_outcome: optionalText,
    transcription_provider: optionalText,
    lifecycle_contract_version: z.union([z.string(), z.number()]).nullish(),
  })
  .nullish()

const mediaSchema = z.looseObject({
  id: idValue,
  type: optionalText,
  media_type: optionalText,
  format: optionalText,
  content_type: optionalText,
  file_size_bytes: optionalNumber,
  size_bytes: optionalNumber,
  duration_seconds: optionalNumber,
})

const recordingSchema = z.looseObject({
  id: idValue,
  status: optionalText,
  started_at: optionalText,
  created_at: optionalText,
  media_files: z.array(mediaSchema).nullish(),
  media: z.array(mediaSchema).nullish(),
})

const meetingSchema = z.looseObject({
  id: idValue,
  platform: z.string(),
  native_meeting_id: z.string(),
  status: z.string(),
  start_time: optionalText,
  end_time: optionalText,
  constructed_meeting_url: optionalText,
  recordings: z.array(recordingSchema).nullish(),
  reason: optionalText,
  data: z
    .looseObject({
      service_provenance: provenanceSchema,
      reason: optionalText,
      completion_reason: optionalText,
      failure_reason: optionalText,
      error: z.unknown().optional(),
    })
    .nullish(),
})

const runningBotSchema = z.looseObject({
  platform: optionalText,
  native_meeting_id: optionalText,
  meeting_id: idValue.nullish(),
  id: idValue.nullish(),
  status: optionalText,
})

const botStatusSchema = z.looseObject({
  running_bots: z.array(runningBotSchema).nullish(),
  running: z.unknown().optional(),
  count: z.number().nullish(),
})

const masterSchema = z.looseObject({
  raw_url: optionalText,
  media_id: idValue.nullish(),
  media_file_id: idValue.nullish(),
})

const segmentSchema = z.looseObject({
  segment_id: idValue.nullish(),
  id: idValue.nullish(),
  speaker: optionalText,
  text: z.string().nullish(),
  start: z.number().nullish(),
  end: z.number().nullish(),
  start_time: z.number().nullish(),
  end_time: z.number().nullish(),
  absolute_start_time: optionalText,
  language: optionalText,
  completed: z.boolean().nullish(),
  confidence: optionalNumber,
  words: z
    .array(
      z.looseObject({
        word: z.string(),
        start: z.number(),
        end: z.number(),
        probability: optionalNumber,
      })
    )
    .nullish(),
})

const transcriptSchema = z.looseObject({
  id: idValue.nullish(),
  segments: z.array(segmentSchema).nullish(),
})

const webhookSchema = z.looseObject({
  webhook_url: optionalText,
  url: optionalText,
  webhook_events: z.record(z.string(), z.boolean()).nullish(),
  events: z.record(z.string(), z.boolean()).nullish(),
  webhook_secret_configured: z.boolean().nullish(),
  has_secret: z.boolean().nullish(),
  webhook_secret: z.unknown().optional(),
})

const healthSchema = z.looseObject({ version: optionalText })

type RequestOptions = {
  body?: unknown
  retry?: boolean
  timeoutMs?: number
  signal?: AbortSignal
  /** Statuses returned to the caller instead of thrown. */
  allow?: number[]
  /** Extra literal secrets to scrub from error text (passcode, webhook secret). */
  secrets?: (string | undefined)[]
}

function assertPlatform(platform: string): asserts platform is BotPlatform {
  if (!(BOT_PLATFORMS as readonly string[]).includes(platform)) {
    throw new VexaError("invalid", "unsupported platform")
  }
}

function nativeIdSegment(nativeMeetingId: string): string {
  if (!VEXA_NATIVE_ID_PATTERN.test(nativeMeetingId)) {
    throw new VexaError("invalid", "invalid native meeting id")
  }
  return encodeURIComponent(nativeMeetingId)
}

function idSegment(id: string, label: string): string {
  if (!VEXA_ID_PATTERN.test(id)) throw new VexaError("invalid", `invalid ${label}`)
  return encodeURIComponent(id)
}

function errorName(error: unknown) {
  return error instanceof Error || (typeof DOMException !== "undefined" && error instanceof DOMException)
    ? error.name
    : ""
}

function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined

  const seconds = Number(value)

  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_RETRY_AFTER_MS, seconds * 1000)

  const date = Date.parse(value)

  return Number.isFinite(date) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - now)) : undefined
}

function errorCode(body: string): string | undefined {
  if (/auth_session_missing/i.test(body)) return "auth_session_missing"
  if (/zoom_requires_rtms/i.test(body)) return "zoom_requires_rtms"

  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const candidate = parsed.code ?? parsed.error_code ?? parsed.error

    return typeof candidate === "string" && /^[a-z0-9_.-]{1,64}$/i.test(candidate) ? candidate : undefined
  } catch {
    return undefined
  }
}

function classify(status: number, body: string): VexaErrorKind {
  if (status === 401) return "auth"
  if (status === 403) return CONCURRENCY_BODY.test(body) ? "capacity" : "auth"
  if (status === 429) return "capacity"
  if (status === 409) return "conflict"
  if (status === 400 || status === 422) return "invalid"
  if (status === 404) return "not_found"
  if (status === 503) return /TRANSCRIPTION_SERVICE|transcription service|no stt|stt backend/i.test(body) ? "config" : "unavailable"
  if (status >= 500) return "unavailable"
  return "bad_response"
}

function sameOrigin(candidate: string | undefined, origin: string): string | undefined {
  if (!candidate) return undefined

  try {
    const url = new URL(candidate, origin)

    return url.origin === origin && !url.username && !url.password ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function toPlatform(value: string | undefined): BotPlatform | undefined {
  return value && (BOT_PLATFORMS as readonly string[]).includes(value) ? (value as BotPlatform) : undefined
}

function toProvenance(value: z.infer<typeof provenanceSchema>): VexaServiceProvenance | undefined {
  if (!value) return undefined

  return {
    botAdmittedAt: value.bot_admitted_at,
    botDepartedAt: value.bot_departed_at,
    botOutcome: value.bot_outcome,
    transcriptionProvider: value.transcription_provider,
    lifecycleContractVersion:
      value.lifecycle_contract_version === null || value.lifecycle_contract_version === undefined
        ? undefined
        : String(value.lifecycle_contract_version),
  }
}

function toRecording(value: z.infer<typeof recordingSchema>): VexaRecording {
  return {
    id: value.id,
    status: value.status,
    startedAt: value.started_at ?? value.created_at,
    media: (value.media_files ?? value.media ?? []).map((media) => ({
      id: media.id,
      type: media.type ?? media.media_type,
      format: media.format,
      contentType: media.content_type,
      sizeBytes: media.file_size_bytes ?? media.size_bytes,
      durationSeconds: media.duration_seconds,
    })),
  }
}

function toSegment(value: z.infer<typeof segmentSchema>, index: number): VexaTranscriptSegment {
  return {
    segmentId: value.segment_id ?? value.id ?? String(index),
    speaker: value.speaker,
    text: value.text ?? "",
    start: value.start ?? value.start_time ?? 0,
    end: value.end ?? value.end_time ?? value.start ?? value.start_time ?? 0,
    absoluteStartTime: value.absolute_start_time,
    language: value.language,
    completed: value.completed ?? undefined,
    confidence: value.confidence,
    words: value.words?.map((word) => ({
      word: word.word,
      start: word.start,
      end: word.end,
      probability: word.probability,
    })),
  }
}

/** Reads a non-OK body, bounded, for classification and a redacted preview. */
async function readBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 4000)
  } catch {
    return ""
  }
}

export function createVexaClient(options: VexaClientOptions): BotProvider {
  let base: URL

  try {
    base = new URL(options.baseUrl)
  } catch {
    throw new VexaError("config", "invalid Vexa base URL")
  }
  if (
    (base.protocol !== "http:" && base.protocol !== "https:") ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new VexaError("config", "invalid Vexa base URL")
  }
  if (!options.apiKey || options.apiKey.length < 16) {
    throw new VexaError("config", "invalid Vexa API key")
  }

  const origin = base.origin
  const prefix = base.pathname.replace(/\/+$/, "")
  const apiKey = options.apiKey
  const fetchImpl = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 10_000
  const streamTimeoutMs = options.streamTimeoutMs ?? 1_800_000
  const retries = Math.max(0, options.retries ?? 2)
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  function redact(text: string, secrets: (string | undefined)[] = []) {
    return redactBotError(scrubSecrets(text, [apiKey, ...secrets]))
  }

  function fail(kind: VexaErrorKind, message: string, status?: number, code?: string, secrets?: (string | undefined)[]) {
    return new VexaError(kind, redact(message, secrets), { status, code })
  }

  async function request(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    if (!path.startsWith("/") || path.startsWith("//")) throw new VexaError("invalid", "invalid path")

    const url = `${origin}${prefix}${path}`
    const label = `Vexa ${method} ${path.split("?")[0]}`
    const attempts = opts.retry ? retries + 1 : 1

    for (let attempt = 1; ; attempt += 1) {
      const timeout = AbortSignal.timeout(opts.timeoutMs ?? timeoutMs)
      const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout
      const headers: Record<string, string> = { "X-API-Key": apiKey, Accept: "application/json" }
      let response: Response

      if (opts.body !== undefined) headers["Content-Type"] = "application/json"

      try {
        response = await fetchImpl(url, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          redirect: "error",
          signal,
        })
      } catch (error) {
        const name = errorName(error)

        if (name === "TimeoutError" || name === "AbortError") {
          throw fail("timeout", `${label} timed out`)
        }
        if (attempt < attempts) {
          await sleep(backoff(attempt))
          continue
        }
        throw fail("network", `${label} failed: ${error instanceof Error ? error.message : String(error)}`, undefined, undefined, opts.secrets)
      }

      if (response.ok || opts.allow?.includes(response.status)) return response

      const body = await readBody(response)
      const retryable = response.status === 429 || response.status >= 500

      if (retryable && attempt < attempts) {
        await sleep(parseRetryAfter(response.headers.get("retry-after"), now()) ?? backoff(attempt))
        continue
      }

      throw fail(
        classify(response.status, body),
        `${label} → ${response.status}: ${body.slice(0, BODY_PREVIEW)}`,
        response.status,
        errorCode(body),
        opts.secrets
      )
    }
  }

  function backoff(attempt: number) {
    return BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * BASE_BACKOFF_MS)
  }

  async function json<T>(response: Response, schema: z.ZodType<T>, label: string): Promise<{ value: T; raw: unknown }> {
    let raw: unknown

    try {
      const text = await response.text()

      raw = text ? JSON.parse(text) : {}
    } catch {
      throw new VexaError("bad_response", `${label}: invalid JSON`)
    }

    const parsed = schema.safeParse(raw)

    if (!parsed.success) throw new VexaError("bad_response", `${label}: unexpected response shape`)
    return { value: parsed.data, raw }
  }

  function botPath(platform: BotPlatform, nativeMeetingId: string) {
    assertPlatform(platform)
    return `/bots/${platform}/${nativeIdSegment(nativeMeetingId)}`
  }

  const client: BotProvider = {
    async requestBot(req: VexaBotRequest): Promise<VexaBotResult> {
      assertPlatform(req.platform)
      nativeIdSegment(req.nativeMeetingId)

      const body: Record<string, unknown> = {
        platform: req.platform,
        native_meeting_id: req.nativeMeetingId,
        bot_name: req.botName,
        transcribe_enabled: req.transcribeEnabled,
        recording_enabled: req.recordingEnabled,
      }

      if (req.language) body.language = req.language
      if (req.task) body.task = req.task
      if (req.passcode) body.passcode = req.passcode
      if (req.meetingUrl) body.meeting_url = req.meetingUrl
      if (req.teamsBaseHost) body.teams_base_host = req.teamsBaseHost
      if (req.authenticated !== undefined) body.authenticated = req.authenticated
      if (req.automaticLeave) {
        body.automatic_leave = { max_time_left_alone: req.automaticLeave.maxTimeLeftAloneMs }
      }

      // Never auto-retried: BullMQ retries, guarded by findActiveBot.
      const response = await request("POST", "/bots", { body, secrets: [req.passcode, req.meetingUrl] })
      const { value, raw } = await json(response, botResponseSchema, "Vexa POST /bots")

      return {
        vexaMeetingId: value.id ?? value.meeting_id ?? value.meeting?.id ?? undefined,
        status: value.status ?? value.meeting?.status,
        raw,
      }
    },

    async stopBot(platform, nativeMeetingId) {
      const response = await request("DELETE", botPath(platform, nativeMeetingId), { retry: true })
      const { value, raw } = await json(response, z.looseObject({ status: optionalText }), "Vexa DELETE /bots")

      return { status: value.status, raw }
    },

    async getMeeting(vexaMeetingId): Promise<VexaMeeting> {
      const response = await request("GET", `/meetings/${idSegment(vexaMeetingId, "meeting id")}`, { retry: true })
      const { value, raw } = await json(response, meetingSchema, "Vexa GET /meetings")
      const platform = toPlatform(value.platform)

      if (!platform) throw new VexaError("bad_response", "Vexa GET /meetings: unknown platform")

      return {
        id: value.id,
        platform,
        nativeMeetingId: value.native_meeting_id,
        status: value.status,
        startTime: value.start_time,
        endTime: value.end_time,
        constructedMeetingUrl: value.constructed_meeting_url,
        recordings: (value.recordings ?? []).map(toRecording),
        reason: value.data?.reason ?? value.data?.completion_reason ?? value.data?.failure_reason ?? value.reason,
        serviceProvenance: toProvenance(value.data?.service_provenance),
        raw,
      }
    },

    async findActiveBot(platform, nativeMeetingId): Promise<VexaActiveBot | undefined> {
      assertPlatform(platform)

      const response = await request("GET", "/bots/status", { retry: true })
      const { value } = await json(response, botStatusSchema, "Vexa GET /bots/status")
      const running = Array.isArray(value.running) ? value.running : []
      const bots = [
        ...(value.running_bots ?? []),
        ...running.flatMap((item) => {
          const parsed = runningBotSchema.safeParse(item)

          return parsed.success ? [parsed.data] : []
        }),
      ]
      const match = bots.find(
        (bot) => bot.platform === platform && bot.native_meeting_id === nativeMeetingId
      )

      if (!match) return undefined
      return {
        platform,
        nativeMeetingId,
        vexaMeetingId: match.meeting_id ?? match.id ?? undefined,
        status: match.status,
      }
    },

    async getRecordingMaster(recordingId, type): Promise<VexaRecordingMaster> {
      const response = await request(
        "GET",
        `/recordings/${idSegment(recordingId, "recording id")}/master?type=${encodeURIComponent(type)}`,
        { retry: true }
      )
      const { value, raw } = await json(response, masterSchema, "Vexa GET /recordings/master")

      return {
        rawUrl: sameOrigin(value.raw_url, origin),
        mediaId: value.media_id ?? value.media_file_id ?? undefined,
        raw,
      }
    },

    async streamRecordingMedia(recordingId, mediaId, opts = {}) {
      const response = await request(
        "GET",
        `/recordings/${idSegment(recordingId, "recording id")}/media/${idSegment(mediaId, "media id")}/raw`,
        { retry: true, timeoutMs: streamTimeoutMs, signal: opts.signal }
      )

      if (!response.body) throw new VexaError("bad_response", "Vexa recording stream has no body")

      const length = Number(response.headers.get("content-length"))

      return {
        body: response.body,
        contentType: response.headers.get("content-type") ?? undefined,
        contentLength: Number.isFinite(length) && length >= 0 && response.headers.has("content-length") ? length : undefined,
      }
    },

    async getTranscript(vexaMeetingId): Promise<VexaTranscript> {
      const response = await request("GET", `/transcripts/by-id/${idSegment(vexaMeetingId, "meeting id")}`, {
        retry: true,
      })
      const { value, raw } = await json(response, transcriptSchema, "Vexa GET /transcripts")

      return {
        vexaMeetingId,
        segments: (value.segments ?? []).map(toSegment),
        raw,
      }
    },

    async sendChat(platform, nativeMeetingId, text): Promise<BotChatResult> {
      const path = botPath(platform, nativeMeetingId)
      const message = text.slice(0, 1000)
      const chat = await request("POST", `${path}/chat`, { body: { text: message }, allow: [404, 405] })

      if (chat.ok) return "sent"

      const acts = await request("POST", `${path}/acts`, {
        body: { type: "chat", text: message },
        allow: [404, 405],
      })

      return acts.ok ? "sent" : "unsupported"
    },

    async deleteMeeting(vexaMeetingId) {
      // 200/204/404 resolve (already gone); 409 (bot still in the meeting) throws `conflict`.
      await request("DELETE", `/meetings/${idSegment(vexaMeetingId, "meeting id")}`, {
        retry: true,
        allow: [404],
      })
    },

    async configureWebhook(config: VexaWebhookConfig) {
      let target: URL

      try {
        target = new URL(config.url)
      } catch {
        throw new VexaError("invalid", "invalid webhook URL")
      }
      if (target.protocol !== "https:" && target.protocol !== "http:") {
        throw new VexaError("invalid", "invalid webhook URL")
      }
      if (!config.secret || config.secret.length < 32) {
        throw new VexaError("config", "webhook secret must be at least 32 characters")
      }

      await request("PUT", "/user/webhook", {
        body: { webhook_url: target.toString(), webhook_secret: config.secret, webhook_events: config.events },
        retry: true,
        secrets: [config.secret],
      })
    },

    async getWebhook(): Promise<VexaWebhookInfo> {
      const response = await request("GET", "/user/webhook", { retry: true })
      const { value } = await json(response, webhookSchema, "Vexa GET /user/webhook")
      const events = value.webhook_events ?? value.events ?? undefined

      return {
        url: value.webhook_url ?? value.url,
        events: events ?? undefined,
        secretConfigured:
          value.webhook_secret_configured ?? value.has_secret ?? (value.webhook_secret ? true : undefined),
        // The raw body is not returned: older gateways echo the secret.
        raw: { webhook_url: value.webhook_url ?? value.url, webhook_events: events },
      }
    },

    async health() {
      try {
        const response = await request("GET", "/bots/status", { retry: false })
        const { value, raw } = await json(response, healthSchema, "Vexa GET /bots/status")

        return { ok: true, version: value.version, raw }
      } catch {
        return { ok: false }
      }
    },
  }

  return client
}

let provider: BotProvider | undefined

/** Process-wide provider built from getBotConfig() (VEXA_API_URL / VEXA_API_KEY only). */
export function getBotProvider(): BotProvider {
  if (provider) return provider

  const config = getBotConfig()
  const { baseUrl, apiKey } = assertVexaConfig(config)

  provider = createVexaClient({
    baseUrl,
    apiKey,
    timeoutMs: config.vexa.timeoutMs,
    streamTimeoutMs: config.vexa.streamTimeoutMs,
  })
  return provider
}

/** Test helper. */
export function setBotProviderForTesting(value: BotProvider | undefined) {
  provider = value
}
