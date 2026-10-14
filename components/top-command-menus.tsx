"use client"

/**
 * The top bar's dropdowns (Sync, Send bot). Loaded on intent by
 * `TopCommandBar` (M10 C bundle diet), which renders identical static
 * triggers until then; `defaultOpen` opens the menu the click mounted.
 */
import { BotIcon, FolderSearchIcon, RefreshCwIcon } from "lucide-react"
import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SendBotTriggerContent,
  sendBotTriggerProps,
  syncTriggerProps,
} from "@/components/top-command-triggers"
import type { Dictionary } from "@/lib/i18n/dictionaries"

export type SyncMenuTarget = "calendar" | "gmail"

export function SyncMenu({
  dictionary,
  trigger,
  syncing,
  defaultOpen,
  onSync,
  onFindDriveRecordings,
}: {
  dictionary: Dictionary
  /** The trigger's content (shared with the static placeholder). */
  trigger: ReactNode
  syncing?: boolean
  defaultOpen?: boolean
  onSync: (target: SyncMenuTarget) => void
  onFindDriveRecordings: () => void
}) {
  return (
    <DropdownMenu defaultOpen={defaultOpen}>
      <DropdownMenuTrigger render={<Button {...syncTriggerProps(syncing)} />}>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onSync("calendar")}>
          <RefreshCwIcon aria-hidden="true" className="size-4" />
          {dictionary.calendarSync}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onFindDriveRecordings}>
          <FolderSearchIcon aria-hidden="true" className="size-4" />
          {dictionary.findDriveRecordings}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onSync("gmail")}>{dictionary.gmailContext}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function SendBotMenu({
  dictionary,
  compact,
  defaultOpen,
  onSendBot,
}: {
  dictionary: Dictionary
  /** Icon-only trigger (next to the Record button). */
  compact: boolean
  defaultOpen?: boolean
  onSendBot: () => void
}) {
  return (
    <DropdownMenu defaultOpen={defaultOpen}>
      <DropdownMenuTrigger render={<Button {...sendBotTriggerProps(dictionary, compact)} />}>
        <SendBotTriggerContent dictionary={dictionary} compact={compact} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onSendBot}>
          <BotIcon aria-hidden="true" className="size-4" />
          {dictionary.botJoinMenu}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
