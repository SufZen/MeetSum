import { describe, expect, it } from "vitest"

import {
  createGoogleAuthorizationUrl,
  createSessionCookie,
  verifySessionCookie,
} from "@/lib/auth/session"

describe("Google OAuth session", () => {
  it("creates and verifies signed session cookies for allowed users", () => {
    const cookie = createSessionCookie(
      {
        email: "info@realization.co.il",
        name: "MeetSum Admin",
        picture: "https://example.com/avatar.png",
      },
      {
        secret: "test-secret",
        allowedEmails: ["info@realization.co.il"],
        now: 1_000,
      }
    )

    expect(
      verifySessionCookie(cookie.value, {
        secret: "test-secret",
        allowedEmails: ["info@realization.co.il"],
        now: 1_000,
      })
    ).toMatchObject({
      email: "info@realization.co.il",
      name: "MeetSum Admin",
    })
  })

  it("rejects tampered cookies and users outside the allow-list", () => {
    const cookie = createSessionCookie(
      { email: "info@realization.co.il" },
      {
        secret: "test-secret",
        allowedEmails: ["info@realization.co.il"],
        now: 1_000,
      }
    )

    expect(
      verifySessionCookie(`${cookie.value}x`, {
        secret: "test-secret",
        allowedEmails: ["info@realization.co.il"],
        now: 1_000,
      })
    ).toBeUndefined()
    expect(
      verifySessionCookie(cookie.value, {
        secret: "test-secret",
        allowedEmails: ["other@example.com"],
        now: 1_000,
      })
    ).toBeUndefined()
  })

  it("builds Google OAuth URLs with secure OpenID scopes and state", () => {
    const url = createGoogleAuthorizationUrl({
      clientId: "client-id",
      redirectUri: "https://meetsum.realization.co.il/api/auth/google/callback",
      state: "state-123",
    })

    expect(url.origin).toBe("https://accounts.google.com")
    expect(url.searchParams.get("client_id")).toBe("client-id")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("scope")).toContain("openid")
    expect(url.searchParams.get("state")).toBe("state-123")
  })
})
