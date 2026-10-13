/**
 * Where the logger writes (B1). Production and dev: one JSON line per write
 * on stdout. Under vitest the default sink discards lines so the test output
 * stays readable; tests that assert on log lines install a capture sink with
 * `setLogSinkForTesting` (see tests/helpers/capture-logs.ts).
 *
 * The current sink lives on `globalThis`, so a module registry reset in a
 * test (`vi.resetModules()`) still writes to the installed sink.
 */
type SinkFn = (line: string) => void

const SINK_KEY = Symbol.for("meetsum.log.sink")

const stdoutSink: SinkFn = (line) => {
  process.stdout.write(line)
}

const discardSink: SinkFn = () => undefined

function defaultSink(): SinkFn {
  return process.env.VITEST ? discardSink : stdoutSink
}

type SinkHolder = { [SINK_KEY]?: SinkFn }

function currentSink(): SinkFn {
  return (globalThis as SinkHolder)[SINK_KEY] ?? defaultSink()
}

/** The pino destination: a plain object with `write`, so no worker threads. */
export const logDestination = {
  write(line: string) {
    currentSink()(line)
  },
}

/** Tests: route every log line to `sink`; `undefined` restores the default. */
export function setLogSinkForTesting(sink: SinkFn | undefined) {
  ;(globalThis as SinkHolder)[SINK_KEY] = sink
}
