"use client"

/**
 * Personal preferences (M9 A4): the signed-in user's interface language and
 * time zone, stored in `users.locale` / `users.time_zone` through
 * `/api/me/preferences`. Changing the language moves to the same page in the
 * new locale; the zone list is searchable and offers the browser's zone.
 */
import { GlobeIcon } from "lucide-react"
import { useEffect, useId, useState } from "react"
import { toast } from "sonner"

import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { apiErrorText } from "@/lib/i18n/api-errors"
import { systemTimeZone } from "@/lib/i18n/format"
import { SUPPORTED_LOCALES, replacePathLocale, type SupportedLocale } from "@/lib/i18n/locales"
import { listTimeZones } from "@/lib/i18n/time-zone"

type PreferencesView = { locale: SupportedLocale | null; timeZone: string | null }

const LANGUAGE_KEYS: Record<SupportedLocale, string> = {
  he: "settingsLanguageHebrew",
  en: "settingsLanguageEnglish",
}

/** Zones whose id contains every search word (case-insensitive; "tel aviv" finds Asia/Tel_Aviv). */
export function filterTimeZones(zones: readonly string[], query: string, limit = 200): string[] {
  const words = query.trim().toLowerCase().split(/[\s/_]+/).filter(Boolean)

  if (!words.length) return zones.slice(0, limit)

  return zones.filter((zone) => {
    const haystack = zone.toLowerCase().replace(/_/g, " ")

    return words.every((word) => haystack.includes(word))
  }).slice(0, limit)
}

export function PersonalPreferences() {
  const { t, locale, timeZone: activeZone } = useI18n()
  const [preferences, setPreferences] = useState<PreferencesView>()
  const [saving, setSaving] = useState(false)
  const [query, setQuery] = useState("")
  // Browser-only values, read after mount so server and client markup match.
  const [zones, setZones] = useState<string[]>([])
  const [browserZone, setBrowserZone] = useState("")
  const languageId = useId()
  const zoneId = useId()
  const searchId = useId()

  useEffect(() => {
    let cancelled = false

    void fetch("/api/me/preferences")
      .then(async (response) => {
        const body = await response.json().catch(() => ({}))

        if (!response.ok) throw new Error(apiErrorText(body, t, t("opPersonalErrLoad"), locale))
        if (cancelled) return
        setZones(listTimeZones())
        setBrowserZone(systemTimeZone())
        setPreferences(body.preferences)
      })
      .catch((error: unknown) => {
        if (!cancelled) toast.error(error instanceof Error ? error.message : t("opPersonalErrLoad"))
      })

    return () => {
      cancelled = true
    }
  }, [t, locale])

  async function save(patch: Partial<PreferencesView>) {
    setSaving(true)
    try {
      const response = await fetch("/api/me/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      })
      const body = await response.json().catch(() => ({}))

      if (!response.ok) throw new Error(apiErrorText(body, t, t("opPersonalErrSave"), locale))

      setPreferences(body.preferences)
      toast.success(t("opPersonalSaved"))

      const nextLocale: SupportedLocale | null = body.preferences?.locale ?? null

      if (patch.locale !== undefined && nextLocale && nextLocale !== locale) {
        window.location.assign(`${replacePathLocale(window.location.pathname, nextLocale)}${window.location.search}`)
      } else if (patch.timeZone !== undefined) {
        // Server-rendered dates pick up the new zone on the next render.
        window.location.reload()
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("opPersonalErrSave"))
    } finally {
      setSaving(false)
    }
  }

  const visibleZones = filterTimeZones(zones, query)
  const selectedZone = preferences?.timeZone ?? ""
  const disabled = saving || !preferences

  return (
    <section className="ms-card p-3.5" aria-busy={!preferences}>
      <div className="flex items-start gap-3">
        <div className="grid size-8 place-items-center rounded-md bg-brand-soft text-brand-text">
          <GlobeIcon aria-hidden="true" className="size-4" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t("settingsSectionPersonal")}</h2>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">{t("opPersonalDescription")}</p>
        </div>
      </div>

      <div className="mt-4 grid gap-3">
        <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface-2 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <Label htmlFor={languageId} className="text-sm font-semibold text-foreground">
              {t("settingsInterfaceLanguage")}
            </Label>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">{t("opPersonalLanguageDescription")}</p>
          </div>
          <NativeSelect
            id={languageId}
            value={preferences?.locale ?? ""}
            disabled={disabled}
            onChange={(event) => void save({ locale: (event.target.value || null) as SupportedLocale | null })}
          >
            <NativeSelectOption value="">{t("opPersonalLanguageWorkspaceDefault")}</NativeSelectOption>
            {SUPPORTED_LOCALES.map((item) => (
              <NativeSelectOption key={item} value={item} lang={item}>
                {t(LANGUAGE_KEYS[item])}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>

        <div className="grid gap-3 rounded-lg border border-line bg-surface-2 p-3">
          <div className="min-w-0">
            <Label htmlFor={zoneId} className="text-sm font-semibold text-foreground">
              {t("settingsTimeZone")}
            </Label>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              {t("opPersonalTimeZoneDescription")}{" "}
              <span>
                {t("opPersonalTimeZoneCurrentLabel")}{" "}
                <bdi dir="ltr" className="font-mono text-xs">
                  {activeZone}
                </bdi>
              </span>
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="grid gap-1">
              <Label htmlFor={searchId} className="sr-only">
                {t("settingsTimeZoneSearch")}
              </Label>
              <Input
                id={searchId}
                type="search"
                dir="ltr"
                className="h-9"
                placeholder={t("settingsTimeZoneSearch")}
                value={query}
                disabled={disabled}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <NativeSelect
              id={zoneId}
              className="w-full"
              value={selectedZone}
              disabled={disabled}
              onChange={(event) => void save({ timeZone: event.target.value || null })}
            >
              <NativeSelectOption value="">{t("opPersonalTimeZoneDefault", { zone: activeZone })}</NativeSelectOption>
              {selectedZone && !visibleZones.includes(selectedZone) ? (
                <NativeSelectOption value={selectedZone}>{selectedZone}</NativeSelectOption>
              ) : null}
              {visibleZones.map((zone) => (
                <NativeSelectOption key={zone} value={zone}>
                  {zone}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          {query && !visibleZones.length ? (
            <p role="status" className="text-xs text-muted-foreground">
              {t("opPersonalNoZoneMatch")}
            </p>
          ) : null}
          <Button
            variant="outline"
            className="h-9 w-fit"
            disabled={disabled || !browserZone || browserZone === selectedZone}
            onClick={() => void save({ timeZone: browserZone })}
          >
            {t("settingsUseBrowserTimeZone")}
            <bdi dir="ltr" className="font-mono text-xs text-muted-foreground">
              {browserZone}
            </bdi>
          </Button>
        </div>
      </div>
    </section>
  )
}
