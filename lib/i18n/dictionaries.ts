import { asrMessagesEn, asrMessagesHe } from "@/lib/i18n/asr-messages"
import { botMessagesEn, botMessagesHe } from "@/lib/i18n/m7/bot"
import { playerMessagesEn, playerMessagesHe } from "@/lib/i18n/player-messages"
import { clipsMessagesEn, clipsMessagesHe } from "@/lib/i18n/m5/clips"
import { commentsMessagesEn, commentsMessagesHe } from "@/lib/i18n/m5/comments"
import {
  intelligenceMessagesEn,
  intelligenceMessagesHe,
} from "@/lib/i18n/m5/intelligence"
import { tasksMessagesEn, tasksMessagesHe } from "@/lib/i18n/m5/tasks"
import { askMessagesEn, askMessagesHe } from "@/lib/i18n/m6/ask"
import { searchMessagesEn, searchMessagesHe } from "@/lib/i18n/m6/search"
import { exportsMessagesEn, exportsMessagesHe } from "@/lib/i18n/m8/exports"
import { integrationsMessagesEn, integrationsMessagesHe } from "@/lib/i18n/m8/integrations"
import type { SupportedLocale } from "@/lib/i18n/locales"
import { m9AnalyticsMessages } from "@/lib/i18n/m9/analytics"
import { m9CoreMessages } from "@/lib/i18n/m9/core"
import { m9ExportsMessages } from "@/lib/i18n/m9/exports"
import { m9NotificationsMessages } from "@/lib/i18n/m9/notifications"
import { m9OnboardingMessages } from "@/lib/i18n/m9/onboarding"
import { m9PwaMessages } from "@/lib/i18n/m9/pwa"
import { m9SettingsMessages } from "@/lib/i18n/m9/settings"
import { m9ShareMessages } from "@/lib/i18n/m9/share"
import { m9ShellMessages } from "@/lib/i18n/m9/shell"
import {
  workspaceMessagesEn,
  workspaceMessagesHe,
} from "@/lib/i18n/workspace-messages"

export { formatMessage } from "@/lib/i18n/workspace-messages"

/**
 * M9 message modules (`lib/i18n/m9/*`), each `{ en, he }`, one owner per
 * module (docs/parity/m9.md, Step 0 item 5). Hebrew may carry extra `_two`
 * plural keys; `tests/i18n-keys.test.ts` checks parity and collisions.
 */
export const M9_MESSAGE_MODULES = {
  core: m9CoreMessages,
  settings: m9SettingsMessages,
  exports: m9ExportsMessages,
  share: m9ShareMessages,
  notifications: m9NotificationsMessages,
  analytics: m9AnalyticsMessages,
  onboarding: m9OnboardingMessages,
  shell: m9ShellMessages,
  pwa: m9PwaMessages,
} as const

