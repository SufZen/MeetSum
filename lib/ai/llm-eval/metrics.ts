/**
 * Eval metrics (M5 D8): Wilson intervals, action-item matching against the
 * reference, pairwise verdict combination and the route decision rule.
 * Pure; no text leaves these functions except through counts.
 */
import { normalizeTaskTitle } from "@/lib/meetings/action-item-merge"
import type {
  EvalCriterion,
  EvalReferenceActionItem,
  ModelSpec,
  Verdict,
} from "@/lib/ai/llm-eval/types"

/** Wilson score interval for `successes / n` (z = 1.96 → 95%). */
export function wilsonInterval(successes: number, n: number, z = 1.96): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 0 }

  const p = successes / n
  const z2 = z * z
  const denominator = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denominator
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator

  return { low: Math.max(0, center - half), high: Math.min(1, center + half) }
}

/** Hebrew one-letter prefixes peeled from tokens longer than 3 letters. */
const HEBREW_PREFIX = /^[והבלמשכ](?=[א-ת]{3,})/u

export function titleTokens(title: string): Set<string> {
  return new Set(
    normalizeTaskTitle(title)
      .split(/\s+/)
      .map((token) => token.replace(HEBREW_PREFIX, ""))
      .filter((token) => token.length >= 2)
  )
}

/** Overlap coefficient |A∩B| / min(|A|,|B|). */
export function titleOverlap(a: string, b: string): number {
  const left = titleTokens(a)
  const right = titleTokens(b)

  if (!left.size || !right.size) return 0

  let shared = 0

  for (const token of left) if (right.has(token)) shared += 1

  return shared / Math.min(left.size, right.size)
}

export const TITLE_MATCH_THRESHOLD = 0.5

function sameOwner(a?: string, b?: string): boolean {
  const left = a?.trim().toLowerCase()
  const right = b?.trim().toLowerCase()

  return Boolean(left && right && (left === right || left.split(/\s+/)[0] === right.split(/\s+/)[0]))
}

export type ActionItemMatch = {
  predicted: number
  reference: number
  matched: number
  precision: number
  recall: number
  /** Matched pairs whose reference names an owner. */
  ownerExpected: number
  ownerMatched: number
  /** Matched pairs whose reference has a due date. */
  dueExpected: number
  dueMatched: number
}

/**
 * Greedy one-to-one matching by title overlap (≥ 0.5, best pair first);
 * owner (full or first name, case-insensitive) and `dueOn` (exact) are
 * scored on matched pairs.
 */
export function matchActionItems(
  predicted: EvalReferenceActionItem[],
  reference: EvalReferenceActionItem[]
): ActionItemMatch {
  const pairs: Array<{ p: number; r: number; score: number }> = []

  predicted.forEach((item, p) =>
    reference.forEach((ref, r) => {
      const score = titleOverlap(item.title, ref.title)

      if (score >= TITLE_MATCH_THRESHOLD) pairs.push({ p, r, score })
    })
  )
  pairs.sort((a, b) => b.score - a.score || a.p - b.p || a.r - b.r)

  const usedP = new Set<number>()
  const usedR = new Set<number>()
  let ownerExpected = 0
  let ownerMatched = 0
  let dueExpected = 0
  let dueMatched = 0

  for (const pair of pairs) {
    if (usedP.has(pair.p) || usedR.has(pair.r)) continue
    usedP.add(pair.p)
    usedR.add(pair.r)

    const ref = reference[pair.r]
    const item = predicted[pair.p]

    if (ref.owner) {
      ownerExpected += 1
      if (sameOwner(item.owner, ref.owner)) ownerMatched += 1
    }
    if (ref.dueOn) {
      dueExpected += 1
      if (item.dueOn === ref.dueOn) dueMatched += 1
    }
  }

  const matched = usedP.size

  return {
    predicted: predicted.length,
    reference: reference.length,
    matched,
    precision: predicted.length ? matched / predicted.length : reference.length ? 0 : 1,
    recall: reference.length ? matched / reference.length : 1,
    ownerExpected,
    ownerMatched,
    dueExpected,
    dueMatched,
  }
}

/**
 * Winner of one comparison judged in both orders. `ab` was judged with the
 * challenger as A, `ba` with it as B. Inconsistent verdicts count as a tie.
 */
