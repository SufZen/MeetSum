/**
 * Diarization error rate (DER) for the ASR eval harness (M3 C2).
 *
 * Frame-based (10 ms), with a no-score collar around every reference turn
 * boundary, overlapped speech counted once per reference speaker, and an
 * optimal one-to-one reference→hypothesis speaker mapping (Hungarian).
 */

export type SpeakerTurn = {
  speaker: string
  startMs: number
  endMs: number
}

export type DerResult = {
  der: number
  missMs: number
  falseAlarmMs: number
  confusionMs: number
  refSpeechMs: number
  refSpeakers: number
  hypSpeakers: number
}

export type DerOptions = {
  /** No-score collar on each side of every reference boundary (ms). */
  collarMs?: number
  /** Frame size (ms). */
  frameMs?: number
}

export const DEFAULT_DER_COLLAR_MS = 250
const DEFAULT_FRAME_MS = 10

function speakerIndex(turns: readonly SpeakerTurn[]) {
  const names = [...new Set(turns.map((turn) => turn.speaker))]

  return { names, index: new Map(names.map((name, i) => [name, i])) }
}

function frameRange(startMs: number, endMs: number, frameMs: number) {
  return [Math.max(0, Math.round(startMs / frameMs)), Math.max(0, Math.round(endMs / frameMs))]
}

/** Max speakers per side: frames are 32-bit speaker bitmasks. */
const MAX_SPEAKERS = 32

function bitCount(value: number) {
  let v = value - ((value >>> 1) & 0x55555555)
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)

  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

/** Per-frame active speakers as bitmasks: bit i = speaker i speaks. */
function framesOf(
  turns: readonly SpeakerTurn[],
  index: Map<string, number>,
  totalFrames: number,
  frameMs: number
) {
  if (index.size > MAX_SPEAKERS) {
    throw new Error(`DER supports at most ${MAX_SPEAKERS} speakers per side`)
  }

  const frames = new Uint32Array(totalFrames)

  for (const turn of turns) {
    const speaker = index.get(turn.speaker)

    if (speaker === undefined || turn.endMs <= turn.startMs) continue

    const [start, end] = frameRange(turn.startMs, turn.endMs, frameMs)
    const bit = (1 << speaker) >>> 0

    for (let f = start; f < Math.min(end, totalFrames); f += 1) frames[f] |= bit
  }

  return frames
}

/**
 * Hungarian algorithm (Kuhn–Munkres) on a square cost matrix; returns the
 * column assigned to each row. O(n³).
 */
export function hungarian(cost: number[][]): number[] {
  const n = cost.length
  const u = new Array<number>(n + 1).fill(0)
  const v = new Array<number>(n + 1).fill(0)
  const p = new Array<number>(n + 1).fill(0)
  const way = new Array<number>(n + 1).fill(0)

  for (let i = 1; i <= n; i += 1) {
    p[0] = i
    let j0 = 0
    const minv = new Array<number>(n + 1).fill(Infinity)
    const used = new Array<boolean>(n + 1).fill(false)

    do {
      used[j0] = true
      const i0 = p[j0]
      let delta = Infinity
      let j1 = 0

      for (let j = 1; j <= n; j += 1) {
        if (used[j]) continue
        const current = cost[i0 - 1][j - 1] - u[i0] - v[j]

        if (current < minv[j]) {
          minv[j] = current
          way[j] = j0
        }
        if (minv[j] < delta) {
          delta = minv[j]
          j1 = j
        }
      }

      for (let j = 0; j <= n; j += 1) {
        if (used[j]) {
          u[p[j]] += delta
          v[j] -= delta
        } else {
          minv[j] -= delta
        }
      }

      j0 = j1
    } while (p[j0] !== 0)

    do {
      const j1 = way[j0]
      p[j0] = p[j1]
      j0 = j1
    } while (j0)
  }

  const assignment = new Array<number>(n).fill(-1)

  for (let j = 1; j <= n; j += 1) {
    if (p[j]) assignment[p[j] - 1] = j - 1
  }

  return assignment
}

/** Reference→hypothesis speaker mapping that maximizes total overlap. */
function optimalMapping(overlap: number[][], refCount: number, hypCount: number) {
  const n = Math.max(refCount, hypCount)

  if (!n) return new Map<number, number>()

  const max = Math.max(0, ...overlap.flat())
  const cost = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => max - (overlap[i]?.[j] ?? 0))
  )
  const assignment = hungarian(cost)
  const mapping = new Map<number, number>()

  assignment.forEach((j, i) => {
    if (i < refCount && j >= 0 && j < hypCount && (overlap[i]?.[j] ?? 0) > 0) {
      mapping.set(i, j)
    }
  })

  return mapping
}

