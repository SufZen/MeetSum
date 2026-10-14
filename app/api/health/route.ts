import { NextResponse } from "next/server"

import { getProviderHealthStatus } from "@/lib/ai/provider-health"
import { withPublicRoute } from "@/lib/auth/authz"
import { checkRedis, checkStorage, type CheckResult } from "@/lib/health/checks"
import { pingDatabase } from "@/lib/health/database"
import { limitHealthProbe } from "@/lib/health/rate-limit"
import { createHealthReport, type HealthState } from "@/lib/health/status"
import { validateRuntimeEnvironment } from "@/lib/ops/environment"
import packageJson from "@/package.json"

const startedAt = Date.now()

/** M10: real Redis PING and S3 HeadBucket, reported in the legacy vocabulary. */
function legacyState(result: CheckResult): HealthState {
  if (result === "ok") return "ok"
  if (result === "skip") return "not_configured"
  return "degraded"
}

// Kept for compatibility (shape unchanged since M1). New probes should use
// /api/health/live and /api/health/ready.
export const GET = withPublicRoute(
  "Liveness/readiness probe for the reverse proxy and uptime checks; exposes no tenant data.",
  async (request) => {
    const limited = await limitHealthProbe(request)

    if (limited) return limited

    const report = await createHealthReport({
      version: packageJson.version,
      startedAt,
      database: () => pingDatabase(),
      redis: async () => legacyState(await checkRedis()),
      storage: async () => legacyState(await checkStorage()),
      ai: async () => {
        const status = getProviderHealthStatus()
        return {
          provider: status.ai.provider,
          configured: status.ai.configured,
          model: status.ai.model,
          transcriptionMode: status.ai.transcriptionMode,
        }
      },
      warnings: () => {
        const report = validateRuntimeEnvironment()

        return [
          ...report.fatal.map((issue) => `FATAL: ${issue}`),
          ...report.warnings,
        ]
      },
    })

    return NextResponse.json(report)
  }
)
