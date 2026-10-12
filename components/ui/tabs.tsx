"use client"

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-horizontal:flex-col",
        className
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "group/tabs-list relative inline-flex w-fit items-center justify-center text-fg-3 group-data-horizontal/tabs:h-8 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col",
  {
    variants: {
      variant: {
        /** Segmented control: neutral track, raised active segment. */
        default: "rounded-md bg-surface-2 p-0.5",
        /** Cadence tabs: sliding 2px brand ink under the active tab. */
        line: "gap-1 rounded-none bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  children,
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    >
      {children}
      {variant === "line" ? (
        // Base UI measures the active tab in physical px; the ink follows it
        // in both reading directions. Arrow keys follow the DirectionProvider.
        <TabsPrimitive.Indicator
          data-slot="tabs-indicator"
          className="pointer-events-none absolute -bottom-px h-0.5 rounded-full bg-brand transition-[left,width] duration-(--dur-4) ease-emphasized forced-colors:bg-[Highlight] group-data-vertical/tabs:hidden"
          style={{ left: "var(--active-tab-left)", width: "var(--active-tab-width)" }}
        />
      ) : null}
    </TabsPrimitive.List>
  )
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-full flex-1 items-center justify-center gap-1.5 rounded-sm border border-transparent px-2.5 text-base font-medium whitespace-nowrap text-fg-3 transition-[color,background-color,box-shadow] duration-(--dur-1) ease-standard outline-none group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-fg focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-transparent disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pe-1.5 has-data-[icon=inline-start]:ps-1.5 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=default]/tabs-list:data-active:bg-surface group-data-[variant=default]/tabs-list:data-active:text-fg group-data-[variant=default]/tabs-list:data-active:shadow-1",
        "group-data-[variant=line]/tabs-list:rounded-none group-data-[variant=line]/tabs-list:data-active:text-brand-text",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn(
        "flex-1 text-base outline-none",
        className
      )}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
