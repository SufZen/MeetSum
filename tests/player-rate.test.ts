import { describe, expect, it } from "vitest"

import {
  RATES,
  RATE_STORAGE_KEY,
  VOLUME_STORAGE_KEY,
  formatRate,
  nextRate,
  readPlayerPrefs,
  writePlayerPref,
} from "@/lib/player/rate"

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))

  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  }
}

describe("rates", () => {
  it("offers the fixed speed ladder", () => {
    expect(RATES).toEqual([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2])
  })

  it("steps up and down the ladder and clamps at the ends", () => {
    expect(nextRate(1, 1)).toBe(1.25)
    expect(nextRate(1, -1)).toBe(0.75)
    expect(nextRate(2, 1)).toBe(2)
    expect(nextRate(0.5, -1)).toBe(0.5)
  })

  it("snaps an off-ladder rate to the nearest step before moving", () => {
    expect(nextRate(1.1, 1)).toBe(1.25)
    expect(nextRate(1.6, -1)).toBe(1.5)
    expect(nextRate(1.4, -1)).toBe(1.25)
  })

  it("formats rates for the speed menu", () => {
    expect(formatRate(1)).toBe("1×")
    expect(formatRate(1.25)).toBe("1.25×")
    expect(formatRate(0.5)).toBe("0.5×")
  })
})

describe("player prefs", () => {
  it("uses the documented localStorage keys", () => {
    expect(RATE_STORAGE_KEY).toBe("meetsum.player.rate")
    expect(VOLUME_STORAGE_KEY).toBe("meetsum.player.volume")
  })

  it("reads stored prefs and falls back on missing or invalid values", () => {
    expect(readPlayerPrefs(memoryStorage({ [RATE_STORAGE_KEY]: "1.5", [VOLUME_STORAGE_KEY]: "0.4" }))).toEqual({
      rate: 1.5,
      volume: 0.4,
    })
    expect(readPlayerPrefs(memoryStorage({ [RATE_STORAGE_KEY]: "9", [VOLUME_STORAGE_KEY]: "loud" }))).toEqual({
      rate: 1,
      volume: 1,
    })
    expect(readPlayerPrefs(undefined)).toEqual({ rate: 1, volume: 1 })
  })

  it("survives storage that throws (private mode)", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied")
      },
      setItem: () => {
        throw new Error("denied")
      },
    }

    expect(readPlayerPrefs(throwing)).toEqual({ rate: 1, volume: 1 })
    expect(() => writePlayerPref(throwing, "rate", 1.5)).not.toThrow()
  })

  it("writes prefs", () => {
    const storage = memoryStorage()

    writePlayerPref(storage, "rate", 1.75)
    writePlayerPref(storage, "volume", 0.25)
    expect(storage.data.get(RATE_STORAGE_KEY)).toBe("1.75")
    expect(storage.data.get(VOLUME_STORAGE_KEY)).toBe("0.25")
  })
})
