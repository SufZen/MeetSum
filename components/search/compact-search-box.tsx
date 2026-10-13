"use client"

/**
 * The memory panel's body (M6 D1): a compact search box that opens the
 * Search & Ask page, plus a link straight to Ask.
 */
import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { SearchIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { CitedMark } from "@/components/ui/meeting-atoms"
import { Input } from "@/components/ui/input"
import { EMPTY_SEARCH_STATE, SEARCH_QUERY_MAX, serializeSearchUrl } from "@/lib/client/search-url"
import type { Dictionary } from "@/lib/i18n/dictionaries"

export function CompactSearchBox({
  locale,
  dictionary: t,
  initialQuery = "",
}: {
  locale: string
  dictionary: Dictionary
  /** The top bar's query, carried over as a starting point. */
  initialQuery?: string
}) {
  const router = useRouter()
  const [value, setValue] = useState(initialQuery)

  return (
    <section className="grid gap-3 rounded-lg bg-surface p-4 ring-1 ring-line">
      <div className="grid gap-1">
        <h2 className="text-lg font-semibold text-fg">{t.searchCompactTitle}</h2>
        <p className="text-sm text-fg-3">{t.searchCompactBody}</p>
      </div>
      <form
        role="search"
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          const search = serializeSearchUrl({ ...EMPTY_SEARCH_STATE, q: value })

          router.push(`/${locale}/search${search ? `?${search}` : ""}`)
        }}
      >
        <div className="relative min-w-48 flex-1">
          <SearchIcon aria-hidden className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-fg-3" />
          <Input
            type="search"
            dir="auto"
            maxLength={SEARCH_QUERY_MAX}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={t.searchPlaceholder}
            aria-label={t.searchLabel}
            className="h-10 ps-9"
          />
        </div>
        <Button type="submit" size="lg">
          {t.searchSubmit}
        </Button>
      </form>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Link href={`/${locale}/search`} className="text-brand-text hover:underline">
          {t.searchCompactOpen}
        </Link>
        <Link href={`/${locale}/search?tab=ask`} className="inline-flex items-center gap-1 text-brand-text hover:underline">
          <CitedMark aria-hidden className="size-3.5 text-ai-text" />
          {t.searchCompactAsk}
        </Link>
      </div>
    </section>
  )
}
