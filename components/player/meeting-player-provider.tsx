"use client"

/**
 * One player per selected meeting (M4 C2).
 *
 * Owns the hidden <audio> element (the clock), an optional muted <video>
 * that follows it, and an external store read with `useSyncExternalStore`.
 * Without media, seeking still moves the cursor so the transcript, citations
 * and the speaker timeline keep working ("transcript only").
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"

import type { TranscriptSegmentWire } from "@/lib/meetings/transcript-wire"
import type { MeetingMediaSummary, PlaybackVariant } from "@/lib/media/playback-select"
import { resolveCitation, type PlayerMarker, type ResolvedCitation } from "@/lib/player/citations"
import { withoutTimeParam } from "@/lib/player/deep-link"
import { nextRate, readPlayerPrefs, writePlayerPref } from "@/lib/player/rate"
import { createPlayerStore, type PlayerState, type PlayerStore } from "@/lib/player/store"
import { formatClock } from "@/lib/player/time-format"
import { formatMessage, type Dictionary } from "@/lib/i18n/dictionaries"

export type SeekSource =
  | "transcript"
  | "scrubber"
  | "keyboard"
  | "citation"
  | "action_item"
  | "quote"
  | "deep_link"
  | "marker"
  | "speaker_bar"
  | "search"

export type SeekOptions = {
  play?: boolean
  source: SeekSource
  segmentId?: string
}

export type SeekEvent = { ms: number; source: SeekSource; segmentId?: string; segmentIndex: number }

export type PlayerCommand = "focusSearch" | "toggleFollow" | "help" | "openTranscript"

type Listener<T> = (value: T) => void

export type MeetingPlayerApi = {
  /** False outside a provider: every call is a no-op. */
  available: boolean
  hasMedia: boolean
  media?: MeetingMediaSummary
  mediaBaseUrl?: string
  store: PlayerStore
  segments: readonly TranscriptSegmentWire[]
  /** Deep-link start (`?t=`), until the user plays. */
  resumeMs?: number
  markers: readonly PlayerMarker[]
  seek: (ms: number, options: SeekOptions) => void
  toggle: () => void
  play: () => void
  pause: () => void
  skip: (deltaMs: number) => void
  setRate: (rate: number) => void
  stepRate: (step: 1 | -1) => void
  setVolume: (volume: number) => void
  toggleMute: () => void
  setVariant: (variant: PlaybackVariant) => void
  setFollow: (follow: boolean) => void
  retry: () => void
  registerVideo: (element: HTMLVideoElement | null) => void
  requestPictureInPicture: () => void
  resolve: (source: { segmentId?: string; startMs?: number }) => ResolvedCitation | undefined
  /** Speaker display name of a segment (citation peek, announcements). */
  speakerNameAt: (segmentIndex: number) => string | undefined
  setSearchMarkers: (markers: PlayerMarker[]) => void
  subscribeSeek: (listener: Listener<SeekEvent>) => () => void
  subscribeCommand: (listener: Listener<PlayerCommand>) => () => void
  emitCommand: (command: PlayerCommand) => void
}

const ANNOUNCED_SOURCES = new Set<SeekSource>([
  "transcript",
  "citation",
  "action_item",
  "quote",
  "deep_link",
  "marker",
  "speaker_bar",
])

const noop = () => undefined
const noopUnsubscribe = () => noop
const fallbackStore = createPlayerStore()

const FALLBACK_API: MeetingPlayerApi = {
  available: false,
  hasMedia: false,
  store: fallbackStore,
  segments: [],
  markers: [],
  seek: noop,
  toggle: noop,
  play: noop,
  pause: noop,
  skip: noop,
  setRate: noop,
  stepRate: noop,
  setVolume: noop,
  toggleMute: noop,
  setVariant: noop,
  setFollow: noop,
  retry: noop,
  registerVideo: noop,
  requestPictureInPicture: noop,
  resolve: () => undefined,
  speakerNameAt: () => undefined,
  setSearchMarkers: noop,
  subscribeSeek: noopUnsubscribe,
  subscribeCommand: noopUnsubscribe,
  emitCommand: noop,
}

const PlayerContext = createContext<MeetingPlayerApi>(FALLBACK_API)

export function useMeetingPlayer(): MeetingPlayerApi {
  return useContext(PlayerContext)
}

