"use client"

/**
 * Honest capability state: a badge when search ran lexical only (no
 * pgvector, no embedding provider, or the query embedding failed), with
 * the reason in a tooltip. Absent in hybrid mode.
 */
import { InfoIcon } from "lucide-react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { SearchResponse } from "@/lib/search/types"

type Degraded = NonNullable<SearchResponse["degraded"]>[number]

const REASON_KEYS: Record<Degraded, keyof Dictionary> = {
  no_vector: "searchLexicalNoVector",
  no_embedding_provider: "searchLexicalNoProvider",
  query_embedding_failed: "searchLexicalQueryFailed",
  no_trgm: "searchLexicalNoTrgm",
}

export function lexicalReasons(response: Pick<SearchResponse, "degraded">, t: Dictionary): string[] {
  const reasons = (response.degraded ?? []).filter((reason): reason is Degraded => reason in REASON_KEYS)

  return reasons.length ? reasons.map((reason) => t[REASON_KEYS[reason]]) : [t.searchLexicalDefault]
}

export function SearchModeBadge({ response, dictionary: t }: { response: SearchResponse; dictionary: Dictionary }) {
  if (response.mode !== "lexical") return null

  const reasons = lexicalReasons(response, t)

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-search-mode="lexical"
            className="inline-flex h-6 items-center gap-1 rounded-full bg-warn-soft px-2 text-xs font-medium text-warn-text focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent"
          />
        }
      >
        <InfoIcon aria-hidden className="size-3.5" />
        {t.searchLexicalBadge}
        <span className="sr-only">: {reasons.join(" ")}</span>
      </TooltipTrigger>
      <TooltipContent className="grid max-w-72 gap-1 text-start">
        {reasons.map((reason) => (
          <span key={reason}>{reason}</span>
        ))}
      </TooltipContent>
    </Tooltip>
  )
}
