/**
 * Per-IP limit for the public health probes (M10 "Health": rate-limited per
 * IP like other public routes). The `health` preset is always the
 * per-instance memory limiter, so a probe never waits on Redis.
 */
import { RATE_LIMIT_PRESETS, rateLimitRequest } from "@/lib/rate-limit"

export async function limitHealthProbe(request: Request): Promise<Response | undefined> {
  return (await rateLimitRequest(request, RATE_LIMIT_PRESETS.health)).blocked
}
