/**
 * Display name of a meeting source (M9): one table for the meeting header
 * and the PDF export. Unknown sources fall back to the id with spaces.
 */
export const MEETING_SOURCE_KEYS: Readonly<Record<string, string>> = {
  pwa_recorder: "mtgSourceRecorder",
  desktop_recorder: "mtgSourceDesktopRecorder",
  upload: "mtgSourceUpload",
  meeting_bot: "mtgSourceBot",
}

export function meetingSourceLabel(source: string, t: (key: string) => string): string {
  if (source === "google_meet") return "Google Meet"

  const key = MEETING_SOURCE_KEYS[source]

  return key ? t(key) : source.replaceAll("_", " ")
}
