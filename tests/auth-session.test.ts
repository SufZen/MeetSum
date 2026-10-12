import { createHmac } from "node:crypto"

import { describe, expect, it } from "vitest"

import {
  createGoogleAuthorizationUrl,
  createSessionCookie,
  getSessionSecret,
  readRequestCookie,
  verifySessionCookie,
} from "@/lib/auth/session"

describe("getSessionSecret", () => {
  it("requires MEETSUM_SESSION_SECRET with no webhook-secret fallback", () => {
    expect(() =>
      getSessionSecret({
        NODE_ENV: "test",
        WEBHOOK_SIGNING_SECRET: "webhook-secret",
      } as NodeJS.ProcessEnv)
    ).toThrow(/MEETSUM_SESSION_SECRET is required/)
  })

  it("rejects a session secret equal to the webhook secret", () => {
    expect(() =>
      getSessionSecret({
        NODE_ENV: "test",
        MEETSUM_SESSION_SECRET: "shared",
        WEBHOOK_SIGNING_SECRET: "shared",
      } as NodeJS.ProcessEnv)
    ).toThrow(/must be different/)
  })

  it("returns a distinct session secret", () => {
    expect(
      getSessionSecret({
        NODE_ENV: "test",
        MEETSUM_SESSION_SECRET: "session-secret",
        WEBHOOK_SIGNING_SECRET: "webhook-secret",
      } as NodeJS.ProcessEnv)
    ).toBe("session-secret")
  })
})

describe("Google OAuth session", () => {
  it("creates and verifies v2 session cookies carrying the user id", () => {
    const cookie = createSessionCookie(
      {
        userId: "usr_1",
        email: "Info@Realization.co.il",
        name: "MeetSum Admin",
        picture: "https://example.com/avatar.png",
      },
      { secret: "test-secret", now: 1_000 }
    )

    expect(
      verifySessionCookie(cookie.value, { secret: "test-secret", now: 1_000 })
    ).toMatchObject({
      v: 2,
      userId: "usr_1",
      email: "info@realization.co.il",
      name: "MeetSum Admin",
    })
  })

  it("no longer consults an allowlist: any signed-in identity gets a session", () => {
    const cookie = createSessionCookie(
      { userId: "usr_2", email: "invitee@example.com" },
      { secret: "test-secret", now: 1_000 }
    )

    expect(
      verifySessionCookie(cookie.value, { secret: "test-secret", now: 1_000 })
    ).toMatchObject({ userId: "usr_2", email: "invitee@example.com" })
  })

  it("rejects tampered, expired and wrongly signed cookies", () => {
    const cookie = createSessionCookie(
      { userId: "usr_1", email: "info@realization.co.il" },
      { secret: "test-secret", now: 1_000 }
    )

    expect(
      verifySessionCookie(`${cookie.value}x`, { secret: "test-secret", now: 1_000 })
    ).toBeUndefined()
    expect(
      verifySessionCookie(cookie.value, { secret: "other-secret", now: 1_000 })
    ).toBeUndefined()
    expect(
      verifySessionCookie(cookie.value, {
        secret: "test-secret",
        now: 1_000 + 8 * 24 * 3600 * 1000,
      })
    ).toBeUndefined()
  })

  it("rejects v1 (allowlist-era) cookies so users sign in once more", () => {
    const encoded = Buffer.from(
      JSON.stringify({ email: "info@realization.co.il", expiresAt: 10_000 })
    ).toString("base64url")
    const signature = createHmac("sha256", "test-secret")
      .update(encoded)
      .digest("base64url")

    expect(
      verifySessionCookie(`${encoded}.${signature}`, {
        secret: "test-secret",
        now: 1_000,
      })
    ).toBeUndefined()
  })

  it("requires a user id to create a session", () => {
    expect(() =>
      createSessionCookie(
        { userId: "", email: "info@realization.co.il" },
        { secret: "test-secret" }
      )
    ).toThrow(/user id/)
  })

  it("reads cookies from a raw Cookie header", () => {
    const request = new Request("http://localhost/", {
      headers: { cookie: "a=1; meetsum_session=abc.def; b=%7Bx%7D" },
    })

    expect(readRequestCookie(request, "meetsum_session")).toBe("abc.def")
    expect(readRequestCookie(request, "b")).toBe("{x}")
    expect(readRequestCookie(request, "missing")).toBeUndefined()
  })

  it("builds Google OAuth URLs with secure OpenID scopes and state", () => {
    const url = createGoogleAuthorizationUrl({
      clientId: "client-id",
      redirectUri: "https://meetsum.realization.co.il/api/auth/google/callback",
      state: "state-123",
      scopes: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/calendar.readonly",
      ],
      prompt: "consent select_account",
    })

    expect(url.origin).toBe("https://accounts.google.com")
    expect(url.searchParams.get("client_id")).toBe("client-id")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("scope")).toContain("openid")
    expect(url.searchParams.get("scope")).toContain("calendar.readonly")
    expect(url.searchParams.get("prompt")).toBe("consent select_account")
    expect(url.searchParams.get("include_granted_scopes")).toBe("true")
    expect(url.searchParams.get("state")).toBe("state-123")
  })
})
