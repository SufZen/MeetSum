/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: {
    // app/global-not-found.tsx: the root layout is `app/[locale]`, so
    // unmatched URLs and unsupported locales need their own 404 document.
    globalNotFound: true,
    // M10 C (lever 4): per-module imports for the icon and date libraries.
    // Both are on Next's default list today; listing them keeps the rewrite
    // if that list changes. App code already imports icons by name only
    // (no barrels re-exported locally, no `dynamicIconImports`).
    optimizePackageImports: ["lucide-react", "date-fns"],
  },
  // pdfkit reads its AFM metrics through __dirname, so it must stay a real
  // node_modules package instead of being bundled (M9 Hebrew PDF export).
  // pino and @sentry/node (M10 observability) resolve optional modules at
  // run time and must not be bundled either.
  serverExternalPackages: ["pdfkit", "pino", "@sentry/node"],
  // Standalone output only traces imported modules; the PDF export loads the
  // vendored Plex TTFs from disk at run time (lib/pdf/fonts.ts).
  outputFileTracingIncludes: {
    "/api/meetings/[id]/export/pdf": ["./assets/fonts/ttf/**/*", "./assets/fonts/OFL.txt"],
  },
}

export default nextConfig
