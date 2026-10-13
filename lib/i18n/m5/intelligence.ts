/**
 * M5 intelligence strings: summary view, templates, analytics, prep,
 * follow-up and LLM settings (owner: Package D). Hebrew-first; every key
 * exists in `he` and `en`.
 */

export const intelligenceMessagesEn = {
  intelChapters: "Chapters",
  intelTopics: "Topics",
  intelTemplate: "Template",
  intelRegenerate: "Regenerate",
  intelAnalytics: "Analytics",
  intelPrep: "Prep",
  intelFollowUpEmail: "Follow-up email",
  intelLlmSettings: "AI models",
}

export const intelligenceMessagesHe: Record<keyof typeof intelligenceMessagesEn, string> = {
  intelChapters: "פרקים",
  intelTopics: "נושאים",
  intelTemplate: "תבנית",
  intelRegenerate: "צור מחדש",
  intelAnalytics: "ניתוח שיחה",
  intelPrep: "הכנה",
  intelFollowUpEmail: "מייל המשך",
  intelLlmSettings: "מודלי AI",
}
