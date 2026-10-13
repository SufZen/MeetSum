"use client"

/**
 * Meeting-scope Ask (M6 D2): a thin wrapper over the code-split Ask panel.
 * It must render inside the meeting's `MeetingPlayerProvider` so citation
 * chips seek the player.
 */
import { LazyAskPanel } from "@/components/ask/lazy"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { MeetingAnswer } from "@/lib/meetings/repository"

/** @deprecated Pre-M6 answer citations; kept for the workspace's legacy props. */
export type AskCitation = Pick<MeetingAnswer["citations"][number], "segmentId" | "startMs">

export function AskMeetingPanel({
  dictionary,
  locale,
  meetingId,
}: {
  dictionary: Dictionary
  locale: string
  meetingId: string
}) {
  return (
    <LazyAskPanel
      locale={locale}
      dictionary={dictionary}
      scope={{ kind: "meeting", meetingId }}
      scopeLabel={dictionary.askScopeMeeting}
    />
  )
}
