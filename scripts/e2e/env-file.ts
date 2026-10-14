/**
 * Per-suite e2e env files (docs/parity/m10.md, "E2E in CI"). Each seed
 * writes its own file and each spec reads it, so the suites never share one:
 *
 *   E2E_<SUITE>_ENV_FILE  (E2E_M6_ENV_FILE, E2E_M8_ENV_FILE, E2E_M9_ENV_FILE, E2E_M10_ENV_FILE)
 *   then E2E_ENV_FILE      (the pre-M10 global override, still honoured)
 *   then the suite default under `.secrets/` (gitignored).
 *
 * The files hold test-only session cookies and ids; they are never printed.
 * In CI (`CI` set) a missing file is an error, so a suite can't go green by
 * skipping every test.
 */
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

export type E2eSuite = "m6" | "m8" | "m9" | "m10"

const DEFAULTS: Record<E2eSuite, string> = {
  m6: path.join(".secrets", "e2e.env"),
  m8: path.join(".secrets", "e2e-m8.env"),
  m9: path.join(".secrets", "e2e-m9.env"),
  m10: path.join(".secrets", "e2e-m10.env"),
}

type Env = Record<string, string | undefined>

export function suiteEnvFile(suite: E2eSuite, env: Env = process.env): string {
  return env[`E2E_${suite.toUpperCase()}_ENV_FILE`]?.trim() || env.E2E_ENV_FILE?.trim() || DEFAULTS[suite]
}

export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {}

  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)

    if (match) values[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, "$2")
  }
  return values
}

/** The suite's env file merged under the process's `E2E_*` variables. */
export function loadSuiteEnv(suite: E2eSuite, env: Env = process.env): Record<string, string> {
  const file = suiteEnvFile(suite, env)
  let values: Record<string, string> = {}

  if (existsSync(file)) {
    values = parseEnvFile(readFileSync(file, "utf8"))
  } else if (env.CI) {
    throw new Error(`E2E env file for ${suite} is missing (${file}); run the suite's seed first`)
  }

  return {
    ...values,
    ...(Object.fromEntries(Object.entries(env).filter(([key, value]) => key.startsWith("E2E_") && value !== undefined)) as Record<string, string>),
  }
}
