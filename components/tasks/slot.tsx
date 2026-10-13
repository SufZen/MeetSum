import type { ReactNode } from "react"

/**
 * Renders a "{key}" message template with `node` in place of the slot, so
 * names and dates stay isolated (`<bdi>`, LTR timecodes) inside a sentence
 * of either direction. No bidi control characters.
 */
export function withSlot(template: string, key: string, node: ReactNode): ReactNode {
  const [before, after = ""] = template.split(`{${key}}`)

  return (
    <>
      {before}
      {node}
      {after}
    </>
  )
}

/** A date or count rendered LTR-isolated, tabular (design-system §8.4). */
export function Isolated({ children }: { children: ReactNode }) {
  return <span className="tabular-nums [direction:ltr] [unicode-bidi:isolate]">{children}</span>
}
