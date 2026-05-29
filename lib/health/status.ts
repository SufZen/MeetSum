export type HealthState = "ok" | "degraded" | "configured" | "not_configured"

export type AiProviderHealth = {
  provider: string
  configured: boolean
  model: string
  transcriptionMode: string
}

export type HealthReport = {
  app: "meetsum"
  version: string
  uptimeSeconds: number
  timestamp: string
  warnings?: string[]
  services: {
    database: HealthState
    redis: HealthState
    storage: HealthState
    ai?: AiProviderHealth
  }
}

export async function createHealthReport(options: {
  version: string
  startedAt: number
  database: () => Promise<HealthState>
  redis: () => Promise<HealthState>
  storage: () => Promise<HealthState>
  ai?: () => Promise<AiProviderHealth>
  warnings?: () => string[]
}): Promise<HealthReport> {
  const [database, redis, storage, ai] = await Promise.all([
    options.database().catch(() => "degraded" as const),
    options.redis().catch(() => "degraded" as const),
    options.storage().catch(() => "degraded" as const),
    options.ai?.().catch(() => undefined),
  ])

  return {
    app: "meetsum",
    version: options.version,
    uptimeSeconds: Math.max(0, Math.floor((Date.now() - options.startedAt) / 1000)),
    timestamp: new Date().toISOString(),
    warnings: options.warnings?.(),
    services: {
      database,
      redis,
      storage,
      ...(ai ? { ai } : {}),
    },
  }
}
