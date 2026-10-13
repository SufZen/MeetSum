"use client"

/**
 * Streams an AskMeetSum answer from `POST /api/ask` (SSE, C8) into the
 * conversation state (`ask-stream.ts`). Stop aborts the fetch; the server
 * saves the message as `aborted`.
 */
import { useCallback, useEffect, useRef, useState } from "react"

import {
  EMPTY_ASK_SESSION,
  abortTurn,
  applyAskEvent,
  askErrorCode,
  readAskStream,
  startTurn,
  turnsFromMessages,
  type AskSession,
} from "@/components/ask/ask-stream"
import type { AskRequest, AskScope, ThreadMessage } from "@/lib/ask/types"

let turnCounter = 0

function nextTurnId() {
  turnCounter += 1

  return `turn-${Date.now().toString(36)}-${turnCounter}`
}

export type AskStreamApi = {
  session: AskSession
  streaming: boolean
  ask: (question: string) => void
  stop: () => void
  /** Starts a new conversation (the next question creates the thread). */
  reset: () => void
  /** Opens a stored thread. */
  loadThread: (threadId: string, messages: readonly ThreadMessage[]) => void
  setFeedback: (turnId: string, feedback: -1 | 1 | null) => void
}

export function useAskStream({
  scope,
  language,
  onTurnFinished,
}: {
  scope: AskScope
  language?: "he" | "en"
  /** A turn reached a final state (refresh the thread list). */
  onTurnFinished?: () => void
}): AskStreamApi {
  const [session, setSession] = useState<AskSession>(EMPTY_ASK_SESSION)
  const [streaming, setStreaming] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const sessionRef = useRef(session)
  const finished = useRef(onTurnFinished)

  useEffect(() => {
    sessionRef.current = session
  }, [session])
  useEffect(() => {
    finished.current = onTurnFinished
  }, [onTurnFinished])
  useEffect(() => () => controller.current?.abort(), [])

  const ask = useCallback(
    (rawQuestion: string) => {
      const question = rawQuestion.trim().slice(0, 2000)

      if (!question || controller.current) return

      const turnId = nextTurnId()
      const abort = new AbortController()
      const threadId = sessionRef.current.threadId
      const body: AskRequest = {
        question,
        scope,
        ...(threadId ? { threadId } : {}),
        ...(language ? { language } : {}),
      }

      controller.current = abort
      setStreaming(true)
      setSession((current) => startTurn(current, turnId, question))

      void (async () => {
        try {
          const response = await fetch("/api/ask", {
            method: "POST",
            headers: { "content-type": "application/json", accept: "text/event-stream" },
            body: JSON.stringify(body),
            signal: abort.signal,
          })

          if (!response.ok || !response.body) {
            const payload = await response.json().catch(() => undefined)

            setSession((current) =>
              applyAskEvent(current, turnId, {
                type: "error",
                code: askErrorCode(response.status, payload),
                message: "",
              })
            )
            return
          }

          const terminal = await readAskStream(response.body, (event) => {
            setSession((current) => applyAskEvent(current, turnId, event))
          })

          if (!terminal) setSession((current) => abortTurn(current, turnId))
        } catch {
          setSession((current) =>
            abort.signal.aborted
              ? abortTurn(current, turnId)
              : applyAskEvent(current, turnId, { type: "error", code: "internal", message: "" })
          )
        } finally {
          if (controller.current === abort) controller.current = null
          setStreaming(false)
          finished.current?.()
        }
      })()
    },
    [language, scope]
  )

  const stop = useCallback(() => {
    controller.current?.abort()
  }, [])

  const reset = useCallback(() => {
    controller.current?.abort()
    controller.current = null
    setSession(EMPTY_ASK_SESSION)
  }, [])

  const loadThread = useCallback((threadId: string, messages: readonly ThreadMessage[]) => {
    controller.current?.abort()
    controller.current = null
    setSession({ threadId, turns: turnsFromMessages(messages) })
  }, [])

  const setFeedback = useCallback((turnId: string, feedback: -1 | 1 | null) => {
    const turn = sessionRef.current.turns.find((item) => item.id === turnId)
    const messageId = turn?.messageId

    if (!messageId) return

    setSession((current) => ({
      ...current,
      turns: current.turns.map((item) => (item.id === turnId ? { ...item, feedback } : item)),
    }))
    void fetch(`/api/ask/messages/${encodeURIComponent(messageId)}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // C8 names the field `rating`; the Step 0 stub doc says `feedback`.
      body: JSON.stringify({ rating: feedback, feedback }),
    }).catch(() => undefined)
  }, [])

  return { session, streaming, ask, stop, reset, loadThread, setFeedback }
}
