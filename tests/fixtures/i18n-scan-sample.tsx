// Scanner fixture for tests/i18n-hardcoded-strings.test.ts (not app code).
declare const toast: { success(message: string): void }

export function Sample({ label }: { label: string }) {
  if (!label) throw new Error("Unable to load")
  toast.success("Saved settings")

  return (
    <div>
      Upload queued
      <button aria-label="Close dialog" type="button" />
      <input placeholder="Search meetings" aria-label={label} />
      <span>MeetSum PDF</span>
      <span>Google Drive</span>
      {/* i18n-allow: fixture shows the opt-out */}
      <span>Allowed text</span>
    </div>
  )
}
