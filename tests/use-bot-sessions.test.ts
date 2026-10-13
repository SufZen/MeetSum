import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  botPollDelay,
  createBotSessionsPoller,
  fetchBotEnabled,
  fetchBotSessions,
  openBotSessionCount,
  type BotSessionsMap,
} from "@/components/bot/use-bot-sessions"
import type { BotSessionSummary, BotStatus } from "@/lib/bot/types"

function summary(status: BotStatus): BotSessionSummary {
  return {
    id: `bot_${status}`,
    meetingId: `meet_${status}`,
    status,
    statusReason: null,
    platform: "google_meet",
    scheduledStart: null,
    joinedAt: null,
    leftAt: null,
    consentStatus: "pending",
    recordingStatus: "none",
    botName: "MeetSum Notetaker",
  }
}

const open: BotSessionsMap = { meet_active: summary("active") }
const idle: BotSessionsMap = { meet_completed: summary("completed") }

describe("botPollDelay", () => {
  it("polls every 5 s while a session is open, 60 s idle, never while hidden", () => {
    expect(openBotSessionCount({ ...open, ...idle, s: summary("scheduled") })).toBe(2)
    expect(botPollDelay({ byMeetingId: open, hidden: false })).toBe(5_000)
    expect(botPollDelay({ byMeetingId: idle, hidden: false })).toBe(60_000)
    expect(botPollDelay({ byMeetingId: {}, hidden: false })).toBe(60_000)
    expect(botPollDelay({ byMeetingId: open, hidden: true })).toBeNull()
  })
})

describe("createBotSessionsPoller", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function setup(responses: BotSessionsMap[]) {
    let hidden = false
    const load = vi.fn(async () => responses.shift() ?? idle)
    const onData = vi.fn()
    const poller = createBotSessionsPoller({ load, isHidden: () => hidden, onData })

    return {
      poller,
      load,
      onData,
      hide: (value: boolean) => {
        hidden = value
      },
    }
  }

  it("polls at 5 s while open and backs off to 60 s once everything ends", async () => {
    const { poller, load, onData } = setup([open, open, idle])

    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(load).toHaveBeenCalledTimes(1)
    expect(onData).toHaveBeenLastCalledWith(open)

    await vi.advanceTimersByTimeAsync(4_999)
    expect(load).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(load).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(load).toHaveBeenCalledTimes(3)
    expect(onData).toHaveBeenLastCalledWith(idle)

    await vi.advanceTimersByTimeAsync(59_999)
    expect(load).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(load).toHaveBeenCalledTimes(4)
    poller.stop()
  })

  it("pauses while the tab is hidden and polls at once when it returns", async () => {
    const { poller, load, hide } = setup([open, open, open])

    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(load).toHaveBeenCalledTimes(1)

    hide(true)
    poller.visibilityChanged()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(load).toHaveBeenCalledTimes(1)

    hide(false)
    poller.visibilityChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(load).toHaveBeenCalledTimes(2)
    poller.stop()
  })

  it("keeps the last data on a failed poll and stops cleanly", async () => {
    const load = vi
      .fn<() => Promise<BotSessionsMap | undefined>>()
      .mockResolvedValueOnce(open)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined)
    const onData = vi.fn()
    const poller = createBotSessionsPoller({ load, isHidden: () => false, onData })

    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(load).toHaveBeenCalledTimes(3)
    expect(onData).toHaveBeenCalledTimes(1)

    poller.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(load).toHaveBeenCalledTimes(3)
  })

  it("refresh polls immediately without overlapping", async () => {
    const { poller, load } = setup([idle, open])

    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    await Promise.all([poller.refresh(), poller.refresh()])
    expect(load).toHaveBeenCalledTimes(2)
    poller.stop()
  })
})

describe("bot session fetchers", () => {
  it("treats a 404 or enabled:false settings response as disabled", async () => {
    const response = (status: number, body: unknown) =>
      vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

    expect(await fetchBotEnabled(response(404, { error: "bot_disabled" }))).toBe(false)
    expect(await fetchBotEnabled(response(200, { enabled: false }))).toBe(false)
    expect(await fetchBotEnabled(response(200, { enabled: true, rules: {} }))).toBe(true)
    expect(await fetchBotSessions(response(200, { byMeetingId: open }))).toEqual(open)
    expect(await fetchBotSessions(response(500, {}))).toBeUndefined()
  })
})
