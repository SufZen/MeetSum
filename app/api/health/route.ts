import { NextResponse } from "next/server"

import { getProviderHealthStatus } from "@/lib/ai/provider-health"
import { withPublicRoute } from "@/lib/auth/authz"
import { pingDatabase } from "@/lib/health/database"
import { createHealthReport, type HealthState } from "@/lib/health/status"
import { validateRuntimeEnvironment } from "@/lib/ops/environment"

const startedAt = Date.now()

function configured(value: string | undefined): HealthState {
  return value ? "configured" : "not_configured"
}

export const GET = withPublicRoute(
  "Liveness/readiness probe for the reverse proxy and uptime checks; exposes no tenant data.",
  async () => {
    const report = await createHealthReport({
      version: process.env.npm_package_version ?? "0.5.0",
      startedAt,
      database: () => pingDatabase(),
      redis: async () => configured(process.env.REDIS_URL),
      storage: async () =>
        configured(
          process.env.S3_ENDPOINT ??
            process.env.MINIO_ENDPOINT ??
            process.env.AWS_ENDPOINT_URL_S3
        ),
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
