"use client"

import { AlertCircleIcon, Loader2Icon, RefreshCwIcon } from "lucide-react"
import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"

/** Shared loading / error / empty states for admin sections. */
export function SectionState({
  loading,
  error,
  empty,
  emptyLabel,
  loadingLabel,
  retryLabel,
  onRetry,
  children,
}: {
  loading: boolean
  error?: string
  empty: boolean
  emptyLabel: string
  loadingLabel: string
  retryLabel: string
  onRetry: () => void
  children: ReactNode
}) {
  if (error) {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
      >
        <span className="flex min-w-0 items-center gap-2">
          <AlertCircleIcon aria-hidden="true" className="size-4 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </span>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCwIcon data-icon="inline-start" />
          {retryLabel}
        </Button>
      </div>
    )
  }

  if (loading && empty) {
    return (
      <div
        aria-busy="true"
        className="flex items-center gap-2 rounded-lg border border-dashed border-[var(--divider)] p-4 text-sm text-muted-foreground"
      >
        <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
        {loadingLabel}
      </div>
    )
  }

  if (empty) {
    return (
      <div className="rounded-lg border border-dashed border-[var(--divider)] p-4 text-sm text-muted-foreground">
        {emptyLabel}
      </div>
    )
  }

  return <>{children}</>
}
