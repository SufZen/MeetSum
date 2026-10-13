/**
 * Hebrew/English due-date parser (owner: Package B). Pure and isomorphic.
 * Step 0 stub: never recognises a date.
 */

export type DueDateParseOptions = {
  /** ISO datetime the phrase is relative to (usually the meeting start). */
  anchor: string
  /** IANA zone; default `Asia/Jerusalem`. */
  timeZone?: string
  /** 0 = Sunday (default). */
  weekStart?: number
  /** Last workday; 4 = Thursday (default). */
  workweekEnd?: number
  /** Numeric date order; default `DMY`. */
  dateOrder?: "DMY" | "MDY"
}

export type DueDateParseResult = {
  /** `YYYY-MM-DD`. */
  date: string
  /** explicit 0.95, weekday 0.9, relative count 0.85, period end 0.8. */
  confidence: number
  rule: string
  matched: string
}

export function parseDueDate(
  text: string,
  opts: DueDateParseOptions
): DueDateParseResult | null {
  void text
  void opts
  return null
}
