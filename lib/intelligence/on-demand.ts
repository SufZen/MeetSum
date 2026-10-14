/**
 * Guards for on-demand LLM generation (M5 prep briefs and follow-up emails):
 *
 * - `limitLlmOnDemand`: the shared `llmOnDemand` budget per
 *   `${workspaceId}:${userId|apiKeyId}` (429 + Retry-After). Callers apply
 *   it after authz and the meeting visibility check.
 * - `singleFlight`: concurrent identical requests (same actor, meeting, kind
 *   and variant) share one LLM call.
 * - ephemeral cache: results that are not persisted (callers without
 *   `meeting:write`) are kept for 10 minutes per (actor, meeting, kind,
 *   variant, inputHash), so repeating a request does not call the model.
 *
 * Everything here is in-memory and per instance (see `lib/rate-limit.ts`).
 */
import { checkRateLimitWindows, llmOnDemandWindows, resetRateLimitsForTesting } from "@/lib/rate-limit"

export const EPHEMERAL_TTL_MS = 10 * 60 * 1000
const MAX_EPHEMERAL_ENTRIES = 1000

export type OnDemandKind = "prep_brief" | "follow_up_email"

/** Who is asking: `user:<id>` or `api_key:<id>`. */
export type OnDemandActor = { workspaceId: string; actorKey: string; canWrite: boolean }

export async function limitLlmOnDemand(actor: OnDemandActor): Promise<Response | undefined> {
  if (process.env.MEETSUM_RATE_LIMIT === "false") return undefined

  const result = await checkRateLimitWindows(
    `llm_on_demand:${actor.workspaceId}:${actor.actorKey}`,
    llmOnDemandWindows(actor.canWrite)
  )

  if (result.allowed) return undefined

  const retryAfter = Math.max(1, Math.ceil((result.resetMs - Date.now()) / 1000))

  return new Response(JSON.stringify({ error: "Too many requests", retryAfterSeconds: retryAfter }), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": String(retryAfter),
      "X-RateLimit-Limit": String(result.limit),
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": String(Math.ceil(result.resetMs / 1000)),
    },
  })
}

const inFlight = new Map<string, Promise<unknown>>()

/** Runs `fn` once per key at a time; concurrent callers share its promise. */
export function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key)

  if (running) return running as Promise<T>

  const promise = fn().finally(() => {
    inFlight.delete(key)
  })

  inFlight.set(key, promise)
  return promise
}

type EphemeralEntry = { value: unknown; expiresAt: number }

const ephemeral = new Map<string, EphemeralEntry>()

export function onDemandKey(parts: {
  actorKey: string
  meetingId: string
  kind: OnDemandKind
  variant: string
  inputHash?: string
}): string {
  return [parts.actorKey, parts.meetingId, parts.kind, parts.variant, parts.inputHash ?? ""].join("\u0000")
}

export function getEphemeral<T>(key: string): T | undefined {
  const entry = ephemeral.get(key)

  if (!entry) return undefined
  if (entry.expiresAt <= Date.now()) {
    ephemeral.delete(key)
    return undefined
  }
  return entry.value as T
}

export function setEphemeral<T>(key: string, value: T) {
  const now = Date.now()

  if (ephemeral.size >= MAX_EPHEMERAL_ENTRIES) {
    for (const [entryKey, entry] of ephemeral) {
      if (entry.expiresAt <= now) ephemeral.delete(entryKey)
    }
    // Still full: drop the oldest insertion.
    if (ephemeral.size >= MAX_EPHEMERAL_ENTRIES) {
      const oldest = ephemeral.keys().next().value

      if (oldest !== undefined) ephemeral.delete(oldest)
    }
  }
  ephemeral.set(key, { value, expiresAt: now + EPHEMERAL_TTL_MS })
}

/** Test hook: clears the budget, in-flight calls and the ephemeral cache. */
export function resetLlmOnDemandForTesting() {
  resetRateLimitsForTesting()
  inFlight.clear()
  ephemeral.clear()
}
