import type { BotSessionStore } from "@/lib/bot/store"
import type { Queryable } from "@/lib/db/client"

/**
 * Postgres BotSessionStore (M7 B1). Step 0 stub: constructing it is safe,
 * every method rejects with "not implemented (M7)".
 */

const METHODS = [
  "create",
  "get",
  "getForUpdate",
  "findByVexaMeetingId",
  "findOpenByTarget",
  "findByCalendarEvent",
  "listForMeeting",
  "listActive",
  "listOpen",
  "listDueForDispatch",
  "listPurgeable",
  "update",
  "transition",
  "countLive",
  "countCreatedSince",
  "recordEvent",
  "withTransaction",
] as const satisfies readonly (keyof BotSessionStore)[]

export function createPostgresBotSessionStore(db: Queryable): BotSessionStore {
  void db

  const store: Record<string, () => Promise<never>> = {}

  for (const method of METHODS) {
    store[method] = () =>
      Promise.reject(new Error(`BotSessionStore.${method} not implemented (M7)`))
  }

  return store as unknown as BotSessionStore
}
