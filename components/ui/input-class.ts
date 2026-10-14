/**
 * The Input control's classes, shared with server-rendered native inputs that
 * must not pull the base-ui Field runtime into a route (the public share
 * password gate, M10 C). Cadence: --line-control boundary (>=3:1), brand focus
 * with a 3px halo; errors are named next to the field (cause + fix), not by
 * colour alone.
 */
export const INPUT_CLASS =
  "h-8 w-full min-w-0 rounded-md py-1 border border-line-control bg-surface px-2.5 text-md text-fg transition-[border-color,box-shadow] duration-(--dur-1) ease-standard outline-none placeholder:text-fg-3 focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25 focus-visible:outline-2 focus-visible:outline-transparent disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-fg-disabled aria-invalid:border-danger aria-invalid:ring-3 aria-invalid:ring-danger/20 md:text-base file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-fg"

/** The Label primitive's classes (same reason). */
export const LABEL_CLASS =
  "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50"
