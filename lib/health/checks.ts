/**
 * Dependency checks for the readiness probes (docs/parity/m10.md, "Health").
 * Each check resolves to "ok" | "fail" | "skip" and never throws, never
 * returns error text, hosts or versions.
 *
 * - database: `select 1` (2 s); skip when Postgres isn't configured outside
 *   production;
 * - redis: `PING` (1 s); skip when REDIS_URL is unset outside production;
 * - storage: S3 `HeadBucket` (2 s); skip when S3_ENDPOINT is unset outside
 *   production;
 * - migrations: the database is not behind the migration files (the highest
 *   `schema_migrations` version is at least the highest file version).
 */
import { readdirSync } from "node:fs"
import { resolve } from "node:path"

export type CheckResult = "ok" | "fail" | "skip"

export const DATABASE_TIMEOUT_MS = 2_000
export const REDIS_TIMEOUT_MS = 1_000
export const STORAGE_TIMEOUT_MS = 2_000

type Env = NodeJS.ProcessEnv

export class CheckTimeoutError extends Error {
  constructor() {
    super("check timed out")
    this.name = "CheckTimeoutError"
  }
}

export async function withTimeout<T>(task: () => Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined

  try {
    return await Promise.race([
      task(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new CheckTimeoutError()), ms)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Runs `probe` under `ms`; any error or timeout is "fail". */
export async function runCheck(probe: () => Promise<unknown>, ms: number): Promise<CheckResult> {
  try {
    await withTimeout(probe, ms)
    return "ok"
  } catch {
    return "fail"
  }
}

function isProduction(env: Env) {
  return env.NODE_ENV === "production"
}

function unconfigured(env: Env): CheckResult {
  return isProduction(env) ? "fail" : "skip"
}

export type Queryable = { query: (text: string) => Promise<{ rows: unknown[] }> }

export function databaseConfigured(env: Env = process.env) {
  return Boolean(env.DATABASE_URL?.trim())
}

async function defaultDatabase(): Promise<Queryable> {
  const { getDatabasePool } = await import("@/lib/db/client")

  return getDatabasePool()
}

export async function checkDatabase(
  options: { env?: Env; db?: () => Promise<Queryable>; timeoutMs?: number } = {}
): Promise<CheckResult> {
  const env = options.env ?? process.env

  if (!options.db && !databaseConfigured(env)) return unconfigured(env)

  return runCheck(async () => (await (options.db ?? defaultDatabase)()).query("select 1"), options.timeoutMs ?? DATABASE_TIMEOUT_MS)
}

export type Pingable = { ping: () => Promise<unknown> }

async function defaultRedis(): Promise<Pingable | undefined> {
  const { getAppRedis } = await import("@/lib/rate-limit/redis-client")

  return getAppRedis()
}

export async function checkRedis(
  options: { env?: Env; redis?: () => Promise<Pingable | undefined>; timeoutMs?: number } = {}
): Promise<CheckResult> {
  const env = options.env ?? process.env

  if (!options.redis && !env.REDIS_URL?.trim()) return unconfigured(env)

  return runCheck(async () => {
    const client = await (options.redis ?? defaultRedis)()

    if (!client) throw new Error("redis unavailable")

    const reply = await client.ping()

    if (reply !== "PONG") throw new Error("unexpected ping reply")
  }, options.timeoutMs ?? REDIS_TIMEOUT_MS)
}

export type BucketProbe = (bucket: string, signal: AbortSignal) => Promise<unknown>

async function headBucket(env: Env): Promise<BucketProbe> {
  const { HeadBucketCommand, S3Client } = await import("@aws-sdk/client-s3")
  const client = new S3Client({
    region: env.S3_REGION ?? "us-east-1",
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: true,
    maxAttempts: 1,
    credentials:
      env.S3_ACCESS_KEY && env.S3_SECRET_KEY ? { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY } : undefined,
  })

  return (bucket, signal) => client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: signal })
}

let cachedBucketProbe: Promise<BucketProbe> | undefined

export async function checkStorage(
  options: { env?: Env; probe?: BucketProbe; timeoutMs?: number } = {}
): Promise<CheckResult> {
  const env = options.env ?? process.env

  if (!options.probe && !env.S3_ENDPOINT?.trim()) return unconfigured(env)

  const timeoutMs = options.timeoutMs ?? STORAGE_TIMEOUT_MS

  return runCheck(async () => {
    const probe = options.probe ?? (await (cachedBucketProbe ??= headBucket(env)))

    await probe(env.S3_BUCKET ?? "meeting-media", AbortSignal.timeout(timeoutMs))
  }, timeoutMs)
}

let cachedFileVersion: string | null | undefined

/** Highest `NNN_name.sql` version in db/migrations (cached; null when none). */
export function latestMigrationFileVersion(directory = resolve(process.cwd(), "db/migrations")): string | null {
  if (cachedFileVersion !== undefined && directory === resolve(process.cwd(), "db/migrations")) return cachedFileVersion

  let latest: string | null = null

  try {
    for (const name of readdirSync(directory)) {
      const match = name.match(/^(\d{3,})_[\w-]+\.sql$/)

      if (match && (latest === null || match[1].localeCompare(latest) > 0)) latest = match[1]
    }
  } catch {
    latest = null
  }

  if (directory === resolve(process.cwd(), "db/migrations")) cachedFileVersion = latest
  return latest
}

/**
 * "ok" when the database is not behind the files. A database ahead of the
 * files is fine: after an automatic rollback the previous release runs on a
 * schema that already has the (backward-compatible) new migration.
 */
export async function checkMigrations(
  options: { env?: Env; db?: () => Promise<Queryable>; fileVersion?: string | null; timeoutMs?: number } = {}
): Promise<CheckResult> {
  const env = options.env ?? process.env

  if (!options.db && !databaseConfigured(env)) return unconfigured(env)

  const fileVersion = options.fileVersion !== undefined ? options.fileVersion : latestMigrationFileVersion()

  if (!fileVersion) return "fail"

  try {
    const applied = await withTimeout(
      async () => (await (options.db ?? defaultDatabase)()).query("select max(version) as version from schema_migrations"),
      options.timeoutMs ?? DATABASE_TIMEOUT_MS
    )
    const version = (applied.rows[0] as { version?: string | null } | undefined)?.version

    return typeof version === "string" && version.localeCompare(fileVersion) >= 0 ? "ok" : "fail"
  } catch {
    return "fail"
  }
}
