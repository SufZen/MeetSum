import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

import type { Queryable } from "@/lib/db/client"
import { DEFAULT_WORKSPACE_ID } from "@/lib/workspaces/constants"

const HASH_PREFIX = "sha256:"

/** API key scopes: admin > write > read (each includes the next). */
export type ApiKeyScopeName = "read" | "write" | "admin"

const SCOPE_ORDER: readonly ApiKeyScopeName[] = ["read", "write", "admin"]

function normalizeHash(hash: string): string {
  return hash.startsWith(HASH_PREFIX) ? hash : `${HASH_PREFIX}${hash}`
}

export function createApiKeyHash(apiKey: string): string {
  const trimmed = apiKey.trim()

  if (!trimmed) {
    throw new Error("API key is required")
  }

  return `${HASH_PREFIX}${createHash("sha256").update(trimmed).digest("hex")}`
}

export function verifyApiKey(
  apiKey: string | undefined,
  keyHashes: string[]
): boolean {
  if (!apiKey || keyHashes.length === 0) {
    return false
  }

  const candidate = Buffer.from(createApiKeyHash(apiKey), "utf8")

  return keyHashes.some((hash) => {
    const expected = Buffer.from(normalizeHash(hash.trim()), "utf8")

    return (
      candidate.length === expected.length &&
      timingSafeEqual(candidate, expected)
    )
  })
}

export function extractBearerToken(headers: Headers): string | undefined {
  const authorization = headers.get("authorization")

  if (!authorization?.startsWith("Bearer ")) {
    return undefined
  }

  return authorization.slice("Bearer ".length).trim() || undefined
}

/** True when the request carries an `Authorization` header of any kind. */
export function hasAuthorizationHeader(headers: Headers): boolean {
  return Boolean(headers.get("authorization")?.trim())
}

export function getConfiguredApiKeyHashes(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const list = (value: string | undefined) =>
    (value ?? "").split(",").map((item) => item.trim()).filter(Boolean)
  // Blank entries (`MEETSUM_API_KEYS=` or a trailing comma) are ignored; they
  // must not make every bearer request fail.
  const raw = list(env.MEETSUM_API_KEYS).map(createApiKeyHash)

  return [...list(env.MEETSUM_API_KEY_HASHES), ...raw]
}

export function isAuthorizedApiRequest(
  request: Request,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return verifyApiKey(
    extractBearerToken(request.headers),
    getConfiguredApiKeyHashes(env)
  )
}

/**
 * Normalise a scope list: unknown values dropped, implied scopes added
 * (admin ⊃ write ⊃ read), returned in ascending order.
 */
export function normalizeApiKeyScopes(scopes: readonly unknown[]): ApiKeyScopeName[] {
  let highest = -1

  for (const scope of scopes) {
    const index = SCOPE_ORDER.indexOf(scope as ApiKeyScopeName)

    if (index > highest) highest = index
  }

  return SCOPE_ORDER.slice(0, highest + 1)
}

export function parseApiKeyScopes(value: string | undefined): ApiKeyScopeName[] {
  return normalizeApiKeyScopes(
    (value ?? "").split(",").map((scope) => scope.trim().toLowerCase())
  )
}

/** Authenticated machine principal (env bootstrap key or database key). */
export type ApiKeyPrincipal = {
  id: string
  label: string
  workspaceId: string
  scopes: ApiKeyScopeName[]
  createdByUserId?: string
  source: "env" | "database"
}

/**
 * Env bootstrap keys (`MEETSUM_API_KEYS` / `MEETSUM_API_KEY_HASHES`) are bound
 * to one workspace (`MEETSUM_ENV_API_KEY_WORKSPACE_ID`, default ws_default)
 * with `MEETSUM_ENV_API_KEY_SCOPES` (default read,write — never implicit admin).
 */
export function resolveEnvApiKey(
  token: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): ApiKeyPrincipal | undefined {
  if (!token || !verifyApiKey(token, getConfiguredApiKeyHashes(env))) {
    return undefined
  }

  const scopesValue = env.MEETSUM_ENV_API_KEY_SCOPES?.trim()

  return {
    id: "env",
    label: "Environment API key",
    workspaceId:
      env.MEETSUM_ENV_API_KEY_WORKSPACE_ID?.trim() || DEFAULT_WORKSPACE_ID,
    scopes: parseApiKeyScopes(scopesValue || "read,write"),
    source: "env",
  }
}

// --- Database-backed API key management ---

export type ApiKeyRecord = {
  id: string
  label: string
  keyPrefix: string
  workspaceId: string
  scopes: ApiKeyScopeName[]
  createdByUserId: string | null
  createdAt: string
  expiresAt: string | null
  revokedAt: string | null
  lastUsedAt: string | null
}

type ApiKeyRow = {
  id: string
  label: string
  key_hash?: string
  key_prefix: string
  workspace_id: string
  scopes: unknown
  created_by_user_id: string | null
  created_at: unknown
  expires_at: unknown
  revoked_at: unknown
  last_used_at: unknown
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()

  return String(value)
}

