/**
 * v0.7.1 deploy safety: scripts/infra-drift.sh compares, for each running
 * infra container (postgres, redis, minio), the resolved image ID of the
 * configured image reference (`docker image inspect <ref>` .Id) with the
 * container's image (`docker inspect` .Image). Strings are never compared:
 * moving from `postgres:17-alpine` to a digest-pinned reference of the same
 * bytes is not drift. It only reads (ps, config, inspect); it never pulls,
 * runs or recreates anything.
 */
import { spawnSync } from "node:child_process"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { createFakeDocker, type FakeDockerRule } from "./helpers/fake-docker"

const root = path.resolve(__dirname, "..")
const hasSh = spawnSync("sh", ["-c", "exit 0"], { stdio: "ignore" }).status === 0

const PG_REF = "postgres:17.9-alpine@sha256:c7526c0f6c3f30260a563d7bcf8ad778effac59a44f8ffa86678c35418338609"
const REDIS_REF = "redis:7.4.8-alpine@sha256:7aec734b2bb298a1d769fd8729f13b8514a41bf90fcdd1f38ec52267fbaa8ee6"
const MINIO_REF = "minio/minio:RELEASE.2025-09-07T16-13-09Z"

/** All three running, each configured ref resolving to `ids[svc]`, running `running[svc]`. */
function world(ids: Record<string, string | null>, running: Record<string, string | null>): FakeDockerRule[] {
  const refs: Record<string, string> = { postgres: PG_REF, redis: REDIS_REF, minio: MINIO_REF }
  const rules: FakeDockerRule[] = []

  for (const svc of ["postgres", "redis", "minio"]) {
    if (running[svc] === null) {
      rules.push({ match: `ps -q ${svc}`, stdout: "" })
      continue
    }
    rules.push({ match: `ps -q ${svc}`, stdout: `cid-${svc}` })
    rules.push({ match: `inspect --format {{.Image}} cid-${svc}`, stdout: running[svc] ?? "" })
    rules.push({ match: `config --images ${svc}`, stdout: refs[svc] })
    if (ids[svc] === null) rules.push({ match: `image inspect --format {{.Id}} ${refs[svc]}`, exit: 1, stdout: "" })
    else rules.push({ match: `image inspect --format {{.Id}} ${refs[svc]}`, stdout: ids[svc] ?? "" })
  }
  return rules
}

function drift(rules: FakeDockerRule[]) {
  const docker = createFakeDocker(rules)
  const result = spawnSync("sh", ["scripts/infra-drift.sh", "--env-file", ".env.local", "-f", "docker-compose.prod.yml"], {
    cwd: root,
    env: { ...process.env, ...docker.env },
    encoding: "utf8",
  })

  return { status: result.status, output: result.stdout + result.stderr, calls: docker.calls() }
}

const SAME = { postgres: "sha256:pg", redis: "sha256:8b81dd37ff02", minio: "sha256:mn" }

describe.runIf(hasSh)("infra-drift.sh", { timeout: 30_000 }, () => {
  it("passes when every running infra container already runs the configured image ID", () => {
    const { status, output, calls } = drift(world(SAME, SAME))

    expect(status, output).toBe(0)
    expect(output).toContain("postgres: running image matches")
    // Compose args are passed through to every compose call.
    expect(calls.filter((call) => call.startsWith("compose"))).not.toHaveLength(0)
    for (const call of calls.filter((entry) => entry.startsWith("compose"))) {
      expect(call).toContain("--env-file .env.local -f docker-compose.prod.yml")
    }
  })

  it("reports drift (exit 3) when a configured reference resolves to a different image ID", () => {
    const { status, output } = drift(world({ ...SAME, postgres: "sha256:pgvector" }, SAME))

    expect(status).toBe(3)
    expect(output).toMatch(/postgres: DRIFT/)
    expect(output).toContain(PG_REF)
    expect(output).toContain("sha256:pgvector")
    expect(output).toContain("sha256:pg")
    expect(output).not.toMatch(/redis: DRIFT|minio: DRIFT/)
  })

  it("treats a configured image that is not on the host as drift and says how to compare", () => {
    const { status, output } = drift(world({ ...SAME, minio: null }, SAME))

    expect(status).toBe(3)
    expect(output).toMatch(/minio: DRIFT/)
    expect(output).toContain("not on this host")
  })

  it("skips services without a running container", () => {
    const { status, output } = drift(world(SAME, { ...SAME, redis: null }))

    expect(status, output).toBe(0)
    expect(output).toContain("redis: no running container")
  })

  it("fails closed when the configured reference cannot be resolved to exactly one image", () => {
    const rules = world(SAME, SAME).map((rule) =>
      rule.match === "config --images redis" ? { ...rule, stdout: "redis:a\nredis:b" } : rule
    )
    const { status, output } = drift(rules)

    expect(status).toBe(3)
    expect(output).toMatch(/redis: DRIFT/)
  })

  it("only reads: never pulls, runs, ups, recreates or removes", () => {
    const { calls } = drift(world({ ...SAME, postgres: "sha256:other" }, SAME))

    for (const call of calls) expect(call).not.toMatch(/\b(pull|up|run|create|rm|stop|restart|tag)\b/)
  })
})
