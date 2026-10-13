/**
 * Waveform peaks (M4, client-safe).
 *
 * Stored as `<original-key-dir>/derived/<assetId>.peaks.v1.json`:
 * `{v:1, durationMs, sampleRate, samplesPerPeak, max, peaks}` where `peaks`
 * are per-bucket absolute maxima scaled to 0..255.
 */

export type PeaksFile = {
  v: 1
  durationMs: number
  sampleRate: number
  samplesPerPeak: number
  /** Largest value in `peaks` (normalization reference). */
  max: number
  peaks: number[]
}

export const DEFAULT_PEAKS_GAMMA = 0.6

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

/**
 * Validates a parsed (or JSON text) peaks file; returns `null` for anything
 * malformed so callers can fall back to a flat bar.
 */
export function parsePeaksFile(json: unknown): PeaksFile | null {
  let value = json

  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) return null

  const candidate = value as Record<string, unknown>

  if (candidate.v !== 1) return null
  if (!isNonNegativeFinite(candidate.durationMs)) return null
  if (!isNonNegativeFinite(candidate.sampleRate) || candidate.sampleRate === 0) return null
  if (!isNonNegativeFinite(candidate.samplesPerPeak) || candidate.samplesPerPeak === 0) {
    return null
  }
  if (!isNonNegativeFinite(candidate.max)) return null
  if (!Array.isArray(candidate.peaks)) return null

  const peaks = candidate.peaks

  for (const peak of peaks) {
    if (!isNonNegativeFinite(peak) || peak > 255) return null
  }

  return {
    v: 1,
    durationMs: candidate.durationMs,
    sampleRate: candidate.sampleRate,
    samplesPerPeak: candidate.samplesPerPeak,
    max: candidate.max,
    peaks: peaks as number[],
  }
}

/**
 * Max-pools `peaks` into at most `targetLength` buckets (one per pixel
 * column). Never upsamples: shorter inputs are returned as a copy.
 */
export function downsamplePeaks(peaks: ArrayLike<number>, targetLength: number): number[] {
  const length = peaks.length
  const target = Math.floor(targetLength)

  if (!Number.isFinite(target) || target <= 0 || length === 0) return []
  if (length <= target) return Array.from(peaks)

  const result = new Array<number>(target)

  for (let bucket = 0; bucket < target; bucket += 1) {
    const start = Math.floor((bucket * length) / target)
    const end = Math.max(start + 1, Math.floor(((bucket + 1) * length) / target))
    let max = peaks[start]

    for (let index = start + 1; index < end; index += 1) {
      if (peaks[index] > max) max = peaks[index]
    }

    result[bucket] = max
  }

  return result
}

/**
 * Maps peaks to 0..1 bar heights: `(peak / max) ^ gamma`, clamped. Gamma
 * < 1 lifts quiet speech so the waveform stays readable. `max <= 0` (silence
 * or a broken file) yields all zeros.
 */
export function normalizePeaks(
  peaks: ArrayLike<number>,
  max: number,
  gamma: number = DEFAULT_PEAKS_GAMMA
): number[] {
  const result = new Array<number>(peaks.length)

  if (!Number.isFinite(max) || max <= 0) return result.fill(0)

  const exponent = Number.isFinite(gamma) && gamma > 0 ? gamma : 1

  for (let index = 0; index < peaks.length; index += 1) {
    const value = peaks[index]
    const ratio = Number.isFinite(value) ? Math.min(1, Math.max(0, value / max)) : 0

    result[index] = ratio === 0 ? 0 : Math.pow(ratio, exponent)
  }

  return result
}
