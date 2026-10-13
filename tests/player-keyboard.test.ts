import { describe, expect, it } from "vitest"

import {
  actionForKey,
  isEditableTarget,
  sliderActionForKey,
  type KeyLike,
} from "@/lib/player/keyboard"

function key(code: string, extra: Partial<KeyLike> = {}): KeyLike {
  return { code, key: extra.key ?? code, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...extra }
}

describe("actionForKey", () => {
  it("maps the transport shortcuts by physical key code", () => {
    expect(actionForKey(key("Space", { key: " " }), { dir: "ltr" })).toEqual({ type: "toggle" })
    expect(actionForKey(key("KeyK"), { dir: "ltr" })).toEqual({ type: "toggle" })
    expect(actionForKey(key("KeyJ"), { dir: "ltr" })).toEqual({ type: "skip", ms: -10_000 })
    expect(actionForKey(key("KeyL"), { dir: "ltr" })).toEqual({ type: "skip", ms: 10_000 })
    expect(actionForKey(key("ArrowLeft"), { dir: "ltr" })).toEqual({ type: "skip", ms: -5_000 })
    expect(actionForKey(key("ArrowRight"), { dir: "ltr" })).toEqual({ type: "skip", ms: 5_000 })
    expect(actionForKey(key("ArrowRight", { shiftKey: true }), { dir: "ltr" })).toEqual({
      type: "skip",
      ms: 1_000,
    })
    expect(actionForKey(key("ArrowLeft", { shiftKey: true }), { dir: "ltr" })).toEqual({
      type: "skip",
      ms: -1_000,
    })
  })

  it("works under a Hebrew keyboard layout (key values are Hebrew letters)", () => {
    // Physical K/J/L/F/M on the Israeli layout produce ל/ח/ך/כ/צ.
    expect(actionForKey(key("KeyK", { key: "ל" }), { dir: "rtl" })).toEqual({ type: "toggle" })
    expect(actionForKey(key("KeyJ", { key: "ח" }), { dir: "rtl" })).toEqual({ type: "skip", ms: -10_000 })
    expect(actionForKey(key("KeyL", { key: "ך" }), { dir: "rtl" })).toEqual({ type: "skip", ms: 10_000 })
    expect(actionForKey(key("KeyF", { key: "כ" }), { dir: "rtl" })).toEqual({ type: "toggleFollow" })
    expect(actionForKey(key("KeyM", { key: "צ" }), { dir: "rtl" })).toEqual({ type: "mute" })
    expect(actionForKey(key("Slash", { key: "." }), { dir: "rtl" })).toEqual({ type: "focusSearch" })
  })

  it("never inverts the time axis in RTL", () => {
    for (const code of ["ArrowLeft", "ArrowRight", "KeyJ", "KeyL"]) {
      expect(actionForKey(key(code), { dir: "rtl" })).toEqual(actionForKey(key(code), { dir: "ltr" }))
    }
    expect(actionForKey(key("ArrowRight"), { dir: "rtl" })).toEqual({ type: "skip", ms: 5_000 })
  })

  it("maps speed, percentage seek, follow, search, help and mute", () => {
    expect(actionForKey(key("Period", { shiftKey: true, key: ">" }), { dir: "ltr" })).toEqual({
      type: "rate",
      step: 1,
    })
    expect(actionForKey(key("Comma", { shiftKey: true, key: "<" }), { dir: "ltr" })).toEqual({
      type: "rate",
      step: -1,
    })
    expect(actionForKey(key("Digit0", { key: "0" }), { dir: "ltr" })).toEqual({ type: "seekPercent", percent: 0 })
    expect(actionForKey(key("Digit7", { key: "7" }), { dir: "ltr" })).toEqual({ type: "seekPercent", percent: 70 })
    expect(actionForKey(key("Numpad3", { key: "3" }), { dir: "ltr" })).toEqual({ type: "seekPercent", percent: 30 })
    expect(actionForKey(key("KeyF"), { dir: "ltr" })).toEqual({ type: "toggleFollow" })
    expect(actionForKey(key("Slash", { key: "/" }), { dir: "ltr" })).toEqual({ type: "focusSearch" })
    expect(actionForKey(key("Slash", { shiftKey: true, key: "?" }), { dir: "ltr" })).toEqual({ type: "help" })
    expect(actionForKey(key("KeyM"), { dir: "ltr" })).toEqual({ type: "mute" })
  })

  it("ignores keys with Ctrl, Meta or Alt, and Shift where it means nothing", () => {
    expect(actionForKey(key("KeyK", { ctrlKey: true }), { dir: "ltr" })).toBeNull()
    expect(actionForKey(key("KeyL", { metaKey: true }), { dir: "ltr" })).toBeNull()
    expect(actionForKey(key("ArrowRight", { altKey: true }), { dir: "ltr" })).toBeNull()
    expect(actionForKey(key("KeyK", { shiftKey: true }), { dir: "ltr" })).toBeNull()
    expect(actionForKey(key("Digit3", { shiftKey: true }), { dir: "ltr" })).toBeNull()
    expect(actionForKey(key("Period", { key: "." }), { dir: "ltr" })).toBeNull()
  })

  it("ignores keys typed into editable fields or while a dialog is open", () => {
    expect(actionForKey(key("Space"), { dir: "ltr", editable: true })).toBeNull()
    expect(actionForKey(key("KeyK"), { dir: "ltr", dialogOpen: true })).toBeNull()
  })

  it("returns null for unmapped keys and repeat-sensitive toggles", () => {
    expect(actionForKey(key("KeyQ"), { dir: "ltr" })).toBeNull()
    expect(actionForKey(key("Space", { repeat: true }), { dir: "ltr" })).toBeNull()
    expect(actionForKey(key("ArrowRight", { repeat: true }), { dir: "ltr" })).toEqual({ type: "skip", ms: 5_000 })
  })
})

describe("isEditableTarget", () => {
  it("detects inputs, textareas, selects and contenteditable", () => {
    expect(isEditableTarget({ tagName: "INPUT", type: "text" })).toBe(true)
    expect(isEditableTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false)
    expect(isEditableTarget({ tagName: "TEXTAREA" })).toBe(true)
    expect(isEditableTarget({ tagName: "SELECT" })).toBe(true)
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(true)
    expect(isEditableTarget({ tagName: "DIV", role: "textbox" })).toBe(true)
    expect(isEditableTarget({ tagName: "BUTTON" })).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})

describe("sliderActionForKey", () => {
  it("steps the scrubber in time order regardless of direction", () => {
    expect(sliderActionForKey(key("ArrowRight"))).toEqual({ type: "skip", ms: 5_000 })
    expect(sliderActionForKey(key("ArrowUp"))).toEqual({ type: "skip", ms: 5_000 })
    expect(sliderActionForKey(key("ArrowLeft"))).toEqual({ type: "skip", ms: -5_000 })
    expect(sliderActionForKey(key("PageUp"))).toEqual({ type: "skip", ms: 30_000 })
    expect(sliderActionForKey(key("PageDown"))).toEqual({ type: "skip", ms: -30_000 })
    expect(sliderActionForKey(key("Home"))).toEqual({ type: "seekPercent", percent: 0 })
    expect(sliderActionForKey(key("End"))).toEqual({ type: "seekPercent", percent: 100 })
    expect(sliderActionForKey(key("KeyQ"))).toBeNull()
  })
})
