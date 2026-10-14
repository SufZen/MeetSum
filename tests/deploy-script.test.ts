/**
 * M10 B5 + security check 7: scripts/deploy-vps.sh is the only deploy path.
 * `--dry-run` prints the plan without executing anything; the plan runs
 * lock < preflight < backup < pull < build < migrate < up < ready, builds
 * once, migrates with the new image before the switch, and never touches the
 * database on rollback. deploy.yml only calls the script, behind the
 * DEPLOY_ENABLED gate. shellcheck runs when it is installed.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

const root = path.resolve(__dirname, "..")
const SCRIPTS = ["scripts/deploy-vps.sh", "scripts/rollback-vps.sh", "scripts/backup-postgres.sh"]
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
    expect(output).toMatch(/MEETSUM_IMAGE_TAG=0123456789ab docker compose .* run --rm migrate/)
    expect(output).toMatch(/MEETSUM_IMAGE_TAG=0123456789ab .*up -d --no-deps app worker/)
    expect(output).toContain("api/health/ready")
    expect(output).toContain("automatic rollback")
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
