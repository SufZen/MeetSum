/**
 * Player store (M4, client-safe, framework-free).
 *
 * One external store per selected meeting, read with `useSyncExternalStore`.
 * The media element (or a cursor without media) feeds `setTime`; the store
 * derives the active segment/word by binary search and notifies only when
 * something a subscriber can see changed: the active segment or word, any
 * non-time field, or `currentMs` at most ~15 times per second.
 */
import { decodeWords, type TranscriptWord } from "@/lib/meetings/transcript-words"
import type { PlaybackVariant } from "@/lib/media/playback-select"
import {
  buildTranscriptIndex,
  findSegmentAt,
  findWordAt,
  type TranscriptIndex,
} from "@/lib/player/word-index"

export type PlayerError = "no_media" | "failed"

export type PlayerState = {
  currentMs: number
  durationMs: number
  playing: boolean
  rate: number
  volume: number
  muted: boolean
  /** End of the buffered range containing the playhead, in ms. */
  bufferedMs: number
  ready: boolean
  error?: PlayerError
  follow: boolean
  activeSegmentIndex: number
  activeWordIndex: number
  variant: PlaybackVariant
}

export type StoreSegment = {
  id: string
  startMs: number
  endMs: number
  revision?: number
  /** Encoded tuples (wire) or decoded words. */
  words?: unknown
}

export const TIME_EMIT_INTERVAL_MS = Math.round(1000 / 15)

export type PlayerStore = {
  getState: () => PlayerState
  subscribe: (listener: () => void) => () => void
  /** Playhead update; `force` emits immediately (explicit seeks). */
  setTime: (ms: number, options?: { force?: boolean }) => void
  patch: (partial: Partial<Omit<PlayerState, "activeSegmentIndex" | "activeWordIndex">>) => void
  setSegments: (segments: readonly StoreSegment[]) => void
  /** Decoded words of a segment (memoized by id + revision). */
  wordsFor: (segmentIndex: number) => TranscriptWord[]
  index: () => TranscriptIndex
}

function decodeSegmentWords(words: unknown): TranscriptWord[] {
  if (!Array.isArray(words) || words.length === 0) return []

  // Already-decoded objects (server-rendered share page) pass through.
  if (!Array.isArray(words[0]) && typeof words[0] === "object") return words as TranscriptWord[]

  return decodeWords(words)
}

export function createPlayerStore(
  initial: Partial<PlayerState> = {},
  { now = () => Date.now() }: { now?: () => number } = {}
): PlayerStore {
  let state: PlayerState = {
    currentMs: 0,
    durationMs: 0,
    playing: false,
    rate: 1,
    volume: 1,
    muted: false,
    bufferedMs: 0,
    ready: false,
    follow: true,
    activeSegmentIndex: -1,
    activeWordIndex: -1,
    variant: "audio",
    ...initial,
  }
  let segments: readonly StoreSegment[] = []
  let index: TranscriptIndex = buildTranscriptIndex([])
  const wordCache = new Map<string, TranscriptWord[]>()
  const listeners = new Set<() => void>()
  let lastEmit = Number.NEGATIVE_INFINITY

  const emit = () => {
    lastEmit = now()
    for (const listener of listeners) listener()
  }

  const wordsFor = (segmentIndex: number): TranscriptWord[] => {
    const segment = segments[segmentIndex]

    if (!segment) return []

    const key = `${segment.id}@${segment.revision ?? 0}`
    let words = wordCache.get(key)

    if (!words) {
      words = decodeSegmentWords(segment.words)
      wordCache.set(key, words)
    }

    return words
  }

  const derive = (ms: number) => {
    const { index: segmentIndex, inGap } = findSegmentAt(index, ms)
    const activeSegmentIndex = inGap ? -1 : segmentIndex
    const activeWordIndex = activeSegmentIndex >= 0 ? findWordAt(wordsFor(activeSegmentIndex), ms) : -1

    return { activeSegmentIndex, activeWordIndex }
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)

      return () => listeners.delete(listener)
    },
    setTime: (ms, options = {}) => {
      const clamped = Math.max(0, state.durationMs > 0 ? Math.min(ms, state.durationMs) : ms)
      const derived = derive(clamped)
      const activeChanged =
        derived.activeSegmentIndex !== state.activeSegmentIndex ||
        derived.activeWordIndex !== state.activeWordIndex
      const timeDue = options.force || now() - lastEmit >= TIME_EMIT_INTERVAL_MS

      if (!activeChanged && !timeDue) {
        // Keep the precise value for the next emit without notifying.
        state = { ...state, currentMs: clamped }
        return
      }

      state = { ...state, currentMs: clamped, ...derived }
      emit()
    },
    patch: (partial) => {
      let changed = false

      for (const key of Object.keys(partial) as (keyof typeof partial)[]) {
        if (state[key] !== partial[key]) {
          changed = true
          break
        }
      }

      if (!changed) return

      state = { ...state, ...partial }
      emit()
    },
    setSegments: (next) => {
      segments = next
      index = buildTranscriptIndex(next)
      state = { ...state, ...derive(state.currentMs) }
      emit()
    },
    wordsFor,
    index: () => index,
  }
}
