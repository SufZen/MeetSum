"use client"

/**
 * M5 Step 0 stub (owner: Package C): typed props, renders nothing yet.
 */
import type { CommentAnchor as CommentAnchorPosition, CommentTargetType } from "@/lib/comments/types"

export type CommentAnchorProps = {
  meetingId: string
  targetType: CommentTargetType
  targetId: string
  anchor?: CommentAnchorPosition
  count?: number
}

export function CommentAnchor(props: CommentAnchorProps) {
  void props
  return null
}
