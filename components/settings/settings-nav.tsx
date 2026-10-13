"use client"

/**
 * Settings navigation (M9 A4). Sections have stable ids; the selected one
 * lives in the URL (`?panel=settings&section=<id>`), read and written through
 * the shell's `useShellUrl()` (D1), so M8's `?section=integrations` deep link
 * keeps working and back/forward walk the sections. Links are real
 * `<a href>`s (modifier-click opens a tab); a plain click navigates in-app.
 */
import { useI18n } from "@/components/i18n-provider"
import { useShellUrl } from "@/hooks/use-shell-url"
import { isPlainLeftClick } from "@/lib/client/shell-navigation"
import {
  SETTINGS_SECTIONS,
  buildShellUrl,
  parseShellUrl,
  type SearchParamsInput,
  type SettingsSectionId,
  type ShellState,
} from "@/lib/client/shell-url"

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "recording"

/** Dictionary key of each section's label (lib/i18n/m9/settings.ts). */
export const SETTINGS_SECTION_LABEL_KEYS: Record<SettingsSectionId, string> = {
  recording: "settingsSectionRecording",
  ai: "settingsSectionAi",
  live: "settingsSectionLive",
  developer: "settingsSectionDeveloper",
  integrations: "settingsSectionIntegrations",
  language: "settingsSectionLanguage",
  account: "settingsSectionAccount",
  personal: "settingsSectionPersonal",
  notifications: "settingsSectionNotifications",
}

/** The selected section for a URL (unknown or missing → the first section). */
export function settingsSectionFromUrl(input: SearchParamsInput | null | undefined): SettingsSectionId {
  return parseShellUrl(input).section ?? DEFAULT_SETTINGS_SECTION
}

/** Shell state of a section (the first section is the default, so it is omitted). */
function sectionState(section: SettingsSectionId): Partial<ShellState> {
  return { panel: "settings", section: section === DEFAULT_SETTINGS_SECTION ? null : section }
}

/** Href of a section, keeping every parameter the shell does not own. */
export function settingsSectionHref(locale: string, section: SettingsSectionId, keep?: SearchParamsInput | null): string {
  return buildShellUrl(locale, sectionState(section), keep)
}

/** The selected Settings section, read from the shell URL. */
export function useSettingsSection(): SettingsSectionId {
  const { locale } = useI18n()

  return useShellUrl(locale).state.section ?? DEFAULT_SETTINGS_SECTION
}

export function SettingsNav({ current }: { current: SettingsSectionId }) {
  const { t, locale } = useI18n()
  const shell = useShellUrl(locale)

  return (
    <nav aria-label={t("settingsNavLabel")} className="ms-card p-2 text-sm">
      <ul className="grid content-start gap-1">
        {SETTINGS_SECTIONS.map((section) => {
          const href = shell.href(sectionState(section))
          const selected = section === current

          return (
            <li key={section}>
              <a
                href={href}
                aria-current={selected ? "page" : undefined}
                onClick={(event) => {
                  if (!isPlainLeftClick(event)) return
                  event.preventDefault()
                  if (!selected) shell.navigate(sectionState(section))
                }}
                className={
                  selected
                    ? "block rounded-lg bg-brand-soft px-3 py-2 text-start font-semibold text-brand-text"
                    : "block rounded-lg px-3 py-2 text-start text-muted-foreground hover:bg-surface-2 hover:text-foreground"
                }
              >
                {t(SETTINGS_SECTION_LABEL_KEYS[section])}
              </a>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
