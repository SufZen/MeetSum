import { describe, expect, it } from "vitest"

import {
  createApiKey,
  createApiKeyHash,
  listApiKeys,
  normalizeApiKeyScopes,
  parseApiKeyScopes,
  resolveEnvApiKey,
  revokeApiKey,
  verifyDatabaseApiKey,
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
      workspaceId: "ws_default",
      scopes: ["read"],
      createdByUserId: null,
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
      workspaceId: "ws_default",
      scopes: ["read"],
      createdByUserId: null,
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
      workspaceId: "ws_default",
      scopes: ["read"],
      createdByUserId: null,
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

type Call = { text: string; values: unknown[] }

function recordingDb(rows: unknown[] = []) {
  const calls: Call[] = []

  return {
    calls,
    db: {
      async query(text: string, values: unknown[] = []) {
        calls.push({ text, values })
        return { rows }
      },
    },
  }
}

const keyRow = {
  id: "api_key_1",
  label: "CI",
  key_prefix: "ms_12345678",
  workspace_id: "ws_a",
  scopes: ["read", "write"],
  created_by_user_id: "usr_1",
  created_at: new Date("2026-10-01T00:00:00Z"),
  expires_at: null,
  revoked_at: null,
  last_used_at: null,
}

describe("api key scopes", () => {
  it("normalises scopes with implication admin > write > read", () => {
    expect(normalizeApiKeyScopes(["admin"])).toEqual(["read", "write", "admin"])
    expect(normalizeApiKeyScopes(["write", "bogus"])).toEqual(["read", "write"])
    expect(normalizeApiKeyScopes(["bogus"])).toEqual([])
    expect(parseApiKeyScopes(" Read , write ")).toEqual(["read", "write"])
  })
})

describe("env API keys", () => {
  const env = (extra: Record<string, string> = {}) =>
    ({ MEETSUM_API_KEYS: "env-key-1", ...extra }) as unknown as NodeJS.ProcessEnv

  it("binds env keys to ws_default with read,write by default (never admin)", () => {
    expect(resolveEnvApiKey("env-key-1", env())).toMatchObject({
      id: "env",
      workspaceId: "ws_default",
      scopes: ["read", "write"],
      source: "env",
    })
  })

  it("honours MEETSUM_ENV_API_KEY_WORKSPACE_ID and MEETSUM_ENV_API_KEY_SCOPES", () => {
    expect(
      resolveEnvApiKey(
        "env-key-1",
        env({
          MEETSUM_ENV_API_KEY_WORKSPACE_ID: "ws_other",
          MEETSUM_ENV_API_KEY_SCOPES: "read",
        })
      )
    ).toMatchObject({ workspaceId: "ws_other", scopes: ["read"] })
  })

  it("rejects unknown tokens", () => {
    expect(resolveEnvApiKey("nope", env())).toBeUndefined()
    expect(resolveEnvApiKey(undefined, env())).toBeUndefined()
  })
})

describe("database API keys are workspace-scoped", () => {
  it("creates a key bound to the workspace, scopes and creator; stores only the hash", async () => {
    const { db, calls } = recordingDb([keyRow])
    const { rawKey, record } = await createApiKey(
      { workspaceId: "ws_a", label: "CI", scopes: ["write"], createdByUserId: "usr_1" },
      db
    )

    expect(rawKey).toMatch(/^ms_[a-f0-9]{64}$/)
    expect(calls[0].text).toMatch(/workspace_id, scopes, created_by_user_id/)
    expect(calls[0].values).toContain(createApiKeyHash(rawKey))
    expect(calls[0].values).not.toContain(rawKey)
    expect(calls[0].values).toContain("ws_a")
    expect(calls[0].values).toContain(JSON.stringify(["read", "write"]))
    expect(record).toMatchObject({
      workspaceId: "ws_a",
      scopes: ["read", "write"],
      createdByUserId: "usr_1",
      createdAt: "2026-10-01T00:00:00.000Z",
    })
  })

  it("refuses a key without scopes", async () => {
    const { db } = recordingDb([keyRow])

    await expect(createApiKey({ workspaceId: "ws_a", scopes: [] }, db)).rejects.toThrow(
      /scope/
    )
  })

  it("lists and revokes only within the workspace", async () => {
    const list = recordingDb([keyRow])

    await listApiKeys("ws_a", list.db)
    expect(list.calls[0].text).toMatch(/WHERE workspace_id = \$1/)
    expect(list.calls[0].values).toEqual(["ws_a"])

    const revoke = recordingDb([])

    expect(await revokeApiKey("ws_b", "api_key_1", revoke.db)).toBeNull()
    expect(revoke.calls[0].text).toMatch(/workspace_id = \$2/)
    expect(revoke.calls[0].values).toEqual(["api_key_1", "ws_b"])
  })

  it("verifies a database key into a principal with workspace and scopes", async () => {
    const { db } = recordingDb([keyRow])

    expect(await verifyDatabaseApiKey("ms_whatever", db)).toEqual({
      id: "api_key_1",
      label: "CI",
      workspaceId: "ws_a",
      scopes: ["read", "write"],
      createdByUserId: "usr_1",
      source: "database",
    })
  })

  it("fails closed on database errors", async () => {
    const db = {
      async query(): Promise<{ rows: unknown[] }> {
        throw new Error("db down")
      },
    }

    expect(await verifyDatabaseApiKey("ms_whatever", db)).toBeUndefined()
  })
})
