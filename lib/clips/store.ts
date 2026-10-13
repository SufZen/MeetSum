/**
 * Clip persistence and clip shares (owner: Package C). Step 0 stubs that
 * throw "not implemented (M5)".
 */
import type { ClipShareView, CreateClipInput, MeetingClip } from "@/lib/clips/types"
import { notImplementedM5, type MeetingShare, type RepoScope } from "@/lib/meetings/repository"

/** Who is acting on clips: the request scope plus the signed-in user. */
export type ClipStoreContext = {
  scope: RepoScope
  actorUserId?: string
}

export async function createClip(
  ctx: ClipStoreContext,
  meetingId: string,
  input: CreateClipInput
): Promise<MeetingClip> {
  void ctx
  void meetingId
  void input
  return notImplementedM5("createClip")
}

export async function listClips(ctx: ClipStoreContext, meetingId: string): Promise<MeetingClip[]> {
  void ctx
  void meetingId
  return notImplementedM5("listClips")
}

export async function getClip(
  ctx: ClipStoreContext,
  clipId: string
): Promise<MeetingClip | undefined> {
  void ctx
  void clipId
  return notImplementedM5("getClip")
}

export async function renameClip(
  ctx: ClipStoreContext,
  clipId: string,
  title: string
): Promise<MeetingClip> {
  void ctx
  void clipId
  void title
  return notImplementedM5("renameClip")
}

/** Soft delete; true when a visible clip was deleted. */
export async function deleteClip(ctx: ClipStoreContext, clipId: string): Promise<boolean> {
  void ctx
  void clipId
  return notImplementedM5("deleteClip")
}

/** Creates a `meeting_shares` row with `scope='clip'`; never changes visibility. */
export async function createClipShare(
  ctx: ClipStoreContext,
  clipId: string
): Promise<MeetingShare> {
  void ctx
  void clipId
  return notImplementedM5("createClipShare")
}

/** Active, unexpired clip share of a live clip in a non-private meeting. */
export async function getClipShareByToken(token: string): Promise<ClipShareView | undefined> {
  void token
  return notImplementedM5("getClipShareByToken")
}
