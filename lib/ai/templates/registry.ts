/**
 * Template registry (A6). Built-ins live in `builtins.ts`; workspace
 * templates (`custom:<key>`, Package D's store) are merged over their
 * `base_template`. Precedence for a meeting: `meetings.template_key`, then
 * the workspace `summaryTemplate`, then `auto` (classified meeting type).
 */
import { BUILT_IN_TEMPLATES, templateForMeetingType } from "@/lib/ai/templates/builtins"
import {
  listCustomTemplates,
  loadCustomTemplate,
  type CustomTemplateRecord,
} from "@/lib/ai/templates/store"
import {
  AUTO_TEMPLATE_KEY,
  BUILT_IN_TEMPLATE_KEYS,
  CUSTOM_TEMPLATE_PREFIX,
  isBuiltInTemplateKey,
  type SummaryTemplateDef,
} from "@/lib/ai/templates/types"

const CUSTOM_KEY_PATTERN = /^[a-z0-9-]{2,40}$/
const DEFAULT_BASE_TEMPLATE = "general"

/** True for a built-in key, `auto`, or a well-formed `custom:<slug>`. */
export function isValidTemplateKey(key: unknown): key is string {
  if (typeof key !== "string") return false
  if (key === AUTO_TEMPLATE_KEY || isBuiltInTemplateKey(key)) return true
  return (
    key.startsWith(CUSTOM_TEMPLATE_PREFIX) &&
    CUSTOM_KEY_PATTERN.test(key.slice(CUSTOM_TEMPLATE_PREFIX.length))
  )
}

export function getBuiltInTemplate(key: string): SummaryTemplateDef | undefined {
  return isBuiltInTemplateKey(key) ? BUILT_IN_TEMPLATES[key] : undefined
}

function joinAddenda(base: string, extra: string): string {
  return [base, extra].map((part) => part.trim()).filter(Boolean).join("\n\n")
}

/** Merges a workspace template over its base built-in. */
export function mergeCustomTemplate(custom: CustomTemplateRecord): SummaryTemplateDef {
  const base =
    getBuiltInTemplate(custom.baseTemplate ?? DEFAULT_BASE_TEMPLATE) ??
    BUILT_IN_TEMPLATES[DEFAULT_BASE_TEMPLATE]

  return {
    key: `${CUSTOM_TEMPLATE_PREFIX}${custom.key}`,
    builtIn: false,
    name: { he: custom.name, en: custom.name },
    description: {
      he: custom.description ?? base.description.he,
      en: custom.description ?? base.description.en,
    },
    promptAddendum: {
      he: joinAddenda(base.promptAddendum.he, custom.prompt),
      en: joinAddenda(base.promptAddendum.en, custom.prompt),
    },
    sections: custom.sections.length ? custom.sections : base.sections,
    ...(custom.language ? { language: custom.language } : base.language ? { language: base.language } : {}),
  }
}

/** Templates available to a workspace: built-ins, then active customs. */
export async function listTemplates(workspaceId: string): Promise<SummaryTemplateDef[]> {
  const builtIns = BUILT_IN_TEMPLATE_KEYS.map((key) => BUILT_IN_TEMPLATES[key])
  let customs: CustomTemplateRecord[] = []

  try {
    customs = await listCustomTemplates(workspaceId)
  } catch {
    // Store unavailable (or not implemented yet): built-ins only.
  }

  return [...builtIns, ...customs.filter((custom) => !custom.archivedAt).map(mergeCustomTemplate)]
}

/**
 * Resolves a template key for a workspace; undefined for `auto`, unknown
 * keys, and missing or archived custom templates.
 */
export async function resolveTemplate(
  workspaceId: string,
  key: string
): Promise<SummaryTemplateDef | undefined> {
  const builtIn = getBuiltInTemplate(key)

  if (builtIn) return builtIn
  if (!key.startsWith(CUSTOM_TEMPLATE_PREFIX)) return undefined

  try {
    const custom = await loadCustomTemplate(workspaceId, key.slice(CUSTOM_TEMPLATE_PREFIX.length))

    return custom && !custom.archivedAt ? mergeCustomTemplate(custom) : undefined
  } catch {
    return undefined
  }
}

/** The requested key by precedence: run override, meeting, workspace, auto. */
export function requestedTemplateKey(options: {
  override?: string | null
  meetingTemplateKey?: string | null
  workspaceTemplate?: string | null
}): string {
  for (const key of [options.override, options.meetingTemplateKey, options.workspaceTemplate]) {
    if (key && isValidTemplateKey(key)) return key
  }

  return AUTO_TEMPLATE_KEY
}

/**
 * The template a summary uses. `auto` (or an unresolvable key) maps the
 * classified meeting type to a built-in; Hebrew without a match uses
 * `hebrew_business`.
 */
export async function selectTemplate(
  workspaceId: string,
  requestedKey: string,
  options: { meetingType?: string; language: string }
): Promise<SummaryTemplateDef> {
  if (requestedKey !== AUTO_TEMPLATE_KEY) {
    const resolved = await resolveTemplate(workspaceId, requestedKey)

    if (resolved) return resolved
  }

  return BUILT_IN_TEMPLATES[templateForMeetingType(options.meetingType, options.language)]
}
