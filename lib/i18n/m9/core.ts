/**
 * M9 core messages (owner: Package A). Step 0 froze the initial key list;
 * the owning package may add keys. Plural keys use `_one`/`_other` in en and
 * `_one`/`_two`/`_other` in he (`plural(key, n)`); `{name}` slots are filled
 * by `formatMessage`. Hebrew copy follows docs/i18n/hebrew-style.md: plural
 * imperative, no gendered actor verbs, ״/׳ (never ASCII quotes), "…" (never "...").
 */
export const m9CoreMessages = {
  en: {
    coreGenericError: "Something went wrong. Try again.",
    coreUnknownErrorCode: "Unexpected error ({code})",
    coreLoading: "Loading…",
    coreRetry: "Try again",
    coreClose: "Close",
    coreSave: "Save",
    coreSaved: "Saved",
    coreCancel: "Cancel",
    coreConfirm: "Confirm",
    coreDelete: "Delete",
    coreBack: "Back",
    coreNotAvailable: "Not available",
    coreRelativeNow: "now",
    coreMeetingsCount_one: "{count} meeting",
    coreMeetingsCount_other: "{count} meetings",
    coreMinutesCount_one: "{count} minute",
    coreMinutesCount_other: "{count} minutes",
  },
  he: {
    coreGenericError: "משהו השתבש. נסו שוב.",
    coreUnknownErrorCode: "שגיאה לא צפויה ({code})",
    coreLoading: "טוען…",
    coreRetry: "נסו שוב",
    coreClose: "סגירה",
    coreSave: "שמירה",
    coreSaved: "נשמר",
    coreCancel: "ביטול",
    coreConfirm: "אישור",
    coreDelete: "מחיקה",
    coreBack: "חזרה",
    coreNotAvailable: "לא זמין",
    coreRelativeNow: "עכשיו",
    coreMeetingsCount_one: "פגישה אחת",
    coreMeetingsCount_two: "שתי פגישות",
    coreMeetingsCount_other: "{count} פגישות",
    coreMinutesCount_one: "דקה",
    coreMinutesCount_two: "שתי דקות",
    coreMinutesCount_other: "{count} דקות",
  },
}
