"use client"

/**
 * A dashboard section with a chart and a "show as table" toggle
 * (docs/parity/m9.md C2): every chart has an accessible table view.
 */
import { useId, useState, type ReactNode } from "react"

import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"

export function ChartCard({
  title,
  description,
  chart,
  table,
  empty,
}: {
  title: string
  description?: ReactNode
  chart: ReactNode
  table: ReactNode
  /** Shown instead of chart and table when there is no data. */
  empty?: string | null
}) {
  const i18n = useI18n()
  const headingId = useId()
  const [asTable, setAsTable] = useState(false)

  return (
    <section aria-labelledby={headingId} className="ms-card grid gap-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <h2 id={headingId} className="text-base font-semibold text-fg">
            {title}
          </h2>
          {description ? <div className="text-sm text-fg-2">{description}</div> : null}
        </div>
        {empty ? null : (
          <Button variant="outline" size="sm" aria-pressed={asTable} onClick={() => setAsTable((value) => !value)}>
            {asTable ? i18n.t("analyticsShowChart") : i18n.t("analyticsShowTable")}
          </Button>
        )}
      </div>
      {empty ? <p className="text-sm text-fg-3">{empty}</p> : asTable ? table : chart}
    </section>
  )
}
