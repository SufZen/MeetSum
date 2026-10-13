"use client"

import type { ReactNode } from "react"

import { Switch } from "@/components/ui/switch"
import { StatusPill } from "@/components/ui/meeting-atoms"

/** A Settings → Integrations section: heading, optional hint, content. */
export function IntegrationsSection({
  id,
  title,
  hint,
  action,
  children,
}: {
  id: string
  title: string
  hint?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h3 id={`${id}-title`} className="text-lg font-semibold text-fg">
            {title}
          </h3>
          {hint ? <p className="mt-0.5 text-sm text-fg-2">{hint}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

/** A labelled switch row; the label is the switch's accessible name. */
export function SwitchRow({
  id,
  label,
  hint,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string
  label: string
  hint?: ReactNode
  checked: boolean
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium text-fg">
          {label}
        </label>
        {hint ? (
          <p id={`${id}-hint`} className="text-xs text-fg-3">
            {hint}
          </p>
        ) : null}
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onCheckedChange={(value) => onCheckedChange(Boolean(value))}
      />
    </div>
  )
}

/** Exception-only pill (needs reauth, error, failed, partial). */
export function ExceptionPill({ tone, children }: { tone: "review" | "failed"; children: ReactNode }) {
  return <StatusPill status={tone}>{children}</StatusPill>
}

/** Timestamps are isolated so Hebrew sentences keep their order. */
export function When({ value }: { value: string }) {
  return <bdi className="tabular-nums">{value}</bdi>
}
