import { useQuery, useQueryClient } from "@tanstack/react-query"
import { listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"
import {
  useCallback,
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react"

import { toast } from "@workspace/shadcn/components/sonner"
import { invoke, isDesktop } from "@/lib/ipc"
import {
  onRepositoryOpened,
  openRepository,
  openRepositoryInNewWindow,
} from "@/lib/navigation"
import type { Project } from "../repository/project"
import {
  activeAfterRemoving,
  EMPTY_WORKSPACE,
  isWorkspaceState,
  type ProjectWorktree,
  type WorkspaceState,
} from "./workspace"

const REPOSITORIES_OPENED_EVENT = "repositories-opened"
const SIDEBAR_PROJECTS_CHANGED_EVENT = "sidebar-projects-changed"
const SIDEBAR_PROJECTS_KEY = ["sidebar-projects"]
const SIDEBAR_REFRESH_INTERVAL = 30_000
const BROWSER_WORKSPACE_KEY = "git-nav.workspace"
// A stalled save must not leave the sidebar unresponsive, the same bound a closing window gets.
const LAYOUT_FLUSH_TIMEOUT = 1_000

function storedBrowserWorkspace() {
  try {
    const stored: unknown = JSON.parse(
      sessionStorage.getItem(BROWSER_WORKSPACE_KEY) ?? "null",
    )
    return isWorkspaceState(stored) ? stored : EMPTY_WORKSPACE
  } catch {
    return EMPTY_WORKSPACE
  }
}

function reportError(message: string) {
  return (error: unknown) => {
    toast.error(message, { description: String(error) })
  }
}

export function useWorkspace(
  layoutFlush: RefObject<(() => Promise<void>) | null>,
) {
  const queryClient = useQueryClient()
  const [state, setState] = useState<WorkspaceState | null>(() =>
    isDesktop ? null : storedBrowserWorkspace(),
  )
  const currentState = useRef(state)
  useLayoutEffect(() => {
    currentState.current = state
  }, [state])
  const [requestedRepository] = useState(() =>
    isDesktop ? null : (
      new URLSearchParams(window.location.search).get("repository")
    ),
  )
  const saving = useRef(Promise.resolve())
  const projects = useQuery({
    queryKey: SIDEBAR_PROJECTS_KEY,
    queryFn: () => invoke<Project[]>("sidebar_projects"),
    refetchInterval: SIDEBAR_REFRESH_INTERVAL,
  })
  const refreshProjects = useCallback(
    () => queryClient.invalidateQueries({ queryKey: SIDEBAR_PROJECTS_KEY }),
    [queryClient],
  )

  const flushLayout = useCallback(async () => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      layoutFlush.current?.(),
      new Promise((resolve) => {
        timeout = setTimeout(resolve, LAYOUT_FLUSH_TIMEOUT)
      }),
    ])
    clearTimeout(timeout)
  }, [layoutFlush])

  const clear = useCallback(async (active: ProjectWorktree) => {
    if (isDesktop) {
      await invoke<void>("clear_window_worktree", { worktree: active.worktree })
    }
    setState((current) =>
      current?.active?.worktree === active.worktree ?
        { active: null }
      : current,
    )
  }, [])

  const showLocally = useCallback(
    async (active: ProjectWorktree | null) => {
      await flushLayout()
      if (!active && currentState.current?.active) {
        await clear(currentState.current.active)
      } else {
        setState((current) => current && { active })
      }
    },
    [clear, flushLayout],
  )

  const show = useCallback(
    async (active: ProjectWorktree | null) => {
      if (isDesktop && active) {
        await openRepository(active.worktree).catch(
          reportError("Could not open the repository"),
        )
      } else {
        await showLocally(active).catch(
          reportError("Could not close the repository"),
        )
      }
    },
    [showLocally],
  )

  useEffect(() => {
    const refreshOnFocus = () => void refreshProjects()
    window.addEventListener("focus", refreshOnFocus)
    return () => window.removeEventListener("focus", refreshOnFocus)
  }, [refreshProjects])

  const listed = useMemo(() => projects.data ?? [], [projects.data])

  useEffect(() => {
    if (!isDesktop) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void listen(SIDEBAR_PROJECTS_CHANGED_EVENT, () => void refreshProjects())
      .then((dispose) => {
        if (disposed) dispose()
        else unlisten = dispose
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [refreshProjects])

  useEffect(() => {
    let disposed = false
    const showOpened = (opened: ProjectWorktree[]) => {
      const last = opened.at(-1)
      if (!disposed && last) void showLocally(last)
    }

    if (!isDesktop) {
      const unsubscribe = onRepositoryOpened((opened) => {
        void refreshProjects()
        showOpened([opened])
      })
      if (requestedRepository) {
        window.history.replaceState(null, "", window.location.pathname)
        invoke<ProjectWorktree>("open_repository", {
          path: requestedRepository,
        })
          .then((opened) => {
            void refreshProjects()
            showOpened([opened])
          })
          .catch(reportError("Could not open the repository"))
      }
      return () => {
        disposed = true
        unsubscribe()
      }
    }

    let loaded = false
    let unlisten: (() => void) | undefined
    const drain = () =>
      invoke<ProjectWorktree[]>("take_opened_repositories")
        .then(showOpened)
        .catch(reportError("Could not open the repository"))
    void (async () => {
      try {
        const dispose = await getCurrentWindow().listen(
          REPOSITORIES_OPENED_EVENT,
          () => {
            if (loaded) void drain()
          },
        )
        if (disposed) {
          dispose()
          return
        }
        unlisten = dispose
        const session = await invoke<WorkspaceState>("window_session")
        if (disposed) return
        setState({ active: session.active })
        loaded = true
        await drain()
      } catch (error) {
        if (disposed) return
        setState((current) => current ?? EMPTY_WORKSPACE)
        loaded = true
        void drain()
        reportError("Could not restore this window")(error)
      }
    })()
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [refreshProjects, requestedRepository, showLocally])

  useEffect(() => {
    if (!state || state === EMPTY_WORKSPACE) return
    if (isDesktop) {
      saving.current = saving.current.then(() =>
        invoke<void>("save_window_worktree", state).catch(
          reportError("Could not save what this window shows"),
        ),
      )
      return
    }
    try {
      sessionStorage.setItem(BROWSER_WORKSPACE_KEY, JSON.stringify(state))
    } catch {
      // Without storage the window still works for as long as the page stays open.
    }
  }, [state])

  const remove = useCallback(
    async (project: string) => {
      try {
        await invoke<void>("remove_sidebar_project", { project })
      } catch (error) {
        reportError("Could not remove the project")(error)
        return
      }
      void refreshProjects()
      if (currentState.current?.active?.project !== project) return
      await flushLayout()
      const active = currentState.current?.active
      if (active?.project !== project) return
      if (isDesktop) {
        try {
          await clear(active)
        } catch (error) {
          reportError("Could not close the repository")(error)
          return
        }
        const next = activeAfterRemoving(active, listed, project)
        if (next) await show(next)
      } else {
        setState(
          (current) =>
            current && {
              active: activeAfterRemoving(current.active, listed, project),
            },
        )
      }
    },
    [clear, flushLayout, listed, refreshProjects, show],
  )

  const openInNewWindow = useCallback(
    async (target: ProjectWorktree) => {
      const showsTarget = state?.active?.worktree === target.worktree
      try {
        if (isDesktop && showsTarget) await flushLayout()
        await openRepositoryInNewWindow(target.worktree)
        if (showsTarget) {
          if (!isDesktop) await flushLayout()
          await clear(target)
        }
      } catch (error) {
        reportError("Could not open a new window")(error)
      }
    },
    [clear, flushLayout, state],
  )

  return {
    state,
    projects: listed,
    projectsLoading: projects.isPending,
    projectsError: projects.error ? String(projects.error) : null,
    show,
    remove,
    openInNewWindow,
  }
}
