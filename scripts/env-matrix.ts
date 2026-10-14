/**
 * Generates docs/env-matrix.md (M10 B6, docs/parity/m10.md "Runbooks").
 *
 *   npm run env:matrix            write docs/env-matrix.md
 *   npm run env:matrix -- --check exit 1 when docs/env-matrix.md is stale
 *
 * Sources:
 * - `.env.example`: every `NAME=` / `# NAME=` line, its section header
 *   (`# --- Title (Mx) ---`), the comment lines above it, and the value
 *   shown (the default when non-empty);
 * - a scan of `process.env.<NAME>` / `process.env["<NAME>"]` (and the injected
 *   `env.<NAME>` / `envText(env, "<NAME>")` forms) in lib/, app/,
 *   worker/, mcp/, scripts/, instrumentation.ts and proxy.ts, which gives
 *   "used by" (app, worker, migrate, mcp, scripts, e2e).
 *
 * Pure helpers are exported for tests/env-documented.test.ts. Values are
 * never read from a real env file: only the committed template.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export type EnvExampleEntry = {
  name: string
  section: string
  milestone: string
  defaultValue: string
  commented: boolean
  notes: string
}

export type EnvUsage = Map<string, Set<string>>

/** Variables the code may read that are not documented on purpose. */
export const ENV_ALLOWLIST: Array<string | RegExp> = [
  "NODE_ENV",
  "NEXT_RUNTIME",
  "NEXT_PHASE",
  "CI",
  /^npm_/,
  /^E2E_/,
  "PORT",
  "HOSTNAME",
  // OS-provided (Windows profile path read by a local helper script).
  "LOCALAPPDATA",
  // Test runner detection (the logger's test sink, the rate limiter's default backend).
  "VITEST",
]

export function isAllowlisted(name: string): boolean {
  return ENV_ALLOWLIST.some((entry) => (typeof entry === "string" ? entry === name : entry.test(name)))
}

const SECTION = /^#\s*-{2,}\s*(.+?)\s*-*\s*$/
const VARIABLE = /^(#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/
const MILESTONE = /\((M\d+[^)]*)\)/

export function parseEnvExample(source: string): EnvExampleEntry[] {
  const entries: EnvExampleEntry[] = []
  let section = ""
  let milestone = ""
  let comments: string[] = []

  for (const raw of source.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim()

    if (!line) {
      comments = []
      continue
    }

    const sectionMatch = line.match(SECTION)

    if (sectionMatch) {
      section = sectionMatch[1].replace(/\s*-+$/, "").trim()
      milestone = section.match(MILESTONE)?.[1] ?? ""
      comments = []
      continue
    }

    const variable = line.match(VARIABLE)

    if (variable) {
      const [, commentPrefix, name, value] = variable

      if (!entries.some((entry) => entry.name === name)) {
        entries.push({
          name,
          section,
          milestone,
          defaultValue: value.trim(),
          commented: Boolean(commentPrefix),
          notes: comments.join(" ").replace(/\s+/g, " ").trim(),
        })
      }
      comments = []
      continue
    }

    if (line.startsWith("#")) comments.push(line.replace(/^#\s?/, ""))
  }

  return entries
}

// `process.env.<NAME>`, `process.env["<NAME>"]`, and the injected-env forms the
// code uses for testability: `env.<NAME>`, `env["<NAME>"]`, `envText(env, "<NAME>")`.
const ENV_READ =
  /\b(?:process\.)?env\.([A-Z][A-Z0-9_]{1,})\b|\b(?:process\.)?env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]|\benv\w*\(\s*env\s*,\s*["']([A-Z][A-Z0-9_]*)["']/g

export function scanEnvReads(source: string): string[] {
  const names = new Set<string>()

  for (const match of source.matchAll(ENV_READ)) names.add(match[1] ?? match[2] ?? match[3])

  return [...names]
}

/** Which process reads a file. */
export function consumerOf(relativePath: string): string {
  const file = relativePath.replace(/\\/g, "/")

  if (file.startsWith("worker/")) return "worker"
  if (file === "scripts/migrate.ts" || file.startsWith("lib/db/migrations")) return "migrate"
  if (file.startsWith("mcp/")) return "mcp"
  if (/^scripts\/(e2e\/|.*e2e-seed|fake-providers|bot-simulate)/.test(file)) return "e2e"
  if (file.startsWith("scripts/")) return "scripts"
  if (file.startsWith("lib/jobs/") || file.startsWith("lib/worker-health/")) return "worker"

  return "app"
}

const SCAN_ROOTS = ["lib", "app", "worker", "mcp", "scripts", "instrumentation.ts", "proxy.ts"]

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const full = path.join(dir, name)

    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|mjs|js|cjs)$/.test(name) && !/\.test\./.test(name)) out.push(full)
  }
}

