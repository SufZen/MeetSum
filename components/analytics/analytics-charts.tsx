"use client"

/**
 * Recharts views for the workspace dashboard (docs/parity/m9.md C2). Loaded
 * lazily and only on `/[locale]/analytics`. Time axes never mirror: every
 * chart sits in a `dir="ltr"` wrapper. Speakers use `--spk-*`, status uses
 * `--ok`/`--warn`.
 */
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts"

import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"

export type TrendPoint = { label: string; meetings: number; hours: number }
export type TalkBar = { label: string; minutes: number; color: string }
export type ActionPoint = { label: string; created: number; completed: number }

export function TrendChart({ data, labels }: { data: TrendPoint[]; labels: { meetings: string; hours: string } }) {
  const config: ChartConfig = {
    meetings: { label: labels.meetings, color: "var(--color-spk-1)" },
    hours: { label: labels.hours, color: "var(--color-spk-3)" },
  }

  return (
    <div dir="ltr">
      <ChartContainer config={config} className="aspect-auto h-64 w-full">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={16} />
          <YAxis yAxisId="meetings" allowDecimals={false} tickLine={false} axisLine={false} width={32} />
          <YAxis yAxisId="hours" orientation="right" tickLine={false} axisLine={false} width={32} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar yAxisId="meetings" dataKey="meetings" fill="var(--color-meetings)" radius={3} />
          <Bar yAxisId="hours" dataKey="hours" fill="var(--color-hours)" radius={3} />
        </BarChart>
      </ChartContainer>
    </div>
  )
}

export function TalkChart({ data, label }: { data: TalkBar[]; label: string }) {
  const config: ChartConfig = { minutes: { label, color: "var(--color-spk-1)" } }

  return (
    <div dir="ltr">
      <ChartContainer config={config} className="aspect-auto w-full" style={{ height: Math.max(120, data.length * 36) }}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 8 }}>
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="label" tickLine={false} axisLine={false} width={120} />
          <ChartTooltip content={<ChartTooltipContent hideLabel />} />
          <Bar dataKey="minutes" radius={3} fill="var(--color-minutes)">
            {data.map((entry) => (
              <Cell key={entry.label} fill={entry.color} />
            ))}
          </Bar>
        </BarChart>
      </ChartContainer>
    </div>
  )
}

export function SparkBars({ data, color }: { data: Array<{ label: string; count: number }>; color: string }) {
  const config: ChartConfig = { count: { color } }

  return (
    <div dir="ltr" aria-hidden>
      <ChartContainer config={config} className="aspect-auto h-12 w-full">
        {/* Decorative (the count is the card's text): no accessibility layer, so
            the chart surface is not a tab stop inside the aria-hidden wrapper
            (axe aria-hidden-focus). */}
        <BarChart data={data} accessibilityLayer={false} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <Bar dataKey="count" fill="var(--color-count)" radius={2} />
        </BarChart>
      </ChartContainer>
    </div>
  )
}

export function ActionChart({ data, labels }: { data: ActionPoint[]; labels: { created: string; completed: string } }) {
  const config: ChartConfig = {
    created: { label: labels.created, color: "var(--color-warn)" },
    completed: { label: labels.completed, color: "var(--color-ok)" },
  }

  return (
    <div dir="ltr">
      <ChartContainer config={config} className="aspect-auto h-56 w-full">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={16} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar dataKey="created" fill="var(--color-created)" radius={3} />
          <Bar dataKey="completed" fill="var(--color-completed)" radius={3} />
        </BarChart>
      </ChartContainer>
    </div>
  )
}

