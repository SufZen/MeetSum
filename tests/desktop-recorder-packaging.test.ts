import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

describe("desktop recorder Windows packaging", () => {
  it("exposes scripts for building a Windows installer and portable app", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>
    }

    expect(pkg.scripts["desktop:dist:win"]).toContain("electron-builder")
    expect(pkg.scripts["desktop:dist:win"]).toContain("--win")
  })

  it("configures NSIS and portable Windows artifacts for MeetSum Capture", async () => {
    const config = await readFile("electron-builder.yml", "utf8")

    expect(config).toContain("productName: MeetSum Capture")
    expect(config).toContain("app: desktop-recorder")
    expect(config).toContain("target: nsis")
    expect(config).toContain("target: portable")
    expect(config).toContain("createDesktopShortcut: always")
    expect(config).toContain("!node_modules/**")
  })

  it("publishes Windows installer artifacts from GitHub Actions", async () => {
    const workflow = await readFile(
      ".github/workflows/desktop-windows.yml",
      "utf8"
    )

    expect(workflow).toContain("npm run desktop:dist:win")
    expect(workflow).toContain("desktop-recorder/release/*.exe")
  })

  it("wires Windows code-signing secrets and verification into the installer workflow", async () => {
    const workflow = await readFile(
      ".github/workflows/desktop-windows.yml",
      "utf8"
    )

    expect(workflow).toContain("WIN_CSC_LINK: ${{ secrets.WIN_CSC_LINK }}")
    expect(workflow).toContain(
      "WIN_CSC_KEY_PASSWORD: ${{ secrets.WIN_CSC_KEY_PASSWORD }}"
    )
    expect(workflow).toContain("scripts/verify-windows-signature.ps1")
  })

  it("documents the certificate secrets needed for signed Windows installers", async () => {
    const docs = await readFile("docs/desktop-recorder.md", "utf8")

    expect(docs).toContain("WIN_CSC_LINK")
    expect(docs).toContain("WIN_CSC_KEY_PASSWORD")
    expect(docs).toContain("Get-AuthenticodeSignature")
  })
})
