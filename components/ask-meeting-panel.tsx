"use client"

import { SendIcon } from "lucide-react"

import { PlayerCitation } from "@/components/player/player-citation"
import { Button } from "@/components/ui/button"
import { CitedMark } from "@/components/ui/meeting-atoms"
import { Input } from "@/components/ui/input"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { MeetingAnswer } from "@/lib/meetings/repository"

export type AskCitation = Pick<MeetingAnswer["citations"][number], "segmentId" | "startMs">

export function AskMeetingPanel({
  dictionary,
  question,
  answer,
  citations = [],
  answerDir,
  asking,
  disabled,
  onQuestionChange,
  onAsk,
}: {
  dictionary: Dictionary
  question: string
  answer?: string
  /** Numbered source chips; each renders only if it resolves to a segment. */
  citations?: readonly AskCitation[]
  /** Answers are written in the meeting's language. */
  answerDir?: "rtl" | "ltr"
  asking?: boolean
  disabled?: boolean
  onQuestionChange: (value: string) => void
  onAsk: () => void
}) {
  return (
    <section className="grid gap-3 rounded-lg bg-surface p-4 ring-1 ring-line">
      <div className="flex items-center gap-2">
        <CitedMark aria-hidden="true" className="size-4 text-ai-text" />
        <h3 className="text-sm font-semibold">{dictionary.askMeetingMemory}</h3>
      </div>
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault()
          if (!disabled && !asking && question.trim()) onAsk()
        }}
      >
        <Input
          dir="auto"
          value={question}
          onChange={(event) => onQuestionChange(event.target.value)}
          disabled={disabled || asking}
          placeholder={dictionary.askDefaultQuestion}
          aria-label={dictionary.askMeetingMemory}
          className="min-h-10"
        />
        <Button
          type="submit"
          variant="ai"
          className="min-h-10 shrink-0"
          disabled={disabled || asking || !question.trim()}
        >
          <SendIcon data-icon="inline-start" data-directional="" />
          {asking ? dictionary.askThinking : dictionary.ask}
        </Button>
      </form>
      {answer ? (
        <div aria-live="polite" className="grid gap-2 rounded-md bg-surface-2 p-3">
          <p dir={answerDir} className="text-md text-fg">
            {answer}
          </p>
          {citations.length ? (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-fg-3">
              <span>{dictionary.askSources}</span>
              {citations.map((citation, index) => (
                <PlayerCitation
                  key={`${citation.segmentId}-${citation.startMs}`}
                  segmentId={citation.segmentId}
                  startMs={citation.startMs}
                  number={index + 1}
                  dictionary={dictionary}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
