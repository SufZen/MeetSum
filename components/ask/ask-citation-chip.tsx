"use client"

/**
 * Numbered citation chip in an Ask answer (D2). Same meeting with a mounted
 * player: seeks it (M4) after `resolveCitation`. Another meeting: opens the
 * deep link. A citation that doesn't resolve isn't rendered; an unavailable
 * one is a disabled chip.
 */
import Link from "next/link"

import { citationAction } from "@/components/ask/citation-action"
import { useMeetingPlayer } from "@/components/player/meeting-player-provider"
import { formatTimecode } from "@/components/ui/meeting-atoms"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { AskCitation } from "@/lib/ask/types"
import { dirForLanguage, strongDirection } from "@/lib/client/highlight"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import { formatMessage } from "@/lib/i18n/messages"
import { cn } from "@/lib/utils"

const chipBase =
  "inline-flex h-5 min-w-5 items-center justify-center rounded-xs px-1 align-baseline font-mono text-2xs tabular-nums [direction:ltr] [unicode-bidi:isolate]"
const chipInteractive =
  "cursor-pointer bg-surface-3 text-fg-2 transition-colors duration-(--dur-1) ease-standard hover:bg-brand-soft-2 hover:text-brand-text focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent"

export function AskCitationChip({
  citation,
  locale,
  currentMeetingId,
  dictionary: t,
}: {
  citation: AskCitation
  locale: string
  /** The meeting whose player is mounted (meeting-scope Ask). */
  currentMeetingId?: string
  dictionary: Dictionary
}) {
  const player = useMeetingPlayer()
  const action = citationAction(citation, {
    locale,
    currentMeetingId,
    playerAvailable: player.available,
    resolve: player.resolve,
  })

  if (action.kind === "hidden") return null

  if (action.kind === "disabled") {
    return (
      <span
        role="img"
        aria-label={formatMessage(t.askChipUnavailable, { n: citation.n })}
        className={cn(chipBase, "mx-0.5 bg-surface-2 text-fg-disabled line-through")}
      >
        {citation.n}
      </span>
    )
  }

  const seconds = action.kind === "seek" ? action.startMs / 1000 : (citation.startMs ?? 0) / 1000
  const hasTime = action.kind === "seek" || typeof citation.startMs === "number"
  const label = hasTime
    ? formatMessage(t.askChipLabel, { n: citation.n, meeting: citation.meetingTitle, time: formatTimecode(seconds) })
    : formatMessage(t.askChipLabelNoTime, { n: citation.n, meeting: citation.meetingTitle })
  const quoteDir = strongDirection(citation.quote) ?? dirForLanguage(locale) ?? "ltr"

  const trigger =
    action.kind === "seek" ? (
      <button
        type="button"
        aria-label={label}
        data-citation={citation.alias}
        className={cn(chipBase, chipInteractive, "mx-0.5")}
        onClick={() => player.seek(action.startMs, { source: "citation", segmentId: action.segmentId })}
      />
    ) : (
      <Link href={action.href} aria-label={label} data-citation={citation.alias} className={cn(chipBase, chipInteractive, "mx-0.5")} />
    )

  return (
    <Tooltip>
      <TooltipTrigger render={trigger}>{citation.n}</TooltipTrigger>
      <TooltipContent className="grid max-w-80 gap-1 text-start">
        <span className="flex flex-wrap items-center gap-1.5 text-xs">
          <b className="font-semibold">
            <bdi>{citation.meetingTitle}</bdi>
          </b>
          {citation.speakerName ? (
            <span>
              · <bdi>{citation.speakerName}</bdi>
            </span>
          ) : null}
          {hasTime ? (
            <span className="font-mono tabular-nums [direction:ltr] [unicode-bidi:isolate]">{formatTimecode(seconds)}</span>
          ) : null}
        </span>
        {citation.quote ? (
          <q dir={quoteDir} className="line-clamp-3 text-xs">
            {citation.quote}
          </q>
        ) : null}
      </TooltipContent>
    </Tooltip>
  )
}
