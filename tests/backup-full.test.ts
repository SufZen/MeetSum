/**
 * v0.7.1: scripts/backup-full.sh backs MinIO up through a throwaway
 * container of the minio service (its image ships `mc`), mirroring every
 * bucket into the backup directory over a bind mount. It no longer needs (or
 * uses) an `mc` binary on the host, and it fails non-zero when the MinIO part
 * fails instead of skipping it. restore-full.sh mirrors back the same way.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { createFakeDocker, type FakeDockerRule } from "./helpers/fake-docker"

const root = path.resolve(__dirname, "..")
const hasSh = spawnSync("sh", ["-c", "exit 0"], { stdio: "ignore" }).status === 0

function backup(rules: FakeDockerRule[] = []) {
  const docker = createFakeDocker([{ match: "exec -T postgres", stdout: "PGDMP-fake-dump" }, ...rules])
  const bin = path.join(docker.dir, "bin")
  const backupRoot = mkdtempSync(path.join(tmpdir(), "meetsum-backup-"))

  // A host `mc` that must never be called.
  writeFileSync(path.join(bin, "mc"), `#!/bin/sh\nprintf 'HOST-MC %s\\n' "$*" >> "$FAKE_DOCKER_LOG"\nexit 0\n`, { mode: 0o755 })
  const result = spawnSync("sh", ["scripts/backup-full.sh"], {
    cwd: root,
    env: { ...process.env, ...docker.env, BACKUP_DIR: backupRoot, MINIO_ROOT_PASSWORD: "canary-minio-password" },
    encoding: "utf8",
  })

  return { status: result.status, output: result.stdout + result.stderr, calls: docker.calls(), backupRoot }
}

describe.runIf(hasSh)("backup-full.sh", { timeout: 30_000 }, () => {
  it("mirrors MinIO through a --no-deps throwaway minio container into the backup directory", () => {
    const { status, output, calls, backupRoot } = backup()

    expect(status, output).toBe(0)
    const run = calls.find((call) => call.includes(" run --rm "))

    expect(run).toBeDefined()
    expect(run).toContain("--no-deps")
    expect(run).toContain("--pull never")
    expect(run).toMatch(/--entrypoint sh -v \S+[\\/]minio:\/backup minio -c /)
    expect(run).toContain("mc mirror")
    expect(run).toContain("/backup/")
    // Credentials are expanded inside the container, never on the host command line.
    expect(run).toContain("$MINIO_ROOT_USER")
    expect(output + calls.join("\n")).not.toContain("canary-minio-password")
    expect(calls.some((call) => call.startsWith("HOST-MC"))).toBe(false)
    expect(calls.some((call) => /\b(up|create|restart|pull)\b.*\bminio\b/.test(call.replace("--pull never", "")))).toBe(false)

    const dirs = readFileSync(path.join(backupRoot, readdirName(backupRoot), "manifest.json"), "utf8")

    expect(JSON.parse(dirs).files.map((file: { name: string }) => file.name)).toEqual(["postgres.dump", "minio/"])
  })

  it("fails non-zero, without a manifest, when the MinIO mirror fails", () => {
    const { status, output, backupRoot } = backup([{ match: " run --rm ", exit: 1 }])

    expect(status).not.toBe(0)
    expect(output).toMatch(/MinIO backup failed/)
    expect(existsSync(path.join(backupRoot, readdirName(backupRoot), "manifest.json"))).toBe(false)
  })

  it("never skips MinIO silently", () => {
    const script = readFileSync(path.join(root, "scripts/backup-full.sh"), "utf8")

    expect(script).toMatch(/^set -eu$/m)
    expect(script).not.toMatch(/skipping MinIO|command -v mc/)
  })

  it("restore-full.sh restores MinIO through the container too and fails loudly", () => {
    const script = readFileSync(path.join(root, "scripts/restore-full.sh"), "utf8")

    expect(script).not.toMatch(/command -v mc|skipping MinIO restore/)
    expect(script).toMatch(/run --rm --no-deps -T --pull never --entrypoint sh -v "\$\{?MINIO_DIR_ABS\}?:\/backup:ro" minio/)
  })
})

function readdirName(dir: string): string {
  const entries = readdirSync(dir)

  expect(entries).toHaveLength(1)
  return entries[0]
}
