/**
 * Player contract for M5 packages (Step 0): a thin adapter over M4's
 * `useMeetingPlayer()` / `usePlayerState()`. If M4's names change, adapt
 * here only. Outside a player provider every call is a no-op.
 */
import { useCallback, useEffect, useMemo, useRef } from "react"

import {
  useMeetingPlayer,
  usePlayerState,
  type SeekSource,
} from "@/components/player/meeting-player-provider"

export type PlayerSeekOptions = {
  play?: boolean
  /** Defaults to `citation`. */
  source?: SeekSource
  segmentId?: string
}

export type PlayerContract = {
  /** False outside a player provider. */
  available: boolean
  seek: (ms: number, options?: PlayerSeekOptions) => void
  /** Plays `[startMs, endMs)` and pauses at the end (clips). */
  playRange: (startMs: number, endMs: number) => void
  currentMs: number
}

export function usePlayer(): PlayerContract {
  const player = useMeetingPlayer()
  const currentMs = usePlayerState((state) => state.currentMs)
  const stopRange = useRef<(() => void) | undefined>(undefined)

  useEffect(() => () => stopRange.current?.(), [])

  const seek = useCallback(
    (ms: number, options: PlayerSeekOptions = {}) => {
      player.seek(ms, {
        play: options.play,
        source: options.source ?? "citation",
        segmentId: options.segmentId,
      })
    },
    [player]
  )

  const playRange = useCallback(
    (startMs: number, endMs: number) => {
      stopRange.current?.()
      player.seek(startMs, { play: true, source: "citation" })

      let started = false
      const unsubscribe = player.store.subscribe(() => {
        const state = player.store.getState()

        if (state.playing) started = true
        if (state.currentMs >= endMs && state.playing) {
          player.pause()
          stop()
        } else if (started && !state.playing) {
          // Paused or seeked away by the user: stop following the range.
          stop()
        }
      })
      const stop = () => {
        unsubscribe()
        if (stopRange.current === stop) stopRange.current = undefined
      }

      stopRange.current = stop
    },
    [player]
  )

  return useMemo(
    () => ({ available: player.available, seek, playRange, currentMs }),
    [player.available, seek, playRange, currentMs]
  )
}
