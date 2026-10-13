/**
 * Comment and reaction persistence (owner: Package C). Step 0 stubs that
 * throw "not implemented (M5)".
 */
import type {
  CommentListResult,
  CreateCommentInput,
  MeetingComment,
  ReactionEmoji,
  ReactionTargetType,
} from "@/lib/comments/types"
import { notImplementedM5, type RepoScope } from "@/lib/meetings/repository"

/** Comments require a signed-in user principal. */
export type CommentStoreContext = {
  scope: RepoScope
  userId: string
}

export async function listMeetingComments(
  ctx: CommentStoreContext,
  meetingId: string
): Promise<CommentListResult> {
  void ctx
  void meetingId
  return notImplementedM5("listMeetingComments")
}

export async function createComment(
  ctx: CommentStoreContext,
  meetingId: string,
  input: CreateCommentInput
): Promise<MeetingComment> {
  void ctx
  void meetingId
  void input
  return notImplementedM5("createComment")
}

export async function editComment(
  ctx: CommentStoreContext,
  commentId: string,
  body: string
): Promise<MeetingComment> {
  void ctx
  void commentId
  void body
  return notImplementedM5("editComment")
}

export async function deleteComment(ctx: CommentStoreContext, commentId: string): Promise<boolean> {
  void ctx
  void commentId
  return notImplementedM5("deleteComment")
}

export async function resolveComment(
  ctx: CommentStoreContext,
  commentId: string,
  resolved: boolean
): Promise<MeetingComment> {
  void ctx
  void commentId
  void resolved
  return notImplementedM5("resolveComment")
}

/** Toggles a reaction; returns whether it is now set. */
export async function toggleReaction(
  ctx: CommentStoreContext,
  input: {
    meetingId: string
    targetType: ReactionTargetType
    targetId: string
    emoji: ReactionEmoji
  }
): Promise<{ active: boolean }> {
  void ctx
  void input
  return notImplementedM5("toggleReaction")
}
