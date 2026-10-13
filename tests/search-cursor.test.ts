import { describe, expect, it } from "vitest"

import { InvalidCursorError, cursorBinding, decodeCursor, encodeCursor } from "@/lib/search/cursor"

const binding = cursorBinding({ principalKey: "user_1", q: "תקציב", filters: { tags: ["a"] }, group: "meeting" })

describe("search cursor", () => {
  it("round-trips the offset for the same query", () => {
    expect(decodeCursor(encodeCursor(20, binding), binding)).toBe(20)
  })

  it("binding ignores filter key order and array order but not values", () => {
    const a = cursorBinding({ principalKey: "u", q: "x", filters: { tags: ["b", "a"], roomIds: ["r"] }, group: "chunk" })
    const b = cursorBinding({ principalKey: "u", q: "x", filters: { roomIds: ["r"], tags: ["a", "b"] }, group: "chunk" })
    const c = cursorBinding({ principalKey: "u", q: "x", filters: { roomIds: ["r2"], tags: ["a", "b"] }, group: "chunk" })

    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it("rejects a cursor from another query, group or principal", () => {
    const other = cursorBinding({ principalKey: "user_2", q: "תקציב", filters: { tags: ["a"] }, group: "meeting" })
    const chunk = cursorBinding({ principalKey: "user_1", q: "תקציב", filters: { tags: ["a"] }, group: "chunk" })

    expect(() => decodeCursor(encodeCursor(20, binding), other)).toThrow(InvalidCursorError)
    expect(() => decodeCursor(encodeCursor(20, binding), chunk)).toThrow(InvalidCursorError)
  })

  it("rejects tampered and malformed cursors", () => {
    const tampered = Buffer.from(JSON.stringify({ o: 5000, h: binding.split(".")[0] })).toString("base64url")

    expect(() => decodeCursor(tampered, binding)).toThrow(InvalidCursorError)
    expect(() => decodeCursor("not-base64-json", binding)).toThrow(InvalidCursorError)
    expect(() => decodeCursor(Buffer.from('{"o":-1}').toString("base64url"), binding)).toThrow(InvalidCursorError)
    expect(() => decodeCursor("x".repeat(2000), binding)).toThrow(InvalidCursorError)

    const forged = JSON.parse(Buffer.from(encodeCursor(20, binding), "base64url").toString("utf8")) as { o: number; s: string }

    forged.o = 40
    expect(() => decodeCursor(Buffer.from(JSON.stringify(forged)).toString("base64url"), binding)).toThrow(
      InvalidCursorError
    )
  })
})
