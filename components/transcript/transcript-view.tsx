"use client"

/**
 * Interactive transcript (M4 C4): virtualized rows in their own scroll
 * container, follow mode with "Back to playback", niqqud-insensitive search
 * with match navigation, speaker filter, copy with `?t=` links, inline edit
 * with optimistic save/rollback and undo, and speaker reassignment.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { AudioLinesIcon, InfoIcon } from "lucide-react"
import { toast } from "sonner"

import { useMeetingPlayer } from "@/components/player/meeting-player-provider"
import { useSpeakerDirectory } from "@/components/player/speaker-directory"
import { directionForLanguage, talkTimeShare } from "@/components/speaker-display"
import { SegmentRow } from "@/components/transcript/segment-row"
import { SpeakerPicker, type SpeakerChoice } from "@/components/transcript/speaker-picker"
import { TranscriptSkeleton } from "@/components/transcript/transcript-skeleton"
import { TranscriptToolbar, type SpeakerChip } from "@/components/transcript/transcript-toolbar"
import type { MeetingTranscriptHandle, TranscriptStatus } from "@/components/transcript/use-meeting-transcript"
import { Button } from "@/components/ui/button"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import { pluralMessage } from "@/lib/i18n/messages"
import type { MeetingParticipant, MeetingSpeaker } from "@/lib/meetings/repository"
import type { TranscriptSegmentWire } from "@/lib/meetings/transcript-wire"
import type { PlayerMarker } from "@/lib/player/citations"
import { buildSegmentLink, buildShareSegmentLink, formatSegmentCopy } from "@/lib/player/deep-link"
import {
  createEditHistory,
  forgetSegment,
  peekEdit,
  pushEdit,
  type EditEntry,
} from "@/lib/player/edit-history"
import { INITIAL_FOLLOW_STATE, followReducer, isOutsideFollowBand } from "@/lib/player/follow"
import { isEditableTarget } from "@/lib/player/keyboard"
import { withFallbackRange } from "@/lib/player/virtual-fallback"
import type { TokenMark } from "@/lib/player/segment-tokens"
import {
  createSearchIndex,
  searchIndex,
  segmentSpeakerKey,
  stepMatch,
} from "@/lib/player/transcript-search"
import { cn } from "@/lib/utils"

const SEARCH_DEBOUNCE_MS = 150
const MAX_SEARCH_MARKERS = 200
// Space is the play/pause shortcut, so it never counts as a scroll gesture here.
const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"])
const FLASH_SOURCES = new Set(["citation", "action_item", "quote", "search", "marker", "deep_link"])
const EMPTY_MARKS: readonly TokenMark[] = []

/** Position of `value` in a sorted array, or -1. */
function sortedIndexOf(sorted: readonly number[], value: number): number {
  let low = 0
  let high = sorted.length - 1

  while (low <= high) {
    const middle = (low + high) >>> 1

    if (sorted[middle] === value) return middle
    if (sorted[middle] < value) low = middle + 1
    else high = middle - 1
  }

  return -1
}

