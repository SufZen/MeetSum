#!/usr/bin/env node
/**
 * Generates the PWA icons in public/icons/ from the Σ mark
 * (components/ui/sigma-mark.tsx + the `.ms-sigma` transforms in
 * app/globals.css) with `sharp` (docs/parity/m9.md D4). The PNGs are
 * committed; re-run with `npm run pwa:icons` after a brand change.
 *
 * Colours are the light-theme tokens converted from OKLCH to sRGB:
 * --canvas, --spk-1..4 (design-system/tokens.css).
 */
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const outDir = path.join(root, "public", "icons")

export const ICON_COLOURS = {
  canvas: "#f6fafb",
  spk1: "#3883d1",
  spk2: "#d36b2d",
  spk3: "#29975e",
  spk4: "#b556aa",
}

/**
 * The resting Σ in a 28×28 box; `padding` is the share of the canvas kept
 * clear around the 28-unit mark (maskable icons need a ~20% safe zone).
 */
export function sigmaSvg(size, { padding = 0.12, rounded = true } = {}) {
  const c = ICON_COLOURS
  const scale = (size * (1 - padding * 2)) / 28
  const offset = size * padding
  const radius = rounded ? size * 0.22 : 0

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${radius}" fill="${c.canvas}"/>
  <g transform="translate(${offset} ${offset}) scale(${scale})">
    <rect x="5" y="4" width="18" height="3.4" rx="1.7" fill="${c.spk1}"/>
    <rect x="5" y="9.3" width="18" height="3.4" rx="1.7" fill="${c.spk2}" transform="translate(14 11) translate(-3.5 -1) rotate(41.6) scale(0.67 1) translate(-14 -11)"/>
    <rect x="5" y="15.3" width="18" height="3.4" rx="1.7" fill="${c.spk3}" transform="translate(14 17) translate(-3.5 1) rotate(-41.6) scale(0.67 1) translate(-14 -17)"/>
    <rect x="5" y="20.6" width="18" height="3.4" rx="1.7" fill="${c.spk4}"/>
  </g>
</svg>`
}

export const ICONS = [
  { file: "icon-192.png", size: 192, options: {} },
  { file: "icon-512.png", size: 512, options: {} },
  { file: "icon-maskable-512.png", size: 512, options: { padding: 0.24, rounded: false } },
  { file: "apple-touch-icon.png", size: 180, options: { rounded: false } },
]

async function main() {
  const { default: sharp } = await import("sharp")

  await mkdir(outDir, { recursive: true })
  for (const icon of ICONS) {
    const png = await sharp(Buffer.from(sigmaSvg(icon.size, icon.options))).png({ compressionLevel: 9 }).toBuffer()

    await writeFile(path.join(outDir, icon.file), png)
    console.log(`wrote public/icons/${icon.file} (${png.length} bytes)`)
  }
  await writeFile(path.join(outDir, "icon.svg"), sigmaSvg(512))
  console.log("wrote public/icons/icon.svg")
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
