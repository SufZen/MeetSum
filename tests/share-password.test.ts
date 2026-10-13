import { describe, expect, it, vi } from "vitest"

const crypto = vi.hoisted(() => ({ timingSafeEqual: vi.fn() }))

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>()

  crypto.timingSafeEqual.mockImplementation(actual.timingSafeEqual)

  return { ...actual, default: actual, timingSafeEqual: crypto.timingSafeEqual }
})

import { createApiKeyHash } from "@/lib/auth/api-keys"
import {
  hashSharePassword,
  SHARE_PASSWORD_MAX,
  SHARE_PASSWORD_MIN,
  validateSharePassword,
  verifySharePassword,
} from "@/lib/sharing/share-password"
import { generateSharePassword } from "@/lib/sharing/password-policy"

describe("share passwords (M9 B4)", () => {
  it("hashes with scrypt N=2^15 r=8 p=1, a 16-byte salt and a 32-byte key", async () => {
    const hash = await hashSharePassword("correct horse")
    const [prefix, n, r, p, salt, key] = hash.split("$")

    expect(prefix).toBe("scrypt")
    expect([n, r, p]).toEqual(["32768", "8", "1"])
    expect(Buffer.from(salt!, "base64")).toHaveLength(16)
    expect(Buffer.from(key!, "base64")).toHaveLength(32)
    expect(hash).not.toContain("correct horse")
  })

  it("round-trips and rejects a wrong password", async () => {
    const hash = await hashSharePassword("סיסמה-סודית")

    expect(await verifySharePassword("סיסמה-סודית", hash)).toBe(true)
    expect(await verifySharePassword("סיסמה-סודיתx", hash)).toBe(false)
    expect(await verifySharePassword("", hash)).toBe(false)
  })

  it("salts every hash", async () => {
    expect(await hashSharePassword("same password")).not.toBe(await hashSharePassword("same password"))
  })

  it("compares in constant time", async () => {
    const hash = await hashSharePassword("timing safe")

    crypto.timingSafeEqual.mockClear()
    await verifySharePassword("timing wrong", hash)

    expect(crypto.timingSafeEqual).toHaveBeenCalledTimes(1)
  })

  it("still verifies the memory repository's legacy sha256 hashes", async () => {
    const legacy = createApiKeyHash("legacy-pass")

    expect(await verifySharePassword("legacy-pass", legacy)).toBe(true)
    expect(await verifySharePassword("other-pass", legacy)).toBe(false)
  })

  it("refuses malformed or tampered hashes without throwing", async () => {
    for (const stored of [
      "scrypt$1048576$8$1$c2FsdA==$a2V5a2V5a2V5a2V5a2V5",
      "scrypt$1000$8$1$c2FsdA==$a2V5a2V5a2V5a2V5a2V5a2V5",
      "scrypt$32768$8$1$$",
      "bcrypt$whatever",
      "",
    ]) {
      expect(await verifySharePassword("anything-long", stored)).toBe(false)
    }
    expect(await verifySharePassword("anything-long", null)).toBe(false)
  })

  it("enforces 10–128 characters (code points) for new passwords", () => {
    expect(SHARE_PASSWORD_MIN).toBe(10)
    expect(validateSharePassword("123456789")).toEqual({ error: "password_too_short" })
    expect(validateSharePassword("12345678")).toEqual({ error: "password_too_short" })
    expect(validateSharePassword("          ")).toEqual({ error: "password_too_short" })
    expect(validateSharePassword("1234567890")).toEqual({ password: "1234567890" })
    expect(validateSharePassword("🔒".repeat(SHARE_PASSWORD_MAX))).toEqual({ password: "🔒".repeat(SHARE_PASSWORD_MAX) })
    expect(validateSharePassword("a".repeat(SHARE_PASSWORD_MAX + 1))).toEqual({ error: "password_too_long" })
    expect(validateSharePassword(12345678)).toEqual({ error: "password_invalid" })
  })

  it("keeps verifying an existing shorter (8-character) password", async () => {
    expect(await verifySharePassword("12345678", await hashSharePassword("12345678"))).toBe(true)
  })

  it("generates a strong 16-character password from an unambiguous alphabet", () => {
    const passwords = Array.from({ length: 50 }, () => generateSharePassword())

    for (const password of passwords) {
      expect(password).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{16}$/)
      expect(validateSharePassword(password)).toEqual({ password })
    }
    expect(new Set(passwords).size).toBe(50)
  })

  it("never verifies an over-long candidate (no unbounded work)", async () => {
    const hash = await hashSharePassword("a".repeat(SHARE_PASSWORD_MAX))

    expect(await verifySharePassword("a".repeat(SHARE_PASSWORD_MAX + 1), hash)).toBe(false)
  })
})
