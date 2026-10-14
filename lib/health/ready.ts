/**
 * App readiness (`GET /api/health/ready`, docs/parity/m10.md "Health"):
 * 200 `{ status: "ok", checks }` when no check fails, else 503
 * `{ status: "fail", checks }`. Checks run in parallel with short timeouts;
 * a result is reused for 1 s so a probe storm doesn't multiply dependency
 * calls. The body never carries error text, hosts, versions or tenant data.
 */
import { checkDatabase, checkMigrations, checkRedis, checkStorage, type CheckResult } from "@/lib/health/checks"

export type ReadinessChecks = {
  database: CheckResult
  redis: CheckResult
  storage: CheckResult
  migrations: CheckResult
}

export type ReadinessReport = { status: "ok" | "fail"; checks: ReadinessChecks }

export type ReadinessDeps = {
  database?: () => Promise<CheckResult>
  redis?: () => Promise<CheckResult>
  storage?: () => Promise<CheckResult>
  migrations?: () => Promise<CheckResult>
}

const CACHE_MS = 1_000
let cached: { at: number; report: Promise<ReadinessReport> } | undefined

export async function runReadiness(deps: ReadinessDeps = {}): Promise<ReadinessReport> {
  const [database, redis, storage, migrations] = await Promise.all([
    (deps.database ?? (() => checkDatabase()))().catch((): CheckResult => "fail"),
    (deps.redis ?? (() => checkRedis()))().catch((): CheckResult => "fail"),
    (deps.storage ?? (() => checkStorage()))().catch((): CheckResult => "fail"),
    (deps.migrations ?? (() => checkMigrations()))().catch((): CheckResult => "fail"),
  ])
  const checks = { database, redis, storage, migrations }

  return { status: Object.values(checks).includes("fail") ? "fail" : "ok", checks }
}

/** `runReadiness` with the default checks, memoized for 1 s. */
export function getReadiness(now = Date.now()): Promise<ReadinessReport> {
  if (cached && now - cached.at < CACHE_MS) return cached.report

  const report = runReadiness()

  cached = { at: now, report }
  return report
}

export function resetReadinessCacheForTesting() {
  cached = undefined
}
