/**
 * Slack provider (docs/parity/m8.md A9), workspace connection. Owner:
 * Package A.
 *
 * - Channel picker: `conversations.list` (public, plus private with
 *   `SLACK_PRIVATE_CHANNELS`), `exclude_archived`, 200 per page, cursor;
 *   the query filters on the server.
 * - Deliver: `chat.postMessage` (no unfurls) → `chat.getPermalink` → the
 *   `slack_message` link. A re-send to the same channel within 24 h
 *   `chat.update`s the tracked message; an unchanged payload is a no-op.
 *   `action_item.created` posts a one-item message.
 * - No duplicate post on retry: before `chat.postMessage` a pending intent
 *   `progress.slackIntent = {destinationKey, marker, at}` is written (its
 *   own write), the message carries the marker in Slack message metadata
 *   (`event_type: meetsum_delivery`), and `progress.slackPosted` is written
 *   right after the post, before the link. A retry with an intent but no
 *   result searches the channel history since the intent
 *   (`conversations.history`, `include_all_metadata`) for the marker and
 *   adopts that message; it posts only when the marker is not found. When
 *   the history cannot be read (an older connection without
 *   `channels:history`, a private channel without `groups:history`) it posts
 *   again (logged): reconnect Slack to get the scope.
 */
import { createHash } from "node:crypto"

import { integrationLog, ProviderHttpError } from "@/lib/integrations/core/errors"
import { recapLocale } from "@/lib/integrations/core/links"
import type {
  DeliverInput,
  DeliverResult,
  IntegrationProvider,
  PickerPage,
  ProviderCtx,
  RuleDestination,
} from "@/lib/integrations/core/types"
import { buildSlackActionItemMessage, buildSlackRecapMessage, type SlackMessage } from "@/lib/integrations/slack/blocks"
import { slackCall } from "@/lib/integrations/slack/client"
import { slackFakeHandlers } from "@/lib/integrations/slack/fake"
import {
  SLACK_DEFAULT_SCOPES,
  slackAuthorizeUrl,
  slackClientConfig,
  slackExchangeCode,
  slackRefresh,
  slackRevoke,
  slackScopes,
} from "@/lib/integrations/slack/oauth"
import { getTaskTimeZone } from "@/lib/tasks/time-zone"

export const SLACK_UPDATE_WINDOW_MS = 24 * 60 * 60_000

