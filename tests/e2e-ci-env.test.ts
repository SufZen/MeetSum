/**
 * M10 A: scripts/e2e/ci-env.sh (docs/parity/m10.md, "Per-run secrets").
 * Every secret is fresh random hex, nothing secret reaches stdout, the
 * production suite gets no fakes or replay, and the file is gitignored.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"

import { afterAll, describe, expect, it } from "vitest"

import { parseEnvFile, suiteEnvFile } from "@/scripts/e2e/env-file"
import { scrubText, secretValues } from "@/scripts/e2e/scrub-logs"

// Relative and under the gitignored test-results/: works with any bash on Windows (Git Bash or WSL).
mkdirSync("test-results", { recursive: true })
const dir = path.relative(process.cwd(), mkdtempSync(path.join("test-results", "ci-env-")))
const bash = spawnSync("bash", ["--version"], { encoding: "utf8" })
const haveTools = bash.status === 0 && spawnSync("bash", ["-c", "command -v openssl"], { encoding: "utf8" }).status === 0
const SECRET_KEYS = /(SECRET|SECRET_KEY|ENCRYPTION_KEY|API_KEY|PASSWORD|TOKEN)$/

function generate(suite: string) {
  const file = path.join(dir, `${suite}.env`).replaceAll("\\", "/")
  const run = spawnSync("bash", ["scripts/e2e/ci-env.sh", suite, file], { encoding: "utf8" })

  expect(run.status, run.stderr).toBe(0)
  return { stdout: `${run.stdout}${run.stderr}`, values: parseEnvFile(readFileSync(file, "utf8")) }
}

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe.skipIf(!haveTools)("ci-env.sh", () => {
  it("writes random, distinct secrets and never prints them", () => {
    const { stdout, values } = generate("core")
    const secrets = Object.entries(values).filter(([key]) => SECRET_KEYS.test(key) && !key.endsWith("_URL"))

    expect(secrets.map(([key]) => key)).toEqual(
      expect.arrayContaining(["MEETSUM_SESSION_SECRET", "WEBHOOK_SIGNING_SECRET", "GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY", "VEXA_WEBHOOK_SECRET", "S3_SECRET_KEY"])
    )
    for (const [key, value] of secrets) {
      expect(value, key).toMatch(/^[0-9a-f]{64}$/)
      expect(stdout).not.toContain(value)
    }
    expect(new Set(secrets.map(([, value]) => value)).size).toBe(secrets.length)
  })

  it("is different on every run", () => {
    expect(generate("m6").values.MEETSUM_SESSION_SECRET).not.toBe(generate("m6").values.MEETSUM_SESSION_SECRET)
  })

  it("points only at loopback services", () => {
    const { values } = generate("m8")

    for (const [key, value] of Object.entries(values)) {
      if (/^[a-z]+:\/\//.test(value)) expect(new URL(value).hostname, key).toMatch(/^(127\.0\.0\.1|localhost)$/)
    }
  })

  it("gives the production suite no fakes, no replay and no bypass flags", () => {
    const { values } = generate("m9-prod")

    expect(values.NODE_ENV).toBe("production")
    expect(values.MEETSUM_LLM_REPLAY_DIR).toBeUndefined()
    expect(values.MEETSUM_INTEGRATIONS_FAKE_BASE_URL).toBeUndefined()
    expect(values.LOCAL_TRANSCRIPTION_URL).toBeUndefined()
    expect(Object.keys(values).filter((key) => key.startsWith("MEETSUM_ALLOW_"))).toEqual([])
  })

  it("wires the core suite to fake ASR, replay and the fake Vexa", () => {
    const { values } = generate("core")

    expect(values.NODE_ENV).toBe("development")
    expect(values.MEETSUM_ASR_CHAIN).toBe("local-whisper-chunked")
    expect(values.LOCAL_TRANSCRIPTION_URL).toBe("http://127.0.0.1:4010/asr")
    expect(values.MEETSUM_LLM_REPLAY_DIR).toBe("tests/fixtures/e2e/llm-replay")
    expect(values.MEETSUM_BOT_ENABLED).toBe("true")
    expect(values.VEXA_API_KEY!.length).toBeGreaterThanOrEqual(16)
  })

  it("rejects an unknown suite", () => {
    expect(spawnSync("bash", ["scripts/e2e/ci-env.sh", "nope", path.join(dir, "x.env")]).status).not.toBe(0)
  })
})

describe("scrub-logs", () => {
  it("removes env secrets, session cookies and bearer tokens from logs", () => {
    const secret = "a".repeat(64)
    const secrets = secretValues({ MEETSUM_SESSION_SECRET: secret, NODE_ENV: "development", E2E_BASE_URL: "http://localhost:3000" })
    const out = scrubText(`boot ${secret} cookie: meetsum_session=abc.def; Authorization: Bearer xoxb-1234567890 ok`, secrets)

    expect(secrets).toEqual([secret])
    expect(out).not.toContain(secret)
    expect(out).not.toContain("abc.def")
    expect(out).not.toContain("xoxb-1234567890")
    expect(out).toContain("ok")
  })
})

describe("env files stay out of git", () => {
  it("the default CI env file and every suite env file are under the gitignored .secrets/", () => {
    expect(readFileSync(".gitignore", "utf8")).toMatch(/^\.secrets\/$/m)
    expect(readFileSync("scripts/e2e/ci-env.sh", "utf8")).toContain(".secrets/ci.env")
    for (const suite of ["m6", "m8", "m9", "m10"] as const) {
      expect(suiteEnvFile(suite, {}).replaceAll("\\", "/")).toMatch(/^\.secrets\//)
    }
  })

  it("per-suite overrides win over the global E2E_ENV_FILE", () => {
    expect(suiteEnvFile("m8", { E2E_ENV_FILE: "a.env", E2E_M8_ENV_FILE: "b.env" })).toBe("b.env")
    expect(suiteEnvFile("m9", { E2E_ENV_FILE: "a.env", E2E_M8_ENV_FILE: "b.env" })).toBe("a.env")
  })

  it("the workflow never uploads secrets", () => {
    const workflow = readFileSync(".github/workflows/e2e.yml", "utf8")

    expect(workflow).not.toMatch(/\$\{\{\s*secrets\./)
    for (const block of workflow.split("actions/upload-artifact").slice(1)) {
      const paths = block.split(/\n\s*-\s*(?:name|uses):/)[0]!

      expect(paths).not.toMatch(/\.secrets|ci\.env|\.env/)
    }
  })
})