function rowToRecord(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    label: row.label,
    keyPrefix: row.key_prefix,
    workspaceId: row.workspace_id,
    scopes: normalizeApiKeyScopes(Array.isArray(row.scopes) ? row.scopes : []),
    createdByUserId: row.created_by_user_id ?? null,
    createdAt: toIso(row.created_at) ?? "",
    expiresAt: toIso(row.expires_at),
    revokedAt: toIso(row.revoked_at),
    lastUsedAt: toIso(row.last_used_at),
  }
}

async function defaultDb(): Promise<Queryable> {
  const { getDatabasePool } = await import("@/lib/db/client")

  return getDatabasePool()
}

const RECORD_COLUMNS = `id, label, key_prefix, workspace_id, scopes,
  created_by_user_id, created_at, expires_at, revoked_at, last_used_at`

/**
 * Generate a new API key bound to a workspace. Returns the raw key (shown
 * once) and the stored record; only the sha256 hash is persisted.
 */
export async function createApiKey(
  options: {
    workspaceId: string
    label?: string
    scopes: readonly ApiKeyScopeName[]
    expiresAt?: string | null
    createdByUserId?: string | null
  },
  db?: Queryable
): Promise<{ rawKey: string; record: ApiKeyRecord }> {
  const client = db ?? (await defaultDb())
  const scopes = normalizeApiKeyScopes(options.scopes)

  if (scopes.length === 0) {
    throw new Error("At least one API key scope is required")
  }

  const rawKey = `ms_${randomBytes(32).toString("hex")}`
  const keyHash = createApiKeyHash(rawKey)
  const keyPrefix = rawKey.slice(0, 11) // "ms_" + first 8 hex chars
  const id = `api_key_${randomBytes(8).toString("hex")}`

  const result = await client.query(
    `INSERT INTO api_keys (
       id, label, key_hash, key_prefix, expires_at,
       workspace_id, scopes, created_by_user_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     RETURNING ${RECORD_COLUMNS}`,
    [
      id,
      options.label ?? "",
      keyHash,
      keyPrefix,
      options.expiresAt ?? null,
      options.workspaceId,
      JSON.stringify(scopes),
      options.createdByUserId ?? null,
    ]
  )

  return {
    rawKey,
    record: rowToRecord(result.rows[0] as ApiKeyRow),
  }
}

/** API keys of one workspace (active and revoked). Hashes are never exposed. */
export async function listApiKeys(
  workspaceId: string,
  db?: Queryable
): Promise<ApiKeyRecord[]> {
  const client = db ?? (await defaultDb())
  const result = await client.query(
    `SELECT ${RECORD_COLUMNS} FROM api_keys
     WHERE workspace_id = $1
     ORDER BY created_at DESC`,
    [workspaceId]
  )

  return (result.rows as ApiKeyRow[]).map(rowToRecord)
}

/** Revoke a key of `workspaceId`; other-workspace ids behave as not found. */
export async function revokeApiKey(
  workspaceId: string,
  id: string,
  db?: Queryable
): Promise<ApiKeyRecord | null> {
  const client = db ?? (await defaultDb())
  const result = await client.query(
    `UPDATE api_keys SET revoked_at = now()
     WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL
     RETURNING ${RECORD_COLUMNS}`,
    [id, workspaceId]
  )

  if (result.rows.length === 0) return null

  return rowToRecord(result.rows[0] as ApiKeyRow)
}

/**
 * Resolve a bearer token against active database keys. Returns the key's
 * principal (workspace, scopes, creator) or undefined. Fails closed on any
 * database error. Updates last_used_at on match.
 */
export async function verifyDatabaseApiKey(
  rawKey: string,
  db?: Queryable
): Promise<ApiKeyPrincipal | undefined> {
  if (!db && process.env.MEETSUM_STORAGE !== "postgres") return undefined

  try {
    const client = db ?? (await defaultDb())
    const keyHash = createApiKeyHash(rawKey)

    const result = await client.query(
      `SELECT id, label, workspace_id, scopes, created_by_user_id
       FROM api_keys
       WHERE key_hash = $1
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())
       LIMIT 1`,
      [keyHash]
    )

    const row = result.rows[0] as
      | Pick<ApiKeyRow, "id" | "label" | "workspace_id" | "scopes" | "created_by_user_id">
      | undefined

    if (!row) return undefined

    // Update last_used_at asynchronously (fire-and-forget)
    client
      .query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [row.id])
      .catch(() => {})

    return {
      id: row.id,
      label: row.label ?? "",
      workspaceId: row.workspace_id,
      scopes: normalizeApiKeyScopes(Array.isArray(row.scopes) ? row.scopes : []),
      createdByUserId: row.created_by_user_id ?? undefined,
      source: "database",
    }
  } catch {
    return undefined
  }
}
