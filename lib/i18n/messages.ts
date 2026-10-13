/**
 * Client-safe message lookup (M9). Never imports the runtime `dictionaries`
 * object: callers pass the active locale's dictionary (or a module slice).
 */
import type { FmtLocale } from "@/lib/i18n/format"

export type MessageValues = Record<string, string | number | undefined>

export type MessageSource = Readonly<Record<string, string>>

/** Fills `{name}` slots; unknown slots stay as written. */
export function fillMessage(template: string, values: MessageValues = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = values[key]

    return value === undefined ? match : String(value)
  })
}

/**
 * `fillMessage` under its pre-M9 name. Client code imports it from here, never
 * from a message module (`dictionaries.ts` re-exports it for server code).
 */
export function formatMessage(template: string, values: MessageValues): string {
  return fillMessage(template, values)
}

/** Looks up `key` (falling back to the key itself) and fills its slots. */
export function translate(messages: MessageSource, key: string, values?: MessageValues): string {
  return fillMessage(messages[key] ?? key, values)
}

/**
 * Plural lookup: `<key>_one|_two|_other` by `Intl.PluralRules(locale)`,
 * falling back to `_other`, then to `key`. `{count}` is filled with `n`
 * unless `values.count` is given (e.g. an already formatted number).
 */
export function pluralMessage(
  messages: MessageSource,
  locale: FmtLocale,
  key: string,
  n: number,
  values: MessageValues = {}
): string {
  const category = new Intl.PluralRules(locale).select(n)
  const template = messages[`${key}_${category}`] ?? messages[`${key}_other`] ?? messages[key] ?? key

  return fillMessage(template, { count: n, ...values })
}
