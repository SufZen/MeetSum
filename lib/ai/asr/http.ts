import {
  fetch as undiciFetch,
  Agent as UndiciAgent,
  FormData as UndiciFormData,
} from "undici"

import { toAsrError } from "./errors"
import { AsrError } from "./types"

// Long-running ASR requests can hold a connection open for many minutes while
// the model transcribes, sending zero bytes until the final JSON. Two things
// break that otherwise:
//   1. Node's built-in fetch (undici) defaults headersTimeout/bodyTimeout to
//      300s, aborting real transcriptions with a generic "fetch failed" long
//      before our own AbortController fires. Both are disabled here; the
//      caller's AbortController remains the real cap.
//   2. A silent, idle TCP connection is reset by stateful firewalls/NAT after
//      ~5 minutes (observed: ECONNRESET at ~300s). TCP keepalive probes keep
//      the socket non-idle so the connection survives a long transcription.
export const longAsrDispatcher = new UndiciAgent({
  headersTimeout: 0,
  bodyTimeout: 0,
  connect: { keepAlive: true, keepAliveInitialDelay: 30_000 },
})

export type FetchFn = typeof fetch

/** Abortable sleep. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
      return
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"))
    }

    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export type MultipartField = string | { blob: Blob; filename: string }

/**
 * POSTs multipart form data. With an injected fetch (tests) the global
 * FormData is used; on the real path undici's own FormData + fetch with the
 * long-ASR dispatcher (a global FormData is not recognized by the installed
 * undici and serializes to an empty body — HTTP 422).
 */
export async function postMultipart(
  url: string,
  fields: Array<[string, MultipartField]>,
  options: { fetch?: FetchFn; headers?: Record<string, string>; signal?: AbortSignal }
): Promise<Response> {
  if (options.fetch) {
    const form = new FormData()

    for (const [name, value] of fields) {
      if (typeof value === "string") form.append(name, value)
      else form.append(name, value.blob, value.filename)
    }

    return options.fetch(url, { method: "POST", body: form, headers: options.headers, signal: options.signal })
  }

  const form = new UndiciFormData()

  for (const [name, value] of fields) {
    if (typeof value === "string") form.append(name, value)
    else form.append(name, value.blob, value.filename)
  }

  return (await undiciFetch(url, {
    method: "POST",
    body: form,
    headers: options.headers,
    signal: options.signal,
    dispatcher: longAsrDispatcher,
  })) as unknown as Response
}

/** Runs a fetch, converting network failures into AsrErrors. */
export async function guardedFetch(
  fetchFn: FetchFn,
  provider: string,
  url: string,
  init?: RequestInit
): Promise<Response> {
  try {
    return await fetchFn(url, init)
  } catch (error) {
    if (error instanceof AsrError) throw error
    throw toAsrError(error, provider)
  }
}

/** Parses a JSON body, mapping malformed responses to a retryable server error. */
export async function readJson<T>(response: Response, provider: string, context: string): Promise<T> {
  const text = await response.text()

  try {
    return (text ? JSON.parse(text) : {}) as T
  } catch {
    throw new AsrError(`${context} returned invalid JSON`, "server", provider, true, response.status)
  }
}

/** A signal that aborts on the parent signal or after `timeoutMs`. */
export function timeoutSignal(timeoutMs: number, parent?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new DOMException(`Timed out after ${timeoutMs}ms`, "TimeoutError")),
    timeoutMs
  )
  const onAbort = () => controller.abort(parent?.reason)

  if (parent?.aborted) controller.abort(parent.reason)
  else parent?.addEventListener("abort", onAbort, { once: true })

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      parent?.removeEventListener("abort", onAbort)
    },
  }
}
