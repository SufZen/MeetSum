"use client"

/**
 * Transcript search + speaker filter (M4 C4). The search box holds text of
 * unknown language, so it is `dir="auto"`. Enter / Shift+Enter step through
 * matches, Esc clears; the count is LTR-isolated ("3/17").
 */
import { forwardRef } from "react"
import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SpeakerAvatar, type SpeakerColor } from "@/components/ui/meeting-atoms"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import { cn } from "@/lib/utils"

export type SpeakerChip = {
  key: string
  name: string
  initials: string
  color: SpeakerColor
  share?: string
}

export const TranscriptToolbar = forwardRef<
  HTMLInputElement,
  {
    dictionary: Dictionary
    query: string
    matchCount: number
    currentMatch: number
    onlyMatches: boolean
    speakers: readonly SpeakerChip[]
    selectedSpeakers: ReadonlySet<string>
    onQueryChange: (value: string) => void
    onStep: (direction: 1 | -1) => void
    onOnlyMatchesChange: (value: boolean) => void
    onToggleSpeaker: (key: string) => void
    onClearSpeakers: () => void
  }
>(function TranscriptToolbar(
  {
    dictionary: t,
    query,
    matchCount,
    currentMatch,
    onlyMatches,
    speakers,
    selectedSpeakers,
    onQueryChange,
    onStep,
    onOnlyMatchesChange,
    onToggleSpeaker,
    onClearSpeakers,
  },
  ref
) {
  const searching = query.trim().length > 0

  return (
    <div className="grid gap-2">
      <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-line-control bg-surface px-2.5 py-1 focus-within:shadow-focus">
        <SearchIcon aria-hidden className="size-4 shrink-0 text-fg-3" />
        <Input
          ref={ref}
          dir="auto"
          type="search"
          value={query}
          placeholder={t.transcriptSearchPlaceholder}
          aria-label={t.transcriptSearchPlaceholder}
          className="h-8 min-w-32 flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:shadow-none focus-visible:ring-0"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              onStep(event.shiftKey ? -1 : 1)
            }
            if (event.key === "Escape" && query) {
              event.preventDefault()
              event.stopPropagation()
              onQueryChange("")
            }
          }}
        />
        {searching ? (
          <>
            <span
              aria-live="polite"
              className="shrink-0 font-mono text-xs text-fg-3 tabular-nums [direction:ltr] [unicode-bidi:isolate]"
            >
              {matchCount ? `${currentMatch + 1}/${matchCount}` : "0/0"}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t.transcriptPrevMatch}
              title={t.transcriptPrevMatch}
              disabled={!matchCount}
              onClick={() => onStep(-1)}
            >
              <ChevronUpIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t.transcriptNextMatch}
              title={t.transcriptNextMatch}
              disabled={!matchCount}
              onClick={() => onStep(1)}
            >
              <ChevronDownIcon />
            </Button>
            <Button
              variant={onlyMatches ? "secondary" : "ghost"}
              size="xs"
              aria-pressed={onlyMatches}
              onClick={() => onOnlyMatchesChange(!onlyMatches)}
            >
              {t.transcriptOnlyMatches}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t.transcriptClearSearch}
              title={t.transcriptClearSearch}
              onClick={() => onQueryChange("")}
            >
              <XIcon />
            </Button>
          </>
        ) : null}
      </div>
      {speakers.length > 1 ? (
        <div role="group" aria-label={t.transcriptSpeakerFilter} className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            aria-pressed={selectedSpeakers.size === 0}
            className={cn(
              "h-7 rounded-full border px-2.5 text-xs font-medium transition-colors duration-(--dur-1)",
              selectedSpeakers.size === 0
                ? "border-brand bg-brand-soft text-brand-text"
                : "border-line-strong text-fg-2 hover:bg-surface-3"
            )}
            onClick={onClearSpeakers}
          >
            {t.transcriptAllSpeakers}
          </button>
          {speakers.map((speaker) => {
            const pressed = selectedSpeakers.has(speaker.key)

            return (
              <button
                key={speaker.key}
                type="button"
                aria-pressed={pressed}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-full border ps-1 pe-2.5 text-xs font-medium transition-colors duration-(--dur-1)",
                  pressed
                    ? "border-brand bg-brand-soft text-brand-text"
                    : "border-line-strong text-fg-2 hover:bg-surface-3"
                )}
                onClick={() => onToggleSpeaker(speaker.key)}
              >
                <SpeakerAvatar initials={speaker.initials} color={speaker.color} size="xs" />
                <bdi className="max-w-32 truncate">{speaker.name}</bdi>
                {speaker.share ? (
                  <span className="font-mono text-fg-3 tabular-nums [direction:ltr] [unicode-bidi:isolate]">
                    {speaker.share}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
})
