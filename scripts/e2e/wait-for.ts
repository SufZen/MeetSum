/**
 * Waits until a service is ready (docs/parity/m10.md, "Order per job").
 *
 *   tsx scripts/e2e/wait-for.ts --url http://127.0.0.1:3101/ready [--log e2e-logs/worker.log --pattern "worker started"] [--timeout 120]
 *
 * Ready when the URL answers 2xx (any status with --any-status) OR the log file contains the pattern
 * (whichever comes first): the worker's /ready endpoint lands with package B,
 * and until then the startup log line is the signal. Exits 1 on timeout.
 * Prints only the URL/pattern, never response bodies.
 */

export type WaitOptions = { url?: string; anyStatus?: boolean; log?: string; pattern?: RegExp; timeoutMs: number; intervalMs?: number }

export function parseWaitArgs(argv: string[]): WaitOptions {
  const value = (name: string) => {
    const index = argv.indexOf(`--${name}`)

    return index >= 0 ? argv[index + 1] : undefined
  }
  const pattern = value("pattern")
  const options: WaitOptions = {
    url: value("url"),
    anyStatus: argv.includes("--any-status"),
    log: value("log"),
    pattern: pattern ? new RegExp(pattern, "i") : undefined,
    timeoutMs: Number(value("timeout") ?? 120) * 1000,
  }

  if (!options.url && !(options.log && options.pattern)) throw new Error("wait-for: pass --url and/or --log with --pattern")
  return options
}

async function urlReady(url: string, anyStatus = false): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })

    await response.body?.cancel()
    return anyStatus || response.ok
  } catch {
    return false
  }
}

async function logReady(file: string, pattern: RegExp): Promise<boolean> {
  try {
    const { readFile } = await import("node:fs/promises")

    return pattern.test(await readFile(file, "utf8"))
  } catch {
    return false
  }
}

export async function waitFor(options: WaitOptions): Promise<boolean> {
  const deadline = Date.now() + options.timeoutMs

  while (Date.now() < deadline) {
    if (options.url && (await urlReady(options.url, options.anyStatus))) return true
    if (options.log && options.pattern && (await logReady(options.log, options.pattern))) return true
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 1_000))
  }
  return false
}

async function main() {
  const options = parseWaitArgs(process.argv.slice(2))
  const what = [options.url, options.log && `${options.log} ~ /${options.pattern?.source}/`].filter(Boolean).join(" or ")
  const started = Date.now()

  if (await waitFor(options)) {
    console.log(`wait-for: ready after ${Math.round((Date.now() - started) / 1000)}s (${what})`)
    return
  }
  console.error(`wait-for: timed out after ${options.timeoutMs / 1000}s (${what})`)
  process.exit(1)
}

if (process.argv[1] && /wait-for/.test(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "wait-for failed")
    process.exit(1)
  })
}