export function collectEnvUsage(root: string): EnvUsage {
  const usage: EnvUsage = new Map()
  const files: string[] = []

  for (const entry of SCAN_ROOTS) {
    const full = path.join(root, entry)

    try {
      if (statSync(full).isDirectory()) walk(full, files)
      else files.push(full)
    } catch {
      // optional root
    }
  }

  for (const file of files) {
    const relative = path.relative(root, file)

    for (const name of scanEnvReads(readFileSync(file, "utf8"))) {
      const consumers = usage.get(name) ?? new Set<string>()

      consumers.add(consumerOf(relative))
      usage.set(name, consumers)
    }
  }

  return usage
}

/** Code reads that `.env.example` does not document (minus the allowlist). */
export function undocumentedReads(usage: EnvUsage, entries: EnvExampleEntry[]): string[] {
  const documented = new Set(entries.map((entry) => entry.name))

  return [...usage.keys()].filter((name) => !documented.has(name) && !isAllowlisted(name)).sort()
}

const SECRET_NAME = /SECRET|PASSWORD|TOKEN|_KEY$|_KEYS(_PREVIOUS)?$|PRIVATE|CREDENTIAL|DSN$|PASSCODE/
const PROD_REQUIRED = new Set([
  "DATABASE_URL",
  "REDIS_URL",
  "S3_ENDPOINT",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "S3_BUCKET",
  "MEETSUM_SESSION_SECRET",
  "MEETSUM_PUBLIC_URL",
  "MEETSUM_STORAGE",
])

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name) && !/_(URL|PORT|HOST|MODE|PROVIDER|ENABLED|FILE|PATH)$/.test(name)
}

function requiredIn(entry: EnvExampleEntry | undefined, name: string, consumers: Set<string>): string {
  const where: string[] = []

  if (!entry?.commented && entry?.defaultValue !== undefined) where.push("dev")
  if (/^(E2E_|MEETSUM_E2E)/.test(name) || consumers.has("e2e")) where.push("e2e")
  if (PROD_REQUIRED.has(name)) where.push("prod")
  if (name === "PG_DUMP_CMD") where.push("CI")

  return where.length ? where.join(", ") : "optional"
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ")
}

export function renderEnvMatrix(entries: EnvExampleEntry[], usage: EnvUsage): string {
  const byName = new Map(entries.map((entry) => [entry.name, entry]))
  const names = [...new Set([...entries.map((entry) => entry.name), ...[...usage.keys()].filter((name) => !isAllowlisted(name))])]
  const lines = [
    "# Environment variable matrix",
    "",
    "<!-- GENERATED by `npm run env:matrix` (scripts/env-matrix.ts) from .env.example and a scan of process.env reads. Do not edit. -->",
    "",
    "Columns: **used by** comes from the code scan (lib/, app/, worker/, mcp/, scripts/, instrumentation.ts, proxy.ts); **required in** is",
    "`dev` when `.env.example` sets the variable uncommented, `prod` for the production essentials, `e2e`/`CI` for test tooling, otherwise `optional`.",
    "**Default** is the value `.env.example` shows (an example, not always a code default). **Secret** marks values that must never be logged",
    "or committed. Notes are the comment above the variable in `.env.example`.",
    "",
  ]
  let currentSection: string | undefined

  for (const name of names) {
    const entry = byName.get(name)
    const section = entry?.section || "Read by code, not in .env.example"

    if (section !== currentSection) {
      currentSection = section
      lines.push("", `## ${section}`, "", "| Variable | Used by | Required in | Default | Secret | Milestone | Notes |", "|---|---|---|---|---|---|---|")
    }

    const consumers = usage.get(name) ?? new Set<string>()
    const usedBy = consumers.size ? [...consumers].sort().join(", ") : "compose/infra"
    const secret = isSecretName(name)
    const shownDefault = secret ? (entry?.defaultValue ? "(example only)" : "") : (entry?.defaultValue ?? "")

    lines.push(
      `| \`${name}\` | ${usedBy} | ${requiredIn(entry, name, consumers)} | ${cell(shownDefault ? `\`${shownDefault}\`` : "")} | ${secret ? "yes" : "no"} | ${entry?.milestone ?? ""} | ${cell(entry?.notes ?? "")} |`
    )
  }

  return `${lines.join("\n")}\n`
}

export function buildEnvMatrix(root: string): string {
  const entries = parseEnvExample(readFileSync(path.join(root, ".env.example"), "utf8"))

  return renderEnvMatrix(entries, collectEnvUsage(root))
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const output = buildEnvMatrix(root)
  const target = path.join(root, "docs/env-matrix.md")

  if (process.argv.includes("--check")) {
    let current = ""

    try {
      current = readFileSync(target, "utf8").replace(/\r\n/g, "\n")
    } catch {
      // missing file is stale
    }

    if (current !== output) {
      process.stderr.write("docs/env-matrix.md is stale: run npm run env:matrix\n")
      process.exit(1)
    }
    process.stdout.write("docs/env-matrix.md is up to date\n")
  } else {
    writeFileSync(target, output)
    process.stdout.write(`wrote ${path.relative(root, target)}\n`)
  }
}
