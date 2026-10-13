import localFont from "next/font/local"

/**
 * Cadence type: one superfamily drawn together so x-heights and weights match
 * when a transcript line switches script mid-sentence. design-system/tokens.css
 * builds --font-ui / --font-he / --font-mono from these variables.
 *
 * Self-hosted (M9): the woff2 files are vendored in assets/fonts/woff2 from
 * IBM's Plex 1.1.0 release (see assets/fonts/README.md), so `next build` never
 * fetches from Google. The PDF export reads the TTFs of the same release.
 *
 * adjustFontFallback is off for the two sans faces: the generated metric
 * fallback (local Arial) covers Hebrew, so it would capture Hebrew glyphs
 * before IBM Plex Sans Hebrew in the --font-ui stack. Turbopack still emits
 * it, which is why tokens.css lists the literal family names first.
 */
export const plexSans = localFont({
  src: [
    { path: "../assets/fonts/woff2/IBMPlexSans-Regular.woff2", weight: "400", style: "normal" },
    { path: "../assets/fonts/woff2/IBMPlexSans-Medium.woff2", weight: "500", style: "normal" },
    { path: "../assets/fonts/woff2/IBMPlexSans-SemiBold.woff2", weight: "600", style: "normal" },
    { path: "../assets/fonts/woff2/IBMPlexSans-Bold.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-plex-sans",
  adjustFontFallback: false,
  display: "swap",
})

export const plexHebrew = localFont({
  src: [
    { path: "../assets/fonts/woff2/IBMPlexSansHebrew-Regular.woff2", weight: "400", style: "normal" },
    { path: "../assets/fonts/woff2/IBMPlexSansHebrew-Medium.woff2", weight: "500", style: "normal" },
    { path: "../assets/fonts/woff2/IBMPlexSansHebrew-SemiBold.woff2", weight: "600", style: "normal" },
    { path: "../assets/fonts/woff2/IBMPlexSansHebrew-Bold.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-plex-hebrew",
  adjustFontFallback: false,
  display: "swap",
})

export const plexMono = localFont({
  src: [
    { path: "../assets/fonts/woff2/IBMPlexMono-Regular.woff2", weight: "400", style: "normal" },
    { path: "../assets/fonts/woff2/IBMPlexMono-Medium.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-plex-mono",
  display: "swap",
})

export const fontVariables = [plexSans.variable, plexHebrew.variable, plexMono.variable].join(" ")
