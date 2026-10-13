import { isValidTemplateKey } from "@/lib/ai/templates/registry"
import { getDatabasePool } from "@/lib/db/client"
import {
  DEFAULT_LOCALE,
  coerceLocale,
  isLegacyLocale,
  type SupportedLocale,
} from "@/lib/i18n/locales"
import { CONTENT_LANGUAGES, type ContentLanguage } from "@/lib/intelligence/types"

export type AppSettings = {
  defaultLocale: SupportedLocale
  /** Meeting content language, independent of the UI locale (M9). */
  meetingLanguageMode: "auto" | ContentLanguage
  /**
   * Summary template (M5): a built-in key (legacy keys stay valid),
   * `custom:<key>` or `auto`.
   */
  summaryTemplate: string
  googleArtifactsFirst: boolean
  pwaRecorderEnabled: boolean
  autoProcessImportedMedia: boolean
  publicSharingEnabled: boolean
  shareTranscriptByDefault: boolean
  shareActionsByDefault: boolean
  audioRetentionDays: number
  retainVideoByDefault: boolean
  /** Visibility of newly created meetings (M2). */
  defaultMeetingVisibility: "workspace" | "private"
  /** LLM provider preference (M5); Gemini is the `auto` default. */
  llmProviderPreference: "auto" | "anthropic" | "gemini"
  /** Summary output language (M5). */
  summaryLanguageMode: "meeting" | "he" | "en" | "mixed"
  /** When an AI title replaces the meeting title (M5). */
  autoTitleMode: "generic_only" | "always" | "off"
  /** Optional AI features (M5). */
  aiFeatures: { sentiment: boolean; prepBriefs: boolean }
}

type AppSettingsRow = {
  key: string
  value: unknown
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  defaultLocale: DEFAULT_LOCALE,
  meetingLanguageMode: "auto",
  summaryTemplate: "general",
  googleArtifactsFirst: true,
  pwaRecorderEnabled: true,
  autoProcessImportedMedia: true,
  publicSharingEnabled: true,
  shareTranscriptByDefault: true,
  shareActionsByDefault: true,
  audioRetentionDays: 180,
  retainVideoByDefault: false,
  defaultMeetingVisibility: "workspace",
  llmProviderPreference: "auto",
  summaryLanguageMode: "meeting",
  autoTitleMode: "generic_only",
  aiFeatures: { sentiment: true, prepBriefs: true },
}

/** In-memory (non-postgres) settings, keyed by workspace id. */
const memorySettings = new Map<string, AppSettings>()

function getMemorySettings(workspaceId: string): AppSettings {
  let settings = memorySettings.get(workspaceId)

  if (!settings) {
    settings = { ...DEFAULT_APP_SETTINGS }
    memorySettings.set(workspaceId, settings)
  }

  return settings
}

/** Language used for new meetings when the request does not specify one. */
export const LEGACY_DEFAULT_MEETING_LANGUAGE = "he"

export function resolveDefaultMeetingLanguage(
  settings: Pick<AppSettings, "meetingLanguageMode">
): string {
  return settings.meetingLanguageMode === "auto"
    ? LEGACY_DEFAULT_MEETING_LANGUAGE
    : settings.meetingLanguageMode
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

function normalizeAiFeatures(value: unknown): AppSettings["aiFeatures"] {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}

  return {
    sentiment: normalizeBoolean(raw.sentiment, DEFAULT_APP_SETTINGS.aiFeatures.sentiment),
    prepBriefs: normalizeBoolean(raw.prepBriefs, DEFAULT_APP_SETTINGS.aiFeatures.prepBriefs),
  }
}

function normalizeBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback
}

function normalizeAudioRetentionDays(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_APP_SETTINGS.audioRetentionDays
  }

  return Math.min(Math.max(Math.trunc(value), 1), 3650)
}

