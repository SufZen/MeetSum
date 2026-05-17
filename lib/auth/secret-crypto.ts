import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto"

const VERSION = "v1"
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

export function encryptSecret(value: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, getSecretKey(), iv)
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()

  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(":")
}

export function decryptSecret(value: string) {
  const [version, ivValue, tagValue, encryptedValue] = value.split(":")

  if (version !== VERSION || !ivValue || !tagValue || !encryptedValue) {
    throw new Error("Unsupported encrypted secret format")
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    getSecretKey(),
    Buffer.from(ivValue, "base64url")
  )

  decipher.setAuthTag(Buffer.from(tagValue, "base64url"))

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8")
}
