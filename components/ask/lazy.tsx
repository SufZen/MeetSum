"use client"

/**
 * Code-split entry for the Ask panel: the meeting page, room page and search
 * page load it on demand so the `/[locale]` first-load bundle stays small.
 */
import dynamic from "next/dynamic"

export const LazyAskPanel = dynamic(() => import("@/components/ask/ask-panel").then((mod) => mod.AskPanel), {
  ssr: false,
  loading: () => <div aria-busy="true" className="h-48 animate-pulse rounded-lg bg-surface-2" />,
})
