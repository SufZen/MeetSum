import { describe, expect, it } from "vitest"

import {
  createApiKeyHash,
  verifyApiKey,
  extractBearerToken,
  getConfiguredApiKeyHashes,
  type ApiKeyRecord,
} from "@/lib/auth/api-keys"

describe("api key CRUD types", () => {
  it("ApiKeyRecord has all required fields", () => {
    const record: ApiKeyRecord = {
      id: "api_key_abc12345",
      label: "CI/CD Pipeline",
      keyPrefix: "ms_8a3f1b2c",
      createdAt: "2026-05-29T08:00:00Z",
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
    }

    expect(record.id).toMatch(/^api_key_/)
    expect(record.keyPrefix).toMatch(/^ms_/)
    expect(record.label).toBe("CI/CD Pipeline")
    expect(record.expiresAt).toBeNull()
    expect(record.revokedAt).toBeNull()
  })

  it("ApiKeyRecord supports revoked state", () => {
    const revoked: ApiKeyRecord = {
      id: "api_key_def45678",
      label: "Old Key",
      keyPrefix: "ms_9b4e2c3d",
      createdAt: "2026-05-01T08:00:00Z",
      expiresAt: null,
      revokedAt: "2026-05-29T09:00:00Z",
      lastUsedAt: "2026-05-28T12:00:00Z",
    }

    expect(revoked.revokedAt).toBeTruthy()
    expect(revoked.lastUsedAt).toBeTruthy()
  })

  it("ApiKeyRecord supports expiration", () => {
    const expiring: ApiKeyRecord = {
      id: "api_key_ghi78901",
      label: "Temp Key",
      keyPrefix: "ms_1c5f3d4e",
      createdAt: "2026-05-29T08:00:00Z",
      expiresAt: "2026-06-29T08:00:00Z",
      revokedAt: null,
      lastUsedAt: null,
    }

    expect(expiring.expiresAt).toBeTruthy()
    const expiresDate = new Date(expiring.expiresAt!)
    const createdDate = new Date(expiring.createdAt)
    expect(expiresDate.getTime()).toBeGreaterThan(createdDate.getTime())
  })
})

describe("api key hash and verify", () => {
  it("creates a sha256-prefixed hash", () => {
    const hash = createApiKeyHash("test-key-123")
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it("produces consistent hashes for the same input", () => {
    const hash1 = createApiKeyHash("my-api-key")
    const hash2 = createApiKeyHash("my-api-key")
    expect(hash1).toBe(hash2)
  })

  it("produces different hashes for different inputs", () => {
    const hash1 = createApiKeyHash("key-a")
    const hash2 = createApiKeyHash("key-b")
    expect(hash1).not.toBe(hash2)
  })

  it("verifies a key against its own hash", () => {
    const key = "ms_test_verification_key"
    const hash = createApiKeyHash(key)
    expect(verifyApiKey(key, [hash])).toBe(true)
  })

  it("rejects an incorrect key", () => {
    const hash = createApiKeyHash("correct-key")
    expect(verifyApiKey("wrong-key", [hash])).toBe(false)
  })

  it("rejects empty key", () => {
    expect(verifyApiKey("", [createApiKeyHash("any")])).toBe(false)
    expect(verifyApiKey(undefined, [createApiKeyHash("any")])).toBe(false)
  })

  it("rejects when hash list is empty", () => {
    expect(verifyApiKey("any-key", [])).toBe(false)
  })
})

describe("extractBearerToken", () => {
  it("extracts token from Bearer header", () => {
    const headers = new Headers({ Authorization: "Bearer my-token-123" })
    expect(extractBearerToken(headers)).toBe("my-token-123")
  })

  it("returns undefined for non-Bearer auth", () => {
    const headers = new Headers({ Authorization: "Basic dXNlcjpwYXNz" })
    expect(extractBearerToken(headers)).toBeUndefined()
  })

  it("returns undefined when no auth header", () => {
    const headers = new Headers()
    expect(extractBearerToken(headers)).toBeUndefined()
  })
})

describe("getConfiguredApiKeyHashes", () => {
  it("reads from MEETSUM_API_KEY_HASHES", () => {
    const hashes = getConfiguredApiKeyHashes({
      MEETSUM_API_KEY_HASHES: "sha256:abc123,sha256:def456",
    } as unknown as NodeJS.ProcessEnv)

    expect(hashes).toHaveLength(2)
    expect(hashes[0]).toContain("sha256:")
  })

  it("hashes raw keys from MEETSUM_API_KEYS", () => {
    const hashes = getConfiguredApiKeyHashes({
      MEETSUM_API_KEYS: "raw-key-1,raw-key-2",
    } as unknown as NodeJS.ProcessEnv)

    expect(hashes).toHaveLength(2)
    expect(hashes[0]).toMatch(/^sha256:/)
  })

  it("returns empty array when no env vars set", () => {
    const hashes = getConfiguredApiKeyHashes({} as unknown as NodeJS.ProcessEnv)
    expect(hashes).toHaveLength(0)
  })
})
