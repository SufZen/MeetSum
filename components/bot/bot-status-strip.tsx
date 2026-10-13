"use client"

import { useEffect, useState } from "react"
import { BotIcon, LaptopIcon, MicIcon, SquareIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

import { BdiMessage } from "@/components/bot/bdi-message"
import { botApi } from "@/components/bot/bot-api"
import { useBotSessionsContext } from "@/components/bot/bot-sessions-context"
import {
  BOT_STEPS,
  BOT_STEP_MESSAGE,
  botHintFor,
  botStepFor,
  botStripActions,
  formatBotJoinTime,
  shouldShowBotStrip,
  type BotStepTone,
} from "@/components/bot/bot-ui-state"
import { LiveTranscriptPanel } from "@/components/bot/live-transcript-panel"
import { StopBotDialog } from "@/components/bot/stop-bot-dialog"
import { Button } from "@/components/ui/button"
import { LiveDot } from "@/components/ui/meeting-atoms"
import type { MeetingBotResponse } from "@/lib/bot/api-types"
import type { BotSessionSummary } from "@/lib/bot/types"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { SupportedLocale } from "@/lib/i18n/locales"
import { cn } from "@/lib/utils"

const TONE_BAR: Record<BotStepTone, string> = {
  info: "bg-info",
  warn: "bg-warn",
  live: "bg-live",
  danger: "bg-danger",
}

const HINT_TONE = {
  default: "text-fg-3",
  warn: "text-warn-text",
  danger: "text-danger-text",
} as const

/**
 * Meeting-header bot strip (M7 C3, showcase "meeting bot states"): the step
 * list, a polite live region for the current step, the hint that says what
 * to do next, and secondary actions only (Play stays the view's primary).
 */
export function BotStatusStrip({
  meetingId,
  meetingTitle,
  meetingLanguage,
  locale,
  dictionary,
  canWrite,
}: {
  meetingId: string
  meetingTitle: string
  meetingLanguage?: string | null
  locale: SupportedLocale
  dictionary: Dictionary
  canWrite: boolean
}) {
  const bot = useBotSessionsContext()
  const polled = bot.byMeetingId[meetingId]
  const [detail, setDetail] = useState<MeetingBotResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const statusKey = polled ? `${polled.id}:${polled.status}` : "none"

  // Detail view: on open and whenever the polled status changes.
  useEffect(() => {
    if (!bot.enabled) return

    let cancelled = false

    void botApi.meeting(meetingId).then((result) => {
      if (cancelled) return
      setDetail(result.ok ? result.body : null)
      setNow(Date.now())
    })

    return () => {
      cancelled = true
    }
  }, [bot.enabled, meetingId, statusKey])

  if (!bot.enabled) return null

  const session: BotSessionSummary | undefined = polled ?? detail?.session ?? detail?.history[0]
  const visible = shouldShowBotStrip(session, now)
  const actions = botStripActions(session, {
    canSend: Boolean(detail?.canSend),
    canWrite,
    visible,
  })

  if (!visible && actions.length === 0) return null

  const step = visible && session ? botStepFor(session) : null
  const hint = visible && session ? botHintFor(session) : null

  const run = async (action: () => ReturnType<typeof botApi.stop>) => {
    setBusy(true)
    const result = await action()

    setBusy(false)
    if (!result.ok) {
      toast.error(dictionary[result.error])
      return
    }
    await bot.refresh()
    const next = await botApi.meeting(meetingId)

    if (next.ok) setDetail(next.body)
  }

  const hintValues = {
    name: hint?.params?.name ?? "",
    platform: hint?.params?.platform ? dictionary[hint.params.platform] : "",
    time: hint?.params?.time ? (
      <span className="font-mono tabular-nums [direction:ltr] [unicode-bidi:isolate]">
        {formatBotJoinTime(hint.params.time, locale)}
      </span>
    ) : (
      ""
    ),
  }

  return (
    <section
      aria-label={dictionary.botStepsLabel}
      className="mt-3 grid gap-2.5 rounded-lg border border-line p-3"
    >
      {step && session ? (
        <>
          <ol className="flex gap-1" aria-hidden="true">
            {BOT_STEPS.map((name, index) => (
              <li
                key={name}
                className={cn(
                  "grid flex-1 content-start gap-1.5 text-2xs",
                  index === step.current ? "font-medium text-fg" : "text-fg-3"
                )}
              >
                <span
                  className={cn(
                    "h-1 rounded-full transition-colors duration-(--dur-4) ease-standard",
                    index < step.current
                      ? "bg-brand"
                      : index === step.current
                        ? TONE_BAR[step.tone]
                        : "bg-line-strong"
                  )}
                />
                <span className="hidden truncate sm:block">
                  {dictionary[index === step.current ? step.labelKey : BOT_STEP_MESSAGE[name]]}
                </span>
              </li>
            ))}
          </ol>
          <div className="flex min-h-9 items-center gap-2.5 text-sm">
            <span
              className={cn(
                "grid size-7 shrink-0 place-items-center rounded-full",
                step.tone === "live"
                  ? "bg-live-soft"
                  : step.tone === "warn"
                    ? "bg-warn-soft text-warn-text"
                    : step.tone === "danger"
                      ? "bg-danger-soft text-danger-text"
                      : "bg-info-soft text-info-text"
              )}
            >
              {step.tone === "live" ? (
                <LiveDot />
              ) : step.tone === "danger" ? (
                <XIcon aria-hidden="true" className="size-3.5" />
              ) : (
                <BotIcon aria-hidden="true" className="size-3.5" />
              )}
            </span>
            <div className="grid min-w-0">
              <b aria-live="polite" className="font-medium">
                {dictionary[step.labelKey]}
              </b>
              {hint ? (
                <small className={cn("text-xs", HINT_TONE[hint.tone])}>
                  <BdiMessage template={dictionary[hint.key]} values={hintValues} />
                </small>
              ) : null}
            </div>
          </div>
        </>
      ) : null}

      {actions.length ? (
        <div className="flex flex-wrap items-center gap-2">
          {actions.includes("send") ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void run(() => botApi.send(meetingId))}
            >
              <BotIcon data-icon="inline-start" />
              {dictionary.botSend}
            </Button>
          ) : null}
          {actions.includes("dont_send") ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void run(() => botApi.stop(meetingId))}
            >
              <XIcon data-icon="inline-start" />
              {dictionary.botDontSend}
            </Button>
          ) : null}
          {actions.includes("stop") ? (
            <Button variant="record" size="sm" disabled={busy} onClick={() => setConfirmOpen(true)}>
              <SquareIcon data-icon="inline-start" />
              {dictionary.botStop}
            </Button>
          ) : null}
          {actions.includes("record_browser") && bot.onRecordFromBrowser ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => bot.onRecordFromBrowser?.(meetingId)}
            >
              <MicIcon data-icon="inline-start" />
              {dictionary.botRecordBrowser}
            </Button>
          ) : null}
          {actions.includes("import_desktop") && bot.onImportDesktop ? (
            <Button variant="secondary" size="sm" onClick={() => bot.onImportDesktop?.()}>
              <LaptopIcon data-icon="inline-start" />
              {dictionary.botImportDesktop}
            </Button>
          ) : null}
        </div>
      ) : null}

      {session?.status === "active" ? (
        <LiveTranscriptPanel
          meetingId={meetingId}
          meetingLanguage={meetingLanguage}
          dictionary={dictionary}
        />
      ) : null}

      <StopBotDialog
        dictionary={dictionary}
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={meetingTitle}
        busy={busy}
        onConfirm={() => {
          setConfirmOpen(false)
          void run(() => botApi.stop(meetingId))
        }}
      />
    </section>
  )
}
