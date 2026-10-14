/**
 * In-memory stand-in for the Redis rate limiter (M10 B4). `eval` runs a
 * line-by-line JavaScript port of SLIDING_WINDOW_LUA over sorted sets with
 * Redis semantics (inclusive ZREMRANGEBYSCORE max, exclusive `(` ZCOUNT min,
 * PEXPIRE against the script's clock), so the tests exercise the same
 * algorithm the real server runs. It refuses any other script.
 */
import { SLIDING_WINDOW_LUA, type RateLimitRedis } from "@/lib/rate-limit/redis"

type Entry = { score: number; member: string }

export class FakeRateLimitRedis implements RateLimitRedis {
  readonly sets = new Map<string, Entry[]>()
  readonly expiresAt = new Map<string, number>()
  readonly calls: Array<{ key: string; args: Array<string | number> }> = []
  down = false
  delayMs = 0

  async eval(script: string, numKeys: number, ...rest: Array<string | number>): Promise<unknown> {
    if (this.down) throw new Error("connect ECONNREFUSED 127.0.0.1:6379")
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    if (script !== SLIDING_WINDOW_LUA) throw new Error("NOSCRIPT unexpected script")
    if (numKeys !== 1) throw new Error("ERR wrong number of keys")

    const [key, ...argv] = rest.map(String)
    this.calls.push({ key, args: argv })

    const now = Number(argv[0])
    const member = argv[1]
    const n = (argv.length - 2) / 2

    // Lazy expiry, like Redis.
    const expiry = this.expiresAt.get(key)

    if (expiry !== undefined && expiry <= now) {
      this.sets.delete(key)
      this.expiresAt.delete(key)
    }

    let set = this.sets.get(key) ?? []
    let longest = 0

    for (let i = 1; i <= n; i += 1) longest = Math.max(longest, Number(argv[i * 2]))

    // ZREMRANGEBYSCORE key -inf (now - longest)   (inclusive)
    set = set.filter((entry) => entry.score > now - longest)

    const out: number[] = []
    let allowed = 1

    for (let i = 1; i <= n; i += 1) {
      const windowMs = Number(argv[i * 2])
      const max = Number(argv[i * 2 + 1])
      // ZCOUNT key (now - w) +inf, scores ascending
      const inWindow = set.filter((entry) => entry.score > now - windowMs).sort((a, b) => a.score - b.score)
      const count = inWindow.length
      let anchor = now

      if (count >= max) {
        allowed = 0
        anchor = inWindow[count - max].score
      } else if (count > 0) {
        anchor = inWindow[0].score
      }

      out.push(count, anchor)
    }

    if (allowed === 1) set.push({ score: now, member })

    this.sets.set(key, set)
    this.expiresAt.set(key, now + longest)

    return [allowed, ...out]
  }

  keys(): string[] {
    return [...this.sets.keys()]
  }
}