export function computeDer(
  reference: readonly SpeakerTurn[],
  hypothesis: readonly SpeakerTurn[],
  options: DerOptions = {}
): DerResult {
  const frameMs = options.frameMs ?? DEFAULT_FRAME_MS
  const collarMs = Math.max(0, options.collarMs ?? DEFAULT_DER_COLLAR_MS)
  const ref = speakerIndex(reference)
  const hyp = speakerIndex(hypothesis)
  const lastMs = Math.max(
    0,
    ...reference.map((turn) => turn.endMs + collarMs),
    ...hypothesis.map((turn) => turn.endMs)
  )
  const totalFrames = Math.ceil(lastMs / frameMs) + 1
  const refFrames = framesOf(reference, ref.index, totalFrames, frameMs)
  const hypFrames = framesOf(hypothesis, hyp.index, totalFrames, frameMs)
  const scored = new Array<boolean>(totalFrames).fill(true)

  if (collarMs > 0) {
    for (const turn of reference) {
      for (const boundary of [turn.startMs, turn.endMs]) {
        const [start, end] = frameRange(boundary - collarMs, boundary + collarMs, frameMs)

        for (let f = start; f < Math.min(end, totalFrames); f += 1) scored[f] = false
      }
    }
  }

  const overlap = Array.from({ length: ref.names.length }, () =>
    new Array<number>(hyp.names.length).fill(0)
  )

  for (let f = 0; f < totalFrames; f += 1) {
    if (!scored[f] || !refFrames[f] || !hypFrames[f]) continue
    for (let r = 0; r < ref.names.length; r += 1) {
      if (!(refFrames[f] & (1 << r))) continue
      for (let h = 0; h < hyp.names.length; h += 1) {
        if (hypFrames[f] & (1 << h)) overlap[r][h] += 1
      }
    }
  }

  const mapping = optimalMapping(overlap, ref.names.length, hyp.names.length)
  let refSpeech = 0
  let miss = 0
  let falseAlarm = 0
  let confusion = 0

  for (let f = 0; f < totalFrames; f += 1) {
    if (!scored[f]) continue

    const refCount = bitCount(refFrames[f])
    const hypCount = bitCount(hypFrames[f])
    let correct = 0

    if (refCount && hypCount) {
      for (const [r, h] of mapping) {
        if (refFrames[f] & (1 << r) && hypFrames[f] & (1 << h)) correct += 1
      }
    }

    refSpeech += refCount
    miss += Math.max(0, refCount - hypCount)
    falseAlarm += Math.max(0, hypCount - refCount)
    confusion += Math.min(refCount, hypCount) - correct
  }

  const errors = miss + falseAlarm + confusion

  return {
    der: refSpeech ? errors / refSpeech : errors ? 1 : 0,
    missMs: miss * frameMs,
    falseAlarmMs: falseAlarm * frameMs,
    confusionMs: confusion * frameMs,
    refSpeechMs: refSpeech * frameMs,
    refSpeakers: ref.names.length,
    hypSpeakers: hyp.names.length,
  }
}

/* ---------------------------------------------------------------- parsers */

export type TurnsFormat = "rttm" | "json" | "audacity"

function secondsToMs(value: string, context: string) {
  const seconds = Number(value)

  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`Invalid time '${value}' in ${context}`)
  }

  return Math.round(seconds * 1000)
}

/** NIST RTTM: `SPEAKER <file> <chan> <start> <dur> <NA> <NA> <speaker> …` (seconds). */
export function parseRttm(text: string): SpeakerTurn[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith(";"))
    .flatMap((line, index) => {
      const fields = line.split(/\s+/)

      if (fields[0] !== "SPEAKER") return []
      if (fields.length < 8) throw new Error(`Invalid RTTM line ${index + 1}`)

      const startMs = secondsToMs(fields[3], `RTTM line ${index + 1}`)
      const durationMs = secondsToMs(fields[4], `RTTM line ${index + 1}`)

      return [{ speaker: fields[7], startMs, endMs: startMs + durationMs }]
    })
}

/** Audacity label track: `<start>\t<end>\t<label>` (seconds). */
export function parseAudacityLabels(text: string): SpeakerTurn[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("\\"))
    .map((line, index) => {
      const [start, end, ...label] = line.split(/\t+|\s{2,}/)
      const speaker = label.join(" ").trim()

      if (!speaker) throw new Error(`Invalid Audacity label line ${index + 1}`)

      return {
        speaker,
        startMs: secondsToMs(start, `Audacity line ${index + 1}`),
        endMs: secondsToMs(end, `Audacity line ${index + 1}`),
      }
    })
}

function jsonTurn(value: unknown, index: number): SpeakerTurn {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Invalid JSON turn ${index}: must be an object`)
  }

  const turn = value as Record<string, unknown>
  const speaker = turn.speaker ?? turn.label

  if (typeof speaker !== "string" || !speaker) {
    throw new Error(`Invalid JSON turn ${index}: speaker is required`)
  }

  const time = (msKey: string, secondsKey: string) => {
    if (typeof turn[msKey] === "number") return turn[msKey] as number
    if (typeof turn[secondsKey] === "number") return Math.round((turn[secondsKey] as number) * 1000)

    throw new Error(`Invalid JSON turn ${index}: ${msKey} or ${secondsKey} is required`)
  }

  return { speaker, startMs: time("startMs", "start"), endMs: time("endMs", "end") }
}

/**
 * JSON turns: an array of `{speaker, startMs, endMs}` (or `start`/`end` in
 * seconds), `{turns: [...]}`, or an ASR result `{segments: [...]}`.
 */
export function parseJsonTurns(value: unknown): SpeakerTurn[] {
  const list = Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null
      ? ((value as Record<string, unknown>).turns ??
        (value as Record<string, unknown>).segments)
      : undefined

  if (!Array.isArray(list)) {
    throw new Error("Invalid JSON turns: expected an array, {turns} or {segments}")
  }

  return list.map(jsonTurn)
}

export function detectTurnsFormat(filename: string, text: string): TurnsFormat {
  const lower = filename.toLowerCase()

  if (lower.endsWith(".rttm")) return "rttm"
  if (lower.endsWith(".json")) return "json"
  if (lower.endsWith(".txt") || lower.endsWith(".labels")) {
    return /^\s*SPEAKER\s/m.test(text) ? "rttm" : "audacity"
  }

  const trimmed = text.trimStart()

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) return "json"
  return /^\s*SPEAKER\s/m.test(text) ? "rttm" : "audacity"
}

export function parseTurns(text: string, format: TurnsFormat): SpeakerTurn[] {
  if (format === "rttm") return parseRttm(text)
  if (format === "audacity") return parseAudacityLabels(text)

  return parseJsonTurns(JSON.parse(text))
}
