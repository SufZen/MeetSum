"use client"

import { createContext, useContext, type ReactNode } from "react"

import type { BotSessionsMap } from "@/components/bot/use-bot-sessions"
import type { BotSessionSummary } from "@/lib/bot/types"

/**
 * Shell-provided bot state for surfaces the shell doesn't render directly
 * (the meeting header lives inside MeetingWorkspace). Without a provider the
 * value is "disabled", so every bot surface stays hidden.
 */
export type BotSessionsContextValue = {
  enabled: boolean
  byMeetingId: BotSessionsMap
  refresh: () => Promise<void>
  /** Blocked-bot fallback: start the browser recorder for this meeting. */
  onRecordFromBrowser?: (meetingId: string) => void
  /** Blocked-bot fallback: open the desktop-recorder import. */
  onImportDesktop?: () => void
  /** Ask (with an alert dialog) to stop the bot in a meeting. */
  onRequestStop?: (session: BotSessionSummary, title: string | null) => void
}

const DISABLED: BotSessionsContextValue = {
  enabled: false,
  byMeetingId: {},
  refresh: async () => undefined,
}

const BotSessionsContext = createContext<BotSessionsContextValue>(DISABLED)

export function BotSessionsProvider({
  value,
  children,
}: {
  value: BotSessionsContextValue
  children: ReactNode
}) {
  return <BotSessionsContext.Provider value={value}>{children}</BotSessionsContext.Provider>
}

export function useBotSessionsContext(): BotSessionsContextValue {
  return useContext(BotSessionsContext)
}
