/**
 * M9 security review: URL state is navigation only. No shell URL parameter
 * starts capture, joins a bot, sends, deletes, exports or shares; `record=1`
 * may only open the recorder sheet and is never round-tripped; the browser
 * recorder starts only from a trusted click.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { DEFAULT_SHELL_STATE, SHELL_PARAMS, buildShellUrl, parseShellUrl } from "@/lib/client/shell-url"

const root = path.resolve(__dirname, "..")

describe("shell URL schema", () => {
  it("has no action or autostart keys", () => {
    expect([...SHELL_PARAMS].sort()).toEqual(["adminTab", "meeting", "panel", "section", "t", "tab"])
    expect(Object.keys(DEFAULT_SHELL_STATE).sort()).toEqual(["adminTab", "meeting", "panel", "section", "t", "tab"])
    for (const key of SHELL_PARAMS) expect(key).not.toMatch(/record|start|join|send|delete|export|share|auto/i)
  })

  it("parsing action-looking parameters yields plain navigation state", () => {
    const state = parseShellUrl("?panel=recorder&record=1&autostart=1&join=now&delete=m_1&export=pdf&share=1")

    expect(state).toEqual(DEFAULT_SHELL_STATE)
  })

  it("never round-trips record=1", () => {
    expect(buildShellUrl("he", { panel: "settings" }, "?record=1&q=x")).toBe("/he?panel=settings&q=x")
    expect(buildShellUrl("he", {}, "?record=1")).toBe("/he")
  })
})

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)

    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.(ts|tsx)$/.test(name) ? [full] : []
  })
}

describe("recorder start (static)", () => {
  const files = [...sourceFiles(path.join(root, "components")), ...sourceFiles(path.join(root, "app")), ...sourceFiles(path.join(root, "hooks"))]
  const calls = files.flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .map((line, index) => ({ file: path.relative(root, file).replace(/\\/g, "/"), line: index + 1, text: line.trim() }))
      .filter(({ text }) => /\b(?:browserRecorder|recorder)\.start\(/.test(text))
  )
    // The hook's own MediaRecorder.start(timeslice) runs inside start().
    .filter(({ file }) => file !== "components/bot/use-browser-recorder.ts")

  it("is only called from click handlers", () => {
    expect(calls.map(({ file, text }) => `${file}: ${text}`).sort()).toEqual([
      "components/command-center-shell.tsx: onRecordFromBrowser: (meetingId) => void browserRecorder.start({ meetingId }),",
      "components/meeting-recorder.tsx: void recorder.start({ meetingId: meetingId ?? null })",
    ])
  })

  it("the Record button ignores untrusted (scripted) clicks", () => {
    const source = readFileSync(path.join(root, "components/meeting-recorder.tsx"), "utf8")

    expect(source).toMatch(/if \(!event\.nativeEvent\.isTrusted\) return\s+void recorder\.start/)
  })

  it("the shell only opens the recorder sheet for ?record=1", () => {
    const source = readFileSync(path.join(root, "components/command-center-shell.tsx"), "utf8")
    const effect = source.slice(source.indexOf("const recordRequested"), source.indexOf("}, [recordRequested])"))

    expect(effect).toContain("setRecordSheetOpen(true)")
    expect(effect).not.toMatch(/\.start\(|getUserMedia|join|export|delete/i)
  })
})
