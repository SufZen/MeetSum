import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto"

import { verifyApiKey } from "@/lib/auth/api-keys"

/**
 * Share-link passwords (M9 B4, docs/parity/m9.md; M4 carry-over).
 *
 * Stored as `scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>` in
 * `meeting_shares.password_hash` (N=2^15, r=8, p=1, 16-byte salt, 32-byte
 * key). Verification is constant-time and also accepts the memory
 * repository's legacy `sha256:` hashes so existing dev data keeps working.
 * Passwords are 8–128 characters and are never logged or audited.
 */

export const SHARE_PASSWORD_MIN = 8
export const SHARE_PASSWORD_MAX = 128

const PREFIX = "scrypt"
const N = 2 ** 15
const R = 8
const P = 1
const SALT_BYTES = 16
const KEY_BYTES = 32
/** 128·N·r = 32 MiB for the defaults; allow headroom (Node's default cap is exactly 32 MiB). */
const MAX_MEM = 64 * 1024 * 1024
/** Upper bounds when parsing a stored hash, so a tampered row can't make verify expensive. */
const MAX_N = 2 ** 17
const MAX_R = 16
const MAX_P = 4

export type SharePasswordError = "password_invalid" | "password_too_short" | "password_too_long"

/** A share password check could not start in time: the verifier is saturated (the caller answers 503 + Retry-After). */
export class ShareVerifyBusyError extends Error {
  constructor() {
    super("Share password verification is busy")
    this.name = "ShareVerifyBusyError"
  }
}

export type ConcurrencyLimiter = {
  run: <T>(task: () => Promise<T>) => Promise<T>
  /** Running and queued counts (tests, metrics). */
  stats: () => { running: number; queued: number }
}

/**
 * At most `max` tasks run at once. Up to `maxQueue` wait in FIFO order for at
 * most `timeoutMs`; a full queue or a wait past the timeout rejects with
 * `ShareVerifyBusyError` (a short wait, never an unbounded backlog). A
 * finishing task hands its slot straight to the next waiter.
 */
export function createConcurrencyLimiter(max: number, maxQueue: number, timeoutMs = 5_000): ConcurrencyLimiter {
  let running = 0
  const queue: Array<{ resume: () => void }> = []
  const release = () => {
    const next = queue.shift()

    if (next) next.resume()
    else running -= 1
  }

  return {
    async run(task) {
      if (running < max) {
        running += 1
      } else {
        if (queue.length >= maxQueue) throw new ShareVerifyBusyError()
        await new Promise<void>((resolve, reject) => {
          const waiter = {
            resume: () => {
              clearTimeout(timer)
              resolve()
            },
          }
          const timer = setTimeout(() => {
            const index = queue.indexOf(waiter)

            if (index !== -1) queue.splice(index, 1)
            reject(new ShareVerifyBusyError())
          }, timeoutMs)

          queue.push(waiter)
        })
      }
      try {
        return await task()
      } finally {
        release()
      }
    },
    stats: () => ({ running, queued: queue.length }),
  }
}

/**
 * Fair scrypt scheduling (each verification takes ~32 MiB and tens of ms of
 * CPU). Process-wide at most `MEETSUM_SHARE_VERIFY_CONCURRENCY` (default 4)
 * run at once, and one share token may hold at most 2 of those slots with a
 * small queue of its own, so a flood on one link waits on that link's queue
 * and never starves other shares. Waits time out after 5 s (busy → 503).
 */
const globalVerifyLimiter = createConcurrencyLimiter(
  Math.max(1, Number.parseInt(process.env.MEETSUM_SHARE_VERIFY_CONCURRENCY ?? "", 10) || 4),
  64
)
const PER_KEY_CONCURRENCY = 2
const PER_KEY_QUEUE = 16
const keyLimiters = new Map<string, ConcurrencyLimiter>()

async function runVerification<T>(key: string | undefined, task: () => Promise<T>): Promise<T> {
  if (!key) return globalVerifyLimiter.run(task)

  let limiter = keyLimiters.get(key)

  if (!limiter) {
    limiter = createConcurrencyLimiter(PER_KEY_CONCURRENCY, PER_KEY_QUEUE)
    keyLimiters.set(key, limiter)
  }

  const own = limiter

  try {
    return await own.run(() => globalVerifyLimiter.run(task))
  } finally {
    const stats = own.stats()

    if (stats.running === 0 && stats.queued === 0 && keyLimiters.get(key) === own) keyLimiters.delete(key)
  }
}

function scrypt(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password.normalize("NFC"), salt, keyLength, options, (error, key) => (error ? reject(error) : resolve(key)))
  })
}

/** Validates a requested password (code points, so emoji count once). */
export function validateSharePassword(value: unknown): { password: string } | { error: SharePasswordError } {
  if (typeof value !== "string") return { error: "password_invalid" }

  const length = [...value].length

  if (length < SHARE_PASSWORD_MIN || !value.trim()) return { error: "password_too_short" }
  if (length > SHARE_PASSWORD_MAX) return { error: "password_too_long" }

  return { password: value }
}

export async function hashSharePassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const key = await scrypt(password, salt, KEY_BYTES, { N, r: R, p: P, maxmem: MAX_MEM })

  return [PREFIX, N, R, P, salt.toString("base64"), key.toString("base64")].join("$")
}

export function isScryptSharePasswordHash(stored: string | null | undefined): boolean {
  return typeof stored === "string" && stored.startsWith(`${PREFIX}$`)
}

/** Constant-time check of `password` against a stored scrypt (or legacy sha256) hash. */
export async function verifySharePassword(
  password: string,
  stored: string | null | undefined,
  options: { key?: string } = {}
): Promise<boolean> {
  if (!stored || typeof password !== "string" || !password || [...password].length > SHARE_PASSWORD_MAX) {
    return false
  }

  if (!isScryptSharePasswordHash(stored)) {
    // Legacy memory-repo format (`sha256:<hex>`), already timing-safe.
    return /^(sha256:)?[0-9a-f]{64}$/.test(stored) && verifyApiKey(password, [stored])
  }

  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = stored.split("$")
  const n = Number(nRaw)
  const r = Number(rRaw)
  const p = Number(pRaw)

  if (
    !Number.isInteger(n) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    n < 2 ||
    n > MAX_N ||
    (n & (n - 1)) !== 0 ||
    r < 1 ||
    r > MAX_R ||
    p < 1 ||
    p > MAX_P ||
    !saltRaw ||
    !hashRaw
  ) {
    return false
  }

  const expected = Buffer.from(hashRaw, "base64")

  if (expected.length < 16 || expected.length > 64) return false

  const actual = await runVerification(options.key, () =>
    scrypt(password, Buffer.from(saltRaw, "base64"), expected.length, {
      N: n,
      r,
      p,
      maxmem: Math.max(MAX_MEM, 256 * n * r),
    })
  )

  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
