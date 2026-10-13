"use client"

/**
 * The caller's private Ask threads for one scope (C6/C8 thread routes).
 * API-key principals get 403 there; the UI then simply hides the list.
 */
import { useCallback, useEffect, useState } from "react"

import type { AskScope, ThreadMessage, ThreadSummary } from "@/lib/ask/types"

export type ThreadsState = {
  status: "loading" | "ready" | "error" | "unavailable"
  threads: ThreadSummary[]
}

export function threadsQuery(scope: AskScope): string {
  const params = new URLSearchParams({ scope: scope.kind })

  if (scope.kind === "meeting") params.set("meetingId", scope.meetingId)
  if (scope.kind === "room") params.set("roomId", scope.roomId)
  params.set("limit", "50")

  return params.toString()
}

function readThreads(body: unknown): ThreadSummary[] {
  if (!body || typeof body !== "object") return []

  const record = body as { threads?: unknown; items?: unknown }
  const list = Array.isArray(record.threads) ? record.threads : Array.isArray(record.items) ? record.items : []

  return list.filter(
    (item): item is ThreadSummary => Boolean(item) && typeof (item as ThreadSummary).id === "string"
  )
}

export function useThreads(scope: AskScope, enabled = true) {
  const [state, setState] = useState<ThreadsState>({ status: "loading", threads: [] })
  const [reloadKey, setReloadKey] = useState(0)
  const query = threadsQuery(scope)

  useEffect(() => {
    if (!enabled) return

    const controller = new AbortController()

    void fetch(`/api/ask/threads?${query}`, { signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401 || response.status === 403) {
          setState({ status: "unavailable", threads: [] })
          return
        }
        if (!response.ok) throw new Error(String(response.status))

        const threads = readThreads(await response.json()).filter((thread) => !thread.archived)

        setState({ status: "ready", threads })
      })
      .catch(() => {
        if (!controller.signal.aborted) setState((current) => ({ ...current, status: "error" }))
      })

    return () => controller.abort()
  }, [enabled, query, reloadKey])

  const reload = useCallback(() => setReloadKey((key) => key + 1), [])

  const patch = useCallback(
    async (id: string, body: { title?: string; archived?: boolean }) => {
      const response = await fetch(`/api/ask/threads/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })

      if (!response.ok) return false

      setState((current) => ({
        ...current,
        threads: current.threads
          .map((thread) => (thread.id === id ? { ...thread, ...body } : thread))
          .filter((thread) => !thread.archived),
      }))

      return true
    },
    []
  )

  const remove = useCallback(async (id: string) => {
    const response = await fetch(`/api/ask/threads/${encodeURIComponent(id)}`, { method: "DELETE" })

    if (!response.ok) return false

    setState((current) => ({ ...current, threads: current.threads.filter((thread) => thread.id !== id) }))

    return true
  }, [])

  return { state, reload, rename: (id: string, title: string) => patch(id, { title }), archive: (id: string) => patch(id, { archived: true }), remove }
}

/** Loads one thread's messages (`GET /api/ask/threads/:id`). */
export async function fetchThreadMessages(id: string, signal?: AbortSignal): Promise<ThreadMessage[]> {
  const response = await fetch(`/api/ask/threads/${encodeURIComponent(id)}`, { signal })

  if (!response.ok) throw new Error(String(response.status))

  const body = (await response.json()) as { messages?: unknown; thread?: { messages?: unknown } }
  const messages = Array.isArray(body.messages)
    ? body.messages
    : Array.isArray(body.thread?.messages)
      ? body.thread.messages
      : []

  return messages as ThreadMessage[]
}
