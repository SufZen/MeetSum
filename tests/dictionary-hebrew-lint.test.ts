/**
 * M9 A (docs/i18n/hebrew-style.md): every Hebrew dictionary value is Hebrew
 * (unless a brand or code), uses ״/׳ and "…", never opens with a gendered
 * singular imperative, and is already typeset (fixHebrewTypography is a no-op).
 */
import { describe, expect, it } from "vitest"

import { M9_MESSAGE_MODULES, getDictionary } from "@/lib/i18n/dictionaries"
import { fixHebrewTypography } from "@/lib/i18n/hebrew-text"

const HEBREW = /[֐-׿]/
/** Values that are legitimately not Hebrew (brands, codes, symbols). */
const NON_HEBREW_OK = /^[\d\s+.:/%·—–\-()[\]{}A-Za-z0-9#&@,⌘\u200E\u200F]*$/
const BRANDS = /^(?:Google(?: Workspace| Docs| Meet| Drive)?|Gmail|Drive|Meet|Zoom|Teams|Slack|Notion|HubSpot|Outlook|RealizeOS|MeetSum|Vexa|PDF|DOCX|Markdown|API|URL|AI|JSON|CSV|SRT|VTT|TXT|MP3|WebM|EN|HE|n8n|MCP|CLI|webhook|Webhook|ID|IP|OK)$/

/** Gendered singular imperatives that must never open a Hebrew string. */
const GENDERED_IMPERATIVES = [
  "תלחץ",
  "לחץ",
  "תעלה",
  "העלה",
  "הזן",
  "בחר",
  "צור",
  "שמור",
  "הוסף",
  "מחק",
  "ערוך",
  "שלח",
  "פתח",
  "סגור",
  "הקלט",
  "התחבר",
  "שאל",
  "נסה",
  "הזמן",
  "סנכרן",
  "המשך",
  "הורד",
  "העתק",
  "בטל",
  "אשר",
  "חפש",
  "נקה",
  "סמן",
  "הסר",
]

const he = getDictionary("he") as Record<string, string>

/**
 * Keys of M9 modules other packages own (B/C/D). The other rules check them;
 * typesetting them is the owning package's job, so the pre-typeset rule skips
 * them until Integration.
 */
const FOREIGN_KEYS = new Set(
  (["exports", "share", "notifications", "analytics", "onboarding", "shell", "pwa"] as const).flatMap((name) =>
    Object.keys(M9_MESSAGE_MODULES[name].he)
  )
)

describe("Hebrew dictionary lint", () => {
  it("translates every value into Hebrew unless it is a brand or code", () => {
    const offenders = Object.entries(he).filter(
      ([, value]) => value.trim() && !HEBREW.test(value) && !BRANDS.test(value.trim()) && !NON_HEBREW_OK.test(value)
    )

    expect(offenders.map(([key, value]) => `${key}: ${value}`)).toEqual([])
  })

  it("uses gershayim, geresh and the ellipsis character", () => {
    const offenders = Object.entries(he).filter(
      ([, value]) => /[א-ת]["'][א-ת]/.test(value) || /[א-ת]'(?:\s|$)/.test(value) || value.includes("...")
    )

    expect(offenders.map(([key, value]) => `${key}: ${value}`)).toEqual([])
  })

  it("never opens with a gendered singular imperative or uses slash forms", () => {
    const offenders = Object.entries(he).filter(([, value]) => {
      const first = value.trim().split(/\s+/)[0] ?? ""

      return GENDERED_IMPERATIVES.includes(first) || /[א-ת]\/[יהת](?=$|[\s.,])/.test(value)
    })

    expect(offenders.map(([key, value]) => `${key}: ${value}`)).toEqual([])
  })

  it("is pre-typeset (fixHebrewTypography is a no-op)", () => {
    const offenders = Object.entries(he).filter(
      ([key, value]) => !FOREIGN_KEYS.has(key) && fixHebrewTypography(value, { base: "rtl" }) !== value
    )

    expect(offenders.map(([key, value]) => `${key}: ${value}`)).toEqual([])
  })
})
