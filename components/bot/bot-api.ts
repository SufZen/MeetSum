/**
 * Client calls for the bot routes (M7 B7). Every result is either the typed
 * body or `{error: BotMessageKey}` already mapped to a localized message key.
 */
import { botErrorMessageKey } from "@/components/bot/join-meeting-state"
import type {
  BotErrorResponse,
  BotSettingsResponse,
  BotSettingsUpdateRequest,
  BotSettingsUpdateResponse,
  BotStatusResponse,
  JoinBotRequest,
  JoinBotResponse,
  MeetingBotResponse,
  SendBotResponse,
  StopBotResponse,
} from "@/lib/bot/api-types"
import type { BotMessageKey } from "@/lib/i18n/m7/bot"

export type BotApiResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; error: BotMessageKey; body?: Partial<BotErrorResponse> }

async function call<T>(input: string, init?: RequestInit): Promise<BotApiResult<T>> {
  let response: Response

  try {
    response = await fetch(input, {
      cache: "no-store",
      ...init,
      headers: init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers,
    })
  } catch {
    return { ok: false, status: 0, error: "botErrorNetwork" }
  }

  const body = (await response.json().catch(() => undefined)) as unknown

  if (!response.ok) {
    const errorBody = (body ?? undefined) as Partial<BotErrorResponse> | undefined

    return {
      ok: false,
      status: response.status,
      error: botErrorMessageKey(response.status, errorBody),
      body: errorBody,
    }
  }

  return { ok: true, status: response.status, body: body as T }
}

const meetingPath = (meetingId: string) => `/api/meetings/${encodeURIComponent(meetingId)}/bot`

export const botApi = {
  join: (request: JoinBotRequest) =>
    call<JoinBotResponse>("/api/meetings/bot", { method: "POST", body: JSON.stringify(request) }),
  meeting: (meetingId: string) => call<MeetingBotResponse>(meetingPath(meetingId)),
  send: (meetingId: string) =>
    call<SendBotResponse>(meetingPath(meetingId), { method: "POST", body: "{}" }),
  stop: (meetingId: string) => call<StopBotResponse>(meetingPath(meetingId), { method: "DELETE" }),
  settings: () => call<BotSettingsResponse>("/api/settings/bot"),
  updateSettings: (patch: BotSettingsUpdateRequest) =>
    call<BotSettingsUpdateResponse>("/api/settings/bot", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  status: () => call<BotStatusResponse>("/api/bot/status"),
  liveUrl: (meetingId: string) => `${meetingPath(meetingId)}/live`,
}
