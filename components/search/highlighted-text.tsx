/**
 * A snippet with `<mark>`s from `lib/client/highlight.ts`. Text nodes only,
 * never `dangerouslySetInnerHTML`; a mark whose direction differs from the
 * container is isolated in `<bdi>`.
 */
import { Fragment } from "react"

import { highlightParts, type TextDir } from "@/lib/client/highlight"

export function HighlightedText({
  text,
  ranges,
  dir,
}: {
  text: string
  ranges: readonly (readonly [number, number])[]
  dir: TextDir | "auto"
}) {
  return (
    <>
      {highlightParts(text, ranges, dir).map((part, index) =>
        part.mark ? (
          <mark key={index} className="rounded-xs bg-brand-soft-2 px-0.5 text-fg">
            {part.isolate ? <bdi dir={part.dir}>{part.text}</bdi> : part.text}
          </mark>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        )
      )}
    </>
  )
}
