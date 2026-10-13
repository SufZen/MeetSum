import { describe, expect, it } from "vitest"

import {
  DOCK_MAX_ROWS,
  dockEntriesFrom,
  dockStopAction,
  formatDockElapsed,
  nextDockAnnouncement,
  splitDockRows,
  type DockAnnouncerState,
} from "@/components/bot/recorder-dock-state"
import {
  isBrowserRecordingSupported,
  pickRecorderMimeType,
  recordingFileName,
} from "@/components/bot/use-browser-recorder"
import type { BotSessionSummary } from "@/lib/bot/types"

const NOW = Date.parse("2026-10-13T11:30:00.000Z")

function bot(id: string, overrides: Partial<BotSessionSummary> = {}): BotSessionSummary {
  return {
    id,
    meetingId: `meet_${id}`,
    status: "active",
    statusReason: null,
    platform: "google_meet",
    scheduledStart: null,
    joinedAt: "2026-10-13T11:00:00.000Z",
    leftAt: null,
    consentStatus: "sent",
    recordingStatus: "none",
    botName: "MeetSum Notetaker",
    ...overrides,
  }
}

describe("recorder dock timer", () => {
  it("formats mm:ss, then h:mm:ss, never negative", () => {
    expect(formatDockElapsed(0)).toBe("00:00")
    expect(formatDockElapsed(65_400)).toBe("01:05")
    expect(formatDockElapsed(59 * 60_000 + 59_999)).toBe("59:59")
    expect(formatDockElapsed(3_600_000 + 61_000)).toBe("1:01:01")
    expect(formatDockElapsed(-5_000)).toBe("00:00")
  })

  it("times bot rows from joined_at and the browser row from its start", () => {
    const entries = dockEntriesFrom({
      sessions: { meet_a: bot("a") },
      titles: { meet_a: "עדכון סטטוס עסקה" },
      browser: { startedAt: NOW - 10_000, meetingId: null, title: null },
      now: NOW,
    })

    expect(entries.map((entry) => [entry.kind, formatDockElapsed(NOW - entry.startedAt)])).toEqual([
      ["bot", "30:00"],
      ["browser", "00:10"],
    ])
    expect(entries[0]).toMatchObject({ title: "עדכון סטטוס עסקה", platform: "google_meet" })
  })

  it("only lists recordings that are live now", () => {
    const entries = dockEntriesFrom({
      sessions: {
        meet_a: bot("a"),
        meet_b: bot("b", { status: "awaiting_admission", joinedAt: null }),
        meet_c: bot("c", { status: "completed" }),
      },
      titles: {},
      browser: null,
      now: NOW,
    })

    expect(entries.map((entry) => entry.id)).toEqual(["bot:a"])
  })
})

describe("recorder dock overflow", () => {
  it("shows two rows, then +N", () => {
    expect(DOCK_MAX_ROWS).toBe(2)
    expect(splitDockRows([1, 2, 3, 4])).toEqual({ visible: [1, 2], overflow: 2 })
    expect(splitDockRows([1])).toEqual({ visible: [1], overflow: 0 })
  })
})

describe("recorder dock announcements", () => {
  it("announces started and stopped once each", () => {
    let state: DockAnnouncerState = { recording: false }
    const said: Array<string | null> = []

    for (const count of [0, 1, 1, 2, 1, 0, 0, 1]) {
      const next = nextDockAnnouncement(state, count)

      state = next.state
      said.push(next.announce)
    }

    expect(said).toEqual([null, "started", null, null, null, "stopped", null, "started"])
  })
})

describe("recorder dock stop", () => {
  it("stops the browser recorder or asks to stop the bot", () => {
    const [botEntry, browserEntry] = dockEntriesFrom({
      sessions: { meet_a: bot("a") },
      titles: { meet_a: "Legal sync" },
      browser: { startedAt: NOW, meetingId: "meet_x", title: "X" },
      now: NOW,
    })

    expect(dockStopAction(botEntry)).toEqual({
      kind: "bot",
      meetingId: "meet_a",
      sessionId: "a",
      title: "Legal sync",
    })
    expect(dockStopAction(browserEntry)).toEqual({ kind: "browser" })
  })
})

describe("browser recorder helpers", () => {
  it("picks opus webm, then mp4, then the browser default", () => {
    expect(pickRecorderMimeType(() => true)).toBe("audio/webm;codecs=opus")
    expect(pickRecorderMimeType((mime) => mime === "audio/mp4")).toBe("audio/mp4")
    expect(pickRecorderMimeType(() => false)).toBe("")
    expect(recordingFileName(1, "audio/mp4")).toBe("meetsum-recording-1.m4a")
    expect(recordingFileName(1, "audio/webm;codecs=opus")).toBe("meetsum-recording-1.webm")
  })

  it("needs MediaRecorder, getUserMedia and a secure context", () => {
    const ok = { hasMediaRecorder: true, hasGetUserMedia: true, isSecureContext: true }

    expect(isBrowserRecordingSupported(ok)).toBe(true)
    expect(isBrowserRecordingSupported({ ...ok, isSecureContext: false })).toBe(false)
    expect(isBrowserRecordingSupported({ ...ok, hasMediaRecorder: false })).toBe(false)
  })
})