async function listChannels(ctx: ProviderCtx, query: { query?: string; cursor?: string }): Promise<PickerPage> {
  const token = await ctx.getAccessToken()
  const types = process.env.SLACK_PRIVATE_CHANNELS === "true" ? "public_channel,private_channel" : "public_channel"
  const response = await slackCall(
    "conversations.list",
    { types, exclude_archived: true, limit: 200, ...(query.cursor ? { cursor: query.cursor } : {}) },
    { token, form: true, fetch: ctx.fetch }
  )
  const needle = query.query?.trim().toLowerCase().replace(/^#/, "")
  const channels = (Array.isArray(response.channels) ? response.channels : []) as {
    id?: string
    name?: string
    is_private?: boolean
    is_member?: boolean
    num_members?: number
  }[]
  const items = channels
    .filter((channel) => channel.id && channel.name && (!needle || channel.name.toLowerCase().includes(needle)))
    .map((channel) => ({
      id: String(channel.id),
      label: `#${channel.name}`,
      ...(channel.is_private ? { hint: "private" } : channel.is_member === false ? { hint: "not_member" } : {}),
    }))
  const next = (response.response_metadata as { next_cursor?: string } | undefined)?.next_cursor

  return { items, ...(next ? { nextCursor: next } : {}) }
}

export const SLACK_METADATA_EVENT = "meetsum_delivery"

type SlackIntent = { destinationKey: string; marker: string; at: string }
type SlackPosted = { destinationKey: string; ts: string; channel: string }

function intentFor(value: unknown, destinationKey: string): SlackIntent | undefined {
  const intent = value as Partial<SlackIntent> | undefined

  return intent && intent.destinationKey === destinationKey && typeof intent.marker === "string" && typeof intent.at === "string"
    ? (intent as SlackIntent)
    : undefined
}

function postedFor(value: unknown, destinationKey: string): SlackPosted | undefined {
  const posted = value as Partial<SlackPosted> | undefined

  return posted && posted.destinationKey === destinationKey && typeof posted.ts === "string" && typeof posted.channel === "string"
    ? (posted as SlackPosted)
    : undefined
}

/** The message a previous attempt posted for `intent`, found by its metadata marker. */
async function findPostedByMarker(
  input: DeliverInput,
  token: string,
  channel: string,
  intent: SlackIntent
): Promise<SlackPosted | undefined> {
  const oldest = Math.max(0, Date.parse(intent.at) / 1000 - 60).toFixed(6)
  let history: Awaited<ReturnType<typeof slackCall>>

  try {
    history = await slackCall(
      "conversations.history",
      { channel, oldest, limit: 200, include_all_metadata: true },
      { token, form: true, fetch: input.fetch }
    )
  } catch (error) {
    // No history scope or access: we cannot prove the post happened.
    if (error instanceof ProviderHttpError && (error.kind === "forbidden" || error.kind === "invalid")) {
      integrationLog.warn("slack history unavailable; re-posting a pending message", error.providerCode)
      return undefined
    }
    throw error
  }

  const messages = (Array.isArray(history.messages) ? history.messages : []) as {
    ts?: string
    metadata?: { event_type?: string; event_payload?: { marker?: string } }
  }[]
  const found = messages.find(
    (message) => message.metadata?.event_type === SLACK_METADATA_EVENT && message.metadata.event_payload?.marker === intent.marker
  )

  return found?.ts ? { destinationKey: intent.destinationKey, ts: found.ts, channel } : undefined
}

function contentHash(message: SlackMessage): string {
  return createHash("sha256").update(JSON.stringify(message)).digest("hex")
}

async function deliverSlack(input: DeliverInput): Promise<DeliverResult> {
  const destination = input.destination

  if (destination.provider !== "slack" || !destination.channelId) {
    throw new ProviderHttpError("invalid", "slack", 0, { providerCode: "invalid_destination" })
  }

  const locale = recapLocale(input.recap.language)
  const timeZone = getTaskTimeZone()
  let message: SlackMessage
  let destinationKey = destination.channelId

  if (input.delivery.eventName === "action_item.created" && input.delivery.actionItemId) {
    const item = input.recap.actionItems.find((candidate) => candidate.id === input.delivery.actionItemId)

    if (!item) return { status: "skipped", skipReason: "filtered", externalRef: {} }
    message = buildSlackActionItemMessage(input.recap, item, { locale, timeZone })
    destinationKey = `${destination.channelId}#${item.id}`
  } else {
    message = buildSlackRecapMessage(input.recap, { locale, timeZone })
  }

  const hash = contentHash(message)
  const link = await input.links.get({ objectKind: "slack_message", destinationKey })
  const token = await input.getAccessToken()

  if (link && Date.now() - Date.parse(link.createdAt) < SLACK_UPDATE_WINDOW_MS) {
    const ref = { channel: destination.channelId, ts: link.externalId, ...(link.externalUrl ? { permalink: link.externalUrl } : {}) }

    if (link.contentHash === hash) return { status: "sent", externalRef: { ...ref, unchanged: true } }

    try {
      await slackCall(
        "chat.update",
        { channel: destination.channelId, ts: link.externalId, text: message.text, blocks: message.blocks },
        { token, fetch: input.fetch }
      )
      await input.links.upsert({ objectKind: "slack_message", destinationKey, externalId: link.externalId, ...(link.externalUrl ? { externalUrl: link.externalUrl } : {}), contentHash: hash })
      return { status: "sent", externalRef: { ...ref, updated: true } }
    } catch (error) {
      // A deleted message cannot be updated: post anew below.
      if (!(error instanceof ProviderHttpError) || !["message_not_found", "cant_update_message", "edit_window_closed"].includes(error.providerCode ?? "")) {
        throw error
      }
    }
  }

  const progress = input.progress
  let posted = postedFor(progress.slackPosted, destinationKey)
  const pendingIntent = posted ? undefined : intentFor(progress.slackIntent, destinationKey)

  if (!posted && pendingIntent) posted = await findPostedByMarker(input, token, destination.channelId, pendingIntent)

  if (!posted) {
    const intent: SlackIntent = {
      destinationKey,
      marker: pendingIntent?.marker ?? createHash("sha256").update(`${input.delivery.id}:${destinationKey}`).digest("hex").slice(0, 32),
      at: new Date().toISOString(),
    }

    // 1. Intent first (its own write): no write, no post.
    await input.saveProgress({ ...progress, slackIntent: intent })

    // 2. The post, carrying the marker.
    const response = await slackCall(
      "chat.postMessage",
      {
        channel: destination.channelId,
        text: message.text,
        blocks: message.blocks,
        unfurl_links: false,
        unfurl_media: false,
        metadata: { event_type: SLACK_METADATA_EVENT, event_payload: { marker: intent.marker } },
      },
      { token, fetch: input.fetch }
    )

    posted = {
      destinationKey,
      ts: typeof response.ts === "string" ? response.ts : "",
      channel: typeof response.channel === "string" ? response.channel : destination.channelId,
    }

    // 3. The result, separately (a failure here is recovered by the marker search).
    await input.saveProgress({ ...progress, slackIntent: intent, slackPosted: posted })
  }

  const ts = posted.ts
  const channel = posted.channel
  let permalink: string | undefined

  try {
    const response = await slackCall("chat.getPermalink", { channel, message_ts: ts }, { token, form: true, fetch: input.fetch })

    permalink = typeof response.permalink === "string" && /^https:\/\//.test(response.permalink) ? response.permalink : undefined
  } catch {
    permalink = undefined
  }

  await input.links.upsert({ objectKind: "slack_message", destinationKey, externalId: ts, ...(permalink ? { externalUrl: permalink } : {}), contentHash: hash })

  return { status: "sent", externalRef: { channel, ts, ...(permalink ? { permalink } : {}) } }
}

async function validateSlackDestination(destination: RuleDestination, ctx: ProviderCtx): Promise<void> {
  if (destination.provider !== "slack" || !/^[A-Z0-9]{2,32}$/i.test(destination.channelId)) {
    throw new ProviderHttpError("invalid", "slack", 0, { providerCode: "channel_not_found" })
  }

  const token = await ctx.getAccessToken()
  const info = await slackCall("conversations.info", { channel: destination.channelId }, { token, form: true, fetch: ctx.fetch })
  const channel = (info.channel ?? {}) as { is_archived?: boolean; is_member?: boolean; is_private?: boolean }

  if (channel.is_archived) throw new ProviderHttpError("invalid", "slack", 200, { providerCode: "is_archived" })
  if (!channel.is_member && (channel.is_private || !ctx.connection.scopes.includes("chat:write.public"))) {
    throw new ProviderHttpError("invalid", "slack", 200, { providerCode: "not_in_channel" })
  }
}

export const slackProvider: IntegrationProvider = {
  id: "slack",
  scope: "workspace",
  configured: (env = process.env) => Boolean(slackClientConfig(env)),
  oauth: {
    pkce: false,
    get scopes() {
      return slackScopes()
    },
    optionalScopes: ["groups:read", "commands", "users:read", "users:read.email"],
    authorizeUrl: (params) => slackAuthorizeUrl(params),
    exchangeCode: (code, params) => slackExchangeCode(code, params),
    refresh: (refreshToken) => slackRefresh(refreshToken),
    revoke: (tokens) => slackRevoke(tokens),
  },
  async test(ctx) {
    await slackCall("auth.test", {}, { token: await ctx.getAccessToken(), form: true, fetch: ctx.fetch })
  },
  pickers: { channels: listChannels },
  validateDestination: validateSlackDestination,
  deliver: deliverSlack,
  fake: slackFakeHandlers,
}

export { SLACK_DEFAULT_SCOPES }
