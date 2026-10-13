/**
 * Server-side AskMeetSum strings (he/en). The UI dictionary lives in
 * `lib/i18n/m6/ask.ts` (Package D); these are the strings the server itself
 * writes into answers and error events.
 */
export type AskLanguage = "he" | "en"

export const ASK_MESSAGES = {
  he: {
    refusal: "לא מצאתי בפגישות מידע שעונה על השאלה.",
    uncitedNotice: "חלק מהתשובה הוסר כי לא נמצא לו מקור בפגישות.",
    notFound: "הפגישה או החדר לא נמצאו.",
    dailyLimit: "הגעת למגבלת השאלות היומית. אפשר לנסות שוב מחר.",
    rateLimited: "יותר מדי שאלות בזמן קצר. אפשר לנסות שוב בעוד רגע.",
    llmUnavailable: "שירות התשובות אינו זמין כרגע. אפשר לנסות שוב מאוחר יותר.",
    internal: "אירעה שגיאה בעיבוד השאלה.",
  },
  en: {
    refusal: "I couldn't find this in your meetings.",
    uncitedNotice: "Part of the answer was removed because it had no source in your meetings.",
    notFound: "The meeting or room was not found.",
    dailyLimit: "You have reached the daily question limit. Try again tomorrow.",
    rateLimited: "Too many questions in a short time. Try again in a moment.",
    llmUnavailable: "The answer service is unavailable right now. Try again later.",
    internal: "Something went wrong while answering.",
  },
} as const satisfies Record<AskLanguage, Record<string, string>>

export function askMessage(language: AskLanguage, key: keyof (typeof ASK_MESSAGES)["he"]): string {
  return ASK_MESSAGES[language][key]
}
