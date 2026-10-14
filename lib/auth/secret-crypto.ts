import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto"

/**
 * AES-256-GCM secrets at rest (random 12-byte IV, 16-byte tag).
 *
 * - `v1:iv:tag:ct` — unbound, keyed with sha256(master). The format of the
 *   existing callers that pass no `aad` (Google refresh tokens, webhook
 *   secrets, M7 bot passcodes via `sealMeetingSecrets`). Unchanged.
 * - `v2:iv:tag:ct` (M8) — row-bound: the `aad` (e.g.
 *   `${workspaceId}:${connectionId}:${field}`) is authenticated, and the key
 *   is derived for this purpose with HKDF-SHA256 from the master
 *   (`V2_KEY_LABEL`), so it differs from the v1 key.
 *
 * Decryption dispatches strictly on the version prefix:
 * - an unknown prefix, a bad IV length or a tag that is not 16 bytes throws;
 * - a v2 value needs its exact `aad` (missing or different → throws), so a
 *   ciphertext moved to another row or column never decrypts, and rewriting
 *   its prefix to v1 fails too (different key, no AAD);
 * - a row-bound caller (one that passes `aad`) gets v2 only. A v1 value is
 *   refused unless the caller opts in with `allowLegacyV1` for a migration,
 *   so an unbound ciphertext copied into a bound column is not accepted
 *   through the legacy path. Callers that opt in re-encrypt to v2 on their
 *   next write (`encryptSecret(value, aad)` always writes v2).
 * There is no fallback to plaintext or base64.
 *
 * Key rotation (M10, R10): the keyring is the current master
 * (`GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY`, falling back as before) plus the
 * comma-separated `GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEYS_PREVIOUS`. New values
 * carry a key id as a fifth segment (`v2:iv:tag:ct:k<8 hex>`); decryption uses
 * that key, and a value without a key id (written before M10) tries the
 * current key, then each previous key (GCM authentication rejects a wrong
 * key). Encryption always uses the current key. `scripts/reencrypt-tokens.ts`
 * rewrites old rows; key material is never logged or returned.
 */
const VERSION_UNBOUND = "v1"
const VERSION_BOUND = "v2"
const ALGORITHM = "aes-256-gcm"
const IV_BYTES = 12
const TAG_BYTES = 16
/** HKDF `info` for row-bound (v2) secrets. Changing it orphans every v2 value. */
export const V2_KEY_LABEL = "meetsum:secret-crypto:v2:row-bound"

export type DecryptSecretOptions = {
  /**
   * Row-bound callers only: also accept an unbound v1 value (migration of a
   * pre-M8 column). Re-encrypt with `encryptSecret(value, aad)` on the next
   * write. Ignored when no `aad` is given (v1 is the unbound format).
   */
  allowLegacyV1?: boolean
}

const KEY_ID_PATTERN = /^k[0-9a-f]{8}$/

type KeyringEntry = { id: string; source: string }

function currentSource(): string {
  const source =
    process.env.GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY ??
    process.env.MEETSUM_SESSION_SECRET ??
    process.env.WEBHOOK_SIGNING_SECRET

  if (!source) {
    throw new Error(
      "GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY or MEETSUM_SESSION_SECRET is required"
    )
  }

  return source
}

/** Public key id of a master secret: 32 bits of a labelled hash, never the key. */
export function secretKeyId(source: string): string {
  return `k${createHash("sha256").update(`meetsum:secret-crypto:kid:${source}`).digest("hex").slice(0, 8)}`
}

/** Current key first, then GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEYS_PREVIOUS in order. */
function keyring(): KeyringEntry[] {
  const current = currentSource()
  const previous = (process.env.GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEYS_PREVIOUS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value !== current)

  return [current, ...new Set(previous)].map((source) => ({ id: secretKeyId(source), source }))
}

/** Key id that new ciphertexts carry. */
export function currentSecretKeyId(): string {
  return secretKeyId(currentSource())
}

function keyFor(version: typeof VERSION_UNBOUND | typeof VERSION_BOUND, source: string) {
  const master = createHash("sha256").update(source).digest()

  if (version === VERSION_UNBOUND) return master

  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), V2_KEY_LABEL, 32))
}

export function encryptSecret(value: string, aad?: string) {
  const version = aad !== undefined ? VERSION_BOUND : VERSION_UNBOUND
  const source = currentSource()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, keyFor(version, source), iv, {
    authTagLength: TAG_BYTES,
  })

  if (version === VERSION_BOUND) cipher.setAAD(Buffer.from(aad as string, "utf8"))

  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ])

  return [
    version,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
    secretKeyId(source),
  ].join(":")
}

export function decryptSecret(
  value: string,
  aad?: string,
  options: DecryptSecretOptions = {}
) {
  const parts = value.split(":")
  const [version, ivValue, tagValue, encryptedValue, keyId] = parts

  if (
    (parts.length !== 4 && parts.length !== 5) ||
    (parts.length === 5 && !KEY_ID_PATTERN.test(keyId)) ||
    (version !== VERSION_UNBOUND && version !== VERSION_BOUND) ||
    !ivValue ||
    !tagValue ||
    !encryptedValue
  ) {
    throw new Error("Unsupported encrypted secret format")
  }

  if (version === VERSION_BOUND && aad === undefined) {
    throw new Error("Encrypted secret requires its binding context")
  }

  if (version === VERSION_UNBOUND && aad !== undefined && !options.allowLegacyV1) {
    throw new Error("Unbound encrypted secret refused for a bound field")
  }

  const iv = Buffer.from(ivValue, "base64url")
  const tag = Buffer.from(tagValue, "base64url")

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("Unsupported encrypted secret format")
  }

  const ring = keyring()
  const candidates = keyId ? ring.filter((entry) => entry.id === keyId) : ring

  if (candidates.length === 0) {
    throw new Error("Encrypted secret key is not in the keyring")
  }

  let lastError: unknown

  for (const entry of candidates) {
    try {
      const decipher = createDecipheriv(ALGORITHM, keyFor(version, entry.source), iv, {
        authTagLength: TAG_BYTES,
      })

      if (version === VERSION_BOUND) decipher.setAAD(Buffer.from(aad as string, "utf8"))
      decipher.setAuthTag(tag)

      return Buffer.concat([
        decipher.update(Buffer.from(encryptedValue, "base64url")),
        decipher.final(),
      ]).toString("utf8")
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Unable to decrypt secret")
}

/**
 * True when a stored value should be rewritten under the current key: it has
 * no key id (pre-M10) or its key id is not the current one. Does not decrypt.
 */
export function secretNeedsReencryption(value: string): boolean {
  const parts = value.split(":")

  return parts.length !== 5 || parts[4] !== currentSecretKeyId()
}

/**
 * Decrypts with the keyring and encrypts again with the current key (same
 * binding). A bound field that opted into legacy v1 is upgraded to v2.
 */
export function reencryptSecret(value: string, aad?: string, options: DecryptSecretOptions = {}): string {
  return encryptSecret(decryptSecret(value, aad, options), aad)
}
