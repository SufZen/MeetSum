export const GOOGLE_WORKSPACE_SCOPES = {
  calendar: [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events.readonly",
  ],
  gmail: ["https://www.googleapis.com/auth/gmail.readonly"],
  drive: [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/drive.metadata.readonly",
  ],
  admin: [
    "https://www.googleapis.com/auth/admin.directory.user.readonly",
    "https://www.googleapis.com/auth/admin.directory.group.readonly",
  ],
} as const

export type GoogleSyncSource = "calendar" | "gmail" | "drive"

export type GoogleSyncPlanItem = {
  source: GoogleSyncSource
  subject: string
  mode: "incremental-watch" | "polling" | "changes-watch"
}

export function buildGoogleSyncPlan(subject: string): GoogleSyncPlanItem[] {
  return [
    { source: "calendar", subject, mode: "incremental-watch" },
    { source: "gmail", subject, mode: "polling" },
    { source: "drive", subject, mode: "changes-watch" },
  ]
}

export function flattenGoogleWorkspaceScopes(): string[] {
  return Object.values(GOOGLE_WORKSPACE_SCOPES).flat()
}
