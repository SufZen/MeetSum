/**
 * A fake `docker` CLI for shell-script tests: a POSIX sh script placed first
 * on PATH that appends every invocation to a log file and answers from a
 * small table of canned responses (`FAKE_DOCKER_RULES`, one rule per line:
 * `<substring of the argument line>\t<exit code>\t<stdout>`; `\n` in stdout is
 * a newline). Unmatched calls print nothing and exit 0.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

export type FakeDockerRule = { match: string; exit?: number; stdout?: string }

const SCRIPT = `#!/bin/sh
line="$*"
printf '%s\\n' "$line" >> "$FAKE_DOCKER_LOG"
if [ -n "\${FAKE_DOCKER_RULES:-}" ] && [ -f "$FAKE_DOCKER_RULES" ]; then
  while IFS='	' read -r match code out; do
    [ -n "$match" ] || continue
    case "$line" in
      *"$match"*)
        if [ -n "$out" ]; then printf '%b\\n' "$out"; fi
        exit "$code"
        ;;
    esac
  done < "$FAKE_DOCKER_RULES"
fi
exit 0
`

export function createFakeDocker(rules: FakeDockerRule[] = []) {
  const dir = mkdtempSync(path.join(tmpdir(), "meetsum-fake-docker-"))
  const bin = path.join(dir, "bin")
  const log = path.join(dir, "docker.log")
  const rulesFile = path.join(dir, "rules.tsv")

  mkdirSync(bin)
  writeFileSync(path.join(bin, "docker"), SCRIPT, { mode: 0o755 })
  chmodSync(path.join(bin, "docker"), 0o755)
  writeFileSync(log, "")
  writeFileSync(rulesFile, rules.map((rule) => `${rule.match}\t${rule.exit ?? 0}\t${(rule.stdout ?? "").replace(/\n/g, "\\n")}`).join("\n") + "\n")

  return {
    dir,
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      FAKE_DOCKER_LOG: log,
      FAKE_DOCKER_RULES: rulesFile,
    },
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
  }
}
