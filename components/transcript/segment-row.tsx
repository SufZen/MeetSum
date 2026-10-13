"use client"

/**
 * One transcript line (M4 C4). Paragraph `dir` comes from the segment's ASR
 * language (fallback: meeting language), never `dir="auto"`; English runs
 * inside Hebrew lines sit in `<bdi>` from word-level language. Only the
 * active row re-renders on playback ticks (selector subscriptions).
 */
import { memo, useMemo, type MouseEvent, type ReactNode } from "react"
import { CopyIcon, EllipsisIcon, LinkIcon, PencilIcon, UserRoundPenIcon } from "lucide-react"

import { useMeetingPlayer, usePlayerState } from "@/components/player/meeting-player-provider"
import { SegmentEditor } from "@/components/transcript/segment-editor"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SpeakerAvatar } from "@/components/ui/meeting-atoms"
import type { SegmentSpeaker } from "@/components/speaker-display"
import { formatMessage, type Dictionary } from "@/lib/i18n/dictionaries"
import type { TranscriptSegmentWire } from "@/lib/meetings/transcript-wire"
import { buildSegmentTokens, groupLanguageRuns, type TokenMark } from "@/lib/player/segment-tokens"
import { speakerColorVar } from "@/lib/player/speaker-colors"
import { formatClock } from "@/lib/player/time-format"
import { cn } from "@/lib/utils"

export type SegmentRowProps = {
  segment: TranscriptSegmentWire
  index: number
  speaker: SegmentSpeaker
  dir: "rtl" | "ltr"
  marks: readonly TokenMark[]
  currentMatchIndex: number
  canWrite: boolean
  editing: boolean
  saving: boolean
  flashing: boolean
  dictionary: Dictionary
  /** Speaker name element (a picker trigger when editable). */
  speakerSlot?: ReactNode
  onSeek: (ms: number, index: number, segmentId: string) => void
  onStartEdit: (segmentId: string) => void
  onSaveEdit: (segmentId: string, text: string) => void
  onCancelEdit: () => void
  onReassign: (segmentId: string) => void
  onCopy: (segmentId: string, withText: boolean) => void
  /** Text to restore into the editor after a failed save. */
  draft?: string
}

