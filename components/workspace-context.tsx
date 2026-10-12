"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

import {
  fetchMe,
  switchWorkspace as switchWorkspaceRequest,
  type Me,
  type MeWorkspace,
} from "@/components/admin/api"
import type { Permission } from "@/lib/auth/authz"
import type { WorkspaceRole } from "@/lib/workspaces/types"

type WorkspaceState =
  | { status: "loading"; me?: Me }
  | { status: "ready"; me: Me }
  | { status: "error"; me?: Me; error: string }

export type WorkspaceContextValue = {
  status: WorkspaceState["status"]
  me?: Me
  error?: string
  activeWorkspace?: MeWorkspace
  role?: WorkspaceRole
  can: (permission: Permission) => boolean
  refresh: () => Promise<void>
  switchWorkspace: (workspaceId: string) => Promise<void>
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

export function WorkspaceProvider({
  children,
}: {
  children: ReactNode
}) {
  const [state, setState] = useState<WorkspaceState>({ status: "loading" })

  const refresh = useCallback(async () => {
    setState((current) => ({ status: "loading", me: current.me }))

    try {
      setState({ status: "ready", me: await fetchMe() })
    } catch (error) {
      setState((current) => ({
        status: "error",
        me: current.me,
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const switchWorkspace = useCallback(
    async (workspaceId: string) => {
      await switchWorkspaceRequest(workspaceId)
      await refresh()
    },
    [refresh]
  )

  const value = useMemo<WorkspaceContextValue>(() => {
    const me = state.me
    const activeWorkspace = me?.workspaces.find(
      (workspace) => workspace.id === me.activeWorkspaceId
    )
    const permissions = new Set<Permission>(me?.permissions ?? [])

    return {
      status: state.status,
      me,
      error: state.status === "error" ? state.error : undefined,
      activeWorkspace,
      role: activeWorkspace?.role,
      can: (permission) => permissions.has(permission),
      refresh,
      switchWorkspace,
    }
  }, [state, refresh, switchWorkspace])

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  )
}

const FALLBACK: WorkspaceContextValue = {
  status: "loading",
  can: () => false,
  refresh: async () => {},
  switchWorkspace: async () => {},
}

/** Current user, workspace and permissions (deny-by-default while loading). */
export function useWorkspace(): WorkspaceContextValue {
  return useContext(WorkspaceContext) ?? FALLBACK
}
