"use client"

import type { ChangeEvent } from "react"
import {
  BellIcon,
  ChevronDownIcon,
  FolderSearchIcon,
  MoonIcon,
  RefreshCwIcon,
  SearchIcon,
  SparklesIcon,
  SunIcon,
  UserPlusIcon,
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

export type SyncTarget = "calendar" | "gmail"

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
  onFindDriveRecordings,
  darkMode,
  onToggleDarkMode,
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
  onFindDriveRecordings: () => void
  darkMode: boolean
  onToggleDarkMode: () => void
}) {
  return (
    <header className="sticky top-0 z-30 flex min-h-14 flex-col gap-2 border-b border-[var(--divider)] bg-[var(--surface)] px-4 py-2 backdrop-blur lg:flex-row lg:items-center lg:justify-between">
      <div className="flex h-8 w-full items-center gap-2 rounded-md border border-[var(--divider)] bg-[var(--surface-subtle)] px-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] lg:max-w-[390px]">
        <SearchIcon aria-hidden="true" className="size-4 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={dictionary.commandPlaceholder}
          className="h-7 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
        />
        <kbd className="hidden min-w-12 shrink-0 whitespace-nowrap rounded border border-[var(--divider)] bg-[var(--surface-subtle)] px-1.5 py-0.5 text-center font-mono text-[11px] text-muted-foreground sm:inline-flex">
          Ctrl K
        </kbd>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          className="hidden h-8 rounded-md border-[var(--divider)] bg-[var(--surface)] text-[var(--primary)] hover:bg-[var(--selected)] md:inline-flex"
          disabled
          title="Team invite is prepared for a later team release"
        >
          <UserPlusIcon data-icon="inline-start" className="size-4" />
          Invite
        </Button>
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
                className="h-8 min-w-24 rounded-md border-[var(--divider)] bg-[var(--surface)] text-[var(--primary)] hover:bg-[var(--selected)]"
                disabled={syncing}
              />
            }
          >
            <RefreshCwIcon data-icon="inline-start" className="size-4" />
            {syncing ? dictionary.syncing : dictionary.sync}
            <ChevronDownIcon aria-hidden="true" className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onSync("calendar")}>
              <RefreshCwIcon aria-hidden="true" className="size-4" />
              {dictionary.calendarSync}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onFindDriveRecordings}>
              <FolderSearchIcon aria-hidden="true" className="size-4" />
              {dictionary.findDriveRecordings}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onSync("gmail")}>
              {dictionary.gmailContext}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="ghost"
          size="icon"
          className="hidden rounded-full border border-[var(--divider)] bg-[var(--surface)] text-[var(--status-ai)] sm:inline-flex"
          disabled
          title="Provider details live in Google Workspace"
        >
          <SparklesIcon aria-hidden="true" className="size-5" />
          <span className="sr-only">AI status</span>
        </Button>
        <LanguageSwitcher locale={locale} />
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full"
          onClick={onToggleDarkMode}
        >
          {darkMode ? (
            <SunIcon aria-hidden="true" className="size-5" />
          ) : (
            <MoonIcon aria-hidden="true" className="size-5" />
          )}
          <span className="sr-only">Toggle dark mode</span>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="relative rounded-full"
          disabled
          title="Notifications are coming in the next release slice"
        >
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
