import { createCipheriv, createHash, hkdfSync, randomBytes } from "node:crypto"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { V2_KEY_LABEL, decryptSecret, encryptSecret } from "@/lib/auth/secret-crypto"
import { openMeetingSecrets, sealMeetingSecrets } from "@/lib/bot/dispatch"
import { encryptWebhookSecret, resolveSubscriptionSecret } from "@/lib/webhooks/secret"

/**
 * M8 Step 0: row-bound (AAD) encryption without a downgrade path, and v1
 * compatibility for the existing callers (docs/parity/m8.md, "Token secrecy").
 */

const KEY_SOURCE = "secret-crypto-aad-test-key"
const MASTER = createHash("sha256").update(KEY_SOURCE).digest()
const AAD = "ws_1:intc_1:access_token"

function seal(version: string, key: Buffer, value: string, aad?: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)

  if (aad !== undefined) cipher.setAAD(Buffer.from(aad))

  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])

  return [version, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(":")
}

/** A v1 ciphertext built exactly as the pre-M8 code did (sha256 key, no AAD). */
const legacyV1 = (value: string) => seal("v1", MASTER, value)

function withPrefix(sealed: string, version: string) {
  return [version, ...sealed.split(":").slice(1)].join(":")
}

beforeEach(() => {
  vi.stubEnv("GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY", KEY_SOURCE)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("unbound (v1) secrets: existing callers", () => {
  it("keeps v1 for callers without AAD and decrypts legacy v1 values", () => {
    const sealed = encryptSecret("google-refresh-token")

    expect(sealed.startsWith("v1:")).toBe(true)
    expect(decryptSecret(sealed)).toBe("google-refresh-token")
    expect(decryptSecret(legacyV1("bot-passcode"))).toBe("bot-passcode")
  })

  it("round-trips M7 sealMeetingSecrets and legacy plain passcodes", () => {
    const sealed = sealMeetingSecrets({
      platform: "zoom",
      passcode: "123456",
      canonicalUrl: "https://zoom.us/j/1234567890",
    })

    expect(sealed?.startsWith("v1:")).toBe(true)
    expect(openMeetingSecrets(sealed)).toMatchObject({ passcode: "123456" })
    expect(openMeetingSecrets(legacyV1("654321"))).toMatchObject({ passcode: "654321" })
  })

  it("round-trips M1/M2 webhook subscription secrets (API keys are hashed, not encrypted)", () => {
    const ciphertext = encryptWebhookSecret("whsec_example_secret_value")

    expect(resolveSubscriptionSecret({ secret_ciphertext: ciphertext })).toBe("whsec_example_secret_value")
    expect(resolveSubscriptionSecret({ secret_ciphertext: legacyV1("whsec_legacy") })).toBe("whsec_legacy")
  })

  it("never accepts a v2 (row-bound) value through the unbound path", () => {
    expect(() => decryptSecret(encryptSecret("xoxb-token", AAD))).toThrow()
  })
})

describe("row-bound (v2) secrets", () => {
  it("writes v2 with a purpose-derived key and round-trips with the same AAD", () => {
    const sealed = encryptSecret("xoxb-token", AAD)
    const derived = Buffer.from(hkdfSync("sha256", MASTER, Buffer.alloc(0), V2_KEY_LABEL, 32))

    expect(sealed.startsWith("v2:")).toBe(true)
    expect(sealed).not.toContain("xoxb")
    expect(decryptSecret(sealed, AAD)).toBe("xoxb-token")
    // Independently derived HKDF key decrypts it; the bare master does not.
    expect(decryptSecret(seal("v2", derived, "x", AAD), AAD)).toBe("x")
    expect(() => decryptSecret(seal("v2", MASTER, "x", AAD), AAD)).toThrow()
  })

  it("fails when the value is moved to another row, workspace or column", () => {
    const sealed = encryptSecret("xoxb-token", AAD)

    expect(() => decryptSecret(sealed, "ws_1:intc_2:access_token")).toThrow()
    expect(() => decryptSecret(sealed, "ws_2:intc_1:access_token")).toThrow()
    expect(() => decryptSecret(sealed, "ws_1:intc_1:refresh_token")).toThrow()
  })

  it("fails when the version prefix is stripped or rewritten to v1 (no downgrade)", () => {
    const sealed = encryptSecret("xoxb-token", AAD)
    const stripped = sealed.split(":").slice(1).join(":")

    expect(() => decryptSecret(stripped, AAD)).toThrow("Unsupported encrypted secret format")
    expect(() => decryptSecret(withPrefix(sealed, "v1"))).toThrow()
    expect(() => decryptSecret(withPrefix(sealed, "v1"), AAD)).toThrow()
    expect(() => decryptSecret(withPrefix(sealed, "v1"), AAD, { allowLegacyV1: true })).toThrow()
  })

  it("refuses an unbound v1 value in a bound field unless the caller opts in for migration", () => {
    const unbound = encryptSecret("google-refresh-token")

    expect(() => decryptSecret(unbound, AAD)).toThrow("Unbound encrypted secret refused for a bound field")
    expect(decryptSecret(unbound, AAD, { allowLegacyV1: true })).toBe("google-refresh-token")
  })

  it("fails on a tampered tag or ciphertext, a truncated tag and an unknown version", () => {
    const sealed = encryptSecret("refresh", AAD)
    const [version, iv, tag, ct] = sealed.split(":")
    const flip = (value: string) => {
      const bytes = Buffer.from(value, "base64url")

      bytes[0] ^= 0xff
      return bytes.toString("base64url")
    }
    const shortTag = Buffer.from(tag, "base64url").subarray(0, 12).toString("base64url")

    expect(() => decryptSecret([version, iv, flip(tag), ct].join(":"), AAD)).toThrow()
    expect(() => decryptSecret([version, iv, tag, flip(ct)].join(":"), AAD)).toThrow()
    expect(() => decryptSecret([version, iv, shortTag, ct].join(":"), AAD)).toThrow("Unsupported encrypted secret format")
    expect(() => decryptSecret(withPrefix(sealed, "v3"), AAD)).toThrow("Unsupported encrypted secret format")
    expect(() => decryptSecret(`${sealed}:extra`, AAD)).toThrow("Unsupported encrypted secret format")
    expect(() => decryptSecret(Buffer.from("refresh").toString("base64"), AAD)).toThrow()
  })

  it("uses a fresh random IV for every encryption", () => {
    const ivs = new Set(Array.from({ length: 20 }, () => encryptSecret("same", AAD).split(":")[1]))

    expect(ivs.size).toBe(20)
    expect(Buffer.from([...ivs][0], "base64url").length).toBe(12)
  })
})
