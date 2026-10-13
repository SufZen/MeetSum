/**
 * Playback speed ladder and persisted player prefs (M4, client-safe, pure).
 */

export const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const

export const RATE_STORAGE_KEY = "meetsum.player.rate"
export const VOLUME_STORAGE_KEY = "meetsum.player.volume"

function nearestRateIndex(rate: number): number {
  let best = 0

  RATES.forEach((candidate, index) => {
    if (Math.abs(candidate - rate) < Math.abs(RATES[best] - rate)) best = index
  })

  return best
}

/** One step up (1) or down (-1) the ladder, clamped at the ends. */
export function nextRate(current: number, step: 1 | -1): number {
  const index = nearestRateIndex(current)
  const snapped = RATES[index]
  let target = index

  if (step === 1) target = snapped > current ? index : index + 1
  else target = snapped < current ? index : index - 1

  return RATES[Math.min(RATES.length - 1, Math.max(0, target))]
}

export function formatRate(rate: number): string {
  return `${Number(rate.toFixed(2))}×`
}

type StorageLike = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export type PlayerPrefs = { rate: number; volume: number }

function safeGet(storage: StorageLike | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

export function readPlayerPrefs(storage: StorageLike | undefined): PlayerPrefs {
  const rate = Number(safeGet(storage, RATE_STORAGE_KEY))
  const rawVolume = safeGet(storage, VOLUME_STORAGE_KEY)
  const volume = rawVolume === null ? Number.NaN : Number(rawVolume)

  return {
    rate: (RATES as readonly number[]).includes(rate) ? rate : 1,
    volume: Number.isFinite(volume) && volume >= 0 && volume <= 1 ? volume : 1,
  }
}

export function writePlayerPref(
  storage: StorageLike | undefined,
  pref: "rate" | "volume",
  value: number
): void {
  try {
    storage?.setItem(pref === "rate" ? RATE_STORAGE_KEY : VOLUME_STORAGE_KEY, String(value))
  } catch {
    // Private mode or quota: prefs are a convenience.
  }
}