function normalizeSettings(raw: Record<string, unknown>): AppSettings {
  // Stored pt/es/it UI locales (removed in M9) read as he; 030 rewrites them.
  const defaultLocale =
    typeof raw.defaultLocale === "string" && isLegacyLocale(raw.defaultLocale)
      ? "he"
      : coerceLocale(raw.defaultLocale, DEFAULT_APP_SETTINGS.defaultLocale)
  const meetingLanguageMode =
    raw.meetingLanguageMode === "auto"
      ? "auto"
      : CONTENT_LANGUAGES.includes(raw.meetingLanguageMode as ContentLanguage)
        ? (raw.meetingLanguageMode as ContentLanguage)
        : DEFAULT_APP_SETTINGS.meetingLanguageMode

  return {
    defaultLocale,
    meetingLanguageMode,
    summaryTemplate: isValidTemplateKey(raw.summaryTemplate)
      ? raw.summaryTemplate
      : DEFAULT_APP_SETTINGS.summaryTemplate,
    googleArtifactsFirst: normalizeBoolean(
      raw.googleArtifactsFirst,
      DEFAULT_APP_SETTINGS.googleArtifactsFirst
    ),
    pwaRecorderEnabled: normalizeBoolean(
      raw.pwaRecorderEnabled,
      DEFAULT_APP_SETTINGS.pwaRecorderEnabled
    ),
    autoProcessImportedMedia: normalizeBoolean(
      raw.autoProcessImportedMedia,
      DEFAULT_APP_SETTINGS.autoProcessImportedMedia
    ),
    publicSharingEnabled: normalizeBoolean(
      raw.publicSharingEnabled,
      DEFAULT_APP_SETTINGS.publicSharingEnabled
    ),
    shareTranscriptByDefault: normalizeBoolean(
      raw.shareTranscriptByDefault,
      DEFAULT_APP_SETTINGS.shareTranscriptByDefault
    ),
    shareActionsByDefault: normalizeBoolean(
      raw.shareActionsByDefault,
      DEFAULT_APP_SETTINGS.shareActionsByDefault
    ),
    audioRetentionDays: normalizeAudioRetentionDays(raw.audioRetentionDays),
    retainVideoByDefault: normalizeBoolean(
      raw.retainVideoByDefault,
      DEFAULT_APP_SETTINGS.retainVideoByDefault
    ),
    defaultMeetingVisibility:
      raw.defaultMeetingVisibility === "private" ? "private" : "workspace",
    llmProviderPreference: oneOf(
      raw.llmProviderPreference,
      ["auto", "anthropic", "gemini"] as const,
      DEFAULT_APP_SETTINGS.llmProviderPreference
    ),
    summaryLanguageMode: oneOf(
      raw.summaryLanguageMode,
      ["meeting", "he", "en", "mixed"] as const,
      DEFAULT_APP_SETTINGS.summaryLanguageMode
    ),
    autoTitleMode: oneOf(
      raw.autoTitleMode,
      ["generic_only", "always", "off"] as const,
      DEFAULT_APP_SETTINGS.autoTitleMode
    ),
    aiFeatures: normalizeAiFeatures(raw.aiFeatures),
  }
}

/** Keys persisted per workspace (removed settings are never written). */
const SETTING_KEYS = Object.keys(DEFAULT_APP_SETTINGS) as Array<keyof AppSettings>

/** Settings of a workspace, stored in `workspace_settings` (M2). */
export async function getAppSettings(workspaceId: string): Promise<AppSettings> {
  if (process.env.MEETSUM_STORAGE !== "postgres") {
    return { ...getMemorySettings(workspaceId) }
  }

  const result = await getDatabasePool().query(
    "select key, value from workspace_settings where workspace_id = $1",
    [workspaceId]
  )
  const raw: Record<string, unknown> = { ...DEFAULT_APP_SETTINGS }

  for (const row of result.rows as AppSettingsRow[]) {
    if ((SETTING_KEYS as string[]).includes(row.key)) raw[row.key] = row.value
  }

  return normalizeSettings(raw)
}

export async function updateAppSettings(
  workspaceId: string,
  patch: Partial<AppSettings>
): Promise<AppSettings> {
  const current = await getAppSettings(workspaceId)
  const next = normalizeSettings({ ...current, ...patch })

  if (process.env.MEETSUM_STORAGE !== "postgres") {
    const settings = getMemorySettings(workspaceId)

    Object.assign(settings, next)
    return { ...settings }
  }

  const pool = getDatabasePool()

  for (const key of SETTING_KEYS) {
    await pool.query(
      `
        insert into workspace_settings (workspace_id, key, value, updated_at)
        values ($1, $2, $3::jsonb, now())
        on conflict (workspace_id, key) do update
          set value = excluded.value,
              updated_at = now()
      `,
      [workspaceId, key, JSON.stringify(next[key])]
    )
  }

  return next
}
