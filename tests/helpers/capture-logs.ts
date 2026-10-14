/**
 * Captures the server logger's JSON lines (lib/log) for assertions.
 *
 *   const logs = captureLogs()
 *   ...code under test...
 *   expect(logs.find((line) => line.msg.includes("failed"))).toBeDefined()
 *   logs.restore()   // or call restoreLogs() in afterEach
 */
import { setLogSinkForTesting } from "@/lib/log/sink"

export type LogLine = {
  level: string
  msg: string
  service?: string
  version?: string
  component?: string
  err?: { type?: string; message?: string; stack?: string }
  [key: string]: unknown
}

export type CapturedLogs = LogLine[] & {
  /** Raw text of every captured line (for "never contains" checks). */
  text(): string
  /** Lines whose level matches (e.g. "error"). */
  at(level: string): LogLine[]
  /** `msg` of every line, optionally filtered by level. */
  messages(level?: string): string[]
  restore(): void
}

export function captureLogs(): CapturedLogs {
  const raw: string[] = []
  const lines = [] as unknown as CapturedLogs

  setLogSinkForTesting((line) => {
    raw.push(line)
    for (const part of line.split("\n")) {
      if (!part.trim()) continue
      lines.push(JSON.parse(part) as LogLine)
    }
  })

  Object.defineProperties(lines, {
    text: { value: () => raw.join("") },
    at: { value: (level: string) => lines.filter((line) => line.level === level) },
    messages: { value: (level?: string) => lines.filter((line) => !level || line.level === level).map((line) => line.msg) },
    restore: { value: () => setLogSinkForTesting(undefined) },
  })

  return lines
}

export function restoreLogs() {
  setLogSinkForTesting(undefined)
}
