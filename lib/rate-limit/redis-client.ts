/**
 * The app server's dedicated ioredis connection (M10 B3/B4): the Redis rate
 * limiter and the readiness probe share it. It uses the same URL as the
 * BullMQ connections (`REDIS_URL`) but is a separate connection, so a slow
 * queue command never delays a rate-limit check or a probe.
 *
 * Commands are bounded by the callers' own timeouts (`withRedisTimeout`);
 * `maxRetriesPerRequest: 1` keeps queued commands from piling up during an
 * outage. Connection errors are logged at most once a minute.
 */
import { Redis } from "ioredis"

import { getLogger } from "@/lib/log"

let client: Redis | undefined
let lastErrorLogAt = 0

export function redisUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const url = env.REDIS_URL?.trim()

  return url ? url : undefined
}

/** The shared connection, or undefined when REDIS_URL is unset. */
export function getAppRedis(env: NodeJS.ProcessEnv = process.env): Redis | undefined {
  const url = redisUrl(env)

  if (!url) return undefined

  if (!client) {
    client = new Redis(url, {
      connectionName: "meetsum-app",
      connectTimeout: 2_000,
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      retryStrategy: (attempt) => Math.min(attempt * 250, 2_000),
    })
    client.on("error", (error: Error) => {
      const now = Date.now()

      if (now - lastErrorLogAt < 60_000) return
      lastErrorLogAt = now
      getLogger({ component: "redis" }).warn({ errorName: error.name }, "app Redis connection error")
    })
  }

  return client
}

export class RedisTimeoutError extends Error {
  constructor(ms: number) {
    super(`Redis command timed out after ${ms}ms`)
    this.name = "RedisTimeoutError"
  }
}

/** Rejects with RedisTimeoutError when `promise` takes longer than `ms`. */
export async function withRedisTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RedisTimeoutError(ms)), ms)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
