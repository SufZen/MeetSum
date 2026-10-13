/**
 * Incremental SSE parser for fetch() streams (docs/parity/m6.md, D; owner:
 * Package D).
 *
 * STEP 0 STUB: ignores input.
 */
export function createSseParser(onEvent: (type: string, data: unknown) => void): {
  push(chunk: string): void
  end(): void
} {
  void onEvent

  return {
    push(chunk: string) {
      void chunk
    },
    end() {},
  }
}
