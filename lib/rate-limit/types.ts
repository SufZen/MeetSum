export type RateLimitConfig = {
  /** Maximum requests allowed within the window */
  maxRequests: number
  /** Window size in milliseconds */
  windowMs: number
  /**
   * Preset name: the Redis key namespace (`rl:<name>:<sha256(key)>`) and the
   * label in logs. Unnamed configs share the `custom` namespace (their keys
   * still carry the caller's prefix).
   */
  name?: string
  /**
   * M10 R1: when Redis is down, deny (true: cost/abuse presets) instead of
   * falling back to the per-instance memory limiter (false/undefined).
   */
  failClosed?: boolean
  /**
   * Always use the per-instance memory limiter, whatever the backend: health
   * probes must answer without touching Redis.
   */
  local?: boolean
}

export type RateLimitResult = {
  allowed: boolean
  remaining: number
  resetMs: number
  limit: number
}
