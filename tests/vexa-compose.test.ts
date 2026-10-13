import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

import { describe, expect, it } from "vitest"

type YamlType = new (tag: string, options: { kind: string; construct: (data: unknown) => unknown }) => unknown
type JsYaml = {
  load: (source: string, options?: { schema?: unknown }) => unknown
  Type: YamlType
  DEFAULT_SCHEMA: { extend: (types: unknown[]) => unknown }
}

// js-yaml is already installed (eslint depends on it); no new dependency.
const yaml = createRequire(import.meta.url)("js-yaml") as JsYaml

// Compose's merge tags (`!reset`, `!override`) parse as plain values here.
const schema = yaml.DEFAULT_SCHEMA.extend(
  ["!reset", "!override"].flatMap((tag) =>
    ["sequence", "mapping", "scalar"].map(
      (kind) => new yaml.Type(tag, { kind, construct: (data) => data ?? [] })
    )
  )
)

type Service = {
  image?: string
  profiles?: string[]
  ports?: unknown[]
  networks?: unknown
  [key: string]: unknown
}
type ComposeFile = { services: Record<string, Service>; networks?: Record<string, { external?: boolean }> }

const root = path.resolve(__dirname, "..")
const read = (file: string) => readFileSync(path.join(root, file), "utf8")
const loadCompose = (file: string) => yaml.load(read(file), { schema }) as ComposeFile

const FILES = [
  "docker-compose.vexa.yml",
  "deploy/vexa/compose.override.yml",
  "deploy/vexa/compose.socket-proxy.yml",
]
const PINNED = /^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/

function lockValues(): Record<string, string> {
  return Object.fromEntries(
    read("deploy/vexa/vexa.lock")
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=")

        return [line.slice(0, index), line.slice(index + 1)]
      })
  )
}

describe("Vexa compose files", () => {
  it.each(FILES)("%s never uses :latest", (file) => {
    const code = read(file)
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n")

    expect(code).not.toMatch(/:latest\b/)
  })

  it.each(FILES)("%s pins every image by tag and digest", (file) => {
    const images = Object.values(loadCompose(file).services)
      .map((service) => service.image)
      .filter((image): image is string => typeof image === "string")

    expect(images.length).toBeGreaterThan(0)
    for (const image of images) expect(image).toMatch(PINNED)
  })

  it.each(FILES)("%s publishes no port beyond loopback", (file) => {
    for (const [name, service] of Object.entries(loadCompose(file).services)) {
      for (const port of service.ports ?? []) {
        const spec = typeof port === "string" ? port : JSON.stringify(port)

        expect(spec, `${file}:${name}`).toMatch(/^127\.0\.0\.1:\d+:\d+$/)
      }
    }
  })

  it("puts every service it adds behind the vexa profile", () => {
    const { services, networks } = loadCompose("docker-compose.vexa.yml")
    const mergeOnly = ["app", "worker", "minio"]

    expect(Object.keys(services)).toContain("vexa-minio-init")
    for (const [name, service] of Object.entries(services)) {
      if (mergeOnly.includes(name)) {
        // Network attachment only, so the core services never become profiled.
        expect(Object.keys(service), name).toEqual(["networks"])
        expect(Object.keys(service.networks as object), name).toContain("meetsum-vexa")
        continue
      }
      expect(service.profiles, name).toContain("vexa")
      expect(service.ports, name).toBeUndefined()
    }
    expect(networks?.["meetsum-vexa"]?.external).toBe(true)
    expect((services.worker.networks as Record<string, unknown>).default).toBeDefined()
  })

  it("wires Vexa to MeetSum's MinIO and keeps transcription off", () => {
    const { services } = loadCompose("deploy/vexa/compose.override.yml")
    const env = (name: string) => (services[name].environment as string[]).join("\n")

    expect(env("meeting-api")).toContain("MINIO_ENDPOINT=meetsum-minio:9000")
    expect(env("meeting-api")).toContain("TRANSCRIBE_ENABLED=false")
    expect(env("meeting-api")).toContain("RECORDING_ENABLED=true")
    expect(env("storage-init")).toContain("MINIO_BUCKET=${VEXA_MINIO_BUCKET:-vexa-recordings}")
    for (const name of ["gateway", "meeting-api"]) {
      expect(Object.keys(services[name].networks as object), name).toContain("meetsum-vexa")
    }
    for (const service of Object.values(services)) {
      expect(service.mem_limit).toBeDefined()
      expect(service.cpus).toBeDefined()
    }
  })
})

describe("deploy/vexa/vexa.lock", () => {
  it("pins tag v0.12.28 to a 40-hex commit", () => {
    const lock = lockValues()

    expect(lock.VEXA_GIT_REF).toBe("v0.12.28")
    expect(lock.VEXA_VERSION).toBe("0.12.28")
    expect(lock.VEXA_GIT_SHA).toMatch(/^[0-9a-f]{40}$/)
    expect(lock.VEXA_REPO).toBe("https://github.com/Vexa-ai/vexa.git")
  })

  it("pins every image by digest, matching the override", () => {
    const lock = lockValues()
    const imageKeys = Object.keys(lock).filter((key) => key.endsWith("_IMAGE"))

    expect(imageKeys.length).toBeGreaterThanOrEqual(8)
    for (const key of imageKeys) expect(lock[key], key).toMatch(PINNED)

    const override = loadCompose("deploy/vexa/compose.override.yml").services

    expect(override.gateway.image).toBe(lock.GATEWAY_IMAGE)
    expect(override["meeting-api"].image).toBe(lock.MEETING_API_IMAGE)
    expect(override["admin-api"].image).toBe(lock.ADMIN_API_IMAGE)
    expect(override.runtime.image).toBe(lock.RUNTIME_IMAGE)
    expect(override.postgres.image).toBe(lock.POSTGRES_IMAGE)
    expect(override.redis.image).toBe(lock.REDIS_IMAGE)
    expect(lock.BROWSER_IMAGE).toMatch(/^vexaai\/vexa-bot:v0\.12\.28@sha256:/)
  })

  it("keeps the deployment env example free of real secrets", () => {
    const env = read("deploy/vexa/vexa.env.example")

    for (const key of ["ADMIN_TOKEN", "INTERNAL_API_SECRET", "VEXA_MINIO_SECRET_KEY", "DB_PASSWORD"]) {
      expect(env).toMatch(new RegExp(`^${key}=$`, "m"))
    }
    expect(env).toContain(`VEXA_GIT_SHA=${lockValues().VEXA_GIT_SHA}`)
  })
})
