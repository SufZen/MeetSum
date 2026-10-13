"use client"

/**
 * AskMeetSum panel (docs/parity/m6.md, D2): meeting, room or workspace
 * scope. Loaded with next/dynamic (`components/ask/lazy.tsx`).
 *
 * The active scope is always visible. Parts: private conversations for the
 * scope, the message list, a composer (Enter sends, Shift+Enter is a new
 * line, Stop aborts) and suggested questions. Answers stream over SSE and
 * only cited text is shown as an answer.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react"
import { HistoryIcon, PlusIcon, SendIcon, SquareIcon } from "lucide-react"

import { AskTurnView } from "@/components/ask/ask-turn"
import { ThreadList } from "@/components/ask/thread-list"
import { useAskStream } from "@/components/ask/use-ask-stream"
import { fetchThreadMessages, useThreads } from "@/components/ask/use-threads"
import { Button } from "@/components/ui/button"
import { CitedMark } from "@/components/ui/meeting-atoms"
import { Textarea } from "@/components/ui/textarea"
import type { AskScope, ThreadSummary } from "@/lib/ask/types"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import { cn } from "@/lib/utils"

export type AskPanelProps = {
  locale: string
  dictionary: Dictionary
  scope: AskScope
  /** Visible scope name ("This meeting", "Room · Finance", "All meetings"). */
  scopeLabel: string
  /** Optional scope switch (global Ask): rendered next to the scope label. */
  scopeControl?: ReactNode
  /** Pre-fills the composer (palette "Ask about…"). */
  initialQuestion?: string
  className?: string
}

const SUGGESTION_KEYS = {
  meeting: ["askSuggestMeeting1", "askSuggestMeeting2", "askSuggestMeeting3"],
  room: ["askSuggestWorkspace1", "askSuggestWorkspace2", "askSuggestWorkspace3"],
  workspace: ["askSuggestWorkspace1", "askSuggestWorkspace2", "askSuggestWorkspace3"],
} as const

const PLACEHOLDER_KEYS = {
  meeting: "askPlaceholderMeeting",
  room: "askPlaceholderRoom",
  workspace: "askPlaceholderWorkspace",
} as const

function scopeKey(scope: AskScope): string {
  return scope.kind === "meeting" ? `m:${scope.meetingId}` : scope.kind === "room" ? `r:${scope.roomId}` : "w"
}

export function AskPanel(props: AskPanelProps) {
  // A new scope is a new conversation: remount everything below.
  return <AskPanelInner key={scopeKey(props.scope)} {...props} />
}

