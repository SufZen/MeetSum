import type { PeaksFile } from "@/lib/media/peaks"

/**
 * Streaming waveform peaks from signed 16-bit little-endian mono PCM
 * (`ffmpeg -ac 1 -ar 8000 -f s16le`). Chunks may split a sample across a
 * byte boundary; the dangling byte is carried into the next chunk.
 */

export const DEFAULT_PEAKS_MAX_POINTS = 20_000
export const DEFAULT_PEAKS_SAMPLE_RATE = 8000
export const MIN_SAMPLES_PER_PEAK = 400

/** `max(400, ceil(totalSamples / maxPoints))`. */
export function computeSamplesPerPeak(
  totalSamples: number,
  maxPoints: number = DEFAULT_PEAKS_MAX_POINTS
): number {
  const points = Number.isFinite(maxPoints) && maxPoints > 0 ? Math.floor(maxPoints) : DEFAULT_PEAKS_MAX_POINTS
  const samples = Number.isFinite(totalSamples) && totalSamples > 0 ? totalSamples : 0

  return Math.max(MIN_SAMPLES_PER_PEAK, Math.ceil(samples / points))
}

export class PeaksAccumulator {
  readonly samplesPerPeak: number
  private readonly peaks: number[] = []
  private bucketMax = 0
  private bucketCount = 0
  private carry: number | undefined
  totalSamples = 0

  constructor(options: { samplesPerPeak: number }) {
    const value = Math.floor(options.samplesPerPeak)

    if (!Number.isFinite(value) || value <= 0) {
      throw new Error("samplesPerPeak must be a positive integer")
    }
    this.samplesPerPeak = value
  }

  private addSample(sample: number) {
    const magnitude = sample < 0 ? (sample === -32768 ? 32767 : -sample) : sample

    if (magnitude > this.bucketMax) this.bucketMax = magnitude
    this.bucketCount += 1
    this.totalSamples += 1

    if (this.bucketCount === this.samplesPerPeak) this.flushBucket()
  }

  private flushBucket() {
    this.peaks.push(Math.round((this.bucketMax / 32767) * 255))
    this.bucketMax = 0
    this.bucketCount = 0
  }

  push(chunk: Uint8Array) {
    let index = 0

    if (this.carry !== undefined && chunk.length > 0) {
      const raw = this.carry | (chunk[0] << 8)

      this.addSample(raw >= 0x8000 ? raw - 0x10000 : raw)
      this.carry = undefined
      index = 1
    }

    for (; index + 1 < chunk.length; index += 2) {
      const raw = chunk[index] | (chunk[index + 1] << 8)

      this.addSample(raw >= 0x8000 ? raw - 0x10000 : raw)
    }

    if (index < chunk.length) this.carry = chunk[index]
  }

  /** Flushes the partial last bucket; returns 0..255 peaks. */
  finish(): { peaks: number[]; totalSamples: number } {
    if (this.bucketCount > 0) this.flushBucket()

    return { peaks: this.peaks.slice(), totalSamples: this.totalSamples }
  }
}

export function buildPeaksFile(options: {
  peaks: number[]
  sampleRate: number
  samplesPerPeak: number
  durationMs: number
}): PeaksFile {
  let max = 0

  for (const peak of options.peaks) if (peak > max) max = peak

  return {
    v: 1,
    durationMs: Math.max(0, Math.round(options.durationMs)),
    sampleRate: options.sampleRate,
    samplesPerPeak: options.samplesPerPeak,
    max,
    peaks: options.peaks,
  }
}
