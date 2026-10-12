import { IBM_Plex_Mono, IBM_Plex_Sans, IBM_Plex_Sans_Hebrew } from "next/font/google"

/**
 * Cadence type: one superfamily drawn together so x-heights and weights match
 * when a transcript line switches script mid-sentence. design-system/tokens.css
 * builds --font-ui / --font-he / --font-mono from these variables.
 *
 * adjustFontFallback is off for the two sans faces: the generated metric
 * fallback (local Arial) covers Hebrew, so it would capture Hebrew glyphs
 * before IBM Plex Sans Hebrew in the --font-ui stack. Turbopack still emits
 * it, which is why tokens.css lists the literal family names first.
 */
export const plexSans = IBM_Plex_Sans({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex-sans",
  adjustFontFallback: false,
  display: "swap",
})

export const plexHebrew = IBM_Plex_Sans_Hebrew({
  subsets: ["hebrew", "latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex-hebrew",
  adjustFontFallback: false,
  display: "swap",
})

export const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
  display: "swap",
})

export const fontVariables = [plexSans.variable, plexHebrew.variable, plexMono.variable].join(" ")
