"use client"

/**
 * One model-written summary line (M5 D7, Cadence §10):
 * - provenance hairline split into the colours of the speakers it cites;
 *   a line a person edited is theirs and loses it (edit-to-own);
 * - citation chips only for refs that resolve to a real segment (no
 *   citation, no claim);
 * - a hover-revealed per-line flag instead of thumbs: flagging opens the
 *   cited transcript lines so the reader can check the claim.
 */
import { useMemo, useState, type ReactNode } from "react"
import { FlagIcon, PencilIcon } from "lucide-react"

import { CommentAnchor } from "@/components/comments/comment-anchor"
import { ReactionBar } from "@/components/comments/reaction-bar"
import { useMeetingPlayer } from "@/components/player/meeting-player-provider"
import { PlayerCitation } from "@/components/player/player-citation"
import type { SpeakerDirectory } from "@/components/player/speaker-directory"
import { directionForLanguage } from "@/components/speaker-display"
import { provenanceGradient, type SpeakerColor } from "@/components/ui/meeting-atoms"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { SummaryItemRef } from "@/lib/intelligence"
import type { ResolvedCitation } from "@/lib/player/citations"
import { cn } from "@/lib/utils"

const MAX_CHIPS = 3

function flagStorageKey(meetingId: string, id: string) {
  return `meetsum:flag:${meetingId}:${id}`
}

function readFlag(meetingId: string, id: string): boolean {
  try {
    return window.localStorage.getItem(flagStorageKey(meetingId, id)) === "1"
  } catch {
    return false
  }
}

function writeFlag(meetingId: string, id: string, flagged: boolean) {
  try {
    if (flagged) window.localStorage.setItem(flagStorageKey(meetingId, id), "1")
    else window.localStorage.removeItem(flagStorageKey(meetingId, id))
  } catch {
    // Storage unavailable: the flag lasts for this view only.
  }
}

/** Resolves refs to real segments, deduplicated, in citation order. */
export function useResolvedRefs(refs: readonly SummaryItemRef[]): ResolvedCitation[] {
  const player = useMeetingPlayer()

  return useMemo(() => {
    const seen = new Set<string>()
    const resolved: ResolvedCitation[] = []

    for (const ref of refs) {
      const citation = player.resolve({ segmentId: ref.segmentId, startMs: ref.startMs })

      if (citation && !seen.has(citation.segmentId)) {
        seen.add(citation.segmentId)
        resolved.push(citation)
      }
    }

    return resolved
  }, [player, refs])
}

/** Speaker colours of resolved citations, in order of first citation. */
export function useCitationColors(
  citations: readonly ResolvedCitation[],
  directory?: SpeakerDirectory
): SpeakerColor[] {
  const player = useMeetingPlayer()

  return useMemo(() => {
    if (!directory) return []

    return citations.flatMap((citation) => {
      const segment = player.segments[citation.segmentIndex]

      return segment ? [directory.forSegment(segment).color] : []
    })
  }, [citations, directory, player.segments])
}

export function SummaryLine({
  id,
  text,
  refs,
  dir,
  meetingId,
  dictionary: t,
  directory,
  targetType = "summary_item",
  leading,
  meta,
  edited = false,
  className,
}: {
  /** Stable item id (`si_…` or the action item id). */
  id: string
  text: string
  refs: readonly SummaryItemRef[]
  /** Direction of the meeting's primary language (never `auto`). */
  dir: "rtl" | "ltr"
  meetingId: string
  dictionary: Dictionary
  directory?: SpeakerDirectory
  targetType?: "summary_item" | "action_item"
  leading?: ReactNode
  meta?: ReactNode
  /** A person edited it: human text, no hairline. */
  edited?: boolean
  className?: string
}) {
  const player = useMeetingPlayer()
  const citations = useResolvedRefs(refs)
  const colors = useCitationColors(citations, directory)
  // Lines are keyed by item id, so the initial read is per item.
  const [flagged, setFlagged] = useState(() => readFlag(meetingId, id))

  const toggleFlag = () => {
    const next = !flagged

    setFlagged(next)
    writeFlag(meetingId, id, next)
  }

  return (
    <li
      className={cn(
        "group relative grid gap-1 py-1.5 ps-3",
        !edited &&
          "before:absolute before:inset-y-2 before:start-0 before:w-0.75 before:rounded-full before:bg-(image:--prov) before:content-['']",
        className
      )}
      style={edited ? undefined : { ["--prov" as string]: provenanceGradient(colors) }}
    >
      <div className="flex min-w-0 items-start gap-2">
        {leading}
        <div className="min-w-0 flex-1">
          <p dir={dir} className="text-md leading-7 text-fg">
            {text}
            {edited ? (
              <span className="ms-2 inline-flex items-center gap-1 align-middle text-xs text-fg-3">
                <PencilIcon aria-hidden className="size-3" />
                {t.intelEditedLabel}
              </span>
            ) : null}
          </p>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            {meta}
            {citations.slice(0, MAX_CHIPS).map((citation) => (
              <PlayerCitation
                key={citation.segmentId}
                segmentId={citation.segmentId}
                startMs={citation.startMs}
                source={targetType === "action_item" ? "action_item" : "citation"}
                dictionary={t}
              />
            ))}
            <CommentAnchor meetingId={meetingId} targetType={targetType} targetId={id} />
            <ReactionBar meetingId={meetingId} targetType={targetType} targetId={id} />
          </div>
        </div>
        <button
          type="button"
          aria-pressed={flagged}
          aria-label={flagged ? t.intelUnflag : t.intelFlag}
          title={flagged ? t.intelUnflag : t.intelFlag}
          onClick={toggleFlag}
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-md text-fg-3 transition-opacity duration-(--dur-1) hover:bg-surface-3 hover:text-fg focus-visible:opacity-100 focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent",
            flagged ? "text-warn-text opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
          )}
        >
          <FlagIcon aria-hidden className={cn("size-3.5", flagged && "fill-current")} />
        </button>
      </div>
      {flagged ? (
        <div role="note" className="ms-0 grid gap-1.5 rounded-md bg-warn-soft px-3 py-2 text-sm text-warn-text">
          <span className="font-medium">{citations.length ? t.intelFlagHint : t.intelFlagNoSource}</span>
          {citations.map((citation) => {
            const segment = player.segments[citation.segmentIndex]

            return segment ? (
              <span key={citation.segmentId} className="flex items-baseline gap-2 text-fg">
                <PlayerCitation segmentId={citation.segmentId} startMs={citation.startMs} source="citation" dictionary={t} />
                <bdi className="shrink-0 text-fg-2">{player.speakerNameAt(citation.segmentIndex)}</bdi>
                <span dir={directionForLanguage(segment.language) ?? dir} className="min-w-0">
                  {segment.text}
                </span>
              </span>
            ) : null
          })}
        </div>
      ) : null}
    </li>
  )
}
