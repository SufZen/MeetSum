/**
 * Trigger props and content shared by the top bar's static menu placeholders
 * and the lazily loaded menus (`top-command-menus.tsx`), so both render the
 * same button (M10 C). No menu code here.
 */
import { BotIcon, ChevronDownIcon } from "lucide-react"

import type { Dictionary } from "@/lib/i18n/dictionaries"

export function syncTriggerProps(syncing?: boolean) {
  return {
    variant: "outline",
    className: "h-8 min-w-24 rounded-md border-line bg-surface text-brand-text hover:bg-brand-soft",
    disabled: syncing,
  } as const
}

export function sendBotTriggerProps(dictionary: Pick<Dictionary, "botJoinMenu">, compact: boolean) {
  return {
    variant: "record",
    size: compact ? "icon" : "default",
    className: "h-9",
    "aria-label": dictionary.botJoinMenu,
    title: dictionary.botJoinMenu,
  } as const
}

export function SendBotTriggerContent({
  dictionary,
  compact,
}: {
  dictionary: Pick<Dictionary, "botJoinMenu">
  compact: boolean
}) {
  return (
    <>
      {compact ? null : <BotIcon data-icon="inline-start" />}
      {compact ? null : dictionary.botJoinMenu}
      <ChevronDownIcon aria-hidden="true" className="size-4" />
    </>
  )
}
