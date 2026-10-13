/**
 * PKCE S256 (RFC 7636). Owner: Package A.
 */
import { createHash, randomBytes } from "node:crypto"

/** 32 random bytes, base64url (43 characters, within RFC 7636's 43–128). */
export function createCodeVerifier(): string {
  return randomBytes(32).toString("base64url")
}

/** `BASE64URL(SHA256(ASCII(code_verifier)))`. */
export function codeChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url")
}
