import { describe, expect, it } from "vitest"

import { createApiKeyHash } from "@/lib/auth/api-keys"
import {
  SHARE_ACCESS_COOKIE,
  SHARE_ACCESS_MAX_AGE_SECONDS,
  createShareAccessCookie,
  getShareAccessCookiePath,
  verifyShareAccessCookie,
} from "@/lib/sharing/share-access"
import { getShareDocumentLocale } from "@/lib/sharing/share-locale"

const secret = "share-test-secret"
const token = "abc123def456"
const passwordHash = createApiKeyHash("secret-password")
const now = Date.parse("2026-10-12T10:00:00Z")

describe("share access cookie", () => {
  it("is scoped to the share path and short-lived", () => {
    const cookie = createShareAccessCookie({ token, passwordHash, secret, now })

    expect(cookie.name).toBe(SHARE_ACCESS_COOKIE)
    expect(cookie.path).toBe("/share/abc123def456")
    expect(cookie.path).toBe(getShareAccessCookiePath(token))
    expect(cookie.maxAge).toBe(SHARE_ACCESS_MAX_AGE_SECONDS)
    expect(cookie.value).not.toContain("secret-password")
  })

  it("verifies a freshly issued cookie", () => {
    const { value } = createShareAccessCookie({ token, passwordHash, secret, now })

    expect(
      verifyShareAccessCookie(value, { token, passwordHash, secret, now: now + 1000 })
    ).toBe(true)
  })

  it("rejects expired cookies", () => {
    const { value } = createShareAccessCookie({
      token,
      passwordHash,
      secret,
      now,
      maxAgeSeconds: 60,
    })

    expect(
      verifyShareAccessCookie(value, { token, passwordHash, secret, now: now + 61_000 })
    ).toBe(false)
  })

  it("rejects cookies for another share, a changed password or another secret", () => {
    const { value } = createShareAccessCookie({ token, passwordHash, secret, now })

    expect(
      verifyShareAccessCookie(value, { token: "other", passwordHash, secret, now })
    ).toBe(false)
    expect(
      verifyShareAccessCookie(value, {
        token,
        passwordHash: createApiKeyHash("new-password"),
        secret,
        now,
      })
    ).toBe(false)
    expect(
      verifyShareAccessCookie(value, { token, passwordHash, secret: "other", now })
    ).toBe(false)
  })

  it("rejects missing, malformed and tampered values", () => {
    const { value } = createShareAccessCookie({ token, passwordHash, secret, now })
    const [expiresAt, signature] = value.split(".")
    const options = { token, passwordHash, secret, now }

    expect(verifyShareAccessCookie(undefined, options)).toBe(false)
    expect(verifyShareAccessCookie("", options)).toBe(false)
    expect(verifyShareAccessCookie("garbage", options)).toBe(false)
    expect(verifyShareAccessCookie(`.${signature}`, options)).toBe(false)
    expect(verifyShareAccessCookie(`${expiresAt}.`, options)).toBe(false)
    // Extending the expiry invalidates the signature.
    expect(
      verifyShareAccessCookie(`${Number(expiresAt) + 1}.${signature}`, options)
    ).toBe(false)
    expect(verifyShareAccessCookie(`${expiresAt}.${signature}x`, options)).toBe(
      false
    )
  })
})

describe("share document locale", () => {
  it("renders Hebrew meetings right-to-left", () => {
    expect(getShareDocumentLocale({ language: "he", title: "פגישה" })).toEqual({
      lang: "he",
      dir: "rtl",
    })
  })

  it("prefers detected primary language metadata", () => {
    expect(
      getShareDocumentLocale({
        language: "mixed",
        title: "Weekly sync",
        languageMetadata: {
          primaryLanguage: "he",
          secondaryLanguages: ["en"],
          segmentLanguages: [],
          confidence: 0.9,
          mixedLanguage: true,
        },
      })
    ).toEqual({ lang: "he", dir: "rtl" })
  })

  it("detects Hebrew text for mixed meetings without metadata", () => {
    expect(
      getShareDocumentLocale({ language: "mixed", title: "סיכום Q4 roadmap" })
    ).toEqual({ lang: "he", dir: "rtl" })
  })

  it("defaults to English left-to-right", () => {
    expect(getShareDocumentLocale({ language: "en", title: "Standup" })).toEqual({
      lang: "en",
      dir: "ltr",
    })
    expect(getShareDocumentLocale(undefined)).toEqual({ lang: "en", dir: "ltr" })
  })
})
