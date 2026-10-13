"use client"

/**
 * Bot session polling for the shell (M7 C3). GET /api/bot/sessions?active=1
 * on M4's adaptive cadence (lib/client/polling.ts nextPollDelay): 5 s while
 * any bot session is open, 60 s idle, nothing while the tab is hidden (a
 * visibility change polls immediately). Every bot surface is hidden when
 * GET /api/settings/bot says `enabled:false` (or the routes 404).
 *
 * The scheduling lives in `createBotSessionsPoller`, a framework-free core
 * with injected timers so it is tested with fake timers in node.
 */
import { useCallback, useEffect, useRef, useState } from "react"

import { isOpenBotStatus } from "@/components/bot/bot-ui-state"
import { nextPollDelay } from "@/lib/client/polling"
import type { BotSessionsResponse, BotSettingsResponse } from "@/lib/bot/api-types"
import type { BotSessionSummary } from "@/lib/bot/types"

export type BotSessionsMap = Record<string, BotSessionSummary>

export function openBotSessionCount(byMeetingId: Readonly<BotSessionsMap>): number {
  return Object.values(byMeetingId).filter((session) => isOpenBotStatus(session.status)).length
}

export function botPollDelay({
  byMeetingId,
  hidden,
}: {
  byMeetingId: Readonly<BotSessionsMap>
  hidden: boolean
}): number | null {
  return nextPollDelay({
    activeJobs: openBotSessionCount(byMeetingId),
    selectedProcessing: false,
    hidden,
  })
}

type Timers = {
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export type BotSessionsPoller = {
  start: () => void
  stop: () => void
  /** Poll now (after a user action) and reschedule. */
  refresh: () => Promise<void>
  /** Call on `visibilitychange`. */
  visibilityChanged: () => void
}

/**
 * `load` resolves the latest map, or `undefined` to keep the previous one
 * (a transient error). Overlapping polls are never started.
 */
export function createBotSessionsPoller({
  load,
  isHidden,
  onData,
  timers = {
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
}: {
  load: () => Promise<BotSessionsMap | undefined>
  isHidden: () => boolean
  onData: (byMeetingId: BotSessionsMap) => void
  timers?: Timers
}): BotSessionsPoller {
  let current: BotSessionsMap = {}
  let handle: unknown
  let running = false
  let inFlight: Promise<void> | null = null

  const clear = () => {
    if (handle !== undefined) timers.clearTimeout(handle)
    handle = undefined
  }

  const schedule = () => {
    clear()
    if (!running) return

    const delay = botPollDelay({ byMeetingId: current, hidden: isHidden() })

    if (delay === null) return
    handle = timers.setTimeout(() => void poll(), delay)
  }

  const poll = (): Promise<void> => {
    if (inFlight) return inFlight
    clear()
    inFlight = load()
      .then((next) => {
        if (next && running) {
          current = next
          onData(next)
        }
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight = null
        schedule()
      })

    return inFlight
  }

  return {
    start() {
      if (running) return
      running = true
      void poll()
    },
    stop() {
      running = false
      clear()
    },
    refresh: () => (running ? poll() : Promise.resolve()),
    visibilityChanged() {
      if (!running) return
      if (isHidden()) clear()
      else void poll()
    },
  }
}

export type BotSessionsState = {
  /** null while unknown; false hides every bot surface. */
  enabled: boolean | null
  byMeetingId: BotSessionsMap
  refresh: () => Promise<void>
}

export async function fetchBotEnabled(fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetcher("/api/settings/bot", { cache: "no-store" })

    if (!response.ok) return false

    const body = (await response.json()) as BotSettingsResponse

    return body.enabled === true
  } catch {
    return false
  }
}

export async function fetchBotSessions(
  fetcher: typeof fetch = fetch
): Promise<BotSessionsMap | undefined> {
  const response = await fetcher("/api/bot/sessions?active=1", { cache: "no-store" })

  if (!response.ok) return undefined

  const body = (await response.json()) as BotSessionsResponse

  return body.byMeetingId ?? {}
}

/** Shell-level hook; re-runs when the active workspace changes. */
export function useBotSessions(workspaceKey: string | undefined): BotSessionsState {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [byMeetingId, setByMeetingId] = useState<BotSessionsMap>({})
  const pollerRef = useRef<BotSessionsPoller | null>(null)

  useEffect(() => {
    let cancelled = false
    let poller: BotSessionsPoller | null = null
    const onVisibility = () => poller?.visibilityChanged()

    void fetchBotEnabled().then((isEnabled) => {
      if (cancelled) return
      setEnabled(isEnabled)
      if (!isEnabled) {
        setByMeetingId({})
        return
      }
      poller = createBotSessionsPoller({
        load: () => fetchBotSessions(),
        isHidden: () => document.visibilityState === "hidden",
        onData: (next) => {
          if (!cancelled) setByMeetingId(next)
        },
      })
      pollerRef.current = poller
      document.addEventListener("visibilitychange", onVisibility)
      poller.start()
    })

    return () => {
      cancelled = true
      poller?.stop()
      pollerRef.current = null
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [workspaceKey])

  const refresh = useCallback(async () => {
    await pollerRef.current?.refresh()
  }, [])

  return { enabled, byMeetingId, refresh }
}
