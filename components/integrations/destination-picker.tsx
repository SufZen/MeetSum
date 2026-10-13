"use client"

import { useEffect, useId, useState } from "react"
import { CheckIcon } from "lucide-react"

import { integrationsApi } from "@/components/integrations/api"
import { pickerHintKey } from "@/components/integrations/state"
import { im } from "@/components/integrations/messages"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { PickerItem } from "@/lib/integrations/core/types"
import { cn } from "@/lib/utils"

/**
 * Searchable, paginated destination picker over
 * `GET /api/integrations/connections/[id]/options/[picker]` (channels,
 * databases, deals). Labels are user content, so each one is in <bdi>.
 */
export function DestinationPicker({
  t,
  connectionId,
  picker,
  label,
  value,
  disabled,
  onChange,
}: {
  t: Dictionary
  connectionId: string
  picker: string
  label: string
  value: { id: string; label: string } | undefined
  disabled?: boolean
  onChange: (item: PickerItem) => void
}) {
  const id = useId()
  const [query, setQuery] = useState("")
  const [items, setItems] = useState<PickerItem[]>([])
  const [cursor, setCursor] = useState<string>()
  const [state, setState] = useState<"idle" | "loading" | "error">("idle")

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      setState("loading")
      void integrationsApi.picker(connectionId, picker, { query: query.trim() || undefined }).then((result) => {
        if (cancelled) return
        if (!result.ok) {
          setState("error")
          return
        }
        setItems(result.body.items)
        setCursor(result.body.nextCursor)
        setState("idle")
      })
    }, 250)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [connectionId, picker, query])

  async function loadMore() {
    if (!cursor) return
    setState("loading")
    const result = await integrationsApi.picker(connectionId, picker, { query: query.trim() || undefined, cursor })

    if (!result.ok) {
      setState("error")
      return
    }
    setItems((current) => [...current, ...result.body.items.filter((item) => !current.some((existing) => existing.id === item.id))])
    setCursor(result.body.nextCursor)
    setState("idle")
  }

  return (
    <div className="grid gap-1.5" role="group" aria-labelledby={`${id}-label`}>
      <div id={`${id}-label`} className="text-sm font-medium text-fg">
        {label}
        {value?.id ? (
          <span className="ms-2 font-normal text-fg-2">
            <bdi>{value.label || value.id}</bdi>
          </span>
        ) : null}
      </div>
      <Input
        dir="auto"
        type="search"
        value={query}
        disabled={disabled}
        placeholder={t.integrationsPickerSearch}
        aria-label={`${label}: ${t.integrationsPickerSearch}`}
        onChange={(event) => setQuery(event.target.value)}
      />
      <ul
        className="grid max-h-56 gap-0.5 overflow-auto rounded-md border border-line bg-surface-2 p-1"
        aria-busy={state === "loading"}
        aria-label={label}
      >
        {items.map((item) => {
          const selected = item.id === value?.id

          return (
            <li key={item.id}>
              <button
                type="button"
                disabled={disabled}
                aria-pressed={selected}
                onClick={() => onChange(item)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-start text-sm",
                  selected ? "bg-brand-soft text-brand-text" : "text-fg hover:bg-surface-3"
                )}
              >
                <CheckIcon aria-hidden="true" className={cn("size-3.5 shrink-0", selected ? "opacity-100" : "opacity-0")} />
                <bdi className="min-w-0 truncate">{item.label}</bdi>
                {pickerHintKey(item.hint) ? (
                  <span className="ms-auto shrink-0 text-xs text-fg-3">{im(t, pickerHintKey(item.hint)!)}</span>
                ) : null}
              </button>
            </li>
          )
        })}
        {state === "idle" && items.length === 0 ? (
          <li className="px-2 py-1.5 text-sm text-fg-3">{t.integrationsPickerEmpty}</li>
        ) : null}
        {state === "error" ? (
          <li role="alert" className="px-2 py-1.5 text-sm text-danger-text">
            {t.integrationsPickerError}
          </li>
        ) : null}
      </ul>
      {cursor ? (
        <Button type="button" variant="ghost" size="sm" className="w-fit" disabled={disabled || state === "loading"} onClick={() => void loadMore()}>
          {im(t, "integrationsPickerLoadMore")}
        </Button>
      ) : null}
    </div>
  )
}
