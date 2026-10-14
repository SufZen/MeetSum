/**
 * Message namespaces (M10 C, docs/parity/m10.md lever 2). Each message module
 * is one namespace; `base` is the inline block of `dictionaries.ts`. A route's
 * server layout passes only the namespaces its client tree reads to
 * `I18nProvider` (`messagesFor`), so the RSC payload carries just those
 * strings. Client code never imports this file or a message module: it reads
 * `useI18n()` (enforced by the `client-message-import` ds:check rule).
 *
 * Server-side helper: imports every message module.
 */
import { asrMessagesEn, asrMessagesHe } from "@/lib/i18n/asr-messages"
import { M9_MESSAGE_MODULES, dictionaries, type Dictionary } from "@/lib/i18n/dictionaries"
import type { SupportedLocale } from "@/lib/i18n/locales"
import { clipsMessagesEn, clipsMessagesHe } from "@/lib/i18n/m5/clips"
import { commentsMessagesEn, commentsMessagesHe } from "@/lib/i18n/m5/comments"
import { intelligenceMessagesEn, intelligenceMessagesHe } from "@/lib/i18n/m5/intelligence"
import { tasksMessagesEn, tasksMessagesHe } from "@/lib/i18n/m5/tasks"
import { askMessagesEn, askMessagesHe } from "@/lib/i18n/m6/ask"
import { searchMessagesEn, searchMessagesHe } from "@/lib/i18n/m6/search"
import { botMessagesEn, botMessagesHe } from "@/lib/i18n/m7/bot"
import { exportsMessagesEn, exportsMessagesHe } from "@/lib/i18n/m8/exports"
import { integrationsMessagesEn, integrationsMessagesHe } from "@/lib/i18n/m8/integrations"
import { playerMessagesEn, playerMessagesHe } from "@/lib/i18n/player-messages"
import { workspaceMessagesEn, workspaceMessagesHe } from "@/lib/i18n/workspace-messages"

type Messages = Readonly<Record<string, string>>
type LocalePair = { en: Messages; he: Messages }

const MODULES = {
  workspace: { en: workspaceMessagesEn, he: workspaceMessagesHe },
  asr: { en: asrMessagesEn, he: asrMessagesHe },
  player: { en: playerMessagesEn, he: playerMessagesHe },
  bot: { en: botMessagesEn, he: botMessagesHe },
  intelligence: { en: intelligenceMessagesEn, he: intelligenceMessagesHe },
  tasks: { en: tasksMessagesEn, he: tasksMessagesHe },
  clips: { en: clipsMessagesEn, he: clipsMessagesHe },
  comments: { en: commentsMessagesEn, he: commentsMessagesHe },
  search: { en: searchMessagesEn, he: searchMessagesHe },
  ask: { en: askMessagesEn, he: askMessagesHe },
  integrations: { en: integrationsMessagesEn, he: integrationsMessagesHe },
  m8exports: { en: exportsMessagesEn, he: exportsMessagesHe },
  ...(M9_MESSAGE_MODULES as Record<keyof typeof M9_MESSAGE_MODULES, LocalePair>),
} satisfies Record<string, LocalePair>

export type ModuleNamespace = keyof typeof MODULES
/** `base`: the keys `dictionaries.ts` defines inline (navigation, summary, sign-in…). */
export type Namespace = "base" | ModuleNamespace

export const NAMESPACES: readonly Namespace[] = ["base", ...(Object.keys(MODULES) as ModuleNamespace[])]

/** The inline keys of the dictionary: every key no module defines. */
function baseMessages(locale: SupportedLocale): Messages {
  const moduleKeys = new Set(Object.values(MODULES).flatMap((pair) => Object.keys(pair[locale])))

  return Object.fromEntries(Object.entries(dictionaries[locale]).filter(([key]) => !moduleKeys.has(key)))
}

const baseCache = new Map<SupportedLocale, Messages>()

/** One namespace's messages for `locale`. */
export function namespaceMessages(locale: SupportedLocale, namespace: Namespace): Messages {
  if (namespace === "base") {
    if (!baseCache.has(locale)) baseCache.set(locale, baseMessages(locale))
    return baseCache.get(locale)!
  }

  return MODULES[namespace][locale]
}

/**
 * The provider messages for a route: the union of `namespaces`, in dictionary
 * order (later modules win, as in `dictionaries.ts`). `"all"` is the whole
 * dictionary (`app/[locale]`, whose components still take `dictionary` props).
 */
export function messagesFor(locale: SupportedLocale, namespaces: readonly Namespace[] | "all"): Messages {
  if (namespaces === "all") return dictionaries[locale] as Dictionary

  const wanted = new Set(namespaces)

  return Object.assign({}, ...NAMESPACES.filter((ns) => wanted.has(ns)).map((ns) => namespaceMessages(locale, ns)))
}
