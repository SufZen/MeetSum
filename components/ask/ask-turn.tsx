"use client"

/**
 * One question and its answer (D2).
 *
 * - Streaming: the provisional text in a muted "checking sources" frame. It
 *   is not the answer and is replaced on `done`.
 * - Complete: `done.content` with citation chips, in iris (model text) with
 *   the answer language's `dir`. Only chips that resolve are rendered.
 * - Refused, stopped and failed turns are neutral, never iris.
 */
import { Fragment, useMemo, useState, type ReactNode } from "react"
import { CopyIcon, FlagIcon } from "lucide-react"
import { toast } from "sonner"

import { AskCitationChip } from "@/components/ask/ask-citation-chip"
import type { AskTurn } from "@/components/ask/ask-stream"
import { Button } from "@/components/ui/button"
import { AiProvenance } from "@/components/ui/meeting-atoms"
import type { AskCitation } from "@/lib/ask/types"
import {
  answerCopyText,
  citedCitations,
  segmentAnswer,
  stripCitationMarkers,
  type AnswerInline,
} from "@/lib/client/answer-segments"
import { dirForLanguage, strongDirection } from "@/lib/client/highlight"
import { formatMessage, type Dictionary } from "@/lib/i18n/dictionaries"
import { buildSegmentLink } from "@/lib/player/deep-link"
import { cn } from "@/lib/utils"

const ERROR_KEYS = {
  rate_limited: "askErrorRateLimited",
  daily_limit: "askErrorDailyLimit",
  llm_unavailable: "askErrorUnavailable",
  not_found: "askErrorNotFound",
  internal: "askErrorInternal",
} as const

function Inlines({
  inlines,
  renderCite,
}: {
  inlines: readonly AnswerInline[]
  renderCite: (citation: AskCitation, key: string) => ReactNode
}) {
  return (
    <>
      {inlines.map((inline, index) =>
        inline.type === "cite" ? (
          renderCite(inline.citation, `${index}-${inline.citation.alias}`)
        ) : inline.bold ? (
          <strong key={index} className="font-semibold">
            {inline.text}
          </strong>
        ) : (
          <Fragment key={index}>{inline.text}</Fragment>
        )
      )}
    </>
  )
}

export function AskTurnView({
  turn,
  locale,
  currentMeetingId,
  dictionary: t,
  onFeedback,
}: {
  turn: AskTurn
  locale: string
  currentMeetingId?: string
  dictionary: Dictionary
  onFeedback?: (feedback: -1 | null) => void
}) {
  const [copied, setCopied] = useState(false)
  const blocks = useMemo(
    () => (turn.status === "complete" ? segmentAnswer(turn.content, turn.citations) : []),
    [turn.citations, turn.content, turn.status]
  )
  const shown = useMemo(() => citedCitations(blocks), [blocks])
  const answerDir = dirForLanguage(turn.language) ?? strongDirection(turn.content) ?? "rtl"
  const renderCite = (citation: AskCitation, key: string) => (
    <AskCitationChip
      key={key}
      citation={citation}
      locale={locale}
      currentMeetingId={currentMeetingId}
      dictionary={t}
    />
  )

  const copy = async () => {
    const origin = typeof window === "undefined" ? "" : window.location.origin
    const text = answerCopyText(turn.content, turn.citations, (citation) =>
      citation.meetingId
        ? buildSegmentLink({ origin, locale, meetingId: citation.meetingId, ms: citation.startMs ?? 0 })
        : undefined
    )

    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      toast.success(t.askCopied)
    } catch {
      setCopied(false)
    }
  }

  return (
    <li className="grid gap-2" data-ask-status={turn.status}>
      <div className="flex justify-end">
        <p
          dir="auto"
          className="max-w-[85%] rounded-lg bg-surface-2 px-3 py-2 text-base whitespace-pre-wrap text-fg"
        >
          <span className="sr-only">{t.askQuestion}: </span>
          {turn.question}
        </p>
      </div>

      {turn.status === "streaming" ? (
        <div aria-busy="true" className="grid gap-1 ps-4">
          <span className="inline-flex items-center gap-1.5 text-xs text-fg-3">
            <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-ai motion-reduce:animate-none" />
            {t.askVerifying}
          </span>
          {turn.provisional ? (
            <p dir="auto" className="text-md whitespace-pre-wrap text-fg-3">
              {stripCitationMarkers(turn.provisional)}
              <span
                aria-hidden
                className="ms-0.5 inline-block h-[1.05em] w-0.5 bg-ai align-[-0.15em] animate-ms-caret motion-reduce:animate-none"
              />
            </p>
          ) : null}
        </div>
      ) : null}

      {turn.status === "complete" ? (
        <div className="grid gap-1.5">
          <AiProvenance
            state="ai"
            dir={answerDir}
            label={
              shown.length === 1
                ? t.askAnswerLabelOne
                : formatMessage(t.askAnswerLabel, { count: shown.length })
            }
          >
            <div lang={turn.language} className="grid gap-2">
              {blocks.map((block, index) =>
                block.type === "paragraph" ? (
                  <p key={index}>
                    <Inlines inlines={block.inlines} renderCite={renderCite} />
                  </p>
                ) : (
                  <ul key={index} className="grid list-disc gap-1 ps-5">
                    {block.items.map((item, itemIndex) => (
                      <li key={itemIndex}>
                        <Inlines inlines={item} renderCite={renderCite} />
                      </li>
                    ))}
                  </ul>
                )
              )}
            </div>
          </AiProvenance>
          <div className="flex flex-wrap items-center gap-1 ps-4">
            <Button size="xs" variant="ghost" onClick={() => void copy()} aria-live="polite">
              <CopyIcon data-icon="inline-start" />
              {copied ? t.askCopied : t.askCopy}
            </Button>
            {turn.messageId && onFeedback ? (
              <Button
                size="xs"
                variant="ghost"
                aria-pressed={turn.feedback === -1}
                title={t.askFlagHint}
                className={cn(turn.feedback === -1 && "text-warn-text")}
                onClick={() => onFeedback(turn.feedback === -1 ? null : -1)}
              >
                <FlagIcon data-icon="inline-start" className={cn(turn.feedback === -1 && "fill-current")} />
                {turn.feedback === -1 ? t.askFlagged : t.askFlag}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {turn.status === "refused" ? (
        <div
          role="status"
          dir={dirForLanguage(turn.language ?? locale) ?? undefined}
          className="grid gap-0.5 rounded-md border border-dashed border-line-strong px-3 py-2"
        >
          <p className="text-base text-fg">{t.askRefusal}</p>
          <p className="text-sm text-fg-3">{t.askRefusalHint}</p>
        </div>
      ) : null}

      {turn.status === "aborted" ? <p className="ps-4 text-sm text-fg-3">{t.askStopped}</p> : null}

      {turn.status === "error" ? (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">
          {t[ERROR_KEYS[turn.errorCode ?? "internal"]]}
        </p>
      ) : null}
    </li>
  )
}
