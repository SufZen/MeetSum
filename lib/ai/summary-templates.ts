/**
 * Summary template prompt addendums for different meeting types.
 * These are appended to the base summarization prompt to guide the AI
 * toward extracting domain-specific intelligence.
 */

export type SummaryTemplate =
  | "general"
  | "sales"
  | "real-estate"
  | "product"
  | "operations"
  | "legal"

export const SUMMARY_TEMPLATE_LABELS: Record<SummaryTemplate, string> = {
  general: "General Meeting",
  sales: "Sales Call",
  "real-estate": "Real Estate",
  product: "Product Review",
  operations: "Operations & Planning",
  legal: "Legal & Compliance",
}

export function getSummaryTemplatePrompt(template: SummaryTemplate): string {
  switch (template) {
    case "sales":
      return [
        "This is a sales call. Pay special attention to:",
        "- Lead qualification signals (budget, authority, need, timeline)",
        "- Objections raised and responses given",
        "- Next steps and follow-up commitments",
        "- Pricing discussed or quoted",
        "- Competitor mentions",
        "- Deal stage progression or regression signals",
        "Structure action items as sales follow-ups with clear owners and deadlines.",
      ].join("\n")

    case "real-estate":
      return [
        "This is a real estate meeting. Pay special attention to:",
        "- Property details (address, price, size, condition)",
        "- Client requirements and preferences",
        "- Financial terms (mortgage, commission, closing costs)",
        "- Legal obligations and deadlines (inspection, closing date)",
        "- Regulatory or zoning considerations",
        "- Counterparty positions and negotiation points",
        "Preserve all monetary amounts, dates, and property identifiers exactly.",
      ].join("\n")

    case "product":
      return [
        "This is a product review or planning meeting. Pay special attention to:",
        "- Feature decisions and priorities",
        "- Technical architecture or design decisions",
        "- Sprint/milestone commitments",
        "- Bug reports or quality issues discussed",
        "- User feedback referenced",
        "- Dependencies and blockers identified",
        "Structure action items as development tasks with assignees.",
      ].join("\n")

    case "operations":
      return [
        "This is an operations or planning meeting. Pay special attention to:",
        "- Process improvements discussed",
        "- Resource allocation decisions",
        "- Timeline and milestone adjustments",
        "- Risk identification and mitigation plans",
        "- Budget or cost discussions",
        "- Cross-team dependencies",
        "Structure action items as operational tasks with clear deadlines.",
      ].join("\n")

    case "legal":
      return [
        "This is a legal or compliance meeting. Pay special attention to:",
        "- Regulatory requirements discussed",
        "- Contract terms and conditions",
        "- Compliance deadlines and obligations",
        "- Risk assessments and liability considerations",
        "- Document review status",
        "- Approval or sign-off requirements",
        "Preserve all legal terms, dates, and party names exactly. Flag any uncertainty clearly.",
      ].join("\n")

    case "general":
    default:
      return ""
  }
}
