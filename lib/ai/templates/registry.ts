/**
 * Template registry (owner: Package A). Step 0 stubs: only built-in keys,
 * with names and no sections; legacy keys carry their current English
 * addendum. Package A adds the real built-ins and merges `custom:<key>`
 * templates from Package D's store over their base template.
 */
import {
  getSummaryTemplatePrompt,
  SUMMARY_TEMPLATE_LABELS,
  type SummaryTemplate,
} from "@/lib/ai/summary-templates"
import {
  BUILT_IN_TEMPLATE_KEYS,
  isBuiltInTemplateKey,
  type BuiltInTemplateKey,
  type LocalizedText,
  type SummaryTemplateDef,
} from "@/lib/ai/templates/types"

const BUILT_IN_NAMES: Record<BuiltInTemplateKey, LocalizedText> = {
  general: { he: "פגישה כללית", en: SUMMARY_TEMPLATE_LABELS.general },
  sales: { he: "שיחת מכירה", en: SUMMARY_TEMPLATE_LABELS.sales },
  standup: { he: "סטנדאפ", en: "Stand-up" },
  one_on_one: { he: "שיחת 1:1", en: "One-on-one" },
  interview: { he: "ראיון", en: "Interview" },
  board_investor: { he: "דירקטוריון / משקיעים", en: "Board / investor" },
  hebrew_business: { he: "פגישה עסקית", en: "Hebrew business" },
  "real-estate": { he: "נדל״ן", en: SUMMARY_TEMPLATE_LABELS["real-estate"] },
  product: { he: "סקירת מוצר", en: SUMMARY_TEMPLATE_LABELS.product },
  operations: { he: "תפעול ותכנון", en: SUMMARY_TEMPLATE_LABELS.operations },
  legal: { he: "משפטי ורגולציה", en: SUMMARY_TEMPLATE_LABELS.legal },
}

const LEGACY_KEYS = new Set<string>(Object.keys(SUMMARY_TEMPLATE_LABELS))

function builtInTemplate(key: BuiltInTemplateKey): SummaryTemplateDef {
  const legacyAddendum = LEGACY_KEYS.has(key)
    ? getSummaryTemplatePrompt(key as SummaryTemplate)
    : ""

  return {
    key,
    builtIn: true,
    name: BUILT_IN_NAMES[key],
    description: { he: "", en: "" },
    promptAddendum: { he: legacyAddendum, en: legacyAddendum },
    sections: [],
  }
}

/** Templates available to a workspace (Step 0: built-ins only). */
export async function listTemplates(workspaceId: string): Promise<SummaryTemplateDef[]> {
  void workspaceId

  return BUILT_IN_TEMPLATE_KEYS.map(builtInTemplate)
}

/**
 * Resolves a template key for a workspace; undefined for `auto`, unknown
 * keys and (Step 0) `custom:<key>`.
 */
export async function resolveTemplate(
  workspaceId: string,
  key: string
): Promise<SummaryTemplateDef | undefined> {
  void workspaceId

  return isBuiltInTemplateKey(key) ? builtInTemplate(key) : undefined
}
