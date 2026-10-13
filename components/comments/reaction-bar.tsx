"use client"

/**
 * M5 Step 0 stub (owner: Package C): typed props, renders nothing yet.
 */
import type { ReactionSummary, ReactionTargetType } from "@/lib/comments/types"

export type ReactionBarProps = {
  meetingId: string
  targetType: ReactionTargetType
  targetId: string
  reactions?: ReactionSummary[]
}

export function ReactionBar(props: ReactionBarProps) {
  void props
  return null
}