export function combineVerdicts(
  ab: Verdict | undefined,
  ba: Verdict | undefined,
  challenger: ModelSpec,
  baseline: ModelSpec
): ModelSpec | "tie" | undefined {
  if (!ab || !ba) return undefined

  const first = ab === "tie" ? "tie" : ab === "A" ? challenger : baseline
  const second = ba === "tie" ? "tie" : ba === "B" ? challenger : baseline

  return first === second ? first : "tie"
}

export type WinTally = { wins: number; ties: number; losses: number }

export function tally(outcomes: Array<ModelSpec | "tie">, challenger: ModelSpec): WinTally {
  return outcomes.reduce<WinTally>(
    (acc, outcome) => {
      if (outcome === "tie") acc.ties += 1
      else if (outcome === challenger) acc.wins += 1
      else acc.losses += 1
      return acc
    },
    { wins: 0, ties: 0, losses: 0 }
  )
}

/** Win rate with ties as half a win, plus its Wilson 95% interval. */
export function winRate(t: WinTally): { n: number; rate: number; low: number; high: number } {
  const n = t.wins + t.ties + t.losses

  if (!n) return { n: 0, rate: 0, low: 0, high: 0 }

  const successes = t.wins + t.ties / 2

  return { n, rate: successes / n, ...wilsonInterval(successes, n) }
}

export function percentile(values: number[], p: number): number | null {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)

  if (!sorted.length) return null

  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))

  return sorted[index]
}

export function mean(values: number[]): number | null {
  const finite = values.filter((value) => Number.isFinite(value))

  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null
}

/** The criteria the route decision weighs (spec: faithfulness + fluency). */
export const DECISION_CRITERIA: readonly EvalCriterion[] = ["faithfulness", "hebrew_fluency"]

export type RouteDecision = {
  challenger: ModelSpec
  baseline: ModelSpec
  outcome: "adopt" | "keep_baseline" | "insufficient_data"
  reasons: string[]
}

/**
 * Decision rule (docs/parity/m5.md D8, generalized to any challenger vs the
 * baseline): adopt when the faithfulness + fluency win rate is ≥ 55% with a
 * Wilson lower bound > 45%, action-item recall is non-inferior (Δ ≥ −0.05)
 * and cost is at most 3× the baseline. Unknown cost → insufficient data.
 */
export function decideRoute(input: {
  challenger: ModelSpec
  baseline: ModelSpec
  quality: WinTally
  recallChallenger: number | null
  recallBaseline: number | null
  costChallenger: number | null
  costBaseline: number | null
}): RouteDecision {
  const reasons: string[] = []
  const quality = winRate(input.quality)
  let insufficient = false
  let pass = true

  if (!quality.n) {
    insufficient = true
    reasons.push("no judged comparisons")
  } else {
    const ok = quality.rate >= 0.55 && quality.low > 0.45

    pass &&= ok
    reasons.push(
      `quality win rate ${(quality.rate * 100).toFixed(1)}% (CI low ${(quality.low * 100).toFixed(1)}%) ${ok ? "meets" : "misses"} ≥55% / >45%`
    )
  }

  if (input.recallChallenger === null || input.recallBaseline === null) {
    insufficient = true
    reasons.push("recall unknown")
  } else {
    const delta = input.recallChallenger - input.recallBaseline
    const ok = delta >= -0.05

    pass &&= ok
    reasons.push(`recall Δ ${delta >= 0 ? "+" : ""}${delta.toFixed(3)} ${ok ? "non-inferior" : "inferior"} (≥ −0.05)`)
  }

  if (input.costChallenger === null || input.costBaseline === null || input.costBaseline <= 0) {
    insufficient = true
    reasons.push("cost unknown (set provider prices)")
  } else {
    const ratio = input.costChallenger / input.costBaseline
    const ok = ratio <= 3

    pass &&= ok
    reasons.push(`cost ${ratio.toFixed(2)}× baseline ${ok ? "within" : "over"} 3×`)
  }

  return {
    challenger: input.challenger,
    baseline: input.baseline,
    outcome: !pass ? "keep_baseline" : insufficient ? "insufficient_data" : "adopt",
    reasons,
  }
}
