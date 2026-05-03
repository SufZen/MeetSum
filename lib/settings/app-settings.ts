import { getDatabasePool } from "@/lib/db/client"
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  type SupportedLocale,
} from "@/lib/i18n/locales"

export type AppSettings = {
  defaultLocale: SupportedLocale
  meetingLanguageMode: "auto" | SupportedLocale
  aiProviderPreference: "gemini-developer-api" | "vertex-ai"
  summaryTemplate: "general" | "sales" | "real-estate" | "product" | "operations" | "legal"
  googleArtifactsFirst: boolean
  pwaRecorderEnabled: boolean
  autoProcessImportedMedia: boolean
  publicSharingEnabled: boolean
  shareTranscriptByDefault: boolean
  shareActionsByDefault: boolean
  audioRetentionDays: number
  retainVideoByDefault: boolean
  requireApiKeyForMachines: boolean
}

type AppSettingsRow = {
  key: string
  value: unknown
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  defaultLocale: DEFAULT_LOCALE,
  meetingLanguageMode: "auto",
  aiProviderPreference: "gemini-developer-api",
  summaryTemplate: "general",
  googleArtifactsFirst: true,
  pwaRecorderEnabled: true,
  autoProcessImportedMedia: true,
  publicSharingEnabled: true,
  shareTranscriptByDefault: true,
  shareActionsByDefault: true,
  audioRetentionDays: 180,
  retainVideoByDefault: false,
  requireApiKeyForMachines: true,
}

const memorySettings: AppSettings = { ...DEFAULT_APP_SETTINGS }

function isSummaryTemplate(value: unknown): value is AppSettings["summaryTemplate"] {
  return (
    value === "general" ||
    value === "sales" ||
    value === "real-estate" ||
    value === "product" ||
    value === "operations" ||
    value === "legal"
  )
}

function isAiProviderPreference(
  value: unknown
): value is AppSettings["aiProviderPreference"] {
  return value === "gemini-developer-api" || value === "vertex-ai"
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
  const defaultLocale =
    typeof raw.defaultLocale === "string" && isSupportedLocale(raw.defaultLocale)
      ? raw.defaultLocale
      : DEFAULT_APP_SETTINGS.defaultLocale
  const meetingLanguageMode =
    raw.meetingLanguageMode === "auto"
      ? "auto"
      : typeof raw.meetingLanguageMode === "string" &&
          isSupportedLocale(raw.meetingLanguageMode)
        ? raw.meetingLanguageMode
        : DEFAULT_APP_SETTINGS.meetingLanguageMode

  return {
    defaultLocale,
    meetingLanguageMode,
    aiProviderPreference: isAiProviderPreference(raw.aiProviderPreference)
      ? raw.aiProviderPreference
      : DEFAULT_APP_SETTINGS.aiProviderPreference,
    summaryTemplate: isSummaryTemplate(raw.summaryTemplate)
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
    requireApiKeyForMachines: normalizeBoolean(
      raw.requireApiKeyForMachines,
      DEFAULT_APP_SETTINGS.requireApiKeyForMachines
    ),
  }
}

export async function getAppSettings(): Promise<AppSettings> {
  if (process.env.MEETSUM_STORAGE !== "postgres") {
    return { ...memorySettings }
  }

  const result = await getDatabasePool().query(
    "select key, value from app_settings"
  )
  const raw = { ...DEFAULT_APP_SETTINGS }

  for (const row of result.rows as AppSettingsRow[]) {
    raw[row.key as keyof AppSettings] = row.value as never
  }

  return normalizeSettings(raw)
}

export async function updateAppSettings(
  patch: Partial<AppSettings>
): Promise<AppSettings> {
  const current = await getAppSettings()
  const next = normalizeSettings({ ...current, ...patch })

  if (process.env.MEETSUM_STORAGE !== "postgres") {
    Object.assign(memorySettings, next)
    return { ...memorySettings }
  }

  const pool = getDatabasePool()
  const entries = Object.entries(next) as Array<[keyof AppSettings, unknown]>

  for (const [key, value] of entries) {
    await pool.query(
      `
        insert into app_settings (key, value, updated_at)
        values ($1, $2::jsonb, now())
        on conflict (key) do update
          set value = excluded.value,
              updated_at = now()
      `,
      [key, JSON.stringify(value)]
    )
  }

  return next
}