/** Subscribes to one derived value; re-renders only when it changes. */
export function usePlayerState<T>(selector: (state: PlayerState) => T): T {
  const { store } = useContext(PlayerContext)

  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState())
  )
}

function lastEndMs(segments: readonly TranscriptSegmentWire[]): number {
  let end = 0

  for (const segment of segments) if (segment.endMs > end) end = segment.endMs

  return end
}

function bufferedEnd(element: HTMLMediaElement): number {
  const { buffered, currentTime } = element

  for (let index = 0; index < buffered.length; index += 1) {
    if (buffered.start(index) <= currentTime && buffered.end(index) >= currentTime) {
      return buffered.end(index) * 1000
    }
  }

  return 0
}

export function MeetingPlayerProvider({
  meetingId,
  mediaBaseUrl,
  media,
  segments,
  durationMs: knownDurationMs,
  initialMs,
  markers = [],
  dictionary,
  speakerName,
  children,
}: {
  meetingId: string
  /** `/api/meetings/<id>` or `/api/share/<token>`; media is `${base}/media`. */
  mediaBaseUrl?: string
  media?: MeetingMediaSummary
  segments: readonly TranscriptSegmentWire[]
  durationMs?: number
  /** `?t=` deep link, applied after metadata loads (never autoplays). */
  initialMs?: number
  markers?: readonly PlayerMarker[]
  dictionary: Dictionary
  /** Display name of a segment's speaker for live announcements. */
  speakerName?: (segment: TranscriptSegmentWire) => string | undefined
  children: ReactNode
}) {
  const hasMedia = Boolean(media?.available && mediaBaseUrl)
  const [store] = useState(() =>
    createPlayerStore({
      durationMs: media?.durationMs ?? knownDurationMs ?? lastEndMs(segments),
      error: hasMedia ? undefined : "no_media",
    })
  )
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const frameRef = useRef<number | null>(null)
  const seekListeners = useRef(new Set<Listener<SeekEvent>>())
  const commandListeners = useRef(new Set<Listener<PlayerCommand>>())
  // The deep-link target doubles as the "Resume at" chip until the user plays
  // or seeks. `initialMs` may arrive after mount (read from the URL).
  const [resumeMs, setResumeMs] = useState<number | undefined>(initialMs)
  const [seenInitialMs, setSeenInitialMs] = useState<number | undefined>(initialMs)

  if (initialMs !== seenInitialMs) {
    setSeenInitialMs(initialMs)
    setResumeMs(initialMs)
  }
  const [searchMarkers, setSearchMarkers] = useState<PlayerMarker[]>([])
  const [announcement, setAnnouncement] = useState("")
  const [reloadKey, setReloadKey] = useState(0)
  const segmentsRef = useRef(segments)
  const speakerNameRef = useRef(speakerName)

  useEffect(() => {
    segmentsRef.current = segments
    speakerNameRef.current = speakerName
  }, [segments, speakerName])

  // Index the transcript whenever it changes.
  useEffect(() => {
    store.setSegments(segments)
    if (!hasMedia && store.getState().durationMs <= 0) {
      store.patch({ durationMs: knownDurationMs ?? lastEndMs(segments) })
    }
  }, [hasMedia, knownDurationMs, segments, store])

  // Detail (with media) may arrive after the list row the player mounted with.
  useEffect(() => {
    store.patch({ error: hasMedia ? undefined : "no_media" })
  }, [hasMedia, store])

  // Prefs (rate, volume) persist across meetings.
  useEffect(() => {
    const prefs = readPlayerPrefs(typeof window === "undefined" ? undefined : window.localStorage)

    store.patch({ rate: prefs.rate, volume: prefs.volume })
  }, [store])

  // Position the deep-link target (cursor only without media; never plays).
  useEffect(() => {
    if (resumeMs === undefined) return

    const audio = audioRef.current

    if (!hasMedia) {
      store.setTime(resumeMs, { force: true })
    } else if (audio && audio.readyState >= 1) {
      audio.currentTime = resumeMs / 1000
      store.setTime(resumeMs, { force: true })
    }
  }, [hasMedia, resumeMs, store])

  // Drop `t` from the URL once it has been consumed.
  useEffect(() => {
    if (initialMs === undefined || typeof window === "undefined") return

    const next = withoutTimeParam(window.location.search)

    if (next !== window.location.search) {
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${next}${window.location.hash}`)
    }
  }, [initialMs])

  const stopLoop = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = null
  }, [])

  const syncVideo = useCallback((force = false) => {
    const audio = audioRef.current
    const video = videoRef.current

    if (!audio || !video) return
    if (force || Math.abs(video.currentTime - audio.currentTime) > 0.3) {
      video.currentTime = audio.currentTime
    }
  }, [])

  const startLoop = useCallback(() => {
    stopLoop()

    const tick = () => {
      const audio = audioRef.current

      if (!audio) return
      store.setTime(audio.currentTime * 1000)
      syncVideo()
      frameRef.current = requestAnimationFrame(tick)
    }

    frameRef.current = requestAnimationFrame(tick)
  }, [stopLoop, store, syncVideo])

  useEffect(() => stopLoop, [stopLoop])

  const announceSeek = useCallback(
    (ms: number, segmentIndex: number) => {
      const segment = segmentsRef.current[segmentIndex]
      const name = segment ? speakerNameRef.current?.(segment) : undefined
      const time = formatClock(ms)

      setAnnouncement(
        name
          ? formatMessage(dictionary.playerPlayingFrom, { time, speaker: name })
          : formatMessage(dictionary.playerPlayingFromTime, { time })
      )
    },
    [dictionary.playerPlayingFrom, dictionary.playerPlayingFromTime]
  )

  const seek = useCallback(
    (ms: number, options: SeekOptions) => {
      const audio = audioRef.current
      const { durationMs } = store.getState()
      const target = Math.max(0, durationMs > 0 ? Math.min(ms, durationMs) : ms)

      setResumeMs(undefined)

      if (hasMedia && audio) {
        audio.currentTime = target / 1000
        syncVideo(true)
        if (options.play) void audio.play().catch(() => undefined)
      }

      store.setTime(target, { force: true })

      const segmentIndex = store.getState().activeSegmentIndex
      const event: SeekEvent = {
        ms: target,
        source: options.source,
        segmentIndex,
        ...(options.segmentId ? { segmentId: options.segmentId } : {}),
      }

      if (ANNOUNCED_SOURCES.has(options.source)) announceSeek(target, segmentIndex)
      for (const listener of seekListeners.current) listener(event)
    },
    [announceSeek, hasMedia, store, syncVideo]
  )

  const play = useCallback(() => {
    const audio = audioRef.current

    if (!hasMedia || !audio) return
    setResumeMs(undefined)
    void audio.play().catch(() => undefined)
  }, [hasMedia])

  const pause = useCallback(() => {
    audioRef.current?.pause()
  }, [])

  const toggle = useCallback(() => {
    const audio = audioRef.current

    if (!audio || !hasMedia) return
    if (audio.paused) play()
    else pause()
  }, [hasMedia, pause, play])

  const skip = useCallback(
    (deltaMs: number) => seek(store.getState().currentMs + deltaMs, { source: "keyboard" }),
    [seek, store]
  )

  const setRate = useCallback(
    (rate: number) => {
      if (audioRef.current) audioRef.current.playbackRate = rate
      if (videoRef.current) videoRef.current.playbackRate = rate
      store.patch({ rate })
      writePlayerPref(window.localStorage, "rate", rate)
    },
    [store]
  )

  const stepRate = useCallback(
    (step: 1 | -1) => setRate(nextRate(store.getState().rate, step)),
    [setRate, store]
  )

  const setVolume = useCallback(
    (volume: number) => {
      const clamped = Math.min(1, Math.max(0, volume))

      if (audioRef.current) {
        audioRef.current.volume = clamped
        audioRef.current.muted = clamped === 0
      }
      store.patch({ volume: clamped, muted: clamped === 0 })
      writePlayerPref(window.localStorage, "volume", clamped)
    },
    [store]
  )

  const toggleMute = useCallback(() => {
    const muted = !store.getState().muted

    if (audioRef.current) audioRef.current.muted = muted
    store.patch({ muted })
  }, [store])

  const setVariant = useCallback((variant: PlaybackVariant) => store.patch({ variant }), [store])
  const setFollow = useCallback((follow: boolean) => store.patch({ follow }), [store])

  const retry = useCallback(() => {
    store.patch({ error: undefined, ready: false })
    setReloadKey((key) => key + 1)
  }, [store])

  const registerVideo = useCallback(
    (element: HTMLVideoElement | null) => {
      videoRef.current = element

      if (!element) return
      element.muted = true
      element.playbackRate = store.getState().rate
      syncVideo(true)
      if (store.getState().playing) void element.play().catch(() => undefined)
    },
    [store, syncVideo]
  )

  const requestPictureInPicture = useCallback(() => {
    const video = videoRef.current

    if (!video || typeof document === "undefined") return
    if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => undefined)
    else void video.requestPictureInPicture?.().catch(() => undefined)
  }, [])

  const resolve = useCallback(
    (source: { segmentId?: string; startMs?: number }) =>
      resolveCitation(segmentsRef.current, store.index(), source),
    // `segments` is a dependency so consumers re-resolve after a transcript load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, segments]
  )

  const speakerNameAt = useCallback((segmentIndex: number) => {
    const segment = segmentsRef.current[segmentIndex]

    return segment ? speakerNameRef.current?.(segment) : undefined
  }, [])

  const subscribeSeek = useCallback((listener: Listener<SeekEvent>) => {
    seekListeners.current.add(listener)

    return () => {
      seekListeners.current.delete(listener)
    }
  }, [])

  const subscribeCommand = useCallback((listener: Listener<PlayerCommand>) => {
    commandListeners.current.add(listener)

    return () => {
      commandListeners.current.delete(listener)
    }
  }, [])

  const emitCommand = useCallback((command: PlayerCommand) => {
    for (const listener of commandListeners.current) listener(command)
  }, [])

  const allMarkers = useMemo(() => [...markers, ...searchMarkers], [markers, searchMarkers])

  const api = useMemo<MeetingPlayerApi>(
    () => ({
      available: true,
      hasMedia,
      ...(media ? { media } : {}),
      ...(mediaBaseUrl ? { mediaBaseUrl } : {}),
      store,
      segments,
      ...(resumeMs !== undefined ? { resumeMs } : {}),
      markers: allMarkers,
      seek,
      toggle,
      play,
      pause,
      skip,
      setRate,
      stepRate,
      setVolume,
      toggleMute,
      setVariant,
      setFollow,
      retry,
      registerVideo,
      requestPictureInPicture,
      resolve,
      speakerNameAt,
      setSearchMarkers,
      subscribeSeek,
      subscribeCommand,
      emitCommand,
    }),
    [
      allMarkers,
      emitCommand,
      hasMedia,
      media,
      mediaBaseUrl,
      pause,
      play,
      registerVideo,
      requestPictureInPicture,
      resolve,
      resumeMs,
      retry,
      seek,
      segments,
      setFollow,
      setRate,
      setVariant,
      setVolume,
      skip,
      speakerNameAt,
      stepRate,
      store,
      subscribeCommand,
      subscribeSeek,
      toggle,
      toggleMute,
    ]
  )

  const audioSrc = hasMedia ? `${mediaBaseUrl}/media?variant=audio` : undefined

  return (
    <PlayerContext.Provider value={api}>
      {children}
      {audioSrc ? (
        <audio
          key={`${meetingId}:${reloadKey}`}
          ref={audioRef}
          src={audioSrc}
          preload="metadata"
          hidden
          onLoadedMetadata={(event) => {
            const element = event.currentTarget
            const duration = Number.isFinite(element.duration) ? element.duration * 1000 : undefined
            const { rate, volume, muted } = store.getState()

            element.playbackRate = rate
            element.volume = volume
            element.muted = muted
            store.patch({
              ready: true,
              error: undefined,
              ...(duration ? { durationMs: duration } : {}),
            })

            if (resumeMs !== undefined) {
              element.currentTime = resumeMs / 1000
              store.setTime(resumeMs, { force: true })
            }
          }}
          onPlay={() => {
            store.patch({ playing: true })
            setResumeMs(undefined)
            if (videoRef.current) void videoRef.current.play().catch(() => undefined)
            startLoop()
          }}
          onPause={(event) => {
            store.patch({ playing: false })
            stopLoop()
            videoRef.current?.pause()
            store.setTime(event.currentTarget.currentTime * 1000, { force: true })
          }}
          onEnded={() => {
            store.patch({ playing: false })
            stopLoop()
          }}
          onSeeked={(event) => store.setTime(event.currentTarget.currentTime * 1000, { force: true })}
          onProgress={(event) => store.patch({ bufferedMs: bufferedEnd(event.currentTarget) })}
          onError={() => {
            stopLoop()
            store.patch({ error: "failed", playing: false, ready: false })
          }}
        />
      ) : null}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>
    </PlayerContext.Provider>
  )
}
