"use client"

/**
 * Settings navigation (M9 A4). Sections have stable ids; the selected one
 * lives in the URL (`?panel=settings&section=<id>`), so M8's
 * `?section=integrations` deep link keeps working and back/forward walk the
 * sections. Links are real `<a href>`s (modifier-click opens a tab); a plain
 * click updates the URL with `history.pushState`, which Next keeps in sync
 * with `useSearchParams` without a server round trip.
 */
import { useSearchParams } from "next/navigation"
import type { MouseEvent } from "react"

import { useI18n } from "@/components/i18n-provider"
import {
  SETTINGS_SECTIONS,
  buildShellUrl,
  parseShellUrl,
  type SearchParamsInput,
  type SettingsSectionId,
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

/** Href of a section, keeping every parameter the shell does not own. */
export function settingsSectionHref(locale: string, section: SettingsSectionId, keep?: SearchParamsInput | null): string {
  return buildShellUrl(locale, { panel: "settings", section: section === DEFAULT_SETTINGS_SECTION ? null : section }, keep)
}

/** The selected Settings section, read from the URL. */
export function useSettingsSection(): SettingsSectionId {
  return settingsSectionFromUrl(useSearchParams())
}

function isModifiedClick(event: MouseEvent<HTMLAnchorElement>) {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
}

export function SettingsNav({ current }: { current: SettingsSectionId }) {
  const { t, locale } = useI18n()
  const searchParams = useSearchParams()

  return (
    <nav aria-label={t("settingsNavLabel")} className="ms-card p-2 text-sm">
      <ul className="grid content-start gap-1">
        {SETTINGS_SECTIONS.map((section) => {
          const href = settingsSectionHref(locale, section, searchParams)
          const selected = section === current

          return (
            <li key={section}>
              <a
                href={href}
                aria-current={selected ? "page" : undefined}
                onClick={(event) => {
                  if (isModifiedClick(event)) return
                  event.preventDefault()
                  if (!selected) window.history.pushState(null, "", href)
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
