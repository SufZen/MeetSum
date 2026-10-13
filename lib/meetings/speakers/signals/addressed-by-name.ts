import type { SpeakerCandidate } from "@/lib/meetings/speakers/candidates"
import { indexOfTokens, nameTokens } from "@/lib/meetings/speakers/names"
import type { SignalContext } from "@/lib/meetings/speakers/signals/context"
import { WORKSPACE_MEMORY_WEIGHT } from "@/lib/meetings/speakers/signals/self-intro"

export const ADDRESSED_WEIGHT_EACH = 0.15
export const ADDRESSED_WEIGHT_CAP = 0.45
/** The reply must start within this gap after the mention. */
export const ADDRESSED_MAX_GAP_MS = 5_000

/** First names and aliases a candidate is addressed by ("דנה, מה דעתך?"). */
function addressForms(candidate: SpeakerCandidate): Array<{ tokens: string[]; alias: boolean }> {
  const [full, first] = candidate.nameForms
  const own = [first ?? full].filter(Boolean).map((tokens) => ({ tokens, alias: false }))
  const aliases = candidate.aliasForms.map((tokens) => ({ tokens, alias: true }))

  return [...own, ...aliases].filter(
    (form) => form.tokens.join(" ").length >= 2
  )
}

/**
 * addressed_by_name: a speaker mentions a candidate's name and the next turn
 * (a different speaker, within 5 s) is that candidate → +0.15 per occurrence,
 * capped at 0.45; alias hits add workspace_memory (0.1).
 */
export function addressedByNameSignal(context: SignalContext) {
  const eligible = new Set(context.speakers.map((speaker) => speaker.id))
  const counts = new Map<string, { speakerId: string; candidate: SpeakerCandidate; count: number; alias: boolean }>()
  const forms = context.candidates.map((candidate) => ({
    candidate,
    forms: addressForms(candidate),
  }))

  context.segments.forEach((segment, index) => {
    let reply: (typeof context.segments)[number] | undefined

    for (let next = index + 1; next < context.segments.length; next += 1) {
      const candidate = context.segments[next]

      if (candidate.speakerId && candidate.speakerId !== segment.speakerId) {
        reply = candidate
        break
      }
    }

    if (
      !reply?.speakerId ||
      !eligible.has(reply.speakerId) ||
      reply.startMs - segment.endMs > ADDRESSED_MAX_GAP_MS
    ) {
      return
    }

    const tokens = nameTokens(segment.text)

    for (const { candidate, forms: candidateForms } of forms) {
      const hit = candidateForms.find((form) => indexOfTokens(tokens, form.tokens) >= 0)

      if (!hit) continue

      const key = `${reply.speakerId}\u0000${candidate.key}`
      const current = counts.get(key) ?? {
        speakerId: reply.speakerId,
        candidate,
        count: 0,
        alias: false,
      }

      current.count += 1
      current.alias ||= hit.alias
      counts.set(key, current)
    }
  })

  for (const { speakerId, candidate, count, alias } of counts.values()) {
    context.book.add(speakerId, candidate.key, {
      kind: "addressed_by_name",
      detail: `Answered after being addressed by name ${count}×`,
      weight: Number(Math.min(ADDRESSED_WEIGHT_CAP, ADDRESSED_WEIGHT_EACH * count).toFixed(3)),
    })
    if (alias) {
      context.book.add(speakerId, candidate.key, {
        kind: "workspace_memory",
        detail: `Addressed by a known alias of ${candidate.name}`,
        weight: WORKSPACE_MEMORY_WEIGHT,
      })
    }
  }
}
