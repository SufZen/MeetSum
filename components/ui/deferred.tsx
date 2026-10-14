"use client"

/**
 * Load-on-intent for menus and popovers (M10 C, docs/parity/m10.md lever 3).
 *
 * Until the user shows intent, `placeholder(triggerProps)` renders a static
 * copy of the trigger, so the menu, popover and floating-ui code stay out of
 * the first-load chunks. Hover or focus preloads the chunk; a click (Enter
 * and Space click a button too) or ArrowDown/ArrowUp mounts `children`, the
 * lazily loaded real component, already open (`defaultOpen`). While the chunk
 * is still loading the placeholder stays in place (inert), so nothing moves.
 * Once mounted, the real component stays mounted.
 */
import { Suspense, useState, type KeyboardEvent, type ReactNode } from "react"

export type DeferredTriggerProps = {
  onPointerEnter: () => void
  onFocus: () => void
  onClick: () => void
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
  "aria-haspopup": "menu" | "dialog"
  "aria-expanded": false
}

export function Deferred({
  preload,
  placeholder,
  children,
  popup = "menu",
}: {
  /** Imports the real component's module (call it from `lazy()` too). */
  preload: () => Promise<unknown>
  /** The static trigger; spread `props` on it (undefined while loading). */
  placeholder: (props: DeferredTriggerProps | undefined) => ReactNode
  /** The real component; `defaultOpen` is true when mounted by a click. */
  children: (options: { defaultOpen: boolean }) => ReactNode
  popup?: "menu" | "dialog"
}) {
  const [active, setActive] = useState(false)

  if (active) {
    return <Suspense fallback={placeholder(undefined)}>{children({ defaultOpen: true })}</Suspense>
  }

  const warm = () => void preload().catch(() => undefined)

  return placeholder({
    onPointerEnter: warm,
    onFocus: warm,
    onClick: () => setActive(true),
    onKeyDown: (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
      event.preventDefault()
      setActive(true)
    },
    "aria-haspopup": popup,
    "aria-expanded": false,
  })
}