function AskPanelInner({
  locale,
  dictionary: t,
  scope,
  scopeLabel,
  scopeControl,
  initialQuestion = "",
  className,
}: AskPanelProps) {
  const [question, setQuestion] = useState(initialQuestion)
  const [showThreads, setShowThreads] = useState(false)
  const [threadError, setThreadError] = useState(false)
  const [loadingThread, setLoadingThread] = useState(false)
  const composer = useRef<HTMLTextAreaElement>(null)
  const hintId = useId()
  const listEnd = useRef<HTMLDivElement>(null)
  const threads = useThreads(scope)
  const reloadThreads = threads.reload
  const stream = useAskStream({ scope, onTurnFinished: reloadThreads })
  const { session, streaming } = stream
  const currentMeetingId = scope.kind === "meeting" ? scope.meetingId : undefined
  const lexical = session.turns.some((turn) => turn.searchMode === "lexical")
  const suggestions = useMemo(() => SUGGESTION_KEYS[scope.kind].map((key) => t[key]), [scope.kind, t])
  const lastTurn = session.turns[session.turns.length - 1]

  useEffect(() => {
    listEnd.current?.scrollIntoView({ block: "nearest" })
  }, [session.turns.length, lastTurn?.status])

  useEffect(() => {
    if (initialQuestion) composer.current?.focus()
  }, [initialQuestion])

  const submit = useCallback(
    (value: string) => {
      const text = value.trim()

      if (!text || streaming) return
      stream.ask(text)
      setQuestion("")
    },
    [stream, streaming]
  )

  const openThread = useCallback(
    (thread: ThreadSummary) => {
      setThreadError(false)
      setLoadingThread(true)
      void fetchThreadMessages(thread.id)
        .then((messages) => {
          stream.loadThread(thread.id, messages)
          setShowThreads(false)
        })
        .catch(() => setThreadError(true))
        .finally(() => setLoadingThread(false))
    },
    [stream]
  )

  const newConversation = () => {
    stream.reset()
    setQuestion("")
    composer.current?.focus()
  }

  const threadsAvailable = threads.state.status !== "unavailable"

  return (
    <section
      aria-label={t.askTitle}
      className={cn("grid min-h-0 gap-3 rounded-lg bg-surface p-4 ring-1 ring-line", className)}
    >
      <header className="flex flex-wrap items-center gap-2">
        <CitedMark aria-hidden="true" className="size-4 text-ai-text" />
        <h2 className="text-sm font-semibold text-fg">{t.askTitle}</h2>
        <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-fg-2">
          <span className="text-fg-3">{t.askScope}:</span>
          <bdi data-ask-scope={scope.kind} className="font-medium text-fg">
            {scopeLabel}
          </bdi>
        </span>
        {scopeControl}
        <div className="ms-auto flex items-center gap-1">
          {threadsAvailable ? (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={showThreads}
              onClick={() => setShowThreads((open) => !open)}
            >
              <HistoryIcon data-icon="inline-start" />
              {showThreads ? t.askThreadsHide : t.askThreads}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={newConversation} disabled={!session.turns.length && !session.threadId}>
            <PlusIcon data-icon="inline-start" />
            {t.askNewThread}
          </Button>
        </div>
      </header>

      {showThreads && threadsAvailable ? (
        <div className="rounded-md bg-surface-2 p-2">
          <ThreadList
            state={threads.state}
            activeThreadId={session.threadId}
            dictionary={t}
            onOpen={openThread}
            onRename={threads.rename}
            onArchive={async (id) => {
              const ok = await threads.archive(id)

              if (ok && id === session.threadId) stream.reset()
              return ok
            }}
            onDelete={async (id) => {
              const ok = await threads.remove(id)

              if (ok && id === session.threadId) stream.reset()
              return ok
            }}
          />
        </div>
      ) : null}

      {loadingThread ? (
        <p aria-busy="true" className="text-sm text-fg-3">
          {t.askThreadLoading}
        </p>
      ) : null}
      {threadError ? <p className="text-sm text-danger-text">{t.askThreadLoadError}</p> : null}

      {lexical ? (
        <p data-ask-lexical="" className="rounded-md bg-info-soft px-3 py-1.5 text-xs text-info-text">
          {t.askLexicalNote}
        </p>
      ) : null}

      {session.turns.length ? (
        <ol aria-live="polite" className="grid gap-4">
          {session.turns.map((turn) => (
            <AskTurnView
              key={turn.id}
              turn={turn}
              locale={locale}
              currentMeetingId={currentMeetingId}
              dictionary={t}
              onFeedback={(feedback) => stream.setFeedback(turn.id, feedback)}
            />
          ))}
        </ol>
      ) : (
        <div className="grid gap-2">
          <p className="text-xs text-fg-3">{t.askSuggestions}</p>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((suggestion) => (
              <Button key={suggestion} size="sm" variant="secondary" onClick={() => submit(suggestion)}>
                {suggestion}
              </Button>
            ))}
          </div>
        </div>
      )}
      <div ref={listEnd} />

      <form
        className="grid gap-1.5"
        onSubmit={(event) => {
          event.preventDefault()
          submit(question)
        }}
      >
        <div className="flex items-end gap-2">
          <Textarea
            ref={composer}
            dir="auto"
            rows={2}
            maxLength={2000}
            value={question}
            aria-label={t.askInputLabel}
            aria-describedby={hintId}
            placeholder={t[PLACEHOLDER_KEYS[scope.kind]]}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                submit(question)
              }
            }}
            className="min-h-16 flex-1 resize-none"
          />
          {streaming ? (
            <Button type="button" variant="secondary" className="h-10" onClick={stream.stop}>
              <SquareIcon data-icon="inline-start" className="fill-current" />
              {t.askStop}
            </Button>
          ) : (
            <Button type="submit" variant="ai" className="h-10" disabled={!question.trim()}>
              <SendIcon data-icon="inline-start" data-directional="" className="rtl:-scale-x-100" />
              {t.askSend}
            </Button>
          )}
        </div>
        <p id={hintId} className="text-2xs text-fg-3">
          {t.askInputHint}
        </p>
      </form>
    </section>
  )
}
