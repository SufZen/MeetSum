/**
 * Share-link password policy (client-safe: no node imports). New passwords
 * are 10–128 code points; passwords set before the minimum was raised from 8
 * keep verifying (only setting a password checks the length).
 */
export const SHARE_PASSWORD_MIN = 10
export const SHARE_PASSWORD_MAX = 128

/** No look-alikes (0/O, 1/l/I), so a generated password can be read aloud or retyped. */
const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
export const GENERATED_SHARE_PASSWORD_LENGTH = 16

/**
 * A strong random password for a share link: 16 characters from a
 * 57-symbol alphabet (~93 bits), from `crypto.getRandomValues` with
 * rejection sampling (no modulo bias).
 */
export function generateSharePassword(
  random: (bytes: Uint8Array) => Uint8Array = (bytes) => globalThis.crypto.getRandomValues(bytes)
): string {
  const limit = 256 - (256 % ALPHABET.length)
  let out = ""

  while (out.length < GENERATED_SHARE_PASSWORD_LENGTH) {
    for (const byte of random(new Uint8Array(32))) {
      if (byte < limit && out.length < GENERATED_SHARE_PASSWORD_LENGTH) out += ALPHABET[byte % ALPHABET.length]
    }
  }

  return out
}
