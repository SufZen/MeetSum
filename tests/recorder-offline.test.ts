/**
 * M9 follow-up: the recorder works offline once its sheet opened online, and
 * a "New recording" never attaches to the selected meeting.
 */
import { describe, expect, it, vi } from "vitest"

import { RECORDER_CHUNK_LOADERS, createRecorderPreloader } from "@/components/bot/recorder-preload"
import { LocalizedError, planBrowserRecording, uploadErrorText } from "@/components/bot/recording-target"

describe("recorder chunk preload", () => {
  it("loads every recorder chunk once", async () => {
    const a = vi.fn(async () => ({}))
    const b = vi.fn(async () => ({}))
    const preloader = createRecorderPreloader([a, b])

    expect(await preloader.preload()).toBe(true)
    expect(await preloader.preload()).toBe(true)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(preloader.loaded()).toBe(true)
  })

  it("never rejects, and retries after a failed (offline) attempt", async () => {
    let online = false
    const load = vi.fn(async () => {
      if (!online) throw Object.assign(new Error("Loading chunk 12 failed"), { name: "ChunkLoadError" })
      return {}
    })
    const preloader = createRecorderPreloader([load])

    expect(await preloader.preload()).toBe(false)
    expect(preloader.loaded()).toBe(false)
    online = true
    expect(await preloader.preload()).toBe(true)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it("covers the recorder dock and the upload queue", () => {
    const source = RECORDER_CHUNK_LOADERS.map((loader) => loader.toString()).join("\n")

    expect(source).toContain("recorder-dock")
    expect(source).toContain("upload-queue/browser")
  })
})

describe("planBrowserRecording", () => {
  it("targets a meeting only when the recording was started for it", () => {
    expect(planBrowserRecording({ meetingId: "m_1", captureId: "cap" })).toEqual({ kind: "meeting", meetingId: "m_1" })
    expect(planBrowserRecording({ meetingId: "m_1", captureId: null })).toEqual({ kind: "meeting", meetingId: "m_1" })
  })

  it("sends a new recording through the queue, or to a new meeting, never the selected one", () => {
    expect(planBrowserRecording({ meetingId: null, captureId: "cap" })).toEqual({ kind: "queue" })
    expect(planBrowserRecording({ meetingId: null, captureId: null })).toEqual({ kind: "new-meeting" })
  })
})

describe("uploadErrorText", () => {
  const texts = { offline: "אין חיבור", fallback: "ההעלאה נכשלה" }

  it("never shows a raw network error", () => {
    expect(uploadErrorText(new TypeError("Failed to fetch"), texts, true)).toBe("אין חיבור")
    expect(uploadErrorText(new TypeError("NetworkError when attempting to fetch resource."), texts, true)).toBe("אין חיבור")
    expect(uploadErrorText(Object.assign(new Error("Loading chunk 3 failed"), { name: "ChunkLoadError" }), texts, true)).toBe("אין חיבור")
    expect(uploadErrorText(new Error("boom"), texts, false)).toBe("אין חיבור")
    expect(uploadErrorText(new Error("Internal"), texts, true)).toBe("ההעלאה נכשלה")
  })

  it("passes our own localized errors through", () => {
    expect(uploadErrorText(new LocalizedError("לא ניתן ליצור פגישה"), texts, true)).toBe("לא ניתן ליצור פגישה")
  })
})
