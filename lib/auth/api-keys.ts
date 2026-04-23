import { createHash, timingSafeEqual } from "node:crypto"

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
