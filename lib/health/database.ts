import { getDatabasePool } from "@/lib/db/client"
import type { HealthState } from "@/lib/health/status"

/**
 * Liveness probe for Postgres used by the public health route. Kept out of
 * the route so routes never import the raw pool (M2 route-coverage rule).
 */
export async function pingDatabase(
  env: NodeJS.ProcessEnv = process.env
): Promise<HealthState> {
  if (!env.DATABASE_URL) return "not_configured"

  await getDatabasePool().query("select 1")
  return "ok"
}
