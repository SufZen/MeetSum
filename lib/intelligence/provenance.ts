/**
 * Provenance of a summary for the UI (cadence rule: the iris AI mark only
 * for AI-written content). A heuristic summary, or one where the chain fell
 * back (`fallbackUsed`), is shown as automatic, not AI.
 */
export type SummaryProvenance = "ai" | "auto"

export function summaryProvenance(
  generation: { provider?: string; fallbackUsed?: boolean } | undefined
): SummaryProvenance {
  if (!generation?.provider || generation.provider === "heuristic" || generation.fallbackUsed) return "auto"
  return "ai"
}
