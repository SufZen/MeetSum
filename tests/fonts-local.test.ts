import { readdirSync, readFileSync, statSync, existsSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const root = path.resolve(__dirname, "..")
const SKIP = new Set(["node_modules", ".next", ".git", "dist", "test-results", "playwright-report", ".claude"])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const full = path.join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (/\.(tsx?|mjs|cjs|jsx?)$/.test(name)) out.push(full)
  }
  return out
}

describe("self-hosted fonts (M9 B6)", () => {
  it("no source file imports next/font/google", () => {
    const offenders = ["app", "components", "lib", "hooks"]
      .map((d) => path.join(root, d))
      .filter((d) => existsSync(d))
      .flatMap((d) => walk(d))
      .filter((file) => /from\s+["']next\/font\/google["']/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(root, file))
    expect(offenders).toEqual([])
  })

  it("lib/fonts.ts uses next/font/local over vendored woff2 files that exist", () => {
    const source = readFileSync(path.join(root, "lib/fonts.ts"), "utf8")
    expect(source).toContain('from "next/font/local"')
    const paths = [...source.matchAll(/path:\s*"([^"]+)"/g)].map((m) => m[1])
    expect(paths).toHaveLength(10)
    for (const p of paths) {
      expect(p.endsWith(".woff2")).toBe(true)
      expect(existsSync(path.resolve(root, "lib", p))).toBe(true)
    }
    for (const variable of ["--font-plex-sans", "--font-plex-hebrew", "--font-plex-mono"]) {
      expect(source).toContain(`variable: "${variable}"`)
    }
  })

  it("vendors the TTFs for the PDF renderer with the OFL license and provenance", () => {
    const dir = path.join(root, "assets/fonts")
    expect(readFileSync(path.join(dir, "OFL.txt"), "utf8")).toContain("SIL Open Font License, Version 1.1")
    const readme = readFileSync(path.join(dir, "README.md"), "utf8")
    expect(readme).toContain("github.com/IBM/plex/releases")
    expect(readme).toContain("1.1.0")
    const ttf = readdirSync(path.join(dir, "ttf")).sort()
    expect(ttf).toEqual([
      "IBMPlexMono-Medium.ttf",
      "IBMPlexMono-Regular.ttf",
      "IBMPlexSans-Bold.ttf",
      "IBMPlexSans-Medium.ttf",
      "IBMPlexSans-Regular.ttf",
      "IBMPlexSans-SemiBold.ttf",
      "IBMPlexSansHebrew-Bold.ttf",
      "IBMPlexSansHebrew-Medium.ttf",
      "IBMPlexSansHebrew-Regular.ttf",
      "IBMPlexSansHebrew-SemiBold.ttf",
    ])
  })

  it("keeps pdfkit external and ships the fonts in the runtime image", () => {
    expect(readFileSync(path.join(root, "next.config.mjs"), "utf8")).toMatch(/serverExternalPackages:\s*\[[^\]]*"pdfkit"[^\]]*\]/)
    expect(readFileSync(path.join(root, "Dockerfile"), "utf8")).toContain("COPY --from=builder /app/assets ./assets")
  })
})
