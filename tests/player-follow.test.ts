import { describe, expect, it } from "vitest"

import {
  INITIAL_FOLLOW_STATE,
  followReducer,
  isOutsideFollowBand,
} from "@/lib/player/follow"

describe("followReducer", () => {
  it("starts following with no resume pill", () => {
    expect(INITIAL_FOLLOW_STATE).toEqual({ follow: true, showResume: false })
  })

  it("pauses follow and offers resume when the user scrolls the transcript", () => {
    expect(followReducer(INITIAL_FOLLOW_STATE, { type: "userScroll" })).toEqual({
      follow: false,
      showResume: true,
    })
  })

  it("resumes following and hides the pill", () => {
    expect(followReducer({ follow: false, showResume: true }, { type: "resume" })).toEqual(
      INITIAL_FOLLOW_STATE
    )
  })

  it("keeps state on active change while following, and only surfaces resume when the row is off screen", () => {
    const following = INITIAL_FOLLOW_STATE

    expect(followReducer(following, { type: "activeChanged", visible: false })).toBe(following)

    const paused = { follow: false, showResume: false }

    expect(followReducer(paused, { type: "activeChanged", visible: true })).toBe(paused)
    expect(followReducer(paused, { type: "activeChanged", visible: false })).toEqual({
      follow: false,
      showResume: true,
    })
  })

  it("disables follow on a search jump", () => {
    expect(followReducer(INITIAL_FOLLOW_STATE, { type: "searchJump" })).toEqual({
      follow: false,
      showResume: true,
    })
  })

  it("re-engages follow when the user seeks from the transcript", () => {
    expect(
      followReducer({ follow: false, showResume: true }, { type: "userSeekFromTranscript" })
    ).toEqual(INITIAL_FOLLOW_STATE)
  })

  it("sets follow explicitly (shortcut F)", () => {
    expect(followReducer(INITIAL_FOLLOW_STATE, { type: "setFollow", value: false })).toEqual({
      follow: false,
      showResume: true,
    })
    expect(followReducer({ follow: false, showResume: true }, { type: "setFollow", value: true })).toEqual(
      INITIAL_FOLLOW_STATE
    )
  })
})

describe("isOutsideFollowBand", () => {
  const viewport = { viewportTop: 1_000, viewportHeight: 500 }

  it("is false while the row sits in the middle 60%", () => {
    expect(isOutsideFollowBand({ ...viewport, rowTop: 1_200, rowBottom: 1_260 })).toBe(false)
  })

  it("is true above or below the band", () => {
    expect(isOutsideFollowBand({ ...viewport, rowTop: 1_020, rowBottom: 1_080 })).toBe(true)
    expect(isOutsideFollowBand({ ...viewport, rowTop: 1_420, rowBottom: 1_480 })).toBe(true)
    expect(isOutsideFollowBand({ ...viewport, rowTop: 3_000, rowBottom: 3_060 })).toBe(true)
  })

  it("accepts tall rows that start inside the band", () => {
    expect(isOutsideFollowBand({ ...viewport, rowTop: 1_150, rowBottom: 1_800 })).toBe(false)
  })
})
