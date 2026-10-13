/**
 * Passage retrieval for AskMeetSum (docs/parity/m6.md, B6; owner: Package B).
 *
 * `retrievePassages(ctx, req)` takes the caller's SearchContext (build it
 * with `searchContextFrom(authCtx)`): every leg, the hydration and the
 * segment-text lookup are scoped to what that principal may read, and the
 * ask scope (meeting/room/workspace) narrows further via filters.
 */
import { scopeFilters } from "@/lib/search/filters"
import { getSearchEngine, rankCandidates, type RankedCandidate, type SearchEngine } from "@/lib/search/service"
import type { RetrieveRequest, RetrieveResult, RetrievedPassage, SearchContext } from "@/lib/search/types"

/** Passages per meeting in room and workspace scope. */
export const MAX_PASSAGES_PER_MEETING = 4
const MAX_QUESTION_CHARS = 2000

type Env = Record<string, string | undefined>

function envInt(env: Env, name: string, fallback: number): number {
  const value = Number(env[name])

  return Number.isInteger(value) && value > 0 ? value : fallback
}

/** The chunk's own segment ids (overlap skipped). */
function ownSegments(candidate: RankedCandidate): string[] {
  return candidate.chunk.segmentIds.slice(Math.max(0, candidate.chunk.overlapCount))
}

/** Retrieval query: the question, plus the previous user question for follow-ups. */
export function retrievalQuery(req: Pick<RetrieveRequest, "question" | "previousQuestion">): string {
  const question = req.question.trim().slice(0, MAX_QUESTION_CHARS)
  const previous = req.previousQuestion?.trim().slice(0, MAX_QUESTION_CHARS)

  return previous ? `${question} ${previous}` : question
}

export async function retrievePassages(
  ctx: SearchContext,
  req: RetrieveRequest,
  deps: { engine?: SearchEngine; env?: Env; signal?: AbortSignal } = {}
): Promise<RetrieveResult> {
  const env = deps.env ?? process.env
  const engine = deps.engine ?? (await getSearchEngine())
  const limit = Math.min(req.limit ?? envInt(env, "MEETSUM_ASK_MAX_PASSAGES", 12), 50)
  const budget = req.budgetTokens ?? envInt(env, "MEETSUM_ASK_CONTEXT_TOKENS", 12_000)
  const q = retrievalQuery(req)

  if (!q) return { passages: [], mode: "empty", topSimilarity: null, lexicalHits: 0 }

  const ranked = await rankCandidates(ctx, {
    q,
    filters: scopeFilters(req.scope),
    task: "QUESTION_ANSWERING",
    engine,
    signal: deps.signal,
  })
  const similarities = ranked.candidates
    .map((candidate) => candidate.legs.vector?.similarity)
    .filter((value): value is number => value !== undefined)
  const topSimilarity = similarities.length ? Math.max(...similarities) : null
  const lexicalHits = ranked.candidates.filter((candidate) => candidate.legs.fts || candidate.legs.trgm).length
  const capPerMeeting = req.scope.kind === "meeting" ? Number.POSITIVE_INFINITY : MAX_PASSAGES_PER_MEETING
  const perMeeting = new Map<string, number>()
  const coveredSegments = new Map<string, Set<string>>()
  const seenHashes = new Set<string>()
  const selected: RankedCandidate[] = []
  let used = 0

  for (const candidate of ranked.candidates) {
    if (selected.length >= limit) break

    const { chunk } = candidate
    const count = perMeeting.get(chunk.meetingId) ?? 0

    if (count >= capPerMeeting) continue

    const hashKey = `${chunk.meetingId}:${chunk.contentHash}`

    if (seenHashes.has(hashKey)) continue

    const own = ownSegments(candidate)
    const covered = coveredSegments.get(chunk.meetingId) ?? new Set<string>()

    // Overlap duplicate: every own segment is already in a selected passage.
    if (own.length && own.every((id) => covered.has(id))) continue
    if (used + chunk.tokenEstimate > budget) continue

    selected.push(candidate)
    used += chunk.tokenEstimate
    seenHashes.add(hashKey)
    perMeeting.set(chunk.meetingId, count + 1)
    for (const id of chunk.segmentIds) covered.add(id)
    coveredSegments.set(chunk.meetingId, covered)
  }

  const segmentIds = [...new Set(selected.flatMap(ownSegments))]
  const texts = segmentIds.length ? await engine.segmentTexts(ctx, segmentIds) : {}
  const passages: RetrievedPassage[] = selected.map((candidate) => {
    const { meeting, speakerNames, ...chunk } = candidate.chunk
    const segmentTexts = Object.fromEntries(
      ownSegments(candidate)
        .filter((id) => texts[id] !== undefined)
        .map((id) => [id, texts[id]])
    )

    return {
      chunk,
      meetingTitle: meeting.title,
      meetingStartedAt: meeting.startedAt,
      speakerNames,
      segmentTexts,
      score: candidate.score,
    }
  })

  return { passages, mode: ranked.mode, topSimilarity, lexicalHits }
}
