/**
 * Scrubs e2e logs before they are uploaded as artifacts (docs/parity/m10.md,
 * "Order per job", step 9). Defense in depth on top of the app's own log
 * redaction (package B): every value of the per-run env file that looks like
 * a secret is replaced, and so are session cookies and bearer tokens.
 *
 *   tsx scripts/e2e/scrub-logs.ts <env file> <log file>...
 */
import { readFileSync, writeFileSync } from "node:fs"

import { parseEnvFile } from "./env-file"

const SECRET_NAME = /(SECRET|_KEY|PASSWORD|TOKEN|SESSION)/

export function secretValues(env: Record<string, string>): string[] {
  return Object.entries(env)
    .filter(([key, value]) => SECRET_NAME.test(key) && value.length >= 12)
    .map(([, value]) => value)
    .sort((left, right) => right.length - left.length)
}

export function scrubText(text: string, secrets: string[]): string {
  let out = text

  for (const secret of secrets) out = out.split(secret).join("[redacted]")
  return out
    .replace(/(meetsum_session=)[^;\s"']+/g, "$1[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [redacted]")
}

function main() {
  const [envFile, ...logs] = process.argv.slice(2)

  if (!envFile) throw new Error("usage: scrub-logs.ts <env file> <log file>...")

  const secrets = secretValues(parseEnvFile(readFileSync(envFile, "utf8")))

  for (const file of logs) {
    try {
      writeFileSync(file, scrubText(readFileSync(file, "utf8"), secrets))
    } catch {
      // A service that never started has no log.
    }
  }
  console.log(`scrub-logs: scrubbed ${logs.length} file(s)`)
}

if (process.argv[1] && /scrub-logs/.test(process.argv[1])) main()