export function TranscriptView({
  dictionary: t,
  locale,
  meetingId,
  shareToken,
  meetingLanguage,
  segments,
  speakers,
  participants,
  status,
  canWrite = false,
  transcript,
  hasSummary = false,
  editedAfterSummary = false,
  onTranscriptChanged,
  header,
  fill = false,
  className,
  renderBeforeSegment,
  renderSegmentActions,
  renderSegmentBadges,
  selectedSegmentIds,
}: {
  dictionary: Dictionary
  locale: string
  meetingId?: string
  /** Read-only share page: links go to `/share/<token>?t=`. */
  shareToken?: string
  meetingLanguage?: string
  segments: readonly TranscriptSegmentWire[]
  speakers: readonly MeetingSpeaker[]
  participants: readonly MeetingParticipant[]
  status: TranscriptStatus
  canWrite?: boolean
  /** Mutations; omitted on read-only surfaces. */
  transcript?: MeetingTranscriptHandle
  hasSummary?: boolean
  editedAfterSummary?: boolean
  /** Speakers or text changed (refresh talk time / detail). */
  onTranscriptChanged?: () => void
  /** Rendered above the toolbar (speaker mapping, talk time). */
  header?: ReactNode
  /** Fill a height-constrained parent on large screens (meeting view). */
  fill?: boolean
  className?: string
  /** M5: content above a row (e.g. a chapter heading); rendered inside the virtual item. */
  renderBeforeSegment?: (segment: TranscriptSegmentWire, index: number) => ReactNode
  /** M5: extra hover actions of a row (comment, react, clip). */
  renderSegmentActions?: (segment: TranscriptSegmentWire, index: number) => ReactNode
  /** M5: always-visible badges of a row (comment count, reactions). */
  renderSegmentBadges?: (segment: TranscriptSegmentWire, index: number) => ReactNode
  /** M5: rows highlighted as selected (clip range). */
  selectedSegmentIds?: ReadonlySet<string>
}) {
  const player = useMeetingPlayer()
  const directory = useSpeakerDirectory(speakers, participants, t.speakersGenericLabel)
  const scrollRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const [onlyMatches, setOnlyMatches] = useState(false)
  const [selectedSpeakers, setSelectedSpeakers] = useState<ReadonlySet<string>>(() => new Set())
  const [currentMatch, setCurrentMatch] = useState(-1)
  const [follow, dispatchFollow] = useReducer(followReducer, INITIAL_FOLLOW_STATE)
  const [editing, setEditing] = useState<{ segmentId: string; draft?: string } | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [reassignId, setReassignId] = useState<string | null>(null)
  const [flashingId, setFlashingId] = useState<string | null>(null)
  const [editedThisSession, setEditedThisSession] = useState(false)
  const historyRef = useRef(createEditHistory())
  const followRef = useRef(follow)
  const canEdit = canWrite && Boolean(transcript) && !shareToken
  const meetingDir = directionForLanguage(meetingLanguage) ?? (locale === "he" ? "rtl" : "ltr")

  useEffect(() => {
    followRef.current = follow
    player.setFollow(follow.follow)
  }, [follow, player])

  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS)

    return () => window.clearTimeout(id)
  }, [query])

  /* ------------------------------------------------------------ search */

  const index = useMemo(() => createSearchIndex(segments), [segments])
  const matches = useMemo(
    () =>
      searchIndex(index, debouncedQuery, selectedSpeakers.size ? { speakerKeys: selectedSpeakers } : {}),
    [debouncedQuery, index, selectedSpeakers]
  )
  const marksBySegment = useMemo(() => {
    const map = new Map<number, TokenMark[]>()

    for (const match of matches) {
      const list = map.get(match.segmentIndex) ?? []

      list.push({ start: match.start, end: match.end, matchIndex: match.matchIndex })
      map.set(match.segmentIndex, list)
    }

    return map
  }, [matches])
  const visible = useMemo(() => {
    const result: number[] = []

    segments.forEach((segment, segmentIndex) => {
      if (selectedSpeakers.size && !selectedSpeakers.has(segmentSpeakerKey(segment))) return
      if (onlyMatches && debouncedQuery.trim() && !marksBySegment.has(segmentIndex)) return
      result.push(segmentIndex)
    })

    return result
  }, [debouncedQuery, marksBySegment, onlyMatches, segments, selectedSpeakers])

  const { setSearchMarkers } = player

  useEffect(() => {
    const markers: PlayerMarker[] = matches.slice(0, MAX_SEARCH_MARKERS).map((match) => ({
      id: `match:${match.matchIndex}`,
      startMs: segments[match.segmentIndex]?.startMs ?? 0,
      kind: "search_match",
      label: segments[match.segmentIndex]?.text.slice(match.start, match.end) ?? "",
    }))

    setSearchMarkers(markers)
  }, [matches, segments, setSearchMarkers])

  useEffect(() => () => setSearchMarkers([]), [setSearchMarkers])

  /* ------------------------------------------------------ virtualizer */

  // TanStack Virtual is the spec'd virtualizer; React Compiler skips this component.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 88,
    overscan: 8,
    getItemKey: (position) => segments[visible[position]]?.id ?? position,
    useFlushSync: false,
  })

  const scrollToSegment = useCallback(
    (segmentIndex: number) => {
      const position = sortedIndexOf(visible, segmentIndex)

      if (position >= 0) virtualizer.scrollToIndex(position, { align: "center", behavior: "auto" })

      return position >= 0
    },
    [virtualizer, visible]
  )

  const isSegmentInBand = useCallback(
    (segmentIndex: number) => {
      const element = scrollRef.current
      const position = sortedIndexOf(visible, segmentIndex)
      const item = position >= 0 ? virtualizer.measurementsCache[position] : undefined

      if (!element || !item) return false

      return !isOutsideFollowBand({
        rowTop: item.start,
        rowBottom: item.end,
        viewportTop: element.scrollTop,
        viewportHeight: element.clientHeight,
      })
    },
    [virtualizer, visible]
  )

  // Opening the transcript (tab switch, "Open in transcript") lands on the playhead.
  const landedRef = useRef(false)

  useEffect(() => {
    if (landedRef.current || !visible.length) return

    const id = window.requestAnimationFrame(() => {
      landedRef.current = true

      const active = player.store.getState().activeSegmentIndex

      if (active >= 0) scrollToSegment(active)
    })

    return () => window.cancelAnimationFrame(id)
  }, [player.store, scrollToSegment, visible.length])

  // Follow the active segment without re-rendering on every tick.
  useEffect(() => {
    let previous = player.store.getState().activeSegmentIndex

    return player.store.subscribe(() => {
      const active = player.store.getState().activeSegmentIndex

      if (active === previous) return
      previous = active
      if (active < 0) return

      const inBand = isSegmentInBand(active)

      if (followRef.current.follow) {
        if (!inBand) scrollToSegment(active)
      } else {
        dispatchFollow({ type: "activeChanged", visible: inBand })
      }
    })
  }, [isSegmentInBand, player.store, scrollToSegment])

  // Seeks from elsewhere (citations, action items, markers…) land here.
  useEffect(
    () =>
      player.subscribeSeek((event) => {
        if (event.source === "transcript") return

        const segmentIndex = event.segmentId
          ? segments.findIndex((segment) => segment.id === event.segmentId)
          : event.segmentIndex

        if (segmentIndex < 0) return
        if (FLASH_SOURCES.has(event.source)) {
          dispatchFollow({ type: "resume" })
          scrollToSegment(segmentIndex)
          setFlashingId(segments[segmentIndex]?.id ?? null)
        } else if (followRef.current.follow && !isSegmentInBand(segmentIndex)) {
          scrollToSegment(segmentIndex)
        }
      }),
    [isSegmentInBand, player, scrollToSegment, segments]
  )

  useEffect(() => {
    if (!flashingId) return

    const id = window.setTimeout(() => setFlashingId(null), 1_300)

    return () => window.clearTimeout(id)
  }, [flashingId])

  // Shortcut commands from the player.
  useEffect(
    () =>
      player.subscribeCommand((command) => {
        if (command === "focusSearch") {
          searchRef.current?.focus()
          searchRef.current?.select()
        }
        if (command === "toggleFollow") {
          const next = !followRef.current.follow

          dispatchFollow({ type: "setFollow", value: next })
          if (next) {
            const active = player.store.getState().activeSegmentIndex

            if (active >= 0) scrollToSegment(active)
          }
        }
      }),
    [player, scrollToSegment]
  )

  // User scroll gestures pause follow (programmatic scrolls don't fire these).
  useEffect(() => {
    const element = scrollRef.current

    if (!element) return

    const pause = () => {
      if (followRef.current.follow || !followRef.current.showResume) dispatchFollow({ type: "userScroll" })
    }
    const onPointerDown = (event: PointerEvent) => {
      // Scrollbar drags hit the container itself.
      if (event.target === element) pause()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.code) && !isEditableTarget(event.target as HTMLElement)) pause()
    }

    element.addEventListener("wheel", pause, { passive: true })
    element.addEventListener("touchmove", pause, { passive: true })
    element.addEventListener("pointerdown", onPointerDown)
    element.addEventListener("keydown", onKeyDown)

    return () => {
      element.removeEventListener("wheel", pause)
      element.removeEventListener("touchmove", pause)
      element.removeEventListener("pointerdown", onPointerDown)
      element.removeEventListener("keydown", onKeyDown)
    }
  }, [status])

  const resumeFollow = () => {
    dispatchFollow({ type: "resume" })

    const active = player.store.getState().activeSegmentIndex

    if (active >= 0) scrollToSegment(active)
  }

  const stepSearch = (direction: 1 | -1) => {
    const next = stepMatch(currentMatch, matches.length, direction)

    setCurrentMatch(next)
    if (next < 0) return
    dispatchFollow({ type: "searchJump" })
    scrollToSegment(matches[next].segmentIndex)
  }

  /* ------------------------------------------------------- row actions */

  const onSeek = useCallback(
    (ms: number, segmentIndex: number, segmentId: string) => {
      dispatchFollow({ type: "userSeekFromTranscript" })
      player.seek(ms, { source: "transcript", segmentId })
      void segmentIndex
    },
    [player]
  )

  const onCopy = useCallback(
    (segmentId: string, withText: boolean) => {
      const segment = segments.find((candidate) => candidate.id === segmentId)

      if (!segment) return

      const origin = window.location.origin
      const link = shareToken
        ? buildShareSegmentLink({ origin, token: shareToken, ms: segment.startMs })
        : meetingId
          ? buildSegmentLink({ origin, locale, meetingId, ms: segment.startMs })
          : origin
      const text = withText
        ? formatSegmentCopy({
            ms: segment.startMs,
            speaker: directory.forSegment(segment).name,
            text: segment.text,
            link,
          })
        : link

      void navigator.clipboard
        .writeText(text)
        .then(() => toast.success(t.transcriptCopied))
        .catch(() => undefined)
    },
    [directory, locale, meetingId, segments, shareToken, t.transcriptCopied]
  )

  const undo = useCallback(
    async (entry: EditEntry | undefined) => {
      if (!transcript) return
      if (!entry) {
        toast.info(t.transcriptNothingToUndo)
        return
      }

      const outcome = await transcript.undoSegment(entry.segmentId, entry.revision)

      historyRef.current = forgetSegment(historyRef.current, entry.segmentId)

      if (outcome.ok) {
        // A turn undo restores every segment of the turn at once (M9 B5).
        transcript.applyMutation(outcome.response)
        if (entry.kind === "speaker") transcript.refetch()
        onTranscriptChanged?.()
        toast.success(
          entry.kind === "speaker"
            ? pluralMessage(
                t,
                locale === "he" ? "he" : "en",
                "transcriptSpeakerUndone",
                outcome.response.segments?.length ?? 1
              )
            : t.transcriptUndone
        )
        return
      }
      if (outcome.conflict) {
        toast.error(t.transcriptEditConflict)
        transcript.refetch()
        return
      }

      toast.error(outcome.error === "nothing_to_undo" ? t.transcriptNothingToUndo : t.transcriptUndoFailed)
    },
    [locale, onTranscriptChanged, t, transcript]
  )

  const remember = useCallback(
    (entry: EditEntry, message: string) => {
      historyRef.current = pushEdit(historyRef.current, entry)
      setEditedThisSession(true)
      onTranscriptChanged?.()
      toast.success(message, {
        action: { label: t.transcriptUndo, onClick: () => void undo(entry) },
      })
    },
    [onTranscriptChanged, t.transcriptUndo, undo]
  )

  const onSaveEdit = useCallback(
    async (segmentId: string, text: string) => {
      const segment = segments.find((candidate) => candidate.id === segmentId)

      if (!transcript || !segment) return

      const previousText = segment.text

      transcript.setSegmentText(segmentId, text)
      setEditing(null)
      setSavingId(segmentId)

      const outcome = await transcript.patchSegment(segmentId, { revision: segment.revision ?? 0, text })

      setSavingId(null)

      if (outcome.ok) {
        transcript.applyMutation(outcome.response)
        remember(
          { segmentId, revision: outcome.response.segment.revision ?? 0, kind: "text" },
          t.transcriptEditSaved
        )
        return
      }
      if (outcome.conflict) {
        toast.error(t.transcriptEditConflict)
        if (outcome.segment && transcript.data) {
          transcript.applyMutation({ segment: outcome.segment, version: transcript.data.version })
        } else {
          transcript.refetch()
        }
        return
      }

      transcript.setSegmentText(segmentId, previousText)
      setEditing({ segmentId, draft: text })
      toast.error(t.transcriptEditFailed)
    },
    [remember, segments, t, transcript]
  )

  const onPickSpeaker = useCallback(
    async (segmentId: string, choice: SpeakerChoice) => {
      const segment = segments.find((candidate) => candidate.id === segmentId)

      if (!transcript || !segment) return

      const outcome = await transcript.patchSegment(segmentId, { revision: segment.revision ?? 0, ...choice })

      if (outcome.ok) {
        if (choice.scope === "turn") transcript.refetch()
        else transcript.applyMutation(outcome.response)
        remember(
          { segmentId, revision: outcome.response.segment.revision ?? 0, kind: "speaker" },
          t.transcriptSpeakerChanged
        )
        return
      }
      if (outcome.conflict) {
        toast.error(t.transcriptEditConflict)
        transcript.refetch()
        return
      }

      toast.error(t.transcriptEditFailed)
    },
    [remember, segments, t, transcript]
  )

  // Ctrl/⌘+Z undoes the latest edit of this session.
  useEffect(() => {
    if (!canEdit) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "KeyZ" || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return
      if (isEditableTarget(event.target as HTMLElement) || event.defaultPrevented) return

      const entry = peekEdit(historyRef.current)

      if (!entry) return
      event.preventDefault()
      void undo(entry)
    }

    window.addEventListener("keydown", onKeyDown)

    return () => window.removeEventListener("keydown", onKeyDown)
  }, [canEdit, undo])

  /* ------------------------------------------------------------ render */

  const speakerChips = useMemo<SpeakerChip[]>(() => {
    const seen = new Map<string, SpeakerChip>()
    const total = speakers.reduce((sum, speaker) => sum + speaker.talkTimeMs, 0)

    for (const segment of segments) {
      const key = segmentSpeakerKey(segment)

      if (seen.has(key)) continue

      const resolved = directory.forSegment(segment)
      const stats = segment.speakerId ? speakers.find((speaker) => speaker.id === segment.speakerId) : undefined

      seen.set(key, {
        key,
        name: resolved.name,
        initials: resolved.initials,
        color: resolved.color,
        ...(stats && total ? { share: talkTimeShare(stats.talkTimeMs, total) } : {}),
      })
    }

    return [...seen.values()]
  }, [directory, segments, speakers])

  const currentMatchIndex = currentMatch >= 0 ? (matches[currentMatch]?.matchIndex ?? -1) : -1
  // getVirtualItems() refreshes measurementsCache, so read it second.
  const virtualItems = virtualizer.getVirtualItems()
  const items = withFallbackRange(virtualItems, virtualizer.measurementsCache, visible.length)

  if (status !== "ready" && !segments.length) {
    return (
      <div className={cn("grid gap-3", className)}>
        {header}
        {status === "error" ? (
          <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-line bg-surface-2 p-6 text-center text-sm text-fg-3">
            {t.transcriptLoadFailed}
            {transcript ? (
              <Button variant="secondary" size="sm" onClick={transcript.refetch}>
                {t.playerRetry}
              </Button>
            ) : null}
          </div>
        ) : (
          <TranscriptSkeleton label={t.transcriptLoading} />
        )}
      </div>
    )
  }

  if (!segments.length) {
    return (
      <div className={cn("grid gap-3", className)}>
        {header}
        <div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed border-line bg-surface-2 p-6 text-center text-sm text-fg-3">
          {t.transcriptEmptyState}
        </div>
      </div>
    )
  }

  return (
    <div className={cn("flex min-h-0 flex-col gap-3", className)}>
      {header}
      {hasSummary && (editedAfterSummary || editedThisSession) ? (
        <p className="flex items-start gap-2 rounded-lg bg-info-soft px-3 py-2 text-sm text-info-text">
          <InfoIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          {t.transcriptEditedAfterSummary}
        </p>
      ) : null}
      <TranscriptToolbar
        ref={searchRef}
        dictionary={t}
        query={query}
        matchCount={matches.length}
        currentMatch={Math.max(0, currentMatch)}
        onlyMatches={onlyMatches}
        speakers={speakerChips}
        selectedSpeakers={selectedSpeakers}
        onQueryChange={(value) => {
          setQuery(value)
          setCurrentMatch(-1)
        }}
        onStep={stepSearch}
        onOnlyMatchesChange={setOnlyMatches}
        onToggleSpeaker={(key) =>
          setSelectedSpeakers((current) => {
            const next = new Set(current)

            if (next.has(key)) next.delete(key)
            else next.add(key)

            return next
          })
        }
        onClearSpeakers={() => setSelectedSpeakers(new Set())}
      />
      <div className={cn("relative min-h-0 flex-1", fill && "lg:min-h-64")}>
        <div
          ref={scrollRef}
          role="region"
          aria-label={t.transcriptListLabel}
          aria-busy={status === "loading" || undefined}
          tabIndex={0}
          className={cn(
            "ms-scrollbar h-[70svh] overflow-y-auto rounded-lg outline-none focus-visible:shadow-focus",
            fill && "lg:h-full"
          )}
        >
          {!visible.length ? (
            <div className="m-2 rounded-lg border border-dashed border-line bg-surface p-6 text-center text-sm text-fg-3">
              {t.transcriptNoMatches}
            </div>
          ) : null}
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {items.map((item) => {
              const segmentIndex = visible[item.index]
              const segment = segments[segmentIndex]

              if (!segment) return null

              const speaker = directory.forSegment(segment)
              const dir = directionForLanguage(segment.language) ?? meetingDir
              const nameButton = (
                <button
                  type="button"
                  className="min-w-0 truncate rounded-xs text-start font-semibold text-[color-mix(in_oklch,var(--c)_62%,var(--fg))] hover:underline focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent"
                  aria-label={`${t.transcriptReassign}: ${speaker.name}`}
                >
                  <bdi>{speaker.name}</bdi>
                </button>
              )

              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="absolute top-0 w-full pb-1"
                  style={{ left: 0, transform: `translateY(${item.start}px)` }}
                >
                  {renderBeforeSegment?.(segment, segmentIndex)}
                  <SegmentRow
                    segment={segment}
                    index={segmentIndex}
                    speaker={speaker}
                    dir={dir}
                    marks={marksBySegment.get(segmentIndex) ?? EMPTY_MARKS}
                    currentMatchIndex={currentMatchIndex}
                    canWrite={canEdit}
                    editing={editing?.segmentId === segment.id}
                    saving={savingId === segment.id}
                    flashing={flashingId === segment.id}
                    dictionary={t}
                    speakerSlot={
                      canEdit ? (
                        <SpeakerPicker
                          open={reassignId === segment.id}
                          onOpenChange={(open) => setReassignId(open ? segment.id : null)}
                          trigger={nameButton}
                          speakers={speakers}
                          currentSpeakerId={segment.speakerId}
                          describe={(candidate) =>
                            directory.forSegment({ speaker: candidate.label, speakerId: candidate.id })
                          }
                          dictionary={t}
                          onPick={(choice) => void onPickSpeaker(segment.id, choice)}
                        />
                      ) : undefined
                    }
                    onSeek={onSeek}
                    onStartEdit={(segmentId) => setEditing({ segmentId })}
                    onSaveEdit={(segmentId, text) => void onSaveEdit(segmentId, text)}
                    onCancelEdit={() => setEditing(null)}
                    onReassign={(segmentId) => setReassignId(segmentId)}
                    onCopy={onCopy}
                    draft={editing?.segmentId === segment.id ? editing.draft : undefined}
                    actionsSlot={renderSegmentActions?.(segment, segmentIndex)}
                    badgeSlot={renderSegmentBadges?.(segment, segmentIndex)}
                    selected={selectedSegmentIds?.has(segment.id) ?? false}
                  />
                </div>
              )
            })}
          </div>
        </div>
        {follow.showResume ? (
          <Button
            size="sm"
            className="absolute bottom-4 start-1/2 z-(--z-dock) -translate-x-1/2 animate-ms-pop rounded-full bg-fg text-surface shadow-3 hover:bg-fg rtl:translate-x-1/2"
            onClick={resumeFollow}
          >
            <AudioLinesIcon />
            {t.transcriptFollowResume}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
