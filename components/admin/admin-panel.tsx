"use client"

import { ShieldAlertIcon } from "lucide-react"
import dynamic from "next/dynamic"

import { ADMIN_PANEL_PERMISSIONS } from "@/components/admin/permissions"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useWorkspace } from "@/components/workspace-context"
import { useShellUrl } from "@/hooks/use-shell-url"
import type { AdminTabKey } from "@/lib/client/shell-url"
import type { Permission } from "@/lib/auth/authz"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { SupportedLocale } from "@/lib/i18n/locales"

// Each section loads when its tab is first shown.
const sectionLoading = () => <div aria-busy="true" className="h-40 animate-pulse rounded-lg bg-surface-2" />
const MembersSection = dynamic(
  () => import("@/components/admin/members-section").then((mod) => mod.MembersSection),
  { loading: sectionLoading }
)
const InvitationsSection = dynamic(
  () => import("@/components/admin/invitations-section").then((mod) => mod.InvitationsSection),
  { loading: sectionLoading }
)
const ApiKeysSection = dynamic(
  () => import("@/components/admin/api-keys-section").then((mod) => mod.ApiKeysSection),
  { loading: sectionLoading }
)
const AuditLogSection = dynamic(
  () => import("@/components/admin/audit-log-section").then((mod) => mod.AuditLogSection),
  { loading: sectionLoading }
)

/** The tab ids are the shell URL's `adminTab` values (M9 D1). */
type AdminTab = AdminTabKey

const TAB_PERMISSIONS: Record<AdminTab, Permission> = {
  members: "workspace:read",
  invitations: "members:manage",
  "api-keys": "api_keys:manage",
  audit: "audit:read",
}

export { ADMIN_PANEL_PERMISSIONS }

export function AdminPanel({
  dictionary: t,
  locale,
}: {
  dictionary: Dictionary
  locale: SupportedLocale
}) {
  const { can, activeWorkspace } = useWorkspace()
  const tabs = (Object.keys(TAB_PERMISSIONS) as AdminTab[]).filter((tab) =>
    can(TAB_PERMISSIONS[tab])
  )
  // M9 D1: the tab lives in the URL (`?panel=admin&adminTab=`); Back walks it.
  const shell = useShellUrl(locale)
  const selected = shell.state.adminTab
  const active = tabs.includes(selected) ? selected : tabs[0]
  const tabLabels: Record<AdminTab, string> = {
    members: t.adminTabMembers,
    invitations: t.adminTabInvitations,
    "api-keys": t.adminTabApiKeys,
    audit: t.adminTabAudit,
  }

  return (
    <div className="ms-scrollbar min-h-[calc(100svh-3.5rem)] overflow-y-auto bg-surface-2 p-3 lg:h-[calc(100svh-3.5rem)] lg:p-5">
      <div className="mx-auto grid max-w-7xl gap-4">
        <header className="px-1 py-1">
          <div className="text-xs font-semibold tracking-wide text-brand-text uppercase">
            {t.adminEyebrow}
            {activeWorkspace ? (
              <>
                {" · "}
                <bdi>{activeWorkspace.name}</bdi>
              </>
            ) : null}
          </div>
          <h1 className="mt-1.5 text-xl font-semibold tracking-tight text-foreground">
            {t.adminTitle}
          </h1>
          <p className="mt-1.5 max-w-3xl text-sm leading-6 text-muted-foreground">
            {t.adminDescription}
          </p>
        </header>

        {!active ||
        !ADMIN_PANEL_PERMISSIONS.some((permission) => can(permission)) ? (
          <div className="ms-card flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <ShieldAlertIcon aria-hidden="true" className="size-4" />
            {t.adminNoAccess}
          </div>
        ) : (
          <Tabs
            value={active}
            onValueChange={(value) => shell.navigate({ panel: "admin", adminTab: value as AdminTab })}
            className="ms-card gap-4 p-3 lg:p-4"
          >
            <TabsList className="max-w-full overflow-x-auto">
              {tabs.map((tab) => (
                <TabsTrigger key={tab} value={tab}>
                  {tabLabels[tab]}
                </TabsTrigger>
              ))}
            </TabsList>
            {tabs.includes("members") ? (
              <TabsContent value="members">
                <MembersSection dictionary={t} locale={locale} />
              </TabsContent>
            ) : null}
            {tabs.includes("invitations") ? (
              <TabsContent value="invitations">
                <InvitationsSection dictionary={t} locale={locale} />
              </TabsContent>
            ) : null}
            {tabs.includes("api-keys") ? (
              <TabsContent value="api-keys">
                <ApiKeysSection dictionary={t} locale={locale} />
              </TabsContent>
            ) : null}
            {tabs.includes("audit") ? (
              <TabsContent value="audit">
                <AuditLogSection dictionary={t} locale={locale} />
              </TabsContent>
            ) : null}
          </Tabs>
        )}
      </div>
    </div>
  )
}
