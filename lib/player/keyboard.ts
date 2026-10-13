/**
 * Player keyboard map (M4, client-safe, pure).
 *
 * Shortcuts are matched on `event.code` (the physical key), so they work
 * under the Hebrew layout where KeyK types "ל". The time axis never mirrors:
 * → and L always move forward, also in RTL; `dir` is accepted only so tests
 * can prove that.
 */

export type KeyLike = {
  code: string
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  repeat?: boolean
}

export type PlayerAction =
  | { type: "toggle" }
  | { type: "skip"; ms: number }
  | { type: "rate"; step: 1 | -1 }
  | { type: "seekPercent"; percent: number }
  | { type: "toggleFollow" }
  | { type: "focusSearch" }
  | { type: "help" }
  | { type: "mute" }

export type KeyContext = {
  dir: "ltr" | "rtl"
  /** Focus is in a text field / contenteditable. */
  editable?: boolean
  /** A modal dialog or menu owns the keyboard. */
  dialogOpen?: boolean
}

export const SKIP_LONG_MS = 10_000
export const SKIP_SHORT_MS = 5_000
export const SKIP_FINE_MS = 1_000
export const SKIP_PAGE_MS = 30_000

function digitOf(code: string): number | undefined {
  const match = /^(?:Digit|Numpad)(\d)$/.exec(code)

  return match ? Number(match[1]) : undefined
}

export function actionForKey(event: KeyLike, context: KeyContext): PlayerAction | null {
  if (context.editable || context.dialogOpen) return null
  if (event.ctrlKey || event.metaKey || event.altKey) return null

  const { code, shiftKey } = event
  const repeat = Boolean(event.repeat)

  // Keys where Shift is meaningful.
  switch (code) {
    case "ArrowLeft":
      return { type: "skip", ms: shiftKey ? -SKIP_FINE_MS : -SKIP_SHORT_MS }
    case "ArrowRight":
      return { type: "skip", ms: shiftKey ? SKIP_FINE_MS : SKIP_SHORT_MS }
    case "Comma":
      return shiftKey && !repeat ? { type: "rate", step: -1 } : null
    case "Period":
      return shiftKey && !repeat ? { type: "rate", step: 1 } : null
    case "Slash":
      if (repeat) return null

      return shiftKey ? { type: "help" } : { type: "focusSearch" }
  }

  if (shiftKey) return null

  const digit = digitOf(code)

  if (digit !== undefined) return repeat ? null : { type: "seekPercent", percent: digit * 10 }

  switch (code) {
    case "Space":
    case "KeyK":
      return repeat ? null : { type: "toggle" }
    case "KeyJ":
      return { type: "skip", ms: -SKIP_LONG_MS }
    case "KeyL":
      return { type: "skip", ms: SKIP_LONG_MS }
    case "KeyF":
      return repeat ? null : { type: "toggleFollow" }
    case "KeyM":
      return repeat ? null : { type: "mute" }
    default:
      return null
  }
}

/** Keys of the focused scrubber slider (ARIA slider pattern, time order). */
export function sliderActionForKey(event: KeyLike): PlayerAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null

  switch (event.code) {
    case "ArrowRight":
    case "ArrowUp":
      return { type: "skip", ms: event.shiftKey ? SKIP_FINE_MS : SKIP_SHORT_MS }
    case "ArrowLeft":
    case "ArrowDown":
      return { type: "skip", ms: event.shiftKey ? -SKIP_FINE_MS : -SKIP_SHORT_MS }
    case "PageUp":
      return { type: "skip", ms: SKIP_PAGE_MS }
    case "PageDown":
      return { type: "skip", ms: -SKIP_PAGE_MS }
    case "Home":
      return { type: "seekPercent", percent: 0 }
    case "End":
      return { type: "seekPercent", percent: 100 }
    default:
      return null
  }
}

export type TargetLike = {
  tagName?: string
  type?: string
  isContentEditable?: boolean
  role?: string | null
} | null | undefined

const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
])

/** True for elements that take typed text (shortcuts must not fire). */
export function isEditableTarget(target: TargetLike): boolean {
  if (!target) return false
  if (target.isContentEditable) return true

  const tag = target.tagName?.toUpperCase()

  if (tag === "TEXTAREA" || tag === "SELECT") return true
  if (tag === "INPUT") return !NON_TEXT_INPUTS.has((target.type ?? "text").toLowerCase())

  return target.role === "textbox" || target.role === "combobox" || target.role === "searchbox"
}
