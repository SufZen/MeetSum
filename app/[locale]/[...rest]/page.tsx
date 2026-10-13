import { notFound } from "next/navigation"

/**
 * Unknown paths under a locale (`/he/does-not-exist`, `/he/xx`) render the
 * localized `[locale]/not-found.tsx` inside the locale layout (lang/dir),
 * with a 404 status, instead of Next's default English page.
 */
export default function UnknownLocalePath(): never {
  notFound()
}
