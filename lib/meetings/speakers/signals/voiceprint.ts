import type { SignalContext } from "@/lib/meetings/speakers/signals/context"

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (!a.length || a.length !== b.length) return 0

  let dot = 0
  let normA = 0
  let normB = 0

  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index]
    normA += a[index] * a[index]
    normB += b[index] * b[index]
  }

  return normA && normB ? dot / Math.sqrt(normA * normB) : 0
}

/**
 * voiceprint (only when MEETSUM_VOICEPRINT_MATCHING=true): cosine similarity
 * of the speaker's diarization embedding and a profile's voice embedding of
 * the same model ≥ threshold → 0.5 + (cos − threshold).
 */
export function voiceprintSignal(context: SignalContext, threshold: number) {
  for (const speaker of context.speakers) {
    if (!speaker.embedding?.length) continue

    for (const candidate of context.candidates) {
      if (!candidate.embedding?.length) continue
      if ((candidate.embeddingModel ?? null) !== (speaker.embeddingModel ?? null)) continue

      const cosine = cosineSimilarity(speaker.embedding, candidate.embedding)

      if (cosine < threshold) continue

      context.book.add(speaker.id, candidate.key, {
        kind: "voiceprint",
        detail: `Voice similarity ${cosine.toFixed(2)}`,
        weight: Number(Math.min(0.95, 0.5 + (cosine - threshold)).toFixed(3)),
      })
    }
  }
}
