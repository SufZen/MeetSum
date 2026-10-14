/**
 * A stored language value as an HTML `lang` attribute: a BCP 47 tag, or
 * undefined for anything else (our "mixed" and "unknown" are not language
 * tags, and axe `valid-lang` flags them as a serious violation).
 */
export function bcp47Lang(lang: string | null | undefined): string | undefined {
  return lang && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang) && lang !== "mixed" ? lang : undefined
}
