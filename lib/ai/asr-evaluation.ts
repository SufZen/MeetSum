export type WordErrorRateResult = {
  wer: number
  substitutions: number
  insertions: number
  deletions: number
  referenceWords: number
}

type EditCell = {
  cost: number
  substitutions: number
  insertions: number
  deletions: number
}

export function normalizeTranscriptForWer(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean)
}

function chooseBest(left: EditCell, right: EditCell) {
  if (left.cost !== right.cost) return left.cost < right.cost ? left : right
  const leftEdits = left.substitutions + left.insertions + left.deletions
  const rightEdits = right.substitutions + right.insertions + right.deletions

  return leftEdits <= rightEdits ? left : right
}

export function calculateWordErrorRate(
  reference: string,
  hypothesis: string
): WordErrorRateResult {
  const ref = normalizeTranscriptForWer(reference)
  const hyp = normalizeTranscriptForWer(hypothesis)
  const matrix: EditCell[][] = Array.from({ length: ref.length + 1 }, () =>
    Array.from({ length: hyp.length + 1 }, () => ({
      cost: 0,
      substitutions: 0,
      insertions: 0,
      deletions: 0,
    }))
  )

  for (let i = 1; i <= ref.length; i += 1) {
    matrix[i][0] = {
      ...matrix[i - 1][0],
      cost: matrix[i - 1][0].cost + 1,
      deletions: matrix[i - 1][0].deletions + 1,
    }
  }

  for (let j = 1; j <= hyp.length; j += 1) {
    matrix[0][j] = {
      ...matrix[0][j - 1],
      cost: matrix[0][j - 1].cost + 1,
      insertions: matrix[0][j - 1].insertions + 1,
    }
  }

  for (let i = 1; i <= ref.length; i += 1) {
    for (let j = 1; j <= hyp.length; j += 1) {
      if (ref[i - 1] === hyp[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1]
        continue
      }

      const substitution = {
        ...matrix[i - 1][j - 1],
        cost: matrix[i - 1][j - 1].cost + 1,
        substitutions: matrix[i - 1][j - 1].substitutions + 1,
      }
      const insertion = {
        ...matrix[i][j - 1],
        cost: matrix[i][j - 1].cost + 1,
        insertions: matrix[i][j - 1].insertions + 1,
      }
      const deletion = {
        ...matrix[i - 1][j],
        cost: matrix[i - 1][j].cost + 1,
        deletions: matrix[i - 1][j].deletions + 1,
      }

      matrix[i][j] = chooseBest(chooseBest(substitution, insertion), deletion)
    }
  }

  const result = matrix[ref.length][hyp.length]
  const referenceWords = ref.length

  return {
    wer: referenceWords ? result.cost / referenceWords : hyp.length ? 1 : 0,
    substitutions: result.substitutions,
    insertions: result.insertions,
    deletions: result.deletions,
    referenceWords,
  }
}
