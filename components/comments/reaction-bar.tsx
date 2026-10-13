"use client"

/**
 * Reactions on one target (M5 C4): existing emoji with counts (pressed =
 * mine) plus an "add" popover limited to the allowlist. Counts come from
 * the shared comments snapshot unless `reactions` is passed.
 */
import { useState } from "react"
import { SmilePlusIcon } from "lucide-react"
import { toast } from "sonner"

import {
  collabApi,
  formatMessage,
  reactionsFor,
  refreshComments,
  useCollabStrings,
  useMeetingComments,
} from "@/components/comments/collab-client"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  REACTION_EMOJIS,
  type ReactionEmoji,
  type ReactionSummary,
  type ReactionTargetType,
} from "@/lib/comments/types"
import { cn } from "@/lib/utils"

export type ReactionBarProps = {
  meetingId: string
  targetType: ReactionTargetType
  targetId: string
  reactions?: ReactionSummary[]
  className?: string
}

export function ReactionBar({ meetingId, targetType, targetId, reactions, className }: ReactionBarProps) {
  const { t } = useCollabStrings()
  const state = useMeetingComments(meetingId)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<ReactionEmoji | null>(null)
  const list = reactions ?? reactionsFor(state.snapshot, targetType, targetId)

  // API keys / signed-out viewers cannot react: hide the control entirely.
  if (state.status === "error" && state.error?.code === "user_required") return null

  const toggle = async (emoji: ReactionEmoji) => {
    setOpen(false)
    setPending(emoji)
    try {
      await collabApi.toggleReaction({ meetingId, targetType, targetId, emoji })
      await refreshComments(meetingId)
    } catch {
      toast.error(t.commentsFailed)
    } finally {
      setPending(null)
    }
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {list
        .filter((reaction) => reaction.count > 0)
        .map((reaction) => (
          <button
            key={reaction.emoji}
            type="button"
            aria-pressed={reaction.mine}
            aria-label={formatMessage(t.reactionsCount, { count: reaction.count, emoji: reaction.emoji })}
            disabled={pending === reaction.emoji}
            onClick={() => void toggle(reaction.emoji)}
            className={cn(
              "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs transition-colors duration-(--dur-1) ease-standard focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent",
              reaction.mine
                ? "border-brand bg-brand-soft-2 text-brand-text"
                : "border-line bg-surface-2 text-fg-2 hover:bg-surface-3"
            )}
          >
            <span aria-hidden>{reaction.emoji}</span>
            <span className="font-mono tabular-nums [direction:ltr] [unicode-bidi:isolate]">
              {reaction.count}
            </span>
          </button>
        ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t.reactionsAdd}
              title={t.reactionsAdd}
              className="text-fg-3"
            />
          }
        >
          <SmilePlusIcon />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto flex-row gap-1 p-1.5">
          {REACTION_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={emoji}
              onClick={() => void toggle(emoji)}
              className="grid size-8 place-items-center rounded-md text-lg hover:bg-surface-3 focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent"
            >
              {emoji}
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  )
}
