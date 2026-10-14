/**
 * v0.7.1: scripts/deploy-vps.sh for real (not --dry-run) against stubbed
 * `docker`, `git` and `flock` binaries, so the control flow is exercised:
 * automatic maintenance mode from schema_migrations, refusal on infra image
 * drift, migrate with --no-deps, restarting the old release when a migration
 * fails before the breaking one, and no automatic rollback after a breaking
 * migration. Nothing here touches the repository or a Docker daemon.
 */
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { createFakeDocker, type FakeDockerRule } from "./helpers/fake-docker"

const root = path.resolve(__dirname, "..")
const hasSh = spawnSync("sh", ["-c", "exit 0"], { stdio: "ignore" }).status === 0
const NEW_SHA = "fedcba9876543210fedcba9876543210fedcba98"
const OLD_SHA = "6f9dd96f6bce54432be0d3dc160b4166e549d552"
const PG_REF = "postgres:17.9-alpine@sha256:c7526c0f6c3f30260a563d7bcf8ad778effac59a44f8ffa86678c35418338609"

const versions = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => String(from + index).padStart(3, "0")).join("\\n")

/** A v0.6.0-like host: postgres healthy and on the configured bytes, redis/minio not compared. */
function host(applied: string, extra: FakeDockerRule[] = []): FakeDockerRule[] {
  return [
    ...extra,
    { match: "ps -q postgres", stdout: "cid-postgres" },
    { match: "ps -q redis", stdout: "" },
    { match: "ps -q minio", stdout: "" },
    { match: "State.Health", stdout: "healthy" },
    { match: "inspect --format {{.Image}} cid-postgres", stdout: "sha256:pg" },
    { match: "config --images postgres", stdout: PG_REF },
    { match: `image inspect --format {{.Id}} ${PG_REF}`, stdout: "sha256:pg" },
    { match: "select version from schema_migrations", stdout: applied },
  ]
}

