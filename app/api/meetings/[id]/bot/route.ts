import { withAuthz } from "@/lib/auth/authz"
import { getMeetingBot, sendBotToMeeting, stopMeetingBot } from "@/lib/bot/service"

export const runtime = "nodejs"

type Params = { id: string }

/** GET /api/meetings/[id]/bot — current bot session, history, link (M7 B7). */
export const GET = withAuthz<Params>("meeting:read", async (_request, ctx, route) => {
  const { id } = await route.params

  return getMeetingBot(ctx, id)
})

/** POST /api/meetings/[id]/bot — send the bot to this meeting. */
export const POST = withAuthz<Params>("meeting:write", async (request, ctx, route) => {
  const { id } = await route.params

  return sendBotToMeeting(request, ctx, id)
})

/** DELETE /api/meetings/[id]/bot — don't send (scheduled) or stop (live). */
export const DELETE = withAuthz<Params>("meeting:write", async (_request, ctx, route) => {
  const { id } = await route.params

  return stopMeetingBot(ctx, id)
})
