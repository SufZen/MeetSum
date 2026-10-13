/**
 * Summary style guide (A5), Hebrew and English. Part of the cached system
 * prefix, so it must not contain meeting-specific data.
 */
import { HE_BUSINESS_EXAMPLE } from "@/lib/ai/prompts/examples/he-business"

/** Marker for content the transcript does not make clear. */
export const UNCLEAR_MARKER_HE = "(לא ברור מהתמלול)"
export const UNCLEAR_MARKER_EN = "(unclear from the transcript)"

const HE_STYLE_GUIDE = [
  "הנחיות סגנון:",
  "- עברית טבעית במשלב עסקי ישראלי: ענייני, קצר וברור.",
  "- כשהמגדר של אדם לא ידוע, יש לנסח בלשון ניטרלית: שם, רבים, שם פועל או שם עצם (\"יש לשלוח\", \"שליחת ההצעה\"). \"דנה תשלח\" רק כשהמגדר ידוע מהתמלול. אסור להניח לשון זכר.",
  "- מונחים טכניים ושמות מוצרים נשארים באותיות לטיניות (Supabase, API, PR). בלי תעתיק לעברית ובלי ניקוד.",
  "- תאריכים בפורמט DD.MM.YYYY עם שם היום (15.10.2026, יום חמישי). שעות בפורמט 24 שעות (14:30).",
  "- סכומים: 1,200 ₪ או $1,200. ספרות לכל סכום, אחוז ותאריך ולכל מספר מ-10 ומעלה.",
  "- פיסוק עברי רגיל, בלי תווי בקרה של כיווניות.",
  `- אסור להמציא דבר. כשמשהו לא ברור, יש לציין זאת במפורש: ${UNCLEAR_MARKER_HE}.`,
  "",
  HE_BUSINESS_EXAMPLE,
].join("\n")

const EN_STYLE_GUIDE = [
  "Style guide:",
  "- Clear, concise business English.",
  "- When a person's gender is unknown, use their name, \"they\", or a neutral construction; never assume a gender.",
  "- Keep product names and technical terms exactly as written (Supabase, API, PR).",
  "- Dates as DD.MM.YYYY with the weekday (15.10.2026, Thursday). 24-hour times (14:30).",
  "- Money as $1,200 or 1,200 ₪. Digits for every amount, percentage, date and any number of 10 or more.",
  "- No bidi control characters.",
  `- Never invent anything. Mark uncertainty explicitly: ${UNCLEAR_MARKER_EN}.`,
].join("\n")

export function getStyleGuide(lang: "he" | "en" | string): string {
  return lang === "he" ? HE_STYLE_GUIDE : EN_STYLE_GUIDE
}
