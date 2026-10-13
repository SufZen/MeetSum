/**
 * M7 meeting-bot UI strings (pills, status strip, recorder dock, join dialog,
 * bot rules settings, status reasons). Owned by Package C. Hebrew-first:
 * every key exists in `he` and `en`; other locales fall back to English via
 * dictionaries.ts.
 *
 * M7 branches from M4 in parallel with M5/M6, so this module is spread into
 * dictionaries.ts directly (like asr-messages.ts) instead of through the
 * M5/M6 `lib/i18n/mN/*` merge; consolidate at integration.
 */

export const botMessagesEn = {} satisfies Record<string, string>

export const botMessagesHe: Record<keyof typeof botMessagesEn, string> = {}

export const botMessages = { en: botMessagesEn, he: botMessagesHe } as const
