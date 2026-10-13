"use client"

import { useCallback, useEffect, useState } from "react"

/** Error from a JSON API call; `code` is the body's `error` field. */
export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly body?: unknown

  constructor(status: number, code: string | undefined, body: unknown) {
    super(code ?? `HTTP ${status}`)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.body = body
  }
}

export async function requestJson<T>(url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? undefined : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
  })
  const body = (await response.json().catch(() => undefined)) as unknown

  if (!response.ok) {
    const code = (body as { error?: unknown } | undefined)?.error

    throw new ApiError(response.status, typeof code === "string" ? code : undefined, body)
  }

  return body as T
}

type JsonState<T> = { key: string; data?: T; error?: Error }

/**
 * GETs `url` (null = idle) and refetches when `url`, `refreshKey` or
 * `reload()` change. The last data stays visible while a refetch runs.
 */
export function useJson<T>(url: string | null, refreshKey?: unknown) {
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState<JsonState<T> | undefined>(undefined)
  const key = `${url ?? ""}|${String(refreshKey ?? "")}|${nonce}`

  useEffect(() => {
    if (!url) return

    let cancelled = false

    requestJson<T>(url).then(
      (data) => {
        if (!cancelled) setState({ key, data })
      },
      (error: unknown) => {
        if (!cancelled) {
          setState((previous) => ({
            key,
            data: previous?.data,
            error: error instanceof Error ? error : new Error(String(error)),
          }))
        }
      }
    )

    return () => {
      cancelled = true
    }
  }, [key, url])

  const setData = useCallback(
    (update: T | undefined | ((previous: T | undefined) => T | undefined)) =>
      setState((previous) => ({
        key: previous?.key ?? key,
        data:
          typeof update === "function"
            ? (update as (previous: T | undefined) => T | undefined)(previous?.data)
            : update,
      })),
    [key]
  )
  const reload = useCallback(async () => setNonce((value) => value + 1), [])

  return {
    data: state?.data,
    setData,
    error: state?.key === key ? state.error : undefined,
    loading: Boolean(url) && state?.key !== key,
    reload,
  }
}
