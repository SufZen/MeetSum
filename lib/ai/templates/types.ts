/**
 * Summary template contract (docs/parity/m5.md, Step 0; owner: Package A).
 * Built-ins live in code; workspace templates (`custom:<key>`) live in
 * `summary_templates` (Package D's store) and extend a built-in.
 */

export type LocalizedText = { he: string; en: string }

export type SectionKind = "bullets" | "paragraph" | "table" | "qa" | "scorecard"

export type SectionSpec = {
  key: string
  title: LocalizedText
  kind: SectionKind
  instructions: string
  maxItems?: number
  required: boolean
}

export type SummaryTemplateDef = {
  /** Built-in key, or `custom:<key>` for a workspace template. */
  key: string
  builtIn: boolean
  name: LocalizedText
  description: LocalizedText
  promptAddendum: LocalizedText
  sections: SectionSpec[]
  /** Output language the template is written for; undefined = any. */
  language?: string
}

/** Built-in template keys (A6), including the legacy pre-M5 keys. */
export const BUILT_IN_TEMPLATE_KEYS = [
  "general",
  "sales",
  "standup",
  "one_on_one",
  "interview",
  "board_investor",
  "hebrew_business",
  "real-estate",
  "product",
  "operations",
  "legal",
] as const

export type BuiltInTemplateKey = (typeof BUILT_IN_TEMPLATE_KEYS)[number]

/** Prefix of a workspace template key. */
export const CUSTOM_TEMPLATE_PREFIX = "custom:"

/** `auto`: pick a built-in from the classified meeting type. */
export const AUTO_TEMPLATE_KEY = "auto"

export function isBuiltInTemplateKey(key: string): key is BuiltInTemplateKey {
  return (BUILT_IN_TEMPLATE_KEYS as readonly string[]).includes(key)
}
