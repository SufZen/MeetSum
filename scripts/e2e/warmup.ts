/**
 * Warms up the app before a suite (docs/parity/m10.md, "Order per job",
 * step 7): `next dev` compiles each route on its first request, which would
 * otherwise eat the specs' timeouts. GETs every route the suite visits until
 * it answers (any status below 500; signed-out pages redirect), within one
 * shared cap (default 180 s).
 *
 *   tsx scripts/e2e/warmup.ts <suite> [--base http://localhost:3000] [--timeout 180]
 */
import { assertLocal } from "./local-guard"

const COMMON = ["/he/login", "/en/login", "/api/health", "/he", "/en"]

export const WARMUP_ROUTES: Record<string, string[]> = {
  core: [...COMMON, "/he?tab=transcript", "/he?tab=ask", "/he/search", "/api/meetings", "/share/warmup", "/api/search?q=warmup"],
  m6: [...COMMON, "/he/search", "/en/search", "/api/search?q=warmup", "/he?tab=ask"],
  m8: [...COMMON, "/he?panel=settings", "/he?panel=admin", "/api/integrations", "/unsubscribe/warmup"],
  m9: [...COMMON, "/he/tasks", "/he/analytics", "/he/onboarding", "/he?panel=settings", "/share/warmup", "/offline.html", "/he/this-page-does-not-exist"],
  "m9-prod": [...COMMON, "/manifest.webmanifest", "/sw.js", "/offline.html", "/share/warmup"],
}

async function warm(url: string, deadline: number): Promise<number | undefined> {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(Math.max(1_000, deadline - Date.now())) })

      await response.body?.cancel()
      if (response.status < 500) return response.status
    } catch {
      // Not up or still compiling.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  return undefined
}

async function main() {
  const argv = process.argv.slice(2)
  const suite = argv[0] ?? ""
  const flag = (name: string) => {
    const index = argv.indexOf(`--${name}`)

    return index >= 0 ? argv[index + 1] : undefined
  }
  const base = (flag("base") ?? process.env.E2E_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "")
  const routes = WARMUP_ROUTES[suite]

  if (!routes) throw new Error(`warmup: unknown suite "${suite}"`)
  assertLocal(base, "base URL")

  const deadline = Date.now() + Number(flag("timeout") ?? 180) * 1000
  let failed = 0

  for (const route of routes) {
    const started = Date.now()
    const status = await warm(`${base}${route}`, deadline)

    if (status === undefined) failed += 1
    console.log(`warmup ${route.padEnd(36)} ${status ?? "timeout"} ${Math.round((Date.now() - started) / 1000)}s`)
  }
  if (failed) {
    console.error(`warmup: ${failed} route(s) did not answer before the cap`)
    process.exit(1)
  }
}

if (process.argv[1] && /warmup/.test(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "warmup failed")
    process.exit(1)
  })
}
