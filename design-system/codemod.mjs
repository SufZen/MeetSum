#!/usr/bin/env node
// Cadence phase-1 codemod: legacy arbitrary-var classes -> registered utilities.
//
//   node design-system/codemod.mjs            # rewrite files in place
//   node design-system/codemod.mjs --dry-run  # report only
//   node design-system/codemod.mjs app/x.tsx  # custom roots/files
//
// Every rewrite is driven by the explicit tables below so the change is
// reviewable. Anything not in a table is left alone (and still reported by
// design-system/check.mjs).
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const roots = args.filter((a) => !a.startsWith("--"))
const scan = roots.length ? roots : ["components", "app"]

/* --------------------------------------------------------------------------
   1. Legacy CSS variable -> Cadence colour name.
   `default` is used for bg/border/ring/divide/accent/outline/fill/stroke…;
   `text` (when present) is used for text-* because status/brand hues have a
   dedicated AA text step (`--ok-text`, `--brand-text`, …).
   -------------------------------------------------------------------------- */
const COLOR_MAP = {
  // surfaces
  surface: { default: "surface" },
  "surface-subtle": { default: "surface-2" },
  rail: { default: "surface-2" },
  "surface-hover": { default: "surface-3" },
  "app-bg": { default: "canvas" },
  muted: { default: "surface-2" },
  sidebar: { default: "canvas" },
  "sidebar-accent": { default: "surface-3" },
  // lines
  divider: { default: "line" },
  border: { default: "line" },
  "sidebar-border": { default: "line" },
  // text
  "text-primary": { default: "fg" },
  "text-secondary": { default: "fg-2" },
  "text-muted": { default: "fg-3" },
  "muted-foreground": { default: "fg-3" },
  // brand / selection / focus
  primary: { default: "brand", text: "brand-text" },
  "primary-foreground": { default: "on-brand" },
  selected: { default: "brand-soft" },
  "sidebar-primary": { default: "brand-soft" },
  "sidebar-primary-foreground": { default: "brand-text" },
  focus: { default: "ring" }, // --color-ring = --ring = --focus
  // v1 --accent was an amber highlight used next to action tags
  accent: { default: "warn" },
  // status
  "status-success": { default: "ok", text: "ok-text" },
  "status-warning": { default: "warn", text: "warn-text" },
  "status-error": { default: "danger", text: "danger-text" },
  "status-info": { default: "info", text: "info-text" },
  "status-ai": { default: "ai", text: "ai-text" }, // model state only
  // tags (soft fill + AA text)
  "tag-action": { default: "warn-soft" },
  "tag-action-fg": { default: "warn-text" },
  "tag-business": { default: "brand-soft" },
  "tag-business-fg": { default: "brand-text" },
  "tag-technical": { default: "info-soft" },
  "tag-technical-fg": { default: "info-text" },
  // v1 "AI" tags were applied to language/topic tags ("hebrew", "mixed"…),
  // which are not model-written content. Iris is reserved, so they go neutral.
  "tag-ai": { default: "surface-3" },
  "tag-ai-fg": { default: "fg-2" },
}

const COLOR_UTILITIES = [
  "bg", "text", "border", "border-x", "border-y", "border-t", "border-b", "border-s", "border-e",
  "ring", "divide", "accent", "outline", "fill", "stroke", "placeholder", "decoration", "caret",
  "from", "via", "to",
]

/* 2. Arbitrary sizes -> type scale. */
const SIZE_MAP = {
  "text-[11px]": "text-2xs", // README: replaces 30× text-[11px]
  "text-[10px]": "text-2xs", // nearest step; 9px is reserved for avatar initials
  "text-[0.8rem]": "text-xs", // shadcn's 12.8px small text
}

/* 3. Physical direction -> logical. `rtl:text-*` fallbacks are dropped first
   because `text-start` already flips. */
const PHYSICAL_MAP = { ml: "ms", mr: "me", pl: "ps", pr: "pe", left: "start", right: "end" }
// shadcn primitives whose `side="left|right"` API is physical by design
const PHYSICAL_SKIP = new Set(["components/ui/sheet.tsx", "components/ui/sidebar.tsx", "components/ui/tooltip.tsx"])

const BOUNDARY = String.raw`(?<=^|[\s"'\x60:])`
const colorRe = new RegExp(
  `${BOUNDARY}(${COLOR_UTILITIES.map((u) => u.replace("-", "\\-")).join("|")})-\\[var\\(--([\\w-]+)\\)\\]`,
  "g"
)
const physicalRe = new RegExp(`${BOUNDARY}(-?)(ml|mr|pl|pr|left|right)-(?=[\\w[.])`, "g")

function walk(path, out = []) {
  const st = statSync(path)
  if (st.isFile()) {
    if (/\.(tsx|ts)$/.test(path) && !path.endsWith(".d.ts")) out.push(path)
    return out
  }
  for (const name of readdirSync(path)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    walk(join(path, name), out)
  }
  return out
}

const stats = { files: 0, color: 0, size: 0, physical: 0, unmapped: {} }

for (const root of scan) {
  for (const file of walk(root)) {
    const rel = relative(process.cwd(), file).replaceAll("\\", "/")
    const src = readFileSync(file, "utf8")
    let out = src

    out = out.replace(colorRe, (match, utility, name) => {
      const entry = COLOR_MAP[name]
      if (!entry) {
        stats.unmapped[match] = (stats.unmapped[match] ?? 0) + 1
        return match
      }
      stats.color++
      return `${utility}-${utility === "text" && entry.text ? entry.text : entry.default}`
    })

    for (const [from, to] of Object.entries(SIZE_MAP)) {
      const parts = out.split(from)
      if (parts.length > 1) {
        stats.size += parts.length - 1
        out = parts.join(to)
      }
    }

    if (!PHYSICAL_SKIP.has(rel)) {
      out = out.replace(/\s?\brtl:text-(?:left|right)\b/g, () => {
        stats.physical++
        return ""
      })
      out = out.replace(/(?<![\w-])text-(left|right)(?![\w-])/g, (_, side) => {
        stats.physical++
        return side === "left" ? "text-start" : "text-end"
      })
      out = out.replace(physicalRe, (_, neg, prop) => {
        stats.physical++
        return `${neg}${PHYSICAL_MAP[prop]}-`
      })
    }

    if (out !== src) {
      stats.files++
      if (!dryRun) writeFileSync(file, out)
      console.log(`${dryRun ? "would rewrite" : "rewrote"} ${rel}`)
    }
  }
}

console.log(
  `\n${stats.files} files · ${stats.color} colour classes · ${stats.size} size classes · ${stats.physical} direction classes`
)
const unmapped = Object.entries(stats.unmapped)
if (unmapped.length) {
  console.log("\nunmapped (left as-is):")
  for (const [cls, n] of unmapped.sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${cls}`)
}
