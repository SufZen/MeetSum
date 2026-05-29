import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

const HASH_PREFIX = "sha256:"

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

export function getConfiguredApiKeyHashes(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const hashed = env.MEETSUM_API_KEY_HASHES?.split(",") ?? []
  const raw = env.MEETSUM_API_KEYS?.split(",").map(createApiKeyHash) ?? []

  return [...hashed, ...raw].map((hash) => hash.trim()).filter(Boolean)
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

// --- Database-backed API key management ---

export type ApiKeyRecord = {
  id: string
  label: string
  keyPrefix: string
  createdAt: string
  expiresAt: string | null
  revokedAt: string | null
  lastUsedAt: string | null
}

type ApiKeyRow = {
  id: string
  label: string
  key_hash: string
  key_prefix: string
  created_at: string
  expires_at: string | null
  revoked_at: string | null
  last_used_at: string | null
}

function rowToRecord(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    label: row.label,
    keyPrefix: row.key_prefix,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  }
}

/**
 * Generate a new API key with a cryptographically secure random value.
 * Returns both the raw key (shown once) and the stored record.
 */
export async function createApiKey(options: {
  label?: string
  expiresAt?: string | null
}): Promise<{ rawKey: string; record: ApiKeyRecord }> {
  const { getDatabasePool } = await import("@/lib/db/client")
  const pool = getDatabasePool()

  const rawKey = `ms_${randomBytes(32).toString("hex")}`
  const keyHash = createApiKeyHash(rawKey)
  const keyPrefix = rawKey.slice(0, 11) // "ms_" + first 8 hex chars
  const id = `api_key_${randomBytes(8).toString("hex")}`

  const result = await pool.query(
    `INSERT INTO api_keys (id, label, key_hash, key_prefix, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [id, options.label ?? "", keyHash, keyPrefix, options.expiresAt ?? null]
  )

  return {
    rawKey,
    record: rowToRecord(result.rows[0] as ApiKeyRow),
  }
}

/**
 * List all API keys (active and revoked). Keys are never exposed.
 */
export async function listApiKeys(): Promise<ApiKeyRecord[]> {
  const { getDatabasePool } = await import("@/lib/db/client")
  const pool = getDatabasePool()

  const result = await pool.query(
    "SELECT * FROM api_keys ORDER BY created_at DESC"
  )

  return (result.rows as ApiKeyRow[]).map(rowToRecord)
}

/**
 * Revoke an API key by ID.
 */
export async function revokeApiKey(id: string): Promise<ApiKeyRecord | null> {
  const { getDatabasePool } = await import("@/lib/db/client")
  const pool = getDatabasePool()

  const result = await pool.query(
    `UPDATE api_keys SET revoked_at = now()
     WHERE id = $1 AND revoked_at IS NULL
     RETURNING *`,
    [id]
  )

  if (result.rows.length === 0) return null

  return rowToRecord(result.rows[0] as ApiKeyRow)
}

/**
 * Check if a bearer token matches any active database-stored API key.
 * Updates last_used_at on match.
 */
export async function verifyDatabaseApiKey(rawKey: string): Promise<boolean> {
  if (process.env.MEETSUM_STORAGE !== "postgres") return false

  try {
    const { getDatabasePool } = await import("@/lib/db/client")
    const pool = getDatabasePool()
    const keyHash = createApiKeyHash(rawKey)

    const result = await pool.query(
      `SELECT id FROM api_keys
       WHERE key_hash = $1
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())
       LIMIT 1`,
      [keyHash]
    )

    if (result.rows.length === 0) return false

    // Update last_used_at asynchronously (fire-and-forget)
    const keyId = (result.rows[0] as { id: string }).id
    pool.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [keyId]).catch(() => {})

    return true
  } catch {
    return false
  }
}

