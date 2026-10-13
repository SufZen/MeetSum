import type { Permission } from "@/lib/auth/authz"

/** Permissions that make the admin panel worth showing in the sidebar. */
export const ADMIN_PANEL_PERMISSIONS: Permission[] = [
  "members:manage",
  "api_keys:manage",
  "audit:read",
]
