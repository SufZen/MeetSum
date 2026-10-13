/**
 * Display labels for classified meeting types (search result chips and the
 * type filter). Client-safe copy of the built-in template names
 * (lib/ai/templates/builtins.ts; a test keeps them in sync) so the search
 * UI doesn't bundle the template definitions.
 */
const LABELS: Record<string, { he: string; en: string }> = {
  general: { he: "פגישה כללית", en: "General Meeting" },
  sales: { he: "שיחת מכירה", en: "Sales Call" },
  standup: { he: "סטנדאפ", en: "Stand-up" },
  one_on_one: { he: "שיחת 1:1", en: "One-on-one" },
  interview: { he: "ראיון", en: "Interview" },
  board_investor: { he: "דירקטוריון / משקיעים", en: "Board / investor" },
  real_estate: { he: "נדל״ן", en: "Real Estate" },
  product: { he: "סקירת מוצר", en: "Product Review" },
  operations: { he: "תפעול ותכנון", en: "Operations & Planning" },
  legal: { he: "משפטי ורגולציה", en: "Legal & Compliance" },
  other: { he: "אחר", en: "Other" },
}

/** The localized label of a meeting-type key; an unknown key reads as words. */
export function meetingTypeLabel(type: string, locale: string): string {
  const label = LABELS[type]

  if (label) return locale === "he" ? label.he : label.en

  return type.replace(/[_-]+/g, " ")
}
