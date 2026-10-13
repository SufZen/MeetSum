/**
 * Parses `GET /api/analytics/overview` parameters (docs/parity/m9.md C2):
 * `from`/`to` ISO instants (or `range=30|90|180|365` days back from now),
 * `interval=day|week|month`, `scope=workspace|me`, `roomId?`, `tz?`.
 * Range at most 366 days; default the last 90 days. Client- and server-safe.
 */
import {
  ANALYTICS_DEFAULT_RANGE_DAYS,
  ANALYTICS_MAX_RANGE_DAYS,
  type AnalyticsInterval,
  type AnalyticsQuery,
  type AnalyticsScope,
} from "@/lib/analytics/dashboard/types"
import { isValidTimeZone } from "@/lib/i18n/time-zone"

export const ANALYTICS_INTERVALS: readonly AnalyticsInterval[] = ["day", "week", "month"]
export const ANALYTICS_SCOPES: readonly AnalyticsScope[] = ["workspace", "me"]
export const ANALYTICS_RANGE_PRESETS = [30, 90, 180, 365] as const

export type AnalyticsRangePreset = (typeof ANALYTICS_RANGE_PRESETS)[number]

export type AnalyticsQueryError = "invalid_range" | "range_too_long" | "invalid_interval" | "invalid_scope" | "invalid_room"

const DAY_MS = 86_400_000
const ROOM_ID = /^[A-Za-z0-9_-]{1,128}$/

type Params = { get(name: string): string | null }

function instant(value: string | null): number | undefined {
  if (value === null || value === "") return undefined
  if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2}))?$/.test(value)) return Number.NaN

  return Date.parse(value)
}

export function parseRangePreset(value: string | null | undefined): AnalyticsRangePreset {
  const parsed = Number(value)

  return (ANALYTICS_RANGE_PRESETS as readonly number[]).includes(parsed)
    ? (parsed as AnalyticsRangePreset)
    : ANALYTICS_DEFAULT_RANGE_DAYS
}

export function parseAnalyticsQuery(
  params: Params,
  defaults: { timeZone: string; now?: Date }
): { ok: true; query: AnalyticsQuery } | { ok: false; error: AnalyticsQueryError } {
  const now = (defaults.now ?? new Date()).getTime()
  const interval = (params.get("interval") ?? "week") as AnalyticsInterval
  const scope = (params.get("scope") ?? "workspace") as AnalyticsScope
  const roomId = params.get("roomId") ?? undefined
  const tz = params.get("tz")

  if (!ANALYTICS_INTERVALS.includes(interval)) return { ok: false, error: "invalid_interval" }
  if (!ANALYTICS_SCOPES.includes(scope)) return { ok: false, error: "invalid_scope" }
  if (roomId !== undefined && !ROOM_ID.test(roomId)) return { ok: false, error: "invalid_room" }

  const toParam = instant(params.get("to"))
  const fromParam = instant(params.get("from"))
  const to = toParam ?? now
  const from = fromParam ?? to - parseRangePreset(params.get("range")) * DAY_MS

  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return { ok: false, error: "invalid_range" }
  if (to - from > ANALYTICS_MAX_RANGE_DAYS * DAY_MS) return { ok: false, error: "range_too_long" }

  return {
    ok: true,
    query: {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      interval,
      scope,
      ...(roomId ? { roomId } : {}),
      timeZone: tz && isValidTimeZone(tz) ? tz : defaults.timeZone,
    },
  }
}