export const dictionaries = {
  en: {
    appSubtitle: "AI-first meeting intelligence",
    navMeetings: "Meetings",
    navMemory: "AI Memory",
    navWorkspace: "Google Workspace",
    navAutomations: "Automations",
    navStorage: "Storage",
    navManual: "Manual",
    navSettings: "Settings",
    workspaceSync: "Workspace sync",
    queued: "queued",
    commandPlaceholder: "Search meetings, Hebrew notes, decisions",
    controlPlane: "Self-hosted control plane",
    pageTitle: "Meetings, memory, automations",
    upload: "Upload",
    sync: "Sync",
    syncing: "Syncing",
    calendarSync: "Calendar sync",
    findDriveRecordings: "Find Drive recordings",
    gmailContext: "Gmail context",
    filter: "Filter",
    sortRecent: "Sort: Recent",
    all: "All",
    myMeetings: "My Meetings",
    runAgent: "Run agent",
    selectedMeeting: "Selected meeting",
    summary: "Summary",
    transcript: "Transcript",
    ask: "Ask",
    overview: "Overview",
    decisions: "Decisions",
    actionItems: "Action items",
    unassigned: "Unassigned",
    askMeetingMemory: "Ask meeting memory",
    askDefaultQuestion: "What should RealizeOS receive?",
    noMeetingsTitle: "No meetings yet",
    noMeetingsDescription:
      "Upload audio, record in the browser, or sync Google Workspace to start building meeting memory.",
    pipeline: "Pipeline",
    tags: "Tags",
    integrations: "Integrations",
    automationBus: "Automation bus",
    storagePolicy: "Storage policy",
    audioFirst: "Audio-first",
    videoRetained: "Video retained only when configured",
    language: "Language",
    mixedLanguage: "Mixed language",
    contexts: "Rooms",
    followUp: "Follow-up",
    recorderReady: "Ready for in-person audio",
    record: "Record",
    stop: "Stop",
    recording: "Recording",
    recorderBlocked: "Microphone blocked",
    recorderUnsupported: "Recorder unsupported",
    signInTitle: "Sign in to MeetSum",
    signInDescription:
      "Use your Google Workspace account to access private meeting intelligence.",
    signInWithGoogle: "Continue with Google",
    signInRestricted: "Access is by invitation to a workspace.",
    ...workspaceMessagesEn,
    ...asrMessagesEn,
    ...playerMessagesEn,
    ...botMessagesEn,
    ...intelligenceMessagesEn,
    ...tasksMessagesEn,
    ...clipsMessagesEn,
    ...commentsMessagesEn,
    ...searchMessagesEn,
    ...askMessagesEn,
    ...integrationsMessagesEn,
    ...exportsMessagesEn,
    ...m9CoreMessages.en,
    ...m9SettingsMessages.en,
    ...m9ExportsMessages.en,
    ...m9ShareMessages.en,
    ...m9NotificationsMessages.en,
    ...m9AnalyticsMessages.en,
    ...m9OnboardingMessages.en,
    ...m9ShellMessages.en,
    ...m9PwaMessages.en,
  },
  he: {
    appSubtitle: "מודיעין פגישות מבוסס AI",
    navMeetings: "פגישות",
    navMemory: "זיכרון AI",
    navWorkspace: "Google Workspace",
    navAutomations: "אוטומציות",
    navStorage: "אחסון",
    navManual: "מדריך",
    navSettings: "הגדרות",
    workspaceSync: "סנכרון Workspace",
    queued: "בתור",
    commandPlaceholder: "חיפוש פגישות, הערות בעברית והחלטות",
    controlPlane: "לוח בקרה באחסון עצמי",
    pageTitle: "פגישות, זיכרון ואוטומציות",
    upload: "העלאה",
    sync: "סנכרון",
    syncing: "מסנכרן",
    calendarSync: "סנכרון יומן",
    findDriveRecordings: "איתור הקלטות Drive",
    gmailContext: "הקשר Gmail",
    filter: "סינון",
    sortRecent: "מיון: אחרונים",
    all: "הכל",
    myMeetings: "הפגישות שלי",
    runAgent: "הרצת סוכן",
    selectedMeeting: "פגישה נבחרת",
    summary: "סיכום",
    transcript: "תמלול",
    ask: "שאלה",
    overview: "סקירה",
    decisions: "החלטות",
    actionItems: "משימות",
    unassigned: "לא משויך",
    askMeetingMemory: "שאלה לזיכרון הפגישה",
    askDefaultQuestion: "מה RealizeOS צריך לקבל?",
    noMeetingsTitle: "אין פגישות עדיין",
    noMeetingsDescription:
      "העלו אודיו, הקליטו בדפדפן או סנכרנו את Google Workspace כדי להתחיל לבנות זיכרון פגישות.",
    pipeline: "צינור עיבוד",
    tags: "תגיות",
    integrations: "אינטגרציות",
    automationBus: "אוטומציות",
    storagePolicy: "מדיניות אחסון",
    audioFirst: "אודיו תחילה",
    videoRetained: "וידאו נשמר רק כשהוגדר",
    language: "שפה",
    mixedLanguage: "שפה מעורבת",
    contexts: "חדרים",
    followUp: "מעקב",
    recorderReady: "מוכן להקלטת אודיו",
    record: "הקלטה",
    stop: "עצירה",
    recording: "מקליט",
    recorderBlocked: "המיקרופון חסום",
    recorderUnsupported: "הקלטה לא נתמכת",
    signInTitle: "כניסה ל-\u2060MeetSum",
    signInDescription:
      "התחברו עם חשבון Google Workspace כדי לגשת למודיעין הפגישות הפרטי.",
    signInWithGoogle: "כניסה עם Google",
    signInRestricted: "הגישה מתאפשרת בהזמנה לסביבת עבודה.",
    ...workspaceMessagesHe,
    ...asrMessagesHe,
    ...playerMessagesHe,
    ...botMessagesHe,
    ...intelligenceMessagesHe,
    ...tasksMessagesHe,
    ...clipsMessagesHe,
    ...commentsMessagesHe,
    ...searchMessagesHe,
    ...askMessagesHe,
    ...integrationsMessagesHe,
    ...exportsMessagesHe,
    ...m9CoreMessages.he,
    ...m9SettingsMessages.he,
    ...m9ExportsMessages.he,
    ...m9ShareMessages.he,
    ...m9NotificationsMessages.he,
    ...m9AnalyticsMessages.he,
    ...m9OnboardingMessages.he,
    ...m9ShellMessages.he,
    ...m9PwaMessages.he,
  },
} as const

export type Dictionary = Record<keyof typeof dictionaries.en, string>

export function getDictionary(locale: SupportedLocale): Dictionary {
  return dictionaries[locale]
}
