/**
 * The e2e audio fixture (docs/parity/m10.md, "Fake ASR"): a deterministic
 * 30 s, 16 kHz mono tone sequence with no voice. Pure (no I/O): the fixture
 * script writes it, and the fake ASR reads the tone sequence back.
 *
 * Why a tone sequence: the app transcodes every upload to Opus before ASR
 * (lib/ai/asr/audio.ts), so the bytes the fake ASR receives are not the bytes
 * that were uploaded, and Opus output differs between ffmpeg builds. The fake
 * ASR therefore matches the uploaded file's SHA-256 first and, when that
 * misses, decodes the audio and compares the tone sequence (one tone per
 * second), which survives lossy transcoding.
 */

export const E2E_SAMPLE_RATE = 16_000
export const E2E_TONE_SECONDS = 30
/** Candidate tone frequencies (Hz): 400, 500, ..., 2900. */
export const E2E_TONE_GRID = Array.from({ length: 26 }, (_, index) => 400 + index * 100)

/** Grid indexes of the tones, one per second; `seed` selects the sequence. */
export function toneSequence(seed: number, seconds = E2E_TONE_SECONDS): number[] {
  return Array.from({ length: seconds }, (_, index) => (7 * index + seed) % E2E_TONE_GRID.length)
}

export function toneSignature(tones: number[]): string {
  return tones.join("-")
}

/** 16-bit PCM mono WAV of the tone sequence (raised-cosine fades, no clicks). */
export function toneWav(tones: number[], sampleRate = E2E_SAMPLE_RATE): Buffer {
  const fade = Math.round(sampleRate * 0.02)
  const samples = new Int16Array(tones.length * sampleRate)

  for (const [second, toneIndex] of tones.entries()) {
    const frequency = E2E_TONE_GRID[toneIndex]!

    for (let index = 0; index < sampleRate; index += 1) {
      const edge = Math.min(index, sampleRate - 1 - index)
      const envelope = edge < fade ? 0.5 - 0.5 * Math.cos((Math.PI * edge) / fade) : 1
      const value = 0.3 * envelope * Math.sin((2 * Math.PI * frequency * index) / sampleRate)

      samples[second * sampleRate + index] = Math.round(value * 32_767)
    }
  }

  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
  const header = Buffer.alloc(44)

  header.write("RIFF", 0, "latin1")
  header.writeUInt32LE(36 + data.byteLength, 4)
  header.write("WAVE", 8, "latin1")
  header.write("fmt ", 12, "latin1")
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write("data", 36, "latin1")
  header.writeUInt32LE(data.byteLength, 40)

  return Buffer.concat([header, data])
}

/** Goertzel power of `frequency` over `samples`. */
function goertzel(samples: Float32Array, frequency: number, sampleRate: number): number {
  const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / sampleRate)
  let previous = 0
  let beforePrevious = 0

  for (const sample of samples) {
    const current = sample + coefficient * previous - beforePrevious

    beforePrevious = previous
    previous = current
  }

  return previous * previous + beforePrevious * beforePrevious - coefficient * previous * beforePrevious
}

/**
 * Reads the tone sequence back from 16-bit LE mono PCM: the strongest grid
 * frequency in the middle half of each second, or -1 for a silent second.
 */
export function detectTones(pcm: Buffer, sampleRate = E2E_SAMPLE_RATE): number[] {
  const total = Math.floor(pcm.byteLength / 2)
  const seconds = Math.floor(total / sampleRate)
  const tones: number[] = []

  for (let second = 0; second < seconds; second += 1) {
    const start = second * sampleRate + Math.floor(sampleRate / 4)
    const window = new Float32Array(Math.floor(sampleRate / 2))

    for (let index = 0; index < window.length; index += 1) window[index] = pcm.readInt16LE((start + index) * 2) / 32_768

    let energy = 0

    for (const sample of window) energy += sample * sample
    if (energy / window.length < 1e-5) {
      tones.push(-1)
      continue
    }

    let best = -1
    let bestPower = 0

    for (const [index, frequency] of E2E_TONE_GRID.entries()) {
      const power = goertzel(window, frequency, sampleRate)

      if (power > bestPower) {
        best = index
        bestPower = power
      }
    }
    tones.push(best)
  }

  return tones
}

/** Share of `expected` tones found at the same position (0..1). */
export function toneMatch(expected: number[], detected: number[]): number {
  if (!expected.length) return 0

  let same = 0

  for (const [index, tone] of expected.entries()) if (detected[index] === tone) same += 1
  return same / expected.length
}
