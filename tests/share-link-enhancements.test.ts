import { describe, expect, it } from "vitest"

import type { MeetingShare } from "@/lib/meetings/repository"
import { createApiKeyHash, verifyApiKey } from "@/lib/auth/api-keys"

describe("share link enhancements", () => {
  it("MeetingShare supports expiresAt field", () => {
    const share: MeetingShare = {
      id: "share_test_001",
      meetingId: "meeting_001",
      token: "abc123def456",
      visibility: "public",
      revoked: false,
      expiresAt: "2026-06-15T23:59:59Z",
      includedSections: ["summary", "transcript"],
      createdAt: "2026-05-29T09:00:00Z",
      updatedAt: "2026-05-29T09:00:00Z",
    }

    expect(share.expiresAt).toBe("2026-06-15T23:59:59Z")
    const expiry = new Date(share.expiresAt!)
    expect(expiry.getTime()).toBeGreaterThan(new Date(share.createdAt).getTime())
  })

  it("MeetingShare supports passwordHash field", () => {
    const share: MeetingShare = {
      id: "share_test_002",
      meetingId: "meeting_001",
      token: "abc123def456",
      visibility: "public",
      revoked: false,
      passwordHash: createApiKeyHash("secret-password"),
      includedSections: ["summary"],
      createdAt: "2026-05-29T09:00:00Z",
      updatedAt: "2026-05-29T09:00:00Z",
    }

    expect(share.passwordHash).toMatch(/^sha256:/)
  })

  it("can verify a share password using existing verifyApiKey", () => {
    const password = "meeting-share-secret"
    const hash = createApiKeyHash(password)

    // Correct password should verify
    expect(verifyApiKey(password, [hash])).toBe(true)

    // Wrong password should not verify
    expect(verifyApiKey("wrong-password", [hash])).toBe(false)
  })

  it("share without password has no passwordHash", () => {
    const share: MeetingShare = {
      id: "share_test_003",
      meetingId: "meeting_002",
      token: "xyz789",
      visibility: "public",
      revoked: false,
      includedSections: ["summary", "decisions", "action_items", "transcript", "participants"],
      createdAt: "2026-05-29T09:00:00Z",
      updatedAt: "2026-05-29T09:00:00Z",
    }

    expect(share.passwordHash).toBeUndefined()
  })

  it("expiration check works correctly", () => {
    const share: MeetingShare = {
      id: "share_expired",
      meetingId: "meeting_001",
      token: "expired123",
      visibility: "public",
      revoked: false,
      expiresAt: "2020-01-01T00:00:00Z",
      includedSections: ["summary"],
      createdAt: "2019-12-01T00:00:00Z",
      updatedAt: "2019-12-01T00:00:00Z",
    }

    const isExpired =
      share.expiresAt && new Date(share.expiresAt).getTime() < Date.now()

    expect(isExpired).toBe(true)
  })

  it("non-expired share passes check", () => {
    const future = new Date(Date.now() + 86400000 * 30).toISOString()
    const share: MeetingShare = {
      id: "share_active",
      meetingId: "meeting_001",
      token: "active123",
      visibility: "public",
      revoked: false,
      expiresAt: future,
      includedSections: ["summary"],
      createdAt: "2026-05-29T09:00:00Z",
      updatedAt: "2026-05-29T09:00:00Z",
    }

    const isExpired =
      share.expiresAt && new Date(share.expiresAt).getTime() < Date.now()

    expect(isExpired).toBe(false)
  })

  it("password gate: requires password when passwordHash is set", () => {
    const password = "team-secret-2026"
    const share: MeetingShare = {
      id: "share_gated",
      meetingId: "meeting_003",
      token: "gated999",
      visibility: "public",
      revoked: false,
      passwordHash: createApiKeyHash(password),
      includedSections: ["summary", "transcript"],
      createdAt: "2026-05-29T09:00:00Z",
      updatedAt: "2026-05-29T09:00:00Z",
    }

    // Should require password
    expect(share.passwordHash).toBeDefined()

    // Correct password passes
    expect(verifyApiKey(password, [share.passwordHash!])).toBe(true)

    // Wrong password fails
    expect(verifyApiKey("hacker-attempt", [share.passwordHash!])).toBe(false)

    // Empty password fails
    expect(verifyApiKey("", [share.passwordHash!])).toBe(false)
  })

  it("password gate: allows access when no passwordHash", () => {
    const share: MeetingShare = {
      id: "share_open",
      meetingId: "meeting_004",
      token: "open999",
      visibility: "public",
      revoked: false,
      includedSections: ["summary"],
      createdAt: "2026-05-29T09:00:00Z",
      updatedAt: "2026-05-29T09:00:00Z",
    }

    // No password required
    expect(share.passwordHash).toBeUndefined()
    // Access should be granted without verification
    expect(!share.passwordHash).toBe(true)
  })
})
