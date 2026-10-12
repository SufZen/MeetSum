import { createHash, randomBytes } from "node:crypto"

/** Invitation tokens: `inv_` + 32 random bytes (base64url). Only the hash is stored. */
export function createInvitationToken(): string {
  return `inv_${randomBytes(32).toString("base64url")}`
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token.trim()).digest("hex")
}

/** Cheap shape check before touching the database. */
export function isInvitationTokenShape(token: string): boolean {
  return /^inv_[A-Za-z0-9_-]{43}$/.test(token)
}

export const DEFAULT_INVITE_TTL_HOURS = 168

export function getInviteTtlHours(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.MEETSUM_INVITE_TTL_HOURS)

  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INVITE_TTL_HOURS
}

export function createId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

const EMAIL_PATTERN = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_PATTERN.test(email)
}

export function slugify(name: string): string {
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)

  return base || "workspace"
}
