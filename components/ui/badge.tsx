import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Tags (design-system/README.md §6): soft fill + AA text, radius sm.
 * Meeting/pipeline status is not a Badge: use StatusPill from
 * components/ui/meeting-atoms.tsx, and only for exceptions.
 */
const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-sm border border-transparent px-1.5 text-xs font-medium whitespace-nowrap transition-colors duration-(--dur-1) ease-standard focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-transparent has-data-[icon=inline-end]:pe-1 has-data-[icon=inline-start]:ps-1 aria-invalid:border-danger [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-brand-soft text-brand-text [a]:hover:bg-brand-soft-2",
        secondary: "bg-surface-3 text-fg-2 [a]:hover:bg-surface-4",
        destructive: "bg-danger-soft text-danger-text",
        outline: "border-line-strong text-fg-2 [a]:hover:bg-surface-3",
        ghost: "text-fg-2 hover:bg-surface-3",
        info: "bg-info-soft text-info-text",
        warn: "bg-warn-soft text-warn-text",
        ok: "bg-ok-soft text-ok-text",
        link: "text-brand-text underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
