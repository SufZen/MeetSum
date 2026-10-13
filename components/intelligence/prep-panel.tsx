"use client"

/**
 * Prep tab (M5 D4): related meetings the user can see and a brief built
 * from them. Every "where we left off" line and decision links to the
 * meeting it came from; open tasks come from the stored action items.
 */
import { useState } from "react"
import { RefreshCwIcon } from "lucide-react"

import { ApiError, requestJson, useJson } from "@/components/intelligence/use-json"
import { Button } from "@/components/ui/button"
import { CitedMark } from "@/components/ui/meeting-atoms"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Skeleton } from "@/components/ui/skeleton"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { PrepBriefResult } from "@/lib/intelligence/prep/brief"

export type PrepPanelProps = {
  meetingId: string
  dictionary: Dictionary
  locale?: string
  /** `meeting:write`: may regenerate (overwrite) the shared cached brief. */
  canWrite?: boolean
}

function meetingHref(meetingId: string) {
  return `?meeting=${encodeURIComponent(meetingId)}`
}

function errorMessage(error: unknown, t: Dictionary): string {
  if (error instanceof ApiError && error.code === "llm_not_configured") return t.intelLlmNotConfigured
  if (error instanceof ApiError && error.status >= 500) return t.intelLlmFailed

  return t.intelLoadFailed
}

export function PrepPanel({ meetingId, dictionary: t, locale, canWrite = false }: PrepPanelProps) {
  const [language, setLanguage] = useState<"" | "he" | "en">("")
  const base = `/api/meetings/${encodeURIComponent(meetingId)}/prep`
  const { data, setData, error, loading } = useJson<PrepBriefResult>(language ? `${base}?language=${language}` : base)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | undefined>()
  const dir = (data?.language ?? language) === "en" ? "ltr" : "rtl"
  const titles = new Map((data?.related ?? []).map((meeting) => [meeting.meetingId, meeting.title]))
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium" })

  async function generate() {
    setGenerating(true)
    setGenerateError(undefined)
    try {
      setData(
        await requestJson<PrepBriefResult>(base, {
          method: "POST",
          body: { ...(language ? { language } : {}), ...(data?.brief && canWrite ? { force: true } : {}) },
        })
      )
    } catch (caught) {
      setGenerateError(errorMessage(caught, t))
    } finally {
      setGenerating(false)
    }
  }

  const source = (id: string) => (
    <a href={meetingHref(id)} className="text-xs text-brand-text underline-offset-2 hover:underline">
      <bdi>{titles.get(id) ?? id}</bdi>
    </a>
  )
  const brief = data?.brief

  return (
    <section className="ms-card mx-auto grid max-w-3xl gap-4 p-4" aria-busy={loading || generating}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t.intelPrep}</h3>
        <div className="flex items-center gap-2">
          <NativeSelect
            size="sm"
            aria-label={t.intelLanguage}
            value={language}
            onChange={(event) => setLanguage(event.target.value as "" | "he" | "en")}
          >
            <NativeSelectOption value="">{t.intelLanguageAuto}</NativeSelectOption>
            <NativeSelectOption value="he">{t.intelLanguageHe}</NativeSelectOption>
            <NativeSelectOption value="en">{t.intelLanguageEn}</NativeSelectOption>
          </NativeSelect>
          {!brief || canWrite || data?.stale ? (
            <Button size="sm" variant="ai" disabled={generating || loading} onClick={() => void generate()}>
              <RefreshCwIcon data-icon="inline-start" className="size-4" />
              {generating ? t.intelGenerating : brief ? t.intelRegenerate : t.intelPrepGenerate}
            </Button>
          ) : null}
        </div>
      </div>

      {generateError ? (
        <p role="status" className="text-sm text-danger-text">
          {generateError}
        </p>
      ) : null}

      {loading && !data ? (
        <div className="grid gap-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-full" />
        </div>
      ) : error && !data ? (
        <p className="text-sm text-fg-3">{t.intelLoadFailed}</p>
      ) : (
        <>
          <div>
            <h4 className="mb-1 text-xs font-medium text-fg-3">{t.intelPrepRelated}</h4>
            {data?.related.length ? (
              <ul className="grid gap-1 text-sm">
                {data.related.map((meeting) => (
                  <li key={meeting.meetingId} className="flex items-baseline justify-between gap-2">
                    <a href={meetingHref(meeting.meetingId)} className="min-w-0 truncate text-fg hover:underline">
                      <bdi>{meeting.title}</bdi>
                    </a>
                    <span className="shrink-0 text-xs text-fg-3">{dateFormat.format(new Date(meeting.startedAt))}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-fg-3">{t.intelPrepNoRelated}</p>
            )}
          </div>

          {brief ? (
            <div className="grid gap-4" dir={dir}>
              <span className="inline-flex items-center gap-1 text-xs font-medium text-ai-text">
                <CitedMark className="size-3.5" />
                {t.intelAiLabel}
              </span>
              {data?.stale ? <p className="text-xs text-warn-text">{t.intelPrepStale}</p> : null}
              {brief.goal ? (
                <div>
                  <h4 className="mb-1 text-xs font-medium text-fg-3">{t.intelPrepGoal}</h4>
                  <p className="text-md leading-7">{brief.goal}</p>
                </div>
              ) : null}
              {brief.whereWeLeftOff.length ? (
                <div>
                  <h4 className="mb-1 text-xs font-medium text-fg-3">{t.intelPrepWhereLeftOff}</h4>
                  <ul className="grid gap-1.5">
                    {brief.whereWeLeftOff.map((item) => (
                      <li key={`${item.meetingId}:${item.text}`} className="grid gap-0.5 border-s-2 border-ai-line ps-3">
                        <span className="text-md leading-7">{item.text}</span>
                        {source(item.meetingId)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {brief.openTasks.length ? (
                <div>
                  <h4 className="mb-1 text-xs font-medium text-fg-3">{t.intelPrepOpenTasks}</h4>
                  <ul className="grid gap-1.5 text-sm">
                    {brief.openTasks.map((task) => (
                      <li key={task.taskId} className="flex flex-wrap items-baseline gap-x-2">
                        <span>{task.title}</span>
                        {task.owner ? <bdi className="text-fg-2">{task.owner}</bdi> : null}
                        {task.due ? <span className="text-xs text-fg-3 [direction:ltr] [unicode-bidi:isolate]">{task.due}</span> : null}
                        {source(task.meetingId)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {brief.previousDecisions.length ? (
                <div>
                  <h4 className="mb-1 text-xs font-medium text-fg-3">{t.intelPrepDecisions}</h4>
                  <ul className="grid gap-1.5">
                    {brief.previousDecisions.map((item) => (
                      <li key={`${item.meetingId}:${item.text}`} className="grid gap-0.5 border-s-2 border-ai-line ps-3">
                        <span className="text-md leading-7">{item.text}</span>
                        {source(item.meetingId)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {brief.suggestedQuestions.length ? (
                <div>
                  <h4 className="mb-1 text-xs font-medium text-fg-3">{t.intelPrepQuestions}</h4>
                  <ul className="list-disc ps-5 text-sm leading-6">
                    {brief.suggestedQuestions.map((question) => (
                      <li key={question}>{question}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {brief.suggestedAgenda.length ? (
                <div>
                  <h4 className="mb-1 text-xs font-medium text-fg-3">{t.intelPrepAgenda}</h4>
                  <ol className="list-decimal ps-5 text-sm leading-6">
                    {brief.suggestedAgenda.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ol>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-fg-3">{t.intelPrepEmpty}</p>
          )}
        </>
      )}
    </section>
  )
}
