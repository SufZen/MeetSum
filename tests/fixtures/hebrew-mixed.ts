/**
 * Hebrew / mixed-direction corpus (M9 Step 0, docs/parity/m9.md item 13).
 * Shared by the typography, bidi-visual, PDF and DOCX tests (Packages A and
 * B). `expectTypeset` is the `fixHebrewTypography` output where Step 0's rules
 * already decide it; `null` means "unchanged". Never edit an entry's `text`:
 * add a new one instead, so every suite keeps comparing the same inputs.
 */
import { NBSP, RLM, WJ } from "@/lib/i18n/hebrew-text"

export type HebrewCorpusEntry = {
  id: string
  text: string
  /** Paragraph base direction the renderer should pick. */
  base: "rtl" | "ltr"
  note: string
  expectTypeset: string | null
}

export const HEBREW_MIXED_CORPUS: readonly HebrewCorpusEntry[] = [
  {
    id: "latin-before-digits",
    text: "פגישה עם Lisboa 12 משתתפים",
    base: "rtl",
    note: "RLM after the Latin word keeps '12' after 'Lisboa' visually",
    expectTypeset: `פגישה עם Lisboa${RLM} 12 משתתפים`,
  },
  {
    id: "prefix-hyphen-brand",
    text: "שלחו את הסיכום ל-Google Docs",
    base: "rtl",
    note: "WJ after the prefix hyphen so 'ל-Google' never breaks",
    expectTypeset: `שלחו את הסיכום ל-${WJ}Google Docs`,
  },
  {
    id: "prefix-hyphen-time",
    text: "הפגישה נקבעה ב-14:30",
    base: "rtl",
    note: "WJ before a time after a prefix",
    expectTypeset: `הפגישה נקבעה ב-${WJ}14:30`,
  },
  {
    id: "spaced-dash",
    text: "סיכום — גרסה שנייה",
    base: "rtl",
    note: "NBSP before a spaced em dash",
    expectTypeset: `סיכום${NBSP}— גרסה שנייה`,
  },
  {
    id: "url-untouched",
    text: "ראו https://meetsum.example/he?meeting=m_1&t=90 לפרטים",
    base: "rtl",
    note: "URLs are protected tokens",
    expectTypeset: null,
  },
  {
    id: "email-and-mention",
    text: "שאלה מ-@dana אל dana.levi@example.com 3 פעמים",
    base: "rtl",
    note: "mentions and emails are protected; prefix hyphen before '@' is not Latin/digit",
    expectTypeset: null,
  },
  {
    id: "english-only",
    text: "Weekly sync with Lisboa 12 people — notes",
    base: "ltr",
    note: "no Hebrew: unchanged",
    expectTypeset: null,
  },
  {
    id: "niqqud",
    text: "שָׁלוֹם וּבְרָכָה",
    base: "rtl",
    note: "combining marks must stay attached to their base letter (grapheme clusters)",
    expectTypeset: null,
  },
  {
    id: "brackets",
    text: "התקציב (Q4) אושר [סופי]",
    base: "rtl",
    note: "brackets mirror in RTL runs",
    expectTypeset: null,
  },
  {
    id: "code-switch",
    text: "we need to לסגור את ה-deal עד Friday",
    base: "ltr",
    note: "code-switched speech; first strong character is Latin",
    expectTypeset: `we need to לסגור את ה-${WJ}deal עד Friday`,
  },
  {
    id: "gershayim",
    text: "דו״ח רבעוני של צה״ל ומע״מ",
    base: "rtl",
    note: "gershayim (U+05F4), never ASCII quotes",
    expectTypeset: null,
  },
  {
    id: "numbers-and-percent",
    text: "עלייה של 12.5% ב-Q3 לעומת 2025",
    base: "rtl",
    note: "Western digits, percent sign, a Latin quarter after a prefix",
    expectTypeset: `עלייה של 12.5% ב-${WJ}Q3 לעומת 2025`,
  },
]
