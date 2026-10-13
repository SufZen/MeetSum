/**
 * Export filenames (docs/parity/m8.md, C3). Owner: Package C.
 *
 * `contentDispositionAttachment(title, ext)` →
 *   attachment; filename="<ascii fallback>"; filename*=UTF-8''<percent-encoded>
 * (RFC 6266 with the RFC 5987 extended parameter), so Hebrew titles survive
 * every browser download, and the client reads the name back from the header
 * (`filenameFromContentDisposition`, `filename*` first) instead of rebuilding
 * it with a regex. Pure; safe on the server and in the browser.
 */

const FALLBACK_BASE = "meetsum-export"
/** Code points, so a surrogate pair is never split. */
const MAX_BASE_CODE_POINTS = 120

/** Removes everything that could break a header or name a path. */
function sanitize(value: string): string {
  return value
    .replace(/[\r\n\t\f\v]+/g, " ")
    .replace(/[\u0000-\u001f\u007f"\\/]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

/** Title → a safe, Unicode-preserving base name (no extension). */
export function exportFileBaseName(title: string | null | undefined): string {
  const clean = sanitize(title ?? "")
  const capped = [...clean].slice(0, MAX_BASE_CODE_POINTS).join("").trim()

  return capped || FALLBACK_BASE
}

function asciiFallback(base: string): string {
  const ascii = base
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")

  return ascii || FALLBACK_BASE
}

/** RFC 5987 `value-chars`: encodeURIComponent plus `'()*`. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

function cleanExtension(ext: string): string {
  return ext.replace(/[^A-Za-z0-9]/g, "").toLowerCase() || "bin"
}

export function contentDispositionAttachment(title: string | null | undefined, ext: string): string {
  const base = exportFileBaseName(title)
  const extension = cleanExtension(ext)

  return `attachment; filename="${asciiFallback(base)}.${extension}"; filename*=UTF-8''${encodeRfc5987(`${base}.${extension}`)}`
}

/**
 * The filename a response asks for (`filename*` first, then `filename`),
 * sanitized so it can never carry a path or a control character. Undefined
 * when the header is missing or unparseable.
 */
export function filenameFromContentDisposition(header: string | null | undefined): string | undefined {
  if (!header) return undefined

  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;\s]+)/i.exec(header)

  if (extended) {
    const charset = extended[1].trim().toLowerCase()

    if (charset === "utf-8" || charset === "") {
      try {
        const name = sanitize(decodeURIComponent(extended[2]))

        return name || undefined
      } catch {
        return undefined
      }
    }
  }

  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(header)
  const name = sanitize(plain?.[1] ?? plain?.[2] ?? "")

  return name || undefined
}
