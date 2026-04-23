# Internationalization

MeetSum ships day-one UI support for:

- English: `/en`
- Hebrew: `/he`
- Portuguese: `/pt`
- Spanish: `/es`
- Italian: `/it`

The default UI locale is English. The `meetsum_locale` cookie stores the user's explicit preference. `/` redirects to the saved locale when present and valid, otherwise `/en`.

## Direction

Hebrew renders with `lang="he"` and `dir="rtl"`. All other supported locales render LTR.

## Dictionary Contract

UI copy lives in `lib/i18n/dictionaries.ts`. Every locale must contain exactly the same keys as English, and the unit tests enforce this.

## Meeting Content

Meeting content language is separate from UI language. A user can view the app in English while reading Hebrew or mixed-language transcript content.
