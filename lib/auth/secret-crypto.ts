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

function getMasterSecret() {
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

function keyFor(version: typeof VERSION_UNBOUND | typeof VERSION_BOUND) {
  const master = createHash("sha256").update(getMasterSecret()).digest()

  if (version === VERSION_UNBOUND) return master

  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), V2_KEY_LABEL, 32))
}

export function encryptSecret(value: string, aad?: string) {
  const version = aad !== undefined ? VERSION_BOUND : VERSION_UNBOUND
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, keyFor(version), iv, {
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
  ].join(":")
}

export function decryptSecret(
  value: string,
  aad?: string,
  options: DecryptSecretOptions = {}
) {
  const parts = value.split(":")
  const [version, ivValue, tagValue, encryptedValue] = parts

  if (
    parts.length !== 4 ||
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

  const decipher = createDecipheriv(ALGORITHM, keyFor(version), iv, {
    authTagLength: TAG_BYTES,
  })

  if (version === VERSION_BOUND) decipher.setAAD(Buffer.from(aad as string, "utf8"))
  decipher.setAuthTag(tag)

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8")
}