function deploy(rules: FakeDockerRule[], args: string[] = [], options: { failSecondBackup?: boolean } = {}) {
  const docker = createFakeDocker(rules)
  const bin = path.join(docker.dir, "bin")
  const appDir = mkdtempSync(path.join(tmpdir(), "meetsum-app-"))

  // git: logs to the same file; HEAD is the old SHA until the merge.
  writeFileSync(
    path.join(bin, "git"),
    `#!/bin/sh\nprintf 'git %s\\n' "$*" >> "$FAKE_DOCKER_LOG"\ncase "$*" in "rev-parse HEAD") if grep -q '^git merge' "$FAKE_DOCKER_LOG"; then echo ${NEW_SHA}; else echo ${OLD_SHA}; fi ;; esac\nexit 0\n`,
    { mode: 0o755 }
  )
  writeFileSync(path.join(bin, "flock"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  mkdirSync(path.join(appDir, "scripts"))
  writeFileSync(
    path.join(appDir, "scripts/backup-postgres.sh"),
    `#!/bin/sh\n${options.failSecondBackup ? `if grep -q '^BACKUP$' "$FAKE_DOCKER_LOG"; then exit 1; fi\n` : ""}printf 'BACKUP\\n' >> "$FAKE_DOCKER_LOG"\necho backups/postgres/meetsum-postgres-test.dump\n`,
    { mode: 0o755 }
  )
  mkdirSync(path.join(appDir, "db/migrations"), { recursive: true })
  copyFileSync(path.join(root, "db/migrations/019_workspace_scoping.sql"), path.join(appDir, "db/migrations/019_workspace_scoping.sql"))
  writeFileSync(path.join(appDir, "db/migrations/020_next.sql"), "select 1;\n")
  writeFileSync(path.join(appDir, ".env.local"), "")

  const result = spawnSync("sh", [path.join(root, "scripts/deploy-vps.sh"), ...args], {
    cwd: appDir,
    env: {
      ...process.env,
      ...docker.env,
      APP_DIR: appDir,
      DEPLOY_SHA: NEW_SHA,
      MIN_FREE_KB: "0",
      READY_TIMEOUT_SECONDS: "1",
    },
    encoding: "utf8",
  })
  const calls = docker.calls()
  const at = (pattern: RegExp) => calls.findIndex((call) => pattern.test(call))

  return { status: result.status, output: result.stdout + result.stderr, calls, at }
}

describe.runIf(hasSh)("deploy-vps.sh flow (stubbed docker/git/flock)", { timeout: 30_000 }, () => {
  it("v0.6.0 schema (001-014): maintenance is automatic: stop < freeze backup < migrate --no-deps < up app worker", () => {
    const { status, output, calls, at } = deploy(host(versions(1, 14)))

    expect(status, output).toBe(0)
    expect(output).toContain("pending breaking migration(s): 019_workspace_scoping.sql")
    const stop = at(/ stop app worker$/)
    const backups = calls.map((call, index) => (call === "BACKUP" ? index : -1)).filter((index) => index >= 0)
    const migrate = at(/ run --rm --no-deps migrate$/)
    const up = at(/ up -d --no-deps app worker$/)

    expect(backups).toHaveLength(2)
    expect(at(/ build app$/)).toBeLessThan(stop)
    expect(stop).toBeLessThan(backups[1])
    expect(backups[1]).toBeLessThan(migrate)
    expect(migrate).toBeLessThan(up)
    expect(output).toContain("write-freeze backup: backups/postgres/meetsum-postgres-test.dump")
    // Infra is never upped, recreated or pulled.
    for (const call of calls) expect(call).not.toMatch(/\b(up|pull|create|restart)\b.*\b(postgres|redis|minio)\b/)
  })

  it("an up-to-date schema deploys without a write freeze", () => {
    const { status, output, calls } = deploy(host(versions(1, 32)))

    expect(status, output).toBe(0)
    expect(calls.some((call) => / stop app worker$/.test(call))).toBe(false)
    expect(calls.filter((call) => call === "BACKUP")).toHaveLength(1)
  })

  it("an unreadable schema_migrations fails closed into maintenance mode", () => {
    const rules = host("", [{ match: "select version from schema_migrations", exit: 1 }])
    const { status, output, calls } = deploy(rules)

    expect(status, output).toBe(0)
    expect(output).toContain("using maintenance mode to be safe")
    expect(calls.some((call) => / stop app worker$/.test(call))).toBe(true)
  })

  it("refuses on infra image drift of the pulled configuration (checkout reset, nothing built) unless --allow-infra-change", () => {
    const drift = host(versions(1, 32), [{ match: `image inspect --format {{.Id}} ${PG_REF}`, stdout: "sha256:pgvector-glibc" }])
    const refused = deploy(drift)

    expect(refused.status).toBe(1)
    expect(refused.output).toContain("postgres: DRIFT")
    expect(refused.output).toContain("refusing to deploy")
    expect(refused.calls.some((call) => / build app$/.test(call))).toBe(false)
    expect(refused.calls.some((call) => / run --rm /.test(call))).toBe(false)
    // Judged after the pull, then the checkout goes back.
    const merge = refused.calls.findIndex((call) => call.startsWith("git merge"))
    const check = refused.calls.findIndex((call) => call.includes("config --images postgres"))
    const reset = refused.calls.findIndex((call) => call === `git reset --keep ${OLD_SHA}`)

    expect(merge).toBeGreaterThanOrEqual(0)
    expect(merge).toBeLessThan(check)
    expect(check).toBeLessThan(reset)

    const allowed = deploy(drift, ["--allow-infra-change"])

    expect(allowed.status, allowed.output).toBe(0)
    expect(allowed.output).toContain("drift acknowledged")
    for (const call of allowed.calls) expect(call).not.toMatch(/\b(up|pull|create)\b.*\bpostgres\b/)
  })

  it("a failed write-freeze backup restarts the previous release and migrates nothing", () => {
    const { status, output, calls, at } = deploy(host(versions(1, 14)), [], { failSecondBackup: true })

    expect(status).toBe(1)
    expect(output).toContain("write-freeze backup failed")
    expect(at(/ start app worker$/)).toBeGreaterThan(at(/ stop app worker$/))
    expect(calls.some((call) => / run --rm /.test(call))).toBe(false)
    expect(calls).toContain(`git reset --keep ${OLD_SHA}`)
  })

  it("a failed build moves the checkout back and stops nothing", () => {
    const { status, output, calls, at } = deploy(host(versions(1, 14), [{ match: " build app", exit: 1 }]))

    expect(status).toBe(1)
    expect(output).toContain("build failed; nothing was switched")
    expect(at(new RegExp(`^git reset --keep ${OLD_SHA}$`))).toBeGreaterThan(at(/ build app$/))
    expect(calls.some((call) => / (stop|up|run) /.test(call))).toBe(false)
  })

  it("refuses when postgres is not healthy (and never starts it)", () => {
    const { status, output, calls } = deploy(host(versions(1, 32), [{ match: "State.Health", stdout: "unhealthy" }]))

    expect(status).toBe(1)
    expect(output).toContain("postgres is not healthy (unhealthy)")
    expect(calls.some((call) => /\bup\b/.test(call))).toBe(false)
  })

  it("a migration failing before 019 is applied restarts the stopped v0.6.0 app and worker", () => {
    const { status, output, calls, at } = deploy(host(versions(1, 14), [{ match: "run --rm --no-deps migrate", exit: 1 }]))

    expect(status).toBe(1)
    expect(output).toContain("no breaking migration was applied; restarting the previous app and worker")
    expect(at(new RegExp(`^git reset --keep ${OLD_SHA}$`))).toBeGreaterThan(at(/ run --rm --no-deps migrate$/))
    expect(at(/ start app worker$/)).toBeGreaterThan(at(/ run --rm --no-deps migrate$/))
    expect(calls.some((call) => / up -d /.test(call))).toBe(false)
  })

  it("after a breaking migration a readiness failure does not roll back automatically", () => {
    const { status, output, calls } = deploy(host(versions(1, 14), [{ match: "exec -T app", exit: 1 }]))

    expect(status).toBe(1)
    expect(output).toContain("there is no automatic rollback")
    expect(output).toContain("restore backups/postgres/meetsum-postgres-test.dump")
    expect(calls.filter((call) => / up -d --no-deps app worker$/.test(call))).toHaveLength(1)
    expect(calls.some((call) => /MEETSUM_IMAGE_TAG=previous/.test(call))).toBe(false)
  })
})
