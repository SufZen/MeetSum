# Hebrew copy style (M9)

Applies to every `he` value in `lib/i18n/**`. `tests/dictionary-hebrew-lint.test.ts` enforces the mechanical rules.

## Gender-neutral by construction
- **Buttons, menu items, labels, tabs, column headers:** an infinitive-noun or a noun. "שמירה", "מחיקה", "העלאת קובץ", "יצירה מחדש", "חיבור Google".
- **Instructions and hints (full sentences):** plural imperative. "העלו קובץ אודיו", "נסו שוב", "הזמינו חברי צוות".
- **Never** a gendered singular imperative or future ("שמור", "בחר", "לחץ", "הזן", "תעלה", "תלחץ"), and never slash forms ("בחר/י", "מחובר/ת").
- **Status and events are built around the object,** not a gendered actor verb: "אזכור חדש מ־<bdi>דנה</bdi>", not "דנה הזכירה אותך"; "הפגישה עובדה", not "המערכת עיבדה".
- Ongoing states use nouns or impersonal forms ("בטעינה…", "בסנכרון", "בעיבוד"). Adjectives such as "מחובר" describe things (a connection, an account), never the reader.

## Punctuation
- Gershayim and geresh: ״ and ׳ (מנכ״ל, דק׳). Never ASCII `"` or `'` between Hebrew letters.
- Ellipsis: "…" (one character), never `...`.
- Prefix before a Latin word or a number: maqaf `־` (ל־Google, ב־14:30). `fixHebrewTypography` adds a word joiner at render time.
- Dash with spaces: " — ".

## Glossary
פגישה (meeting), תמליל (transcript), סיכום (summary), משימה (action item / task), חדר (room), סביבת עבודה (workspace), הקלטה (recording), דובר (speaker), תדריך (brief), אינטגרציה (integration), התראה (notification).

## Brands and codes
Brand names stay in Latin (Google, Drive, Slack, Notion, HubSpot, RealizeOS, MeetSum, API, AI). Error codes, ids and URLs render LTR (`<code dir="ltr">`).

## Numbers, dates and plurals
- Never format inside a message. Use `{count}` with `plural(key, n)` (`_one`, `_two`, `_other` in Hebrew; `_one`, `_other` in English) and `fmt.*` from `useI18n()` or `lib/i18n/format.ts`.
- Western digits only; 24-hour clock in Hebrew.
