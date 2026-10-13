/**
 * Transcript follow mode (M4, client-safe, pure).
 *
 * While following, the active segment is kept in the middle of the
 * transcript. Any user scroll gesture (wheel, touch, pointer drag, scroll
 * keys) or a search jump pauses follow and shows "Back to playback"; seeking
 * from the transcript itself re-engages it.
 */

export type FollowState = { follow: boolean; showResume: boolean }

export type FollowEvent =
  | { type: "userScroll" }
  | { type: "resume" }
  | { type: "activeChanged"; visible: boolean }
  | { type: "searchJump" }
  | { type: "userSeekFromTranscript" }
  | { type: "setFollow"; value: boolean }

export const INITIAL_FOLLOW_STATE: FollowState = { follow: true, showResume: false }

const PAUSED: FollowState = { follow: false, showResume: true }

export function followReducer(state: FollowState, event: FollowEvent): FollowState {
  switch (event.type) {
    case "userScroll":
    case "searchJump":
      return state.follow || !state.showResume ? PAUSED : state
    case "resume":
    case "userSeekFromTranscript":
      return state.follow && !state.showResume ? state : INITIAL_FOLLOW_STATE
    case "activeChanged":
      if (state.follow || event.visible || state.showResume) return state

      return PAUSED
    case "setFollow":
      if (event.value) return state.follow && !state.showResume ? state : INITIAL_FOLLOW_STATE

      return state.follow || !state.showResume ? PAUSED : state
  }
}

/** Fraction of the viewport (centred) the active row may sit in. */
export const FOLLOW_BAND = 0.6

/**
 * True when the active row has left the middle band of the viewport, i.e.
 * follow should scroll it back to the centre.
 */
export function isOutsideFollowBand({
  rowTop,
  rowBottom,
  viewportTop,
  viewportHeight,
}: {
  rowTop: number
  rowBottom: number
  viewportTop: number
  viewportHeight: number
}): boolean {
  const margin = (viewportHeight * (1 - FOLLOW_BAND)) / 2
  const bandTop = viewportTop + margin
  const bandBottom = viewportTop + viewportHeight - margin

  // A tall row that starts inside the band is fine even if it overflows it.
  return rowTop < bandTop || rowTop > bandBottom || rowBottom < rowTop
}
