"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { ExternalLinkIcon, SquareIcon } from "lucide-react"

import { BdiMessage } from "@/components/bot/bdi-message"
import { BOT_PLATFORM_MESSAGE } from "@/components/bot/bot-ui-state"
import {
  dockStopAction,
  formatDockElapsed,
  nextDockAnnouncement,
  splitDockRows,
  type DockAnnouncerState,
  type DockEntry,
  type DockStopAction,
} from "@/components/bot/recorder-dock-state"
import { Button } from "@/components/ui/button"
import { LiveDot } from "@/components/ui/meeting-atoms"
import { formatMessage, type Dictionary } from "@/lib/i18n/dictionaries"

/**
 * Recorder dock (M7 C3, cadence.css "recorder dock"): fixed to the bottom on
 * the --z-dock layer, one row per live recording (bot sessions and the
 * browser recorder), at most two rows then "+N". The ticking timer is
 * aria-hidden; a polite region says "Recording started/stopped" once each.
 * The shell pads its content by the reported height so the dock never covers
 * focus (WCAG 2.4.11). Spring entrance, removed under reduced motion.
 */
export function RecorderDock({
  entries,
  dictionary,
  onOpenMeeting,
  onStop,
  onHeightChange,
}: {
  entries: DockEntry[]
  dictionary: Dictionary
  onOpenMeeting: (meetingId: string) => void
  onStop: (action: DockStopAction) => void
  onHeightChange?: (height: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(() => Date.now())
  const [announcement, setAnnouncement] = useState("")
  const announcerRef = useRef<DockAnnouncerState>({ recording: false })
  const { visible, overflow } = splitDockRows(entries)
  const count = entries.length

  useEffect(() => {
    if (count === 0) return

    const intervalId = window.setInterval(() => setNow(Date.now()), 1000)

    return () => window.clearInterval(intervalId)
  }, [count])

  useEffect(() => {
    const { state, announce } = nextDockAnnouncement(announcerRef.current, count)

    announcerRef.current = state
    if (announce) {
      setAnnouncement(announce === "started" ? dictionary.botDockStarted : dictionary.botDockStopped)
    }
  }, [count, dictionary.botDockStarted, dictionary.botDockStopped])

  useLayoutEffect(() => {
    const element = ref.current

    if (!element || !onHeightChange) return
    if (count === 0) {
      onHeightChange(0)
      return
    }

    const report = () => onHeightChange(Math.ceil(element.getBoundingClientRect().height) + 16)
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(report)

    report()
    observer?.observe(element)

    return () => observer?.disconnect()
  }, [count, onHeightChange])

  return (
    <>
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {count > 0 ? (
        <div
          ref={ref}
          role="region"
          aria-label={dictionary.botDockLabel}
          className="fixed inset-x-3 bottom-3 z-(--z-dock) grid gap-1.5 rounded-xl bg-surface p-2 shadow-3 ring-1 ring-live/30 animate-ms-pop motion-reduce:animate-none sm:inset-x-auto sm:end-6 sm:w-md"
        >
          {visible.map((entry) => {
            const title = entry.title || dictionary.botDockUntitled

            return (
              <div key={entry.id} className="flex min-w-0 items-center gap-2.5 ps-2">
                <LiveDot />
                <div className="grid min-w-0 flex-1">
                  <span className="truncate text-sm font-medium">
                    <BdiMessage template={dictionary.botDockRecordingTitle} values={{ title }} />
                  </span>
                  <span className="truncate text-xs text-fg-3">
                    {entry.kind === "bot" ? (
                      <BdiMessage
                        template={dictionary.botDockSourceBot}
                        values={{ platform: dictionary[BOT_PLATFORM_MESSAGE[entry.platform]] }}
                      />
                    ) : (
                      dictionary.botDockSourceBrowser
                    )}
                  </span>
                </div>
                <span
                  aria-hidden="true"
                  className="shrink-0 font-mono text-md tabular-nums [direction:ltr] [unicode-bidi:isolate]"
                >
                  {formatDockElapsed(now - entry.startedAt)}
                </span>
                {entry.meetingId ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={dictionary.botDockOpen}
                    title={dictionary.botDockOpen}
                    onClick={() => entry.meetingId && onOpenMeeting(entry.meetingId)}
                  >
                    <ExternalLinkIcon aria-hidden="true" />
                  </Button>
                ) : null}
                <Button variant="record" size="sm" onClick={() => onStop(dockStopAction(entry))}>
                  <SquareIcon data-icon="inline-start" />
                  {dictionary.botDockStop}
                </Button>
              </div>
            )
          })}
          {overflow > 0 ? (
            <span className="ps-2 text-xs text-fg-3">
              {formatMessage(dictionary.botDockMore, { count: overflow })}
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
