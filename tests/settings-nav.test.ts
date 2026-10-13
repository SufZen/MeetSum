/**
 * M9 A4: the Settings section comes from the URL (stable ids, M8's
 * `?section=integrations` still works), hrefs keep foreign params, and every
 * nav label is localized in Hebrew.
 */
import { describe, expect, it } from "vitest"

import { filterTimeZones } from "@/components/settings/personal-preferences"
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_SECTION_LABEL_KEYS,
  settingsSectionFromUrl,
  settingsSectionHref,
} from "@/components/settings/settings-nav"
import { SETTINGS_SECTIONS } from "@/lib/client/shell-url"
import { getDictionary } from "@/lib/i18n/dictionaries"

describe("settings section from the URL", () => {
  it("reads stable ids and falls back to the first section", () => {
    expect(settingsSectionFromUrl("?panel=settings&section=ai")).toBe("ai")
    expect(settingsSectionFromUrl("?section=integrations")).toBe("integrations")
    expect(settingsSectionFromUrl("?panel=settings&section=Recording%20%26%20Privacy")).toBe(DEFAULT_SETTINGS_SECTION)
    expect(settingsSectionFromUrl("")).toBe("recording")
  })

  it("builds hrefs that keep unknown params and omit the default section", () => {
    expect(settingsSectionHref("he", "integrations", "?integration_error=x")).toBe(
      "/he?panel=settings&section=integrations&integration_error=x"
    )
    expect(settingsSectionHref("en", "recording", "?panel=settings&section=ai")).toBe("/en?panel=settings")
  })
})

describe("settings nav labels", () => {
  it("has a Hebrew label for every section", () => {
    const he = getDictionary("he") as Record<string, string>
    const en = getDictionary("en") as Record<string, string>

    for (const section of SETTINGS_SECTIONS) {
      const key = SETTINGS_SECTION_LABEL_KEYS[section]

      expect(he[key], section).toMatch(/[֐-׿]/)
      expect(en[key], section).toBeTruthy()
    }
  })
})

describe("filterTimeZones", () => {
  const zones = ["Asia/Jerusalem", "Asia/Tel_Aviv", "Europe/Lisbon", "America/New_York"]

  it("matches every word, ignoring case and underscores", () => {
    expect(filterTimeZones(zones, "tel aviv")).toEqual(["Asia/Tel_Aviv"])
    expect(filterTimeZones(zones, "ASIA")).toEqual(["Asia/Jerusalem", "Asia/Tel_Aviv"])
    expect(filterTimeZones(zones, "")).toEqual(zones)
    expect(filterTimeZones(zones, "mars")).toEqual([])
  })
})
