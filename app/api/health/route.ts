import { NextResponse } from "next/server"

import { getDatabasePool } from "@/lib/db/client"
import { createHealthReport, type HealthState } from "@/lib/health/status"

const startedAt = Date.now()

function configured(value: string | undefined): HealthState {
  return value ? "configured" : "not_configured"
}

export async function GET() {
  const report = await createHealthReport({
    version: process.env.npm_package_version ?? "0.0.1",
    startedAt,
    database: async () => {
      if (!process.env.DATABASE_URL) return "not_configured"

      await getDatabasePool().query("select 1")
      return "ok"
    },
    redis: async () => configured(process.env.REDIS_URL),
    storage: async () =>
      configured(
        process.env.S3_ENDPOINT ??
          process.env.MINIO_ENDPOINT ??
          process.env.AWS_ENDPOINT_URL_S3
      ),
  })

  return NextResponse.json(report)
}
