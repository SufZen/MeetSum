"use client"

/**
 * Conversation analytics card (M5 D3): talk-time bars, WPM, longest
 * monologue, questions, filler rate and interruptions per speaker, plus
 * sentiment chips. Real numbers only; the heuristic note says how questions
 * and fillers are counted. Refetches when the transcript changes.
 */
import { useState } from "react"
import { InfoIcon, RefreshCwIcon } from "lucide-react"

import { useI18n } from "@/components/i18n-provider"
import { ApiError, requestJson, useJson } from "@/components/intelligence/use-json"
import type { SpeakerDirectory } from "@/components/player/speaker-directory"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import type {
  MeetingAnalyticsRecord,
  SentimentLabel,
  SpeakerAnalytics,
} from "@/lib/analytics/types"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import { formatTimecode } from "@/lib/i18n/format"

export type AnalyticsCardProps = {
  meetingId: string
  dictionary: Dictionary
  /** Speaker colours (same as transcript and timeline). */
  directory?: SpeakerDirectory
  /** `meeting:write`: re-run sentiment. */
  canWrite?: boolean
  /** Changes when the transcript or speakers change (refetch). */
  refreshKey?: unknown
  locale?: string
}

type AnalyticsResponse = {
  analytics: MeetingAnalyticsRecord
  recomputed: boolean
  sentimentEnabled: boolean
}

const SENTIMENT_CLASS: Record<SentimentLabel, string> = {
  positive: "bg-ok-soft text-ok-text",
  neutral: "bg-surface-3 text-fg-2",
  negative: "bg-danger-soft text-danger-text",
  mixed: "bg-warn-soft text-warn-text",
}

const numberClass = "font-mono tabular-nums [direction:ltr] [unicode-bidi:isolate]"

export function AnalyticsCard({ meetingId, dictionary: t, directory, canWrite, refreshKey }: AnalyticsCardProps) {
  const url = `/api/meetings/${encodeURIComponent(meetingId)}/analytics`
  const { data, setData, error, loading, reload } = useJson<AnalyticsResponse>(url, refreshKey)
  const [sentimentState, setSentimentState] = useState<"idle" | "busy" | "failed">("idle")
  const { fmt } = useI18n()
  const sentimentLabel: Record<SentimentLabel, string> = {
    positive: t.intelSentimentPositive,
    neutral: t.intelSentimentNeutral,
    negative: t.intelSentimentNegative,
    mixed: t.intelSentimentMixed,
  }

  async function runSentiment() {
    setSentimentState("busy")
    try {
      const body = await requestJson<{ analytics: MeetingAnalyticsRecord }>(`${url}/sentiment`, { method: "POST", body: {} })

      setData((previous) => (previous ? { ...previous, analytics: body.analytics } : previous))
      setSentimentState("idle")
    } catch (caught) {
      const analytics = caught instanceof ApiError ? (caught.body as { analytics?: MeetingAnalyticsRecord })?.analytics : undefined

      if (analytics) setData((previous) => (previous ? { ...previous, analytics } : previous))
      setSentimentState("failed")
    }
  }

  const name = (speaker: SpeakerAnalytics) => speaker.displayName ?? speaker.label
  const color = (speaker: SpeakerAnalytics) =>
    directory?.forSegment({ speaker: speaker.label, speakerId: speaker.speakerId }).color

  return (
    <section className="ms-card p-4" aria-busy={loading}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t.intelAnalytics}</h3>
        <span className="text-fg-3" title={t.intelHeuristic}>
          <InfoIcon aria-label={t.intelHeuristic} className="size-3.5" />
        </span>
      </div>

      {loading && !data ? (
        <div className="grid gap-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : error && !data ? (
        <div className="flex items-center justify-between gap-2 text-sm text-fg-3">
          <span>{t.intelLoadFailed}</span>
          <Button size="sm" variant="ghost" onClick={() => void reload()}>
            {t.intelRetry}
          </Button>
        </div>
      ) : data && data.analytics.metrics.speakers.length ? (
        <div className="grid gap-4">
          <div className="grid gap-2">
            <span className="text-xs text-fg-3">{t.intelTalkTime}</span>
            {data.analytics.metrics.speakers.map((speaker) => (
              <div key={speaker.speakerId ?? speaker.label} className="grid gap-1">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <bdi className="min-w-0 truncate">{name(speaker)}</bdi>
                  <span className={`text-xs text-fg-2 ${numberClass}`}>{fmt.percent(speaker.share)}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                  <div
                    className="h-full rounded-full bg-brand forced-color-adjust-none"
                    style={{
                      width: `${Math.max(2, Math.round(speaker.share * 100))}%`,
                      ...(color(speaker) ? { background: `var(--spk-${color(speaker)})` } : {}),
                    }}
                  />
                </div>
              </div>
            ))}
          </div>

          <table className="w-full text-xs">
            <thead className="text-fg-3">
              <tr>
                <th scope="col" className="pb-1 text-start font-normal" />
                <th scope="col" className="pb-1 text-end font-normal">{t.intelWpm}</th>
                <th scope="col" className="pb-1 text-end font-normal">{t.intelLongestMonologue}</th>
                <th scope="col" className="pb-1 text-end font-normal">{t.intelQuestions}</th>
                <th scope="col" className="pb-1 text-end font-normal">{t.intelFillerRate}</th>
                <th scope="col" className="pb-1 text-end font-normal">{t.intelInterruptions}</th>
              </tr>
            </thead>
            <tbody>
              {data.analytics.metrics.speakers.map((speaker) => (
                <tr key={speaker.speakerId ?? speaker.label} className="border-t border-line">
                  <th scope="row" className="py-1 text-start font-medium">
                    <bdi>{name(speaker)}</bdi>
                  </th>
                  <td className={`py-1 text-end ${numberClass}`}>{fmt.number(speaker.wpm, { maximumFractionDigits: 1 })}</td>
                  <td className={`py-1 text-end ${numberClass}`}>{formatTimecode(speaker.longestMonologueMs)}</td>
                  <td className={`py-1 text-end ${numberClass}`}>{speaker.questions}</td>
                  <td className={`py-1 text-end ${numberClass}`}>{fmt.number(speaker.fillerPer100Words, { maximumFractionDigits: 1 })}</td>
                  <td className={`py-1 text-end ${numberClass}`}>{speaker.interruptions}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {data.analytics.metrics.basis === "text" ? <p className="text-xs text-fg-3">{t.intelBasisText}</p> : null}

          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-fg-3">{t.intelSentiment}</span>
              {canWrite && data.sentimentEnabled ? (
                <Button size="xs" variant="ai" disabled={sentimentState === "busy"} onClick={() => void runSentiment()}>
                  <RefreshCwIcon data-icon="inline-start" className="size-3" />
                  {t.intelSentimentRun}
                </Button>
              ) : null}
            </div>
            {!data.sentimentEnabled ? (
              <p className="text-xs text-fg-3">{t.intelSentimentDisabled}</p>
            ) : data.analytics.sentiment?.bySpeaker.length ? (
              <ul className="flex flex-wrap gap-1.5">
                {data.analytics.sentiment.bySpeaker.map((entry) => (
                  <li key={entry.speakerKey} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${SENTIMENT_CLASS[entry.label]}`}>
                    <bdi>{entry.displayName ?? entry.speakerLabel}</bdi>
                    <span>· {sentimentLabel[entry.label]}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {sentimentState === "failed" ? (
              <p role="status" className="text-xs text-danger-text">
                {t.intelSentimentFailed}
              </p>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="text-sm text-fg-3">{t.intelAnalyticsEmpty}</p>
      )}
    </section>
  )
}
