"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"

import {
  ApiError,
  fetchMe,
  switchWorkspace as switchWorkspaceRequest,
  type Me,
  type MeWorkspace,
} from "@/components/admin/api"
import type { Permission } from "@/lib/auth/authz"
import type { WorkspaceRole } from "@/lib/workspaces/types"

type WorkspaceState =
  | { status: "loading"; me?: Me; legacy?: boolean }
  | { status: "ready"; me: Me; legacy?: boolean }
  | { status: "error"; me?: Me; legacy?: boolean; error: string }

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

/**
 * M2-integration: `/api/me` is added by Package A. Until it exists (404),
 * mirror the Step 0 compat authz, where every signed-in principal is the
 * owner of the single legacy workspace. Remove once A has landed.
 */
function legacyMe(user?: {
  email: string
  name?: string
  picture?: string
}): Me {
  return {
    user: {
      id: user?.email ?? "",
      email: user?.email ?? "",
      name: user?.name,
      picture: user?.picture,
    },
    workspaces: [{ id: "ws_default", name: "MeetSum", role: "owner" }],
    activeWorkspaceId: "ws_default",
    permissions: [],
  }
}

export function WorkspaceProvider({
  children,
  initialUser,
}: {
  children: ReactNode
  /** Session user rendered by the server, used before `/api/me` resolves. */
  initialUser?: { email: string; name?: string; picture?: string }
}) {
  const [state, setState] = useState<WorkspaceState>({ status: "loading" })
  const initialUserRef = useRef(initialUser)

  const refresh = useCallback(async () => {
    setState((current) => ({ status: "loading", me: current.me }))

    try {
      setState({ status: "ready", me: await fetchMe() })
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setState({
          status: "ready",
          me: legacyMe(initialUserRef.current),
          legacy: true,
        })
        return
      }

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
      can: (permission) => state.legacy === true || permissions.has(permission),
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
