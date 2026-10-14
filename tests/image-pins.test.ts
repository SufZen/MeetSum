/**
 * M10 B5 + security check 8: every third-party image in every compose file
 * and every Dockerfile FROM is pinned by tag AND digest, and nothing uses
 * `latest`. The only unpinned references allowed are images compose builds
 * from this repository: MeetSum's own app image (`meetsum:<tag>`) and
 * `meetsum-<name>:<tag>` services with a `build` context whose Dockerfile
 * FROM lines are themselves pinned (M10: MinIO from the official source,
 * deploy/minio/Dockerfile).
 */
import { readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

import { describe, expect, it } from "vitest"

type JsYaml = {
  load: (source: string, options?: { schema?: unknown }) => unknown
  Type: new (tag: string, options: { kind: string; construct: (data: unknown) => unknown }) => unknown
  DEFAULT_SCHEMA: { extend: (types: unknown[]) => unknown }
}

// js-yaml is already installed (eslint depends on it); no new dependency.
const yaml = createRequire(import.meta.url)("js-yaml") as JsYaml
// Compose's merge tags (`!reset`, `!override`) parse as plain values here.
const schema = yaml.DEFAULT_SCHEMA.extend(
  ["!reset", "!override"].flatMap((tag) =>
    ["sequence", "mapping", "scalar"].map((kind) => new yaml.Type(tag, { kind, construct: (data) => data ?? [] }))
  )
)
const parse = (source: string) => yaml.load(source, { schema })

const root = path.resolve(__dirname, "..")
const PINNED = /^[a-z0-9][\w./-]*:[\w.-]+@sha256:[0-9a-f]{64}$/
const LOCAL_IMAGE = /^meetsum:\$\{MEETSUM_IMAGE_TAG:-[\w.-]+\}$/
const LOCAL_BUILT_IMAGE = /^meetsum-[a-z0-9-]+:[\w.-]+$/

const composeFiles = [
  ...readdirSync(root).filter((name) => /^docker-compose.*\.ya?ml$/.test(name)),
  ...readdirSync(path.join(root, "deploy/vexa"))
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => `deploy/vexa/${name}`),
]

type Service = { image?: string; build?: string | { context?: string; dockerfile?: string } }

/** The Dockerfile a service builds from (relative to the repo root). */
function dockerfileOf(service: Service): string | undefined {
  if (!service.build) return undefined
  const context = typeof service.build === "string" ? service.build : (service.build.context ?? ".")
  const dockerfile = typeof service.build === "string" ? "Dockerfile" : (service.build.dockerfile ?? "Dockerfile")

  return path.normalize(path.join(context, dockerfile))
}

function fromImages(dockerfile: string): string[] {
  return readFileSync(path.join(root, dockerfile), "utf8")
    .split(/\r?\n/)
    .filter((line) => /^FROM\s/i.test(line))
    .map((line) => line.trim().split(/\s+/)[1])
}

function services(file: string): Array<[string, Service]> {
  const doc = parse(readFileSync(path.join(root, file), "utf8")) as { services?: Record<string, Service> }

  return Object.entries(doc.services ?? {})
}

describe("image pins", () => {
  it("finds the compose files", () => {
    expect(composeFiles).toEqual(expect.arrayContaining(["docker-compose.yml", "docker-compose.prod.yml", "docker-compose.migrate.yml", "docker-compose.vexa.yml"]))
  })

  it.each(composeFiles)("%s: every image is tag + digest (or MeetSum's local image)", (file) => {
    const code = readFileSync(path.join(root, file), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n")

    expect(code).not.toMatch(/:latest\b/)

    for (const [name, service] of services(file)) {
      if (!service.image) continue
      if (LOCAL_IMAGE.test(service.image)) continue
      if (LOCAL_BUILT_IMAGE.test(service.image)) {
        // Allowed only with a build whose base images are pinned.
        const dockerfile = dockerfileOf(service)

        expect(dockerfile, `${file}:${name} has no build`).toBeDefined()
        for (const image of fromImages(dockerfile!)) expect(image, `${file}:${name} FROM`).toMatch(PINNED)
        continue
      }
      expect(service.image, `${file}:${name}`).toMatch(PINNED)
    }
  })

  it("app, worker and migrate share one image and only app builds it", () => {
    const prod = Object.fromEntries(services("docker-compose.prod.yml"))
    const migrate = Object.fromEntries(services("docker-compose.migrate.yml"))

    expect(prod.app.image).toMatch(LOCAL_IMAGE)
    expect(prod.worker.image).toBe(prod.app.image)
    expect(migrate.migrate.image).toBe(prod.app.image)
    expect(prod.app.build).toBeDefined()
    expect(prod.worker.build).toBeUndefined()
    expect(migrate.migrate.build).toBeUndefined()

    const dev = Object.fromEntries(services("docker-compose.yml"))

    expect(dev.worker.image).toBe(dev.app.image)
    expect(dev.migrate.image).toBe(dev.app.image)
    expect(dev.worker.build).toBeUndefined()
  })

  it.each(["Dockerfile", "deploy/minio/Dockerfile"])("%s: every FROM is tag + digest", (dockerfile) => {
    const froms = fromImages(dockerfile)

    expect(froms.length).toBeGreaterThan(0)
    for (const image of froms) expect(image).toMatch(PINNED)
  })

  it("MinIO is built from the official source at a pinned release tag and commit", () => {
    const dockerfile = readFileSync(path.join(root, "deploy/minio/Dockerfile"), "utf8")
    const arg = (name: string) => dockerfile.match(new RegExp(`^ARG ${name}=(\\S+)\\r?$`, "m"))?.[1]
    const release = arg("MINIO_RELEASE")

    expect(release).toMatch(/^RELEASE\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/)
    expect(arg("MC_RELEASE")).toMatch(/^RELEASE\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/)
    expect(arg("MINIO_COMMIT")).toMatch(/^[0-9a-f]{40}$/)
    expect(arg("MC_COMMIT")).toMatch(/^[0-9a-f]{40}$/)
    expect(dockerfile).toContain("https://github.com/minio/minio.git")
    expect(dockerfile).toContain("https://github.com/minio/mc.git")
    expect(dockerfile).toContain('test "$(git rev-parse HEAD)" = "${MINIO_COMMIT}"')
    expect(dockerfile).toContain('test "$(git rev-parse HEAD)" = "${MC_COMMIT}"')
    // Source builds only: no prebuilt binaries and no third-party MinIO image.
    expect(dockerfile).not.toMatch(/dl\.min\.io|coollabsio|minio\/minio:/)

    for (const file of ["docker-compose.yml", "docker-compose.prod.yml"]) {
      const minio = Object.fromEntries(services(file)).minio

      expect(minio.image, file).toBe(`meetsum-minio:${release}`)
      expect(dockerfileOf(minio), file).toBe(path.normalize("deploy/minio/Dockerfile"))
    }
  })

  it("never publishes the worker health port and keeps the dev initdb mount out", () => {
    for (const file of ["docker-compose.yml", "docker-compose.prod.yml"]) {
      const worker = Object.fromEntries(services(file)).worker as Service & { ports?: unknown; healthcheck?: { test?: string[] } }

      expect(worker.ports, file).toBeUndefined()
      expect(worker.healthcheck?.test?.join(" "), file).toContain("/ready")
    }

    expect(readFileSync(path.join(root, "docker-compose.yml"), "utf8")).not.toContain("docker-entrypoint-initdb.d:")
  })
})
