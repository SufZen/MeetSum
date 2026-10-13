/**
 * The root error page strings, split from `shell.ts` (M10 C) so
 * `app/global-error.tsx`, which renders outside every provider, ships four
 * strings per locale instead of the whole shell module. `shell.ts` spreads them.
 */
export const m9ShellErrorMessages = {
  en: {
    shellErrorTitle: "Something went wrong",
    shellErrorRetry: "Try again",
    shellErrorBackToMeetings: "Back to meetings",
    shellErrorDigest: "Error reference",
  },
  he: {
    shellErrorTitle: "משהו השתבש",
    shellErrorRetry: "נסו שוב",
    shellErrorBackToMeetings: "חזרה לפגישות",
    shellErrorDigest: "מזהה שגיאה",
  },
}
