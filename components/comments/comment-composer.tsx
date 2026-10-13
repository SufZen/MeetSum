"use client"

/**
 * Comment composer with an @-mention member picker (M5 C5). Typing `@`
 * opens a listbox of workspace members filtered by what follows; picking
 * one inserts `@[name](user:<id>)`. The server keeps mentions of members
 * only. The textarea is user-entered text of unknown language: `dir="auto"`.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react"

import { collabApi, useCollabStrings } from "@/components/comments/collab-client"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { mentionMarkup } from "@/lib/comments/mentions"
import { COMMENT_MAX_LENGTH } from "@/lib/comments/types"
import { cn } from "@/lib/utils"

type Member = { userId: string; name: string }

let membersCache: Promise<Member[]> | undefined

function loadMembers(): Promise<Member[]> {
  membersCache ??= collabApi
    .listMembers()
    .then(({ members }) =>
      members.map((member) => ({
        userId: member.userId,
        name: member.name?.trim() || member.email.split("@")[0] || member.userId,
      }))
    )
    .catch(() => {
      membersCache = undefined
      return []
    })

  return membersCache
}

/** `@query` being typed right before the caret, if any. */
function activeMention(text: string, caret: number): { start: number; query: string } | undefined {
  const before = text.slice(0, caret)
  const match = /(^|\s)@([^\s@[\]()]{0,40})$/.exec(before)

  return match ? { start: caret - match[2].length - 1, query: match[2] } : undefined
}

export function CommentComposer({
  initialValue = "",
  submitLabel,
  autoFocus,
  onSubmit,
  onCancel,
  className,
}: {
  initialValue?: string
  submitLabel?: string
  autoFocus?: boolean
  /** Throw to keep the draft (the caller reports the error). */
  onSubmit: (body: string) => Promise<void>
  onCancel?: () => void
  className?: string
}) {
  const { t } = useCollabStrings()
  const listId = useId()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [value, setValue] = useState(initialValue)
  const [caret, setCaret] = useState(initialValue.length)
  const [members, setMembers] = useState<Member[]>([])
  const [highlight, setHighlight] = useState(0)
  const [busy, setBusy] = useState(false)
  const mention = activeMention(value, caret)

  useEffect(() => {
    if (mention && !members.length) void loadMembers().then(setMembers)
  }, [mention, members.length])

  const matches = useMemo(() => {
    if (!mention) return []

    const query = mention.query.toLocaleLowerCase()

    return members.filter((member) => member.name.toLocaleLowerCase().includes(query)).slice(0, 6)
  }, [members, mention])

  const pick = (member: Member) => {
    if (!mention) return

    const markup = `${mentionMarkup(member.name, member.userId)} `
    const next = value.slice(0, mention.start) + markup + value.slice(caret)
    const position = mention.start + markup.length

    setValue(next)
    setCaret(position)
    setHighlight(0)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(position, position)
    })
  }

  const submit = async () => {
    const body = value.trim()

    if (!body || busy) return
    setBusy(true)
    try {
      await onSubmit(body)
      setValue("")
      setCaret(0)
    } catch {
      // Keep the draft; the caller already reported the failure.
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && matches.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        setHighlight((current) =>
          (current + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length
        )
        return
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault()
        pick(matches[Math.min(highlight, matches.length - 1)])
        return
      }
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void submit()
    } else if (event.key === "Escape" && onCancel) {
      event.preventDefault()
      onCancel()
    }
  }

  const showList = Boolean(mention)

  return (
    <div className={cn("relative grid gap-2", className)}>
      <Textarea
        ref={textareaRef}
        dir="auto"
        value={value}
        autoFocus={autoFocus}
        maxLength={COMMENT_MAX_LENGTH}
        placeholder={t.commentsPlaceholder}
        aria-label={t.commentsAdd}
        role="combobox"
        aria-expanded={showList}
        aria-controls={showList ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={
          showList && matches[highlight] ? `${listId}-${matches[highlight].userId}` : undefined
        }
        className="min-h-16 text-sm"
        onChange={(event) => {
          setValue(event.target.value)
          setCaret(event.target.selectionStart ?? event.target.value.length)
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
        onKeyDown={onKeyDown}
      />
      {showList ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={t.commentsMentionHint}
          className="absolute inset-x-0 top-full z-(--z-popover) mt-1 max-h-48 overflow-y-auto rounded-lg border border-line bg-popover p-1 shadow-3"
        >
          {matches.length ? (
            matches.map((member, index) => (
              <li
                key={member.userId}
                id={`${listId}-${member.userId}`}
                role="option"
                aria-selected={index === highlight}
                className={cn(
                  "cursor-pointer rounded-md px-2 py-1.5 text-sm",
                  index === highlight ? "bg-surface-3" : "hover:bg-surface-2"
                )}
                onMouseDown={(event) => {
                  event.preventDefault()
                  pick(member)
                }}
              >
                <bdi>{member.name}</bdi>
              </li>
            ))
          ) : (
            <li className="px-2 py-1.5 text-sm text-fg-3">{t.commentsNoMembers}</li>
          )}
        </ul>
      ) : null}
      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t.commentsCancel}
          </Button>
        ) : null}
        <Button size="sm" variant="secondary" disabled={busy || !value.trim()} onClick={() => void submit()}>
          {submitLabel ?? t.commentsSend}
        </Button>
      </div>
    </div>
  )
}
