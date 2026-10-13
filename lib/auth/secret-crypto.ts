import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto"

/**
 * AES-256-GCM secrets at rest.
 *
 * - `v1:iv:tag:ct`: no additional authenticated data (Google tokens, bot
 *   passcodes, webhook secrets). Still written when no `aad` is given.
 * - `v2:iv:tag:ct` (M8): bound to `aad`, e.g. `${workspaceId}:${connectionId}:${field}`
 *   for integration tokens, so a ciphertext copied to another row (or field)
 *   fails to decrypt. A v2 value needs the same `aad` to decrypt; a missing
 *   or different one throws.
 */
const VERSION_PLAIN = "v1"
const VERSION_AAD = "v2"
const ALGORITHM = "aes-256-gcm"

function getSecretKey() {
  const source =
    process.env.GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY ??
    process.env.MEETSUM_SESSION_SECRET ??
    process.env.WEBHOOK_SIGNING_SECRET

  if (!source) {
    throw new Error(
      "GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY or MEETSUM_SESSION_SECRET is required"
    )
  }

  return createHash("sha256").update(source).digest()
}

export function encryptSecret(value: string, aad?: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, getSecretKey(), iv)

  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"))

  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()

  return [
    aad !== undefined ? VERSION_AAD : VERSION_PLAIN,
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(":")
}

export function decryptSecret(value: string, aad?: string) {
  const [version, ivValue, tagValue, encryptedValue] = value.split(":")

  if (
    (version !== VERSION_PLAIN && version !== VERSION_AAD) ||
    !ivValue ||
    !tagValue ||
    !encryptedValue
  ) {
    throw new Error("Unsupported encrypted secret format")
  }

  if (version === VERSION_AAD && aad === undefined) {
    throw new Error("Encrypted secret requires its binding context")
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    getSecretKey(),
    Buffer.from(ivValue, "base64url")
  )

  if (version === VERSION_AAD) decipher.setAAD(Buffer.from(aad as string, "utf8"))
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"))

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8")
}
