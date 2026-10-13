/**
 * Sections a public share link can expose (M4). `media` (the recording) is
 * opt-in and never part of the defaults.
 */
export const SHARE_SECTIONS = [
  "summary",
  "decisions",
  "action_items",
  "transcript",
  "participants",
  "media",
] as const

export type ShareSection = (typeof SHARE_SECTIONS)[number]

/** Sections of a new share when the caller does not choose (pre-M4 five). */
export const DEFAULT_SHARE_SECTIONS: readonly ShareSection[] = [
  "summary",
  "decisions",
  "action_items",
  "transcript",
  "participants",
]

export class InvalidShareSectionError extends Error {
  readonly section: string

  constructor(section: string) {
    super(`Unknown share section: ${section}`)
    this.name = "InvalidShareSectionError"
    this.section = section
  }
}

export function isShareSection(value: unknown): value is ShareSection {
  return typeof value === "string" && (SHARE_SECTIONS as readonly string[]).includes(value)
}

/**
 * Validates a client-supplied section list: must be an array of known
 * sections (trimmed); duplicates are dropped, order is kept. Throws
 * InvalidShareSectionError on an unknown section or a non-array value.
 */
export function parseShareSections(value: unknown): ShareSection[] {
  if (!Array.isArray(value)) {
    throw new InvalidShareSectionError(String(value))
  }

  const sections: ShareSection[] = []

  for (const entry of value) {
    const section = typeof entry === "string" ? entry.trim() : entry

    if (!isShareSection(section)) {
      throw new InvalidShareSectionError(String(entry))
    }
    if (!sections.includes(section)) sections.push(section)
  }

  return sections
}
