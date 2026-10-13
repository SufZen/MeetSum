/**
 * @deprecated Compatibility shim over the M5 template registry
 * (`lib/ai/templates`). The six legacy keys keep their English labels and
 * addenda; new code should use `resolveTemplate` and the section specs.
 */
import { BUILT_IN_TEMPLATES } from "@/lib/ai/templates/builtins"

export type SummaryTemplate =
  | "general"
  | "sales"
  | "real-estate"
  | "product"
  | "operations"
  | "legal"

export const SUMMARY_TEMPLATE_LABELS: Record<SummaryTemplate, string> = {
  general: BUILT_IN_TEMPLATES.general.name.en,
  sales: BUILT_IN_TEMPLATES.sales.name.en,
  "real-estate": BUILT_IN_TEMPLATES["real-estate"].name.en,
  product: BUILT_IN_TEMPLATES.product.name.en,
  operations: BUILT_IN_TEMPLATES.operations.name.en,
  legal: BUILT_IN_TEMPLATES.legal.name.en,
}

/** English prompt addendum of a legacy template ("" for general/unknown). */
export function getSummaryTemplatePrompt(template: SummaryTemplate): string {
  return BUILT_IN_TEMPLATES[template]?.promptAddendum.en ?? ""
}
