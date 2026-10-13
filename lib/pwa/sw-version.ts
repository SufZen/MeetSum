/**
 * Service-worker version (docs/parity/m9.md D4): `MEETSUM_BUILD_ID`, else the
 * Next build id (`.next/BUILD_ID`), else "dev". Server-only.
 */
import { readFileSync } from "node:fs"
import path from "node:path"

let cachedVersion: string | null = null

export function serviceWorkerVersion(): string {
  if (cachedVersion) return cachedVersion

  let version = process.env.MEETSUM_BUILD_ID?.trim() || ""

  if (!version) {
    try {
      version = readFileSync(path.join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim()
    } catch {
      version = ""
    }
  }
  cachedVersion = version || "dev"

  return cachedVersion
}
