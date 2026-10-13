/**
 * MeetSum Cadence meeting atoms: the components generic kits don't have.
 * They depend only on the Cadence tokens (design-system/tokens.css, registered
 * in @theme) and lucide. Spec: design-system/README.md §6.
 *
 * Bidi rules baked in:
 *   - timecodes are always LTR-isolated, mono and tabular
 *   - names render inside <bdi> so they never reorder a Hebrew sentence
 *   - content direction comes from the caller's known language (`dir` prop),
 *     never from dir="auto" (first-strong-character flips "Lisboa Riverside
 *     נכנסת…" to LTR)
 */
"use client"

import { Children, type ComponentProps, type ReactNode } from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { CircleAlert, LoaderCircle, Pencil, Play, X } from "lucide-react"

import { cn } from "@/lib/utils"

/* ------------------------------------------------------------ cited mark */

/**
 * The AI mark is a citation: a play head inside brackets. It replaces the
 * generic sparkle everywhere model-written content is labelled.
 */
export function CitedMark({ className, ...props }: ComponentProps<"svg">) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn("size-4 shrink-0", className)}
      {...props}
    >
      <path d="M8 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20H8" />
      <path d="M16 4h2.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H16" />
      <path d="M10 8.6v6.8l5.2-3.4Z" fill="currentColor" strokeWidth={1.2} />
    </svg>
  )
}

/* ------------------------------------------------------------- timecode */

