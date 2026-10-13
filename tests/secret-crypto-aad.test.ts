import { createCipheriv, createHash, randomBytes } from "node:crypto"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { decryptSecret, encryptSecret } from "@/lib/auth/secret-crypto"

/** M8 Step 0: row-bound (AAD) encryption, v1 compatibility (docs/parity/m8.md). */

const KEY_SOURCE = "secret-crypto-aad-test-key"

/** A v1 ciphertext built exactly as the pre-M8 code did (no AAD). */
function legacyV1(value: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(KEY_SOURCE).digest(), iv)
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])

  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(":")
}

beforeEach(() => {
  vi.stubEnv("GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY", KEY_SOURCE)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("encryptSecret / decryptSecret", () => {
  it("keeps v1 for callers without AAD and decrypts legacy v1 values", () => {
    const sealed = encryptSecret("google-refresh-token")

    expect(sealed.startsWith("v1:")).toBe(true)
    expect(decryptSecret(sealed)).toBe("google-refresh-token")
    expect(decryptSecret(legacyV1("bot-passcode"))).toBe("bot-passcode")
    // A v1 value ignores an AAD argument (existing rows keep working).
    expect(decryptSecret(legacyV1("bot-passcode"), "ws:conn:access_token")).toBe("bot-passcode")
  })

  it("writes v2 when bound to an AAD and round-trips with the same AAD", () => {
    const aad = "ws_1:intc_1:access_token"
    const sealed = encryptSecret("xoxb-token", aad)

    expect(sealed.startsWith("v2:")).toBe(true)
    expect(sealed).not.toContain("xoxb")
    expect(decryptSecret(sealed, aad)).toBe("xoxb-token")
  })

  it("refuses a v2 value with a swapped or missing AAD (copied between rows or fields)", () => {
    const sealed = encryptSecret("xoxb-token", "ws_1:intc_1:access_token")

    expect(() => decryptSecret(sealed, "ws_1:intc_2:access_token")).toThrow()
    expect(() => decryptSecret(sealed, "ws_2:intc_1:access_token")).toThrow()
    expect(() => decryptSecret(sealed, "ws_1:intc_1:refresh_token")).toThrow()
    expect(() => decryptSecret(sealed)).toThrow()
  })

  it("detects tampering", () => {
    const aad = "ws_1:intc_1:refresh_token"
    const [version, iv, tag, ct] = encryptSecret("refresh", aad).split(":")
    const flipped = Buffer.from(ct, "base64url")

    flipped[0] ^= 0xff

    expect(() => decryptSecret([version, iv, tag, flipped.toString("base64url")].join(":"), aad)).toThrow()
    expect(() => decryptSecret(["v1", iv, tag, ct].join(":"))).toThrow()
    expect(() => decryptSecret(["v3", iv, tag, ct].join(":"), aad)).toThrow("Unsupported encrypted secret format")
  })
})
