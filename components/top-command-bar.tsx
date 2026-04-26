"use client"

import type { ChangeEvent } from "react"
import {
  BellIcon,
  ChevronDownIcon,
  RefreshCwIcon,
  SearchIcon,
  SparklesIcon,
} from "lucide-react"

import { LanguageSwitcher } from "@/components/language-switcher"
import { MediaIngestionDrawer } from "@/components/media-ingestion-drawer"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { SupportedLocale } from "@/lib/i18n/locales"

export type SyncTarget = "all" | "calendar" | "drive" | "gmail"

export function TopCommandBar({
  dictionary,
  locale,
  query,
  pending,
  syncing,
  uploadOpen,
  onQueryChange,
  onUploadOpenChange,
  onFileChange,
  onRecordingReady,
  onSync,
}: {
  dictionary: Dictionary
  locale: SupportedLocale
  query: string
  pending?: boolean
  syncing?: boolean
  uploadOpen?: boolean
  onQueryChange: (value: string) => void
  onUploadOpenChange?: (open: boolean) => void
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void
  onRecordingReady: (file: File) => void
  onSync: (target: SyncTarget) => void
}) {
  return (
    <header className="sticky top-0 z-30 flex min-h-16 flex-col gap-3 border-b bg-white/96 px-4 py-3 backdrop-blur lg:flex-row lg:items-center lg:justify-between">
      <div className="flex h-10 w-full items-center gap-2 rounded-md border bg-white px-3 shadow-sm lg:max-w-[360px]">
        <SearchIcon aria-hidden="true" className="size-4 text-slate-400" />
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search meetings, people, topics..."
          className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
        />
        <kbd className="hidden rounded border bg-slate-50 px-1.5 py-0.5 font-mono text-[11px] text-slate-500 sm:inline-flex">
          Ctrl K
        </kbd>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <MediaIngestionDrawer
          dictionary={dictionary}
          pending={pending}
          open={uploadOpen}
          onOpenChange={onUploadOpenChange}
          onFileChange={onFileChange}
          onRecordingReady={onRecordingReady}
        />
        <MediaIngestionDrawer
          dictionary={dictionary}
          pending={pending}
          mode="record"
          onFileChange={onFileChange}
          onRecordingReady={onRecordingReady}
        />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="outline"
                className="h-10 min-w-28 border-teal-300 text-teal-800"
                disabled={syncing}
              />
            }
          >
            <RefreshCwIcon data-icon="inline-start" className="size-4" />
            {syncing ? "Syncing" : "Sync"}
            <ChevronDownIcon aria-hidden="true" className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onSync("all")}>
              Sync all
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onSync("calendar")}>
              Calendar only
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onSync("drive")}>
              Drive recordings
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onSync("gmail")}>
              Gmail context
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="ghost"
          size="icon"
          className="hidden rounded-full border bg-white text-violet-600 sm:inline-flex"
        >
          <SparklesIcon aria-hidden="true" className="size-5" />
          <span className="sr-only">AI status</span>
        </Button>
        <LanguageSwitcher locale={locale} />
        <Button variant="ghost" size="icon" className="relative rounded-full">
          <BellIcon aria-hidden="true" className="size-5" />
          <span className="absolute right-1 top-1 grid size-4 place-items-center rounded-full bg-orange-500 text-[10px] font-semibold text-white">
            3
          </span>
          <span className="sr-only">Notifications</span>
        </Button>
        <span className="size-2.5 rounded-full bg-emerald-500" />
      </div>
    </header>
  )
}
