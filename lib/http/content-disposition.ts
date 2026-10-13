/**
 * Export filenames (docs/parity/m8.md C3, hardened in docs/parity/m9.md
 * "Filenames"; owner since M9: Package B).
 *
 * `contentDispositionAttachment(title, ext, { date, id })` →
 *   attachment; filename="<ascii fallback>"; filename*=UTF-8''<percent-encoded>
 * (RFC 6266 with the RFC 5987 extended parameter), so Hebrew titles survive
 * every browser download, and the client reads the name back from the header
 * (`filenameFromContentDisposition`, `filename*` first) instead of rebuilding
 * it with a regex. Pure; safe on the server and in the browser.
 *
 * Hardening (M9): NFC; bidi controls and C0/C1 controls stripped; `<>:"/\|?*`
 * become `-`; whitespace collapsed; trailing dots and spaces trimmed; Windows
 * reserved device names get a `_` prefix; 120 code points max (a surrogate
 * pair is never split) with the extension after the cap. A title with fewer
 * than 3 ASCII letters gets the dated fallback `meetsum-<yyyy-mm-dd>-<id8>`.
 */

const FALLBACK_BASE = "meetsum-export"
/** Code points, so a surrogate pair is never split. */
const MAX_BASE_CODE_POINTS = 120
/** ALM, LRM, RLM, LRE/RLE/PDF/LRO/RLO, LRI/RLI/FSI/PDI. */
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g
const C0_C1_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g
const WINDOWS_FORBIDDEN = /[<>:"/\\|?*]/g
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i

export type ExportFilenameOptions = {
  /** The meeting's date (Date or ISO string); used by the dated ASCII fallback. */
  date?: Date | string | null
  /** The meeting id; its first 8 alphanumerics go into the dated fallback. */
  id?: string | null
}

/** Removes everything that could break a header, spoof a name or name a path. */
function sanitize(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[\r\n\t\f\v]+/g, " ")
    .replace(BIDI_CONTROLS, "")
    .replace(C0_C1_CONTROLS, "")
    .replace(WINDOWS_FORBIDDEN, "-")
    .replace(/\s+/g, " ")
    .trim()
}

function trimTrailingDotsAndSpaces(value: string): string {
  return value.replace(/[. ]+$/u, "")
}

/** `CON`, `nul`, `COM1`, `LPT¹`… (with or without a dotted suffix) → `_CON`. */
function escapeReserved(value: string): string {
  const stem = value.split(".")[0]?.trim() ?? ""

  return WINDOWS_RESERVED.test(stem) ? `_${value}` : value
}

function hardenBase(value: string): string {
  const clean = trimTrailingDotsAndSpaces(sanitize(value))
  const capped = trimTrailingDotsAndSpaces([...clean].slice(0, MAX_BASE_CODE_POINTS).join("").trim())

  return capped ? escapeReserved(capped) : ""
}

/** Title → a safe, Unicode-preserving base name (no extension). */
export function exportFileBaseName(title: string | null | undefined): string {
  return hardenBase(title ?? "") || FALLBACK_BASE
}

function isoDate(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined

  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10)

  const date = value instanceof Date ? value : new Date(value)

  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10)
}

function datedFallback(options: ExportFilenameOptions): string {
  const date = isoDate(options.date)
  const id8 = (options.id ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 8)

  return [FALLBACK_BASE.replace(/-export$/, ""), date, id8].filter(Boolean).join("-")
}

function asciiFallback(base: string, options?: ExportFilenameOptions): string {
  const ascii = base
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
  const letters = (ascii.match(/[A-Za-z]/g) ?? []).length

  if (letters >= 3) return ascii

  if (options && (options.date || options.id)) return datedFallback(options)

  return FALLBACK_BASE
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

/** The ASCII `filename=` value alone (exposed for tests and logs). */
export function exportAsciiFilename(
  title: string | null | undefined,
  ext: string,
  options?: ExportFilenameOptions
): string {
  return `${asciiFallback(exportFileBaseName(title), options)}.${cleanExtension(ext)}`
}

export function contentDispositionAttachment(
  title: string | null | undefined,
  ext: string,
  options?: ExportFilenameOptions
): string {
  const base = exportFileBaseName(title)
  const extension = cleanExtension(ext)

  return `attachment; filename="${asciiFallback(base, options)}.${extension}"; filename*=UTF-8''${encodeRfc5987(`${base}.${extension}`)}`
}

/** A received name → the same hardening, keeping its extension. */
function hardenReceived(name: string): string | undefined {
  const clean = sanitize(name)
  const match = /^(.+)\.([A-Za-z0-9]{1,10})$/.exec(clean)
  const ext = match?.[2] ?? ""
  const base = hardenBase(match ? match[1] : clean)

  if (!base) return undefined

  return ext ? `${base}.${ext.toLowerCase()}` : base
}

/**
 * The filename a response asks for (`filename*` first, then `filename`),
 * hardened so it can never carry a path, a bidi or control character, or a
 * reserved device name. Undefined when the header is missing or unparseable.
 */
export function filenameFromContentDisposition(header: string | null | undefined): string | undefined {
  if (!header) return undefined

  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;\s]+)/i.exec(header)

  if (extended) {
    const charset = extended[1].trim().toLowerCase()

    if (charset === "utf-8" || charset === "") {
      try {
        return hardenReceived(decodeURIComponent(extended[2]))
      } catch {
        return undefined
      }
    }
  }

  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(header)

  return hardenReceived(plain?.[1] ?? plain?.[2] ?? "")
}
