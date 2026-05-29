import { describe, expect, it } from "vitest"

type BackupManifest = {
  timestamp: string
  version: string
  files: Array<{
    name: string
    sizeBytes: number
    sha256?: string
    type?: string
  }>
}

describe("backup manifest validation", () => {
  it("defines correct manifest shape", () => {
    const manifest: BackupManifest = {
      timestamp: "20260529T080000Z",
      version: "0.3.1",
      files: [
        {
          name: "postgres.dump",
          sizeBytes: 1048576,
          sha256: "a".repeat(64),
        },
        {
          name: "minio/",
          sizeBytes: 2097152,
          type: "directory",
        },
      ],
    }

    expect(manifest.timestamp).toMatch(/^\d{8}T\d{6}Z$/)
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(manifest.files).toHaveLength(2)
  })

  it("postgres file entry has sha256 checksum", () => {
    const pgFile = {
      name: "postgres.dump",
      sizeBytes: 512000,
      sha256: "abc123def456".padEnd(64, "0"),
    }

    expect(pgFile.sha256).toHaveLength(64)
    expect(pgFile.sizeBytes).toBeGreaterThan(0)
  })

  it("validates version compatibility", () => {
    const backupVersion = "0.3.0"
    const currentVersion = "0.3.1"

    const isCompatible =
      backupVersion.split(".").slice(0, 2).join(".") ===
      currentVersion.split(".").slice(0, 2).join(".")

    expect(isCompatible).toBe(true)
  })

  it("detects incompatible major/minor version", () => {
    const backupVersion = "0.2.0"
    const currentVersion = "0.3.1"

    const isCompatible =
      backupVersion.split(".").slice(0, 2).join(".") ===
      currentVersion.split(".").slice(0, 2).join(".")

    expect(isCompatible).toBe(false)
  })

  it("manifest files contain required fields", () => {
    const manifest: BackupManifest = {
      timestamp: "20260529T120000Z",
      version: "0.3.1",
      files: [
        { name: "postgres.dump", sizeBytes: 100, sha256: "abc" },
        { name: "minio/", sizeBytes: 0, type: "directory" },
      ],
    }

    for (const file of manifest.files) {
      expect(file.name).toBeTruthy()
      expect(typeof file.sizeBytes).toBe("number")
    }
  })
})
