import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Cadence buttons (design-system/README.md §6).
 * - default: brand, one primary per view
 * - secondary / outline: surface + line-strong
 * - ghost: toolbar and inline actions
 * - destructive: danger-soft
 * - ai: iris outline, only where a model will run
 * - record: live hue on hover/pressed, only for "record now"
 * Sizes: xs 24 · sm 28 · default (md) 32 · lg 40. Press = scale(.97) at --dur-1.
 * Focus: transparent 2px outline (survives forced colours) + shadow-focus ring.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,scale] duration-(--dur-1) ease-standard outline-none select-none focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-transparent active:not-aria-[haspopup]:scale-97 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-danger aria-invalid:ring-3 aria-invalid:ring-danger/20 motion-reduce:active:scale-100 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-brand text-on-brand hover:bg-brand-hover aria-expanded:bg-brand-hover",
        outline:
          "border-line-strong bg-surface text-fg hover:bg-surface-3 aria-expanded:bg-surface-3",
        secondary:
          "border-line-strong bg-surface text-fg hover:bg-surface-3 aria-expanded:bg-surface-3",
        ghost:
          "text-fg-2 hover:bg-surface-3 hover:text-fg aria-expanded:bg-surface-3 aria-expanded:text-fg",
        destructive:
          "bg-danger-soft text-danger-text hover:border-danger/40 focus-visible:ring-danger/20",
        ai: "border-ai-line bg-surface text-ai-text hover:border-ai hover:bg-ai-soft aria-expanded:bg-ai-soft",
        record:
          "rounded-full border-line-strong bg-surface text-fg hover:border-live hover:bg-live-soft hover:text-live-text active:bg-live-soft aria-pressed:border-live aria-pressed:bg-live-soft aria-pressed:text-live-text [&_svg]:text-live",
        link: "text-brand-text underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-3 text-base has-data-[icon=inline-end]:pe-2.5 has-data-[icon=inline-start]:ps-2.5",
        xs: "h-6 gap-1 rounded-sm px-2 text-xs in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pe-1.5 has-data-[icon=inline-start]:ps-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 px-2.5 text-sm in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pe-2 has-data-[icon=inline-start]:ps-2 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 gap-2 px-4 text-base has-data-[icon=inline-end]:pe-3 has-data-[icon=inline-start]:ps-3",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-sm in-data-[slot=button-group]:rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 in-data-[slot=button-group]:rounded-md",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
