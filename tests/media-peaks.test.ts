import { describe, expect, it } from "vitest"

import {
  downsamplePeaks,
  normalizePeaks,
  parsePeaksFile,
  type PeaksFile,
} from "@/lib/media/peaks"

describe("downsamplePeaks", () => {
  it("max-pools into the target number of buckets", () => {
    expect(downsamplePeaks([1, 5, 2, 8, 3, 0, 7, 4], 4)).toEqual([5, 8, 3, 7])
    expect(downsamplePeaks([1, 5, 2, 8, 3, 0, 7, 4], 2)).toEqual([8, 7])
    expect(downsamplePeaks([1, 5, 2, 8, 3, 0, 7, 4], 1)).toEqual([8])
  })

  it("covers every input sample when the length does not divide evenly", () => {
    const peaks = [9, 0, 0, 0, 0, 0, 0, 0, 0, 255]
    const result = downsamplePeaks(peaks, 3)

    expect(result).toHaveLength(3)
    expect(result[0]).toBe(9)
    expect(result[2]).toBe(255)
    expect(Math.max(...downsamplePeaks(peaks, 7))).toBe(255)
  })

  it("never upsamples and copies short inputs", () => {
    const peaks = [1, 2, 3]
    const result = downsamplePeaks(peaks, 10)

    expect(result).toEqual([1, 2, 3])
    expect(result).not.toBe(peaks)
  })

  it("accepts typed arrays and handles empty or invalid targets", () => {
    expect(downsamplePeaks(Uint8Array.from([1, 9, 3, 4]), 2)).toEqual([9, 4])
    expect(downsamplePeaks([], 5)).toEqual([])
    expect(downsamplePeaks([1, 2], 0)).toEqual([])
    expect(downsamplePeaks([1, 2], Number.NaN)).toEqual([])
  })

  it("keeps the global maximum for large inputs", () => {
    const peaks = Array.from({ length: 20000 }, (_, index) => (index === 12345 ? 255 : index % 50))
    const result = downsamplePeaks(peaks, 800)

    expect(result).toHaveLength(800)
    expect(Math.max(...result)).toBe(255)
  })
})

describe("normalizePeaks", () => {
  it("maps to 0..1 with gamma 0.6 by default", () => {
    const result = normalizePeaks([0, 64, 255], 255)

    expect(result[0]).toBe(0)
    expect(result[1]).toBeCloseTo(Math.pow(64 / 255, 0.6), 10)
    expect(result[2]).toBe(1)
  })

  it("honours a custom gamma and clamps out-of-range values", () => {
    expect(normalizePeaks([50, 100, 200], 100, 1)).toEqual([0.5, 1, 1])
    expect(normalizePeaks([-5, Number.NaN], 100, 1)).toEqual([0, 0])
  })

  it("lifts quiet values (gamma < 1)", () => {
    const [quiet] = normalizePeaks([10], 255)

    expect(quiet).toBeGreaterThan(10 / 255)
  })

  it("returns zeros when max is not positive", () => {
    expect(normalizePeaks([1, 2, 3], 0)).toEqual([0, 0, 0])
    expect(normalizePeaks([1, 2], Number.NaN)).toEqual([0, 0])
  })
})

describe("parsePeaksFile", () => {
  const file: PeaksFile = {
    v: 1,
    durationMs: 3000,
    sampleRate: 8000,
    samplesPerPeak: 400,
    max: 200,
    peaks: [0, 100, 200],
  }

  it("accepts a valid file as object or JSON text", () => {
    expect(parsePeaksFile(file)).toEqual(file)
    expect(parsePeaksFile(JSON.stringify(file))).toEqual(file)
  })

  it("rejects malformed files", () => {
    expect(parsePeaksFile(null)).toBeNull()
    expect(parsePeaksFile("nope")).toBeNull()
    expect(parsePeaksFile([])).toBeNull()
    expect(parsePeaksFile({ ...file, v: 2 })).toBeNull()
    expect(parsePeaksFile({ ...file, sampleRate: 0 })).toBeNull()
    expect(parsePeaksFile({ ...file, samplesPerPeak: -1 })).toBeNull()
    expect(parsePeaksFile({ ...file, durationMs: "3000" })).toBeNull()
    expect(parsePeaksFile({ ...file, peaks: [1, 256] })).toBeNull()
    expect(parsePeaksFile({ ...file, peaks: [1, "2"] })).toBeNull()
    expect(parsePeaksFile({ ...file, peaks: undefined })).toBeNull()
  })
})
