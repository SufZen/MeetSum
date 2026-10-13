/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // pdfkit reads its AFM metrics through __dirname, so it must stay a real
  // node_modules package instead of being bundled (M9 Hebrew PDF export).
  serverExternalPackages: ["pdfkit"],
  // Standalone output only traces imported modules; the PDF export loads the
  // vendored Plex TTFs from disk at run time (lib/pdf/fonts.ts).
  outputFileTracingIncludes: {
    "/api/meetings/[id]/export/pdf": ["./assets/fonts/ttf/**/*", "./assets/fonts/OFL.txt"],
  },
}

export default nextConfig
