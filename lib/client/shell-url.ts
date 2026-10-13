/**
 * The shell URL is the single source of truth for shell state (M9 Step 0,
 * docs/parity/m9.md "Shell URL"; owner: Package D):
 *   /<locale>?panel=<panel>&meeting=<id>&tab=summary|transcript|ask&t=<sec>&adminTab=<tab>&section=<section>
 * Default values are omitted; unknown parameters (`integration_error`, `q`,
 * `source`, `record`, …) are preserved. `section` keeps M8's
 * `?panel=settings&section=integrations` working. Client- and server-safe.
 */
import { parseTimeParam } from "@/lib/player/deep-link"

export const SHELL_PANELS = [
  "meetings",
  "memory",
  "workspace",
  "automations",
  "storage",
  "manual",
  "settings",
  "admin",
] as const

export type ShellPanel = (typeof SHELL_PANELS)[number]

export const MEETING_TABS = ["summary", "transcript", "ask"] as const

export type MeetingTab = (typeof MEETING_TABS)[number]

export const ADMIN_TABS = ["members", "invitations", "api-keys", "audit"] as const

export type AdminTabKey = (typeof ADMIN_TABS)[number]

/** Stable Settings section ids (Package A, A4). */
export const SETTINGS_SECTIONS = [
  "recording",
  "ai",
  "live",
  "developer",
  "integrations",
  "language",
  "account",
  "personal",
  "notifications",
] as const

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]

export type ShellState = {
  panel: ShellPanel
  meeting: string | null
  tab: MeetingTab
  /** Player position in whole seconds. */
  t: number | null
  adminTab: AdminTabKey
  /** null = the Settings shell's first section. */
  section: SettingsSectionId | null
}

export const DEFAULT_SHELL_STATE: ShellState = {
  panel: "meetings",
  meeting: null,
  tab: "summary",
  t: null,
  adminTab: "members",
  section: null,
}

/** The parameters the shell owns; everything else is kept as-is. */
export const SHELL_PARAMS = ["panel", "meeting", "tab", "t", "adminTab", "section"] as const

/**
 * One-shot parameters that are never round-tripped (M9 security review):
 * URL state is navigation only. `record=1` may open the recorder sheet once,
 * but never starts capture, and is dropped from every built URL.
 */
const ONE_SHOT_PARAMS: readonly string[] = ["record"]

/** `useSearchParams()` (a URLSearchParams), a page's `searchParams` object, or a query string. */
export type SearchParamsInput = URLSearchParams | Record<string, string | string[] | undefined> | string

function toSearchParams(input: SearchParamsInput | null | undefined): URLSearchParams {
  if (!input) return new URLSearchParams()
  if (typeof input === "string") return new URLSearchParams(input.startsWith("?") ? input.slice(1) : input)
  if (input instanceof URLSearchParams) return new URLSearchParams(input)

  const params = new URLSearchParams()

  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) value.forEach((item) => params.append(key, item))
    else if (typeof value === "string") params.append(key, value)
  }

  return params
}

function oneOf<T extends string>(values: readonly T[], value: string | null): T | undefined {
  return value !== null && (values as readonly string[]).includes(value) ? (value as T) : undefined
}

/**
 * True when the URL asks the shell for something specific (a shell param, a
 * one-shot `record`, or an `integration_error` coming back from an OAuth
 * callback). The onboarding redirect is skipped then, so deep links and
 * callbacks are never dropped.
 */
export function hasShellIntent(input: SearchParamsInput | null | undefined): boolean {
  const params = toSearchParams(input)

  return [...SHELL_PARAMS, ...ONE_SHOT_PARAMS, "integration_error"].some((name) => params.has(name))
}

const MEETING_ID = /^[A-Za-z0-9_-]{1,128}$/

/** Parses shell state; invalid values fall back to the defaults. */
export function parseShellUrl(input: SearchParamsInput | null | undefined): ShellState {
  const params = toSearchParams(input)
  const meeting = params.get("meeting")
  const ms = parseTimeParam(params.get("t"))
  const legacySettings = params.get("section") === "integrations" && !params.get("panel")

  return {
    panel: oneOf(SHELL_PANELS, params.get("panel")) ?? (legacySettings ? "settings" : DEFAULT_SHELL_STATE.panel),
    meeting: meeting && MEETING_ID.test(meeting) ? meeting : null,
    tab: oneOf(MEETING_TABS, params.get("tab")) ?? DEFAULT_SHELL_STATE.tab,
    t: ms === undefined ? null : Math.floor(ms / 1000),
    adminTab: oneOf(ADMIN_TABS, params.get("adminTab")) ?? DEFAULT_SHELL_STATE.adminTab,
    section: oneOf(SETTINGS_SECTIONS, params.get("section")) ?? null,
  }
}

/**
 * Builds `/<locale>?…` for a shell state. Values equal to the defaults are
 * omitted; `keep` (the current search params) contributes every parameter
 * the shell does not own, except one-shot ones (`record`).
 */
export function buildShellUrl(
  locale: string,
  state: Partial<ShellState>,
  keep?: SearchParamsInput | null
): string {
  const next = { ...DEFAULT_SHELL_STATE, ...state }
  const params = new URLSearchParams()

  if (next.panel !== DEFAULT_SHELL_STATE.panel) params.set("panel", next.panel)
  if (next.meeting) params.set("meeting", next.meeting)
  if (next.meeting && next.tab !== DEFAULT_SHELL_STATE.tab) params.set("tab", next.tab)
  if (next.meeting && next.t !== null && Number.isFinite(next.t) && next.t >= 0) params.set("t", String(Math.floor(next.t)))
  if (next.panel === "admin" && next.adminTab !== DEFAULT_SHELL_STATE.adminTab) params.set("adminTab", next.adminTab)
  if (next.panel === "settings" && next.section) params.set("section", next.section)

  toSearchParams(keep).forEach((value, key) => {
    if (!(SHELL_PARAMS as readonly string[]).includes(key) && !ONE_SHOT_PARAMS.includes(key)) params.append(key, value)
  })

  const query = params.toString()

  return `/${locale}${query ? `?${query}` : ""}`
}