function SegmentRowImpl({
  segment,
  index,
  speaker,
  dir,
  marks,
  currentMatchIndex,
  canWrite,
  editing,
  saving,
  flashing,
  dictionary: t,
  speakerSlot,
  onSeek,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onReassign,
  onCopy,
  draft,
}: SegmentRowProps) {
  const { store } = useMeetingPlayer()
  const active = usePlayerState((state) => state.activeSegmentIndex === index)
  const activeWord = usePlayerState((state) =>
    state.activeSegmentIndex === index ? state.activeWordIndex : -1
  )
  const words = useMemo(
    () => store.wordsFor(index),
    // Memoized by segment identity + revision (the store caches by both).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, index, segment.id, segment.revision, segment.words]
  )
  const runs = useMemo(
    () => groupLanguageRuns(buildSegmentTokens(segment.text, words, marks)),
    [marks, segment.text, words]
  )
  const color = speakerColorVar(speaker.color)
  const time = formatClock(segment.startMs)
  const edited = segment.source === "edited"

  const onTextClick = (event: MouseEvent<HTMLParagraphElement>) => {
    if (typeof window !== "undefined" && window.getSelection()?.toString()) return

    const wordElement = (event.target as HTMLElement).closest<HTMLElement>("[data-w]")
    const wordIndex = wordElement ? Number(wordElement.dataset.w) : -1
    const word = wordIndex >= 0 ? words[wordIndex] : undefined

    onSeek(word ? word.startMs : segment.startMs, index, segment.id)
  }

  return (
    <article
      aria-current={active ? "true" : undefined}
      aria-label={`${speaker.name}, ${time}`}
      data-segment-id={segment.id}
      style={{ ["--c" as string]: color }}
      className={cn(
        "group/seg relative grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3 gap-y-0.5 rounded-lg py-2.5 ps-2 pe-3 transition-[background-color,box-shadow] duration-(--dur-3) ease-standard hover:bg-surface-2",
        active &&
          "bg-[color-mix(in_oklch,var(--c)_9%,var(--surface))] shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--c)_28%,transparent)] hover:bg-[color-mix(in_oklch,var(--c)_9%,var(--surface))]",
        flashing && "animate-ms-flash"
      )}
    >
      <SpeakerAvatar
        initials={speaker.initials}
        color={speaker.color}
        size="sm"
        unconfirmed={speaker.unconfirmed}
        className="row-span-2 mt-0.5"
      />
      <div className="flex min-h-6 min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
        {speakerSlot ?? (
          <b className="min-w-0 truncate font-semibold text-[color-mix(in_oklch,var(--c)_62%,var(--fg))]">
            <bdi>{speaker.name}</bdi>
          </b>
        )}
        {speaker.unconfirmed ? <small className="text-xs text-warn-text">{t.speakersUnconfirmed}</small> : null}
        <button
          type="button"
          aria-label={formatMessage(t.transcriptPlayFrom, { time })}
          className="rounded-xs font-mono text-xs text-fg-3 tabular-nums [direction:ltr] [unicode-bidi:isolate] hover:text-brand-text hover:underline focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent"
          onClick={() => onSeek(segment.startMs, index, segment.id)}
        >
          {time}
        </button>
        {edited ? <small className="text-xs text-fg-3">{t.transcriptEditedBadge}</small> : null}
        <span className="ms-auto opacity-0 transition-opacity duration-(--dur-1) group-focus-within/seg:opacity-100 group-hover/seg:opacity-100 has-aria-expanded:opacity-100">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t.transcriptSegmentActions}
                  title={t.transcriptSegmentActions}
                />
              }
            >
              <EllipsisIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-52">
              <DropdownMenuItem onClick={() => onCopy(segment.id, true)}>
                <CopyIcon />
                {t.transcriptCopyText}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onCopy(segment.id, false)}>
                <LinkIcon />
                {t.transcriptCopyLink}
              </DropdownMenuItem>
              {canWrite ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => onStartEdit(segment.id)}>
                    <PencilIcon />
                    {t.transcriptEdit}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onReassign(segment.id)}>
                    <UserRoundPenIcon />
                    {t.transcriptReassign}
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
      {editing ? (
        <div className="col-start-2">
          <SegmentEditor
            initialText={draft ?? segment.text}
            originalText={segment.text}
            saving={saving}
            dictionary={t}
            onSave={(text) => onSaveEdit(segment.id, text)}
            onCancel={onCancelEdit}
          />
        </div>
      ) : (
        <p
          dir={dir}
          lang={segment.language && segment.language !== "mixed" ? segment.language : undefined}
          className={cn(
            "col-start-2 cursor-pointer text-start text-md",
            active ? "text-fg-3" : "text-fg-2"
          )}
          onClick={onTextClick}
        >
          {runs.map((run, runIndex) => {
            const content = run.tokens.map((token) => {
              const said = active && token.wordIndex !== undefined && activeWord >= 0 && token.wordIndex < activeWord
              const now = active && token.wordIndex !== undefined && token.wordIndex === activeWord
              const marked = token.markIndex !== undefined
              const className = cn(
                token.wordIndex !== undefined && "transition-colors duration-(--dur-2) ease-standard",
                (said || now) && "text-fg",
                now && "underline decoration-2 underline-offset-4 decoration-[color-mix(in_oklch,var(--c)_80%,transparent)]",
                marked && "rounded-xs bg-warn-soft text-fg",
                marked && token.markIndex === currentMatchIndex && "bg-warn text-fg ring-1 ring-warn"
              )

              if (marked) {
                return (
                  <mark
                    key={token.start}
                    data-w={token.wordIndex}
                    data-match={token.markIndex}
                    className={className}
                  >
                    {token.text}
                  </mark>
                )
              }

              return token.wordIndex !== undefined ? (
                <span key={token.start} data-w={token.wordIndex} className={className || undefined}>
                  {token.text}
                </span>
              ) : (
                token.text
              )
            })

            return run.lang ? (
              <bdi key={runIndex} lang={run.lang} dir={run.lang === "he" ? "rtl" : "ltr"}>
                {content}
              </bdi>
            ) : (
              <span key={runIndex}>{content}</span>
            )
          })}
        </p>
      )}
    </article>
  )
}

export const SegmentRow = memo(SegmentRowImpl)
