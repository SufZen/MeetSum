import type { MetadataRoute } from "next"

/**
 * Web app manifest (docs/parity/m9.md D4). Hebrew-first: `lang: "he"`,
 * `dir: "rtl"`; colours are the light brand and canvas tokens
 * (design-system/tokens.css, OKLCH → sRGB). Icons: scripts/generate-pwa-icons.mjs.
 */
const PWA_THEME_COLOR = "#008073"
const PWA_BACKGROUND_COLOR = "#f6fafb"

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "MeetSum",
    short_name: "MeetSum",
    description: "סיכומי פגישות מבוססי AI",
    lang: "he",
    dir: "rtl",
    start_url: "/?source=pwa",
    scope: "/",
    display: "standalone",
    theme_color: PWA_THEME_COLOR,
    background_color: PWA_BACKGROUND_COLOR,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      {
        name: "הקלטה חדשה",
        short_name: "הקלטה",
        description: "New recording",
        url: "/?panel=meetings&record=1",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
    ],
  }
}
