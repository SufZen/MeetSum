/**
 * M10 B5 + security check 7: scripts/deploy-vps.sh is the only deploy path.
 * `--dry-run` prints the plan without executing anything; the plan runs
 * lock < preflight < backup < pull < build < migrate < up < ready, builds
 * once, migrates with the new image before the switch, and never touches the
 * database on rollback. deploy.yml only calls the script, behind the
 * DEPLOY_ENABLED gate. shellcheck runs when it is installed.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { describe, expect, it } from "vitest"

const root = path.resolve(__dirname, "..")
const SCRIPTS = [
  "scripts/deploy-vps.sh",
  "scripts/rollback-vps.sh",
  "scripts/backup-postgres.sh",
  "scripts/backup-full.sh",
  "scripts/restore-full.sh",
  "scripts/infra-drift.sh",
  "scripts/breaking-migrations.sh",
]
const SHA = "0123456789abcdef0123456789abcdef01234567"

function hasCommand(command: string, args: string[] = ["--version"]) {
  return spawnSync(command, args, { stdio: "ignore" }).status === 0
}

const hasSh = hasCommand("sh", ["-c", "exit 0"])

function dryRun(script: string, args: string[] = [], env: Record<string, string> = {}) {
  return execFileSync("sh", [script, ...args, "--dry-run"], {
    cwd: root,
    env: { ...process.env, APP_DIR: root, ...env },
    encoding: "utf8",
  })
}

function order(output: string, markers: string[]) {
  return markers.map((marker) => {
    const index = output.indexOf(marker)

    expect(index, marker).toBeGreaterThanOrEqual(0)
    return index
  })
}

describe("deploy script", () => {
  it.runIf(hasSh).each(SCRIPTS)("%s parses (sh -n)", (script) => {
    expect(spawnSync("sh", ["-n", script], { cwd: root }).status).toBe(0)
  })

  it.runIf(hasCommand("shellcheck"))("passes shellcheck", () => {
    const result = spawnSync("shellcheck", ["-s", "sh", "-S", "warning", ...SCRIPTS], { cwd: root, encoding: "utf8" })

    expect(result.stdout + result.stderr).toBe("")
  })

  it.runIf(hasSh)("dry run: lock < preflight < backup < pull < build < migrate < up < ready", () => {
    const output = dryRun("scripts/deploy-vps.sh", [], { DEPLOY_SHA: SHA })
    const indexes = order(output, [
      "STEP lock",
      "STEP preflight",
      "STEP backup",
      "STEP pull",
      "STEP build",
      "STEP migrate",
      "STEP up app worker",
      "STEP ready",
    ])

    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes)
    expect(output).toContain("+ ./scripts/backup-postgres.sh")
    expect(output).toContain(`git merge --ff-only ${SHA}`)
    // One build (app only), tagged with the SHA; migrate and up use that image.
    expect(output.match(/ build app/g)).toHaveLength(1)
    expect(output).toContain(`MEETSUM_IMAGE_TAG=0123456789ab MEETSUM_GIT_SHA=${SHA} docker compose`)
    // migrate never starts or recreates postgres (--no-deps), after a health check.
    expect(output).toMatch(/MEETSUM_IMAGE_TAG=0123456789ab docker compose .* run --rm --no-deps migrate/)
    expect(output.indexOf("require postgres healthy", output.indexOf("STEP migrate"))).toBeGreaterThan(0)
    expect(output).toMatch(/MEETSUM_IMAGE_TAG=0123456789ab .*up -d --no-deps app worker/)
    expect(output).toContain("api/health/ready")
    expect(output).toContain("automatic rollback")
  })

  it.runIf(hasSh)("a deploy only ever ups app and worker (--no-deps): never postgres, redis or minio", () => {
    for (const args of [[], ["--maintenance"], ["--allow-infra-change"]]) {
      const output = dryRun("scripts/deploy-vps.sh", args, { DEPLOY_SHA: SHA })
      const ups = output.split("\n").filter((line) => /docker compose .* up\b/.test(line))

      expect(ups.length, args.join(" ")).toBeGreaterThan(0)
      for (const line of ups) expect(line).toMatch(/ up -d --no-deps app worker$/)
      expect(output).not.toMatch(/\b(up|create|restart|pull)\b[^\n]*\b(postgres|redis|minio)\b/)
      for (const line of output.split("\n").filter((entry) => / run --rm /.test(entry))) expect(line).toContain("--no-deps")
    }
    const script = readFileSync(path.join(root, "scripts/deploy-vps.sh"), "utf8")

    for (const line of script.split("\n").filter((entry) => /\bup -d\b/.test(entry) && !entry.trim().startsWith("#"))) {
      expect(line).toContain("up -d --no-deps app worker")
    }
  })

  it.runIf(hasSh)("preflight checks postgres health and infra image drift (by image ID) before anything else", () => {
    const output = dryRun("scripts/deploy-vps.sh", [], { DEPLOY_SHA: SHA })
    const [preflight, drift, backup] = order(output, ["STEP preflight", "scripts/infra-drift.sh", "STEP backup"])

    expect(preflight).toBeLessThan(drift)
    expect(drift).toBeLessThan(backup)
    expect(output).toContain("refuse unless --allow-infra-change")
    expect(output).not.toContain("--allow-infra-change: infra drift is reported")
    expect(dryRun("scripts/deploy-vps.sh", ["--allow-infra-change"], { DEPLOY_SHA: SHA })).toContain(
      "--allow-infra-change: infra drift is reported but does not stop the deploy"
    )
  })

  it.runIf(hasSh)("maintenance: build < stop app worker < write-freeze backup < migrate < up < ready, no automatic rollback", () => {
    const output = dryRun("scripts/deploy-vps.sh", ["--maintenance"], { DEPLOY_SHA: SHA })
    const indexes = order(output, [
      "STEP build",
      "STEP schema check",
      "STEP maintenance: stop app worker",
      "STEP backup (write freeze",
      "STEP migrate",
      "STEP up app worker",
      "STEP ready",
    ])

    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes)
    expect(output).toMatch(/docker compose .* stop app worker/)
    expect(output.match(/\+ \.\/scripts\/backup-postgres\.sh/g)).toHaveLength(2)
    expect(output).toContain("NO automatic rollback")
    expect(output).not.toContain("automatic rollback of code and image")
  })

  it.runIf(hasSh)("without --maintenance the plan names the breaking migrations it checks for", () => {
    const output = dryRun("scripts/deploy-vps.sh", [], { DEPLOY_SHA: SHA })

    expect(output).toContain("select version from schema_migrations")
    expect(output).toContain("migrations marked breaking: 019_workspace_scoping.sql")
    expect(output).not.toContain("STEP maintenance")
  })

  it.runIf(hasSh)("passes the host-local docker-compose.local.yml with -f whenever it exists (deploy and rollback)", () => {
    const local = path.join(mkdtempSync(path.join(tmpdir(), "meetsum-local-")), "docker-compose.local.yml")
    const missing = dryRun("scripts/deploy-vps.sh", [], { DEPLOY_SHA: SHA, LOCAL_COMPOSE_FILE: local })

    expect(missing).not.toContain(local)
    writeFileSync(local, "services: {}\n")

    const deploy = dryRun("scripts/deploy-vps.sh", ["--maintenance"], { DEPLOY_SHA: SHA, LOCAL_COMPOSE_FILE: local })
    const composeLines = deploy.split("\n").filter((line) => line.includes("docker compose --env-file"))

    expect(composeLines.length).toBeGreaterThan(3)
    for (const line of composeLines) expect(line).toContain(`-f ${local}`)
    // The local override comes last so it wins, also after the migrate file.
    expect(deploy).toContain(`-f docker-compose.prod.yml -f docker-compose.migrate.yml -f ${local}`)

    const rollback = dryRun("scripts/rollback-vps.sh", [SHA], { LOCAL_COMPOSE_FILE: local })

    expect(rollback).toMatch(new RegExp(`up -d --no-deps app worker`))
    for (const line of rollback.split("\n").filter((entry) => entry.includes("docker compose --env-file"))) {
      expect(line).toContain(`-f ${local}`)
    }
  })

  it.runIf(hasSh)("dry run executes nothing and prints no env values", () => {
    const output = dryRun("scripts/deploy-vps.sh", [], { DEPLOY_SHA: SHA, POSTGRES_PASSWORD: "canary-db-password" })

    expect(output).not.toContain("canary-db-password")
    expect(output).toContain("dry run")
  })

  it.runIf(hasSh)("manual rollback: code and image, never the database", () => {
    const output = dryRun("scripts/rollback-vps.sh", [SHA])

    expect(output).toContain("STEP rollback")
    expect(output).toContain(`git reset --keep ${SHA}`)
    expect(output).toMatch(/MEETSUM_IMAGE_TAG=0123456789ab .*up -d --no-deps app worker/)
    expect(output).toContain("database is not rolled back")
    expect(output).not.toMatch(/restore-postgres|pg_restore|migrate/)
  })

  it("never echoes the env file and fails hard on a failed backup", () => {
    const deploy = readFileSync(path.join(root, "scripts/deploy-vps.sh"), "utf8")
    const backup = readFileSync(path.join(root, "scripts/backup-postgres.sh"), "utf8")

    expect(deploy).toMatch(/^set -eu$/m)
    expect(deploy).not.toMatch(/cat\s+"?\$ENV_FILE|source\s+"?\$ENV_FILE|\.\s+"?\$ENV_FILE|printenv|env\s*$/m)
    expect(deploy).not.toMatch(/backup-postgres\.sh\s*\|\|/)
    expect(deploy).toContain("flock -w")
    expect(backup).toMatch(/^set -eu$/m)
    expect(backup).toContain('[ ! -s "$PARTIAL_FILE" ]')
  })

  it("deploy.yml only runs the script, behind DEPLOY_ENABLED and after CI", () => {
    const workflow = readFileSync(path.join(root, ".github/workflows/deploy.yml"), "utf8")

    expect(workflow).toContain("vars.DEPLOY_ENABLED == 'true'")
    expect(workflow).toContain("github.ref == 'refs/heads/main'")
    expect(workflow).toContain("environment: production")
    expect(workflow).toContain("./scripts/deploy-vps.sh")
    expect(workflow).toMatch(/workflows: \[CI\]/)
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'")
    expect(workflow).not.toMatch(/docker compose|docker exec|backup-postgres/)
    for (const line of workflow.split("\n").filter((entry) => /^\s*(-\s*)?uses:/.test(entry))) {
      expect(line).toMatch(/@[0-9a-f]{40}\b/)
    }
  })
})