export function formatTimecode(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, "0")
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`
}

const timecodeBase =
  "inline-flex h-5 items-center rounded-xs bg-surface-3 px-1.5 font-mono text-xs tabular-nums text-fg-2 [direction:ltr] [unicode-bidi:isolate]"

export function TimecodeChip({
  seconds,
  className,
  ...props
}: { seconds: number } & Omit<ComponentProps<"span">, "children">) {
  return (
    <span className={cn(timecodeBase, className)} {...props}>
      {formatTimecode(seconds)}
    </span>
  )
}

/**
 * A timecode you can play. Render it only when `seconds` resolves to a real
 * transcript segment; an unresolvable citation is worse than none.
 * Hovering or focusing it should light its source lane on the timeline
 * (source trace): pass `onTrace` to wire that up.
 */
export function CitationChip({
  seconds,
  label = "Play source at",
  onTrace,
  className,
  ...props
}: { seconds: number; label?: string; onTrace?: (active: boolean) => void } & Omit<ComponentProps<"button">, "children">) {
  const tc = formatTimecode(seconds)
  return (
    <button
      type="button"
      aria-label={`${label} ${tc}`}
      onPointerEnter={() => onTrace?.(true)}
      onPointerLeave={() => onTrace?.(false)}
      onFocus={() => onTrace?.(true)}
      onBlur={() => onTrace?.(false)}
      className={cn(
        timecodeBase,
        "cursor-pointer gap-0.5 ps-1 pe-1.5 transition-colors duration-(--dur-1) ease-standard hover:bg-brand-soft-2 hover:text-brand-text aria-expanded:bg-brand-soft-2 aria-expanded:text-brand-text focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent",
        className
      )}
      {...props}
    >
      <Play aria-hidden className="size-2.5 fill-current" />
      {tc}
    </button>
  )
}

/* ------------------------------------------------------------- speakers */

export type SpeakerColor = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

const speakerVar: Record<SpeakerColor, string> = {
  1: "var(--spk-1)", 2: "var(--spk-2)", 3: "var(--spk-3)", 4: "var(--spk-4)",
  5: "var(--spk-5)", 6: "var(--spk-6)", 7: "var(--spk-7)", 8: "var(--spk-8)",
}

/** Stable colour per person: assign in order of first speech, then persist. */
export function speakerColor(index: number): SpeakerColor {
  return ((((index % 8) + 8) % 8) + 1) as SpeakerColor
}

/**
 * Provenance hairline: the speakers a claim is drawn from, in order of first
 * citation, as equal colour bands. Use as `--prov` on AiProvenance or any
 * element with a start-edge hairline.
 */
export function provenanceGradient(colors: SpeakerColor[]): string {
  const unique = [...new Set(colors)]
  if (!unique.length) return "var(--ai-line)"
  const n = unique.length
  return `linear-gradient(${unique
    .map((c, k) => `${speakerVar[c]} ${((k / n) * 100).toFixed(1)}% ${(((k + 1) / n) * 100).toFixed(1)}%`)
    .join(", ")})`
}

const avatarVariants = cva(
  "inline-grid shrink-0 place-items-center rounded-full font-semibold tracking-normal forced-color-adjust-none text-[color-mix(in_oklch,var(--c)_70%,var(--fg))] bg-[color-mix(in_oklch,var(--c)_var(--spk-soft-mix),var(--surface))] shadow-[inset_0_0_0_1.5px_color-mix(in_oklch,var(--c)_55%,transparent)]",
  {
    variants: {
      size: {
        xs: "size-5.5 text-3xs",
        sm: "size-6.5 text-2xs",
        md: "size-9 text-xs",
      },
      unconfirmed: {
        true: "border border-dashed border-[color-mix(in_oklch,var(--c)_75%,transparent)] shadow-none",
        false: "",
      },
    },
    defaultVariants: { size: "sm", unconfirmed: false },
  }
)

export function SpeakerAvatar({
  initials,
  color,
  size,
  unconfirmed,
  className,
  style,
  ...props
}: { initials: string; color: SpeakerColor } & VariantProps<typeof avatarVariants> &
  Omit<ComponentProps<"span">, "children" | "color">) {
  return (
    <span
      aria-hidden
      className={cn(avatarVariants({ size, unconfirmed }), className)}
      style={{ ["--c" as string]: speakerVar[color], ...style }}
      {...props}
    >
      {initials}
    </span>
  )
}

export function SpeakerLabel({
  name,
  initials,
  color,
  unconfirmedLabel,
  className,
}: {
  name: string
  initials: string
  color: SpeakerColor
  /** e.g. "unconfirmed" / "לא אושר" — shown until a person confirms the name */
  unconfirmedLabel?: string
  className?: string
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm font-medium", className)}>
      <SpeakerAvatar initials={initials} color={color} size="xs" unconfirmed={!!unconfirmedLabel} />
      <bdi>{name}</bdi>
      {unconfirmedLabel ? <small className="text-xs font-normal text-warn-text">{unconfirmedLabel}</small> : null}
    </span>
  )
}

/** Shows `max` people, then a neutral +N. Overlap is 2px so initials never clip. */
export function AvatarStack({ children, max = 3, className }: { children: ReactNode; max?: number; className?: string }) {
  const people = Children.toArray(children)
  const extra = people.length - max
  return (
    <span className={cn("inline-flex [&>*+*]:-ms-0.5 [&>*]:ring-2 [&>*]:ring-surface", className)}>
      {people.slice(0, max)}
      {extra > 0 ? (
        <span aria-hidden className="inline-grid size-5.5 place-items-center rounded-full bg-surface-3 text-3xs font-semibold text-fg-2">
          +{extra}
        </span>
      ) : null}
    </span>
  )
}

/* --------------------------------------------------------------- status */

export function LiveDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("size-2 shrink-0 rounded-full bg-live forced-color-adjust-none animate-ms-live motion-reduce:animate-none motion-reduce:ring-2 motion-reduce:ring-live/35", className)}
    />
  )
}

const pillVariants = cva(
  "inline-flex h-5.5 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-xs font-medium [&_svg]:size-3 [&_svg]:stroke-[2.2]",
  {
    variants: {
      status: {
        live: "bg-live-soft text-live-text",
        processing: "bg-info-soft text-info-text",
        new: "bg-brand-soft-2 text-brand-text",
        review: "bg-warn-soft text-warn-text",
        failed: "bg-danger-soft text-danger-text",
      },
    },
    defaultVariants: { status: "review" },
  }
)

/**
 * Exceptions only: a finished meeting gets no pill. State is carried by icon +
 * colour + text so it reads in greyscale. `progress` is shown only when it is
 * a real number (never invent one).
 */
export function StatusPill({
  status,
  children,
  progress,
  className,
}: VariantProps<typeof pillVariants> & { children: ReactNode; progress?: number; className?: string }) {
  const icon =
    status === "live" ? <LiveDot /> :
    status === "processing" ? <LoaderCircle aria-hidden className="animate-spin motion-reduce:animate-[spin_2.4s_linear_infinite]" /> :
    status === "failed" ? <X aria-hidden /> :
    status === "new" ? null :
    <CircleAlert aria-hidden />
  return (
    <span className={cn(pillVariants({ status }), className)}>
      {icon}
      {children}
      {typeof progress === "number" ? (
        <span className="font-mono tabular-nums [direction:ltr] [unicode-bidi:isolate]">{Math.round(progress)}%</span>
      ) : null}
    </span>
  )
}

/* ------------------------------------------------------------ provenance */

/**
 * Wraps model-written content. No violet slab: a start-edge hairline split into
 * the colours of the speakers it cites, plus the cited mark and a label. Once a
 * person edits it, it becomes theirs: the hairline goes, the label names the
 * editor, and the edit must survive reprocessing.
 */
export function AiProvenance({
  state,
  label,
  dir,
  sources = [],
  children,
  className,
}: {
  /** `auto`: machine-made but not AI (heuristic summary) — no iris mark. */
  state: "ai" | "edited" | "streaming" | "auto"
  /** "AI · from 3 speakers", "Edited by Ran", "Writing"… localised by the caller */
  label: string
  /** direction of the content's language — required, never "auto" for known text */
  dir: "ltr" | "rtl"
  /** speakers cited by this text, in order of first citation */
  sources?: SpeakerColor[]
  children: ReactNode
  className?: string
}) {
  // Iris (AI) styling only for AI content; edited and automatic content use
  // the neutral frame.
  const human = state === "edited" || state === "auto"
  return (
    <div
      dir={dir}
      style={human ? undefined : { ["--prov" as string]: provenanceGradient(sources) }}
      className={cn(
        "relative grid gap-1 ps-4",
        human
          ? "rounded-md py-2 pe-3 shadow-[inset_0_0_0_1px_var(--line)]"
          : "py-1.5 before:absolute before:inset-y-1.5 before:start-0 before:w-0.75 before:rounded-full before:bg-(image:--prov) before:content-['']",
        className
      )}
    >
      <span className={cn("inline-flex items-center gap-1 text-xs font-medium", human ? "text-fg-3" : "text-ai-text")}>
        {state === "edited" ? (
          <Pencil aria-hidden className="size-3" />
        ) : state === "auto" ? null : (
          <CitedMark className="size-3.5" />
        )}
        {label}
      </span>
      <div className="text-md text-fg">
        {children}
        {state === "streaming" ? (
          <span aria-hidden className="ms-0.5 inline-block h-[1.05em] w-0.5 bg-ai align-[-0.15em] animate-ms-caret motion-reduce:animate-none" />
        ) : null}
      </div>
    </div>
  )
}
