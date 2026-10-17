import { getCurrentWindow } from "@tauri-apps/api/window"
import { useCallback, useEffect, useMemo, useRef } from "react"

import { isDesktop } from "@/lib/ipc"
import { closeRepositoryWindowAfterSaving } from "@/lib/repository-layout"
import {
  repositoryShortcutIndex,
  usesNativeMenu,
} from "../app-menu/app-menu-shortcuts"
import { Launcher } from "../launcher/launcher-window"
import { RepositoryView } from "../repository/repository-view"
import { worktreeName } from "../working-tree/working-tree-state"
import { RepositorySidebar } from "./repository-sidebar"
import { SidebarHandle } from "./sidebar-handle"
import { SidebarToggleContext } from "./sidebar-toggle-context"
import { useSidebar } from "./use-sidebar"
import { useWorkspace } from "./use-workspace"
import { projectHome, sidebarProjects } from "./workspace"

export function WorkspaceWindow() {
  const layoutFlush = useRef<(() => Promise<void>) | null>(null)
  const {
    state,
    projects,
    projectsLoading,
    projectsError,
    show,
    remove,
    openInNewWindow,
  } = useWorkspace(layoutFlush)
  const active = state?.active ?? null
  const sidebar = useSidebar()
  const listedProjects = useMemo(() => sidebarProjects(projects), [projects])
  const repositorySidebar = useMemo(
    () => (
      <RepositorySidebar
        active={active}
        onCollapse={sidebar.toggle}
        onOpenInNewWindow={(target) => void openInNewWindow(target)}
        onRemove={(project) => void remove(project)}
        onSelect={(target) => void show(target)}
        projects={listedProjects}
        projectsError={projectsError}
      />
    ),
    [
      active,
      listedProjects,
      projectsError,
      openInNewWindow,
      remove,
      show,
      sidebar.toggle,
    ],
  )
  const sidebarToggle = useMemo(
    () => ({ collapsed: sidebar.collapsed, toggle: sidebar.toggle }),
    [sidebar.collapsed, sidebar.toggle],
  )
  const projectsRef = useRef(projects)
  useEffect(() => {
    projectsRef.current = projects
  })
  const registerLayoutFlush = useCallback((flush: () => Promise<void>) => {
    layoutFlush.current = flush
    return () => {
      if (layoutFlush.current === flush) layoutFlush.current = null
    }
  }, [])
  const closeActive = useCallback(() => void show(null), [show])

  useEffect(() => {
    if (state) document.getElementById("splash")?.remove()
  }, [state])

  const activeWorktree = active?.worktree
  useEffect(() => {
    const title =
      activeWorktree ? `${worktreeName(activeWorktree)} · Git Nav` : "Git Nav"
    if (isDesktop) void getCurrentWindow().setTitle(title)
    else document.title = title
  }, [activeWorktree])

  useEffect(() => {
    if (!isDesktop) return
    const currentWindow = getCurrentWindow()
    let disposed = false
    let unlisten: (() => void) | undefined
    void currentWindow
      .onCloseRequested((event) =>
        closeRepositoryWindowAfterSaving(
          event,
          () => layoutFlush.current?.() ?? Promise.resolve(),
          () => currentWindow.destroy(),
        ),
      )
      .then((dispose) => {
        if (disposed) dispose()
        else unlisten = dispose
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  // A browser keeps these keys for its own tabs, so only the desktop app takes them.
  useEffect(() => {
    if (!isDesktop) return
    const nativeMenu = usesNativeMenu(navigator.userAgent)
    const onKeyDown = (event: KeyboardEvent) => {
      const index = repositoryShortcutIndex(
        event,
        nativeMenu,
        projectsRef.current.length,
      )
      if (index === null) return
      event.preventDefault()
      void show(projectHome(projectsRef.current[index]))
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [show])

  if (!state) return null

  return (
    <SidebarToggleContext.Provider value={sidebarToggle}>
      <div className="flex h-svh overflow-hidden">
        <div
          className="h-full shrink-0 overflow-hidden"
          style={{
            width: sidebar.collapsed ? 0 : sidebar.width,
            visibility: sidebar.collapsed ? "hidden" : undefined,
          }}
        >
          <div className="h-full" style={{ width: sidebar.width }}>
            {repositorySidebar}
          </div>
        </div>
        <SidebarHandle
          collapsed={sidebar.collapsed}
          onResize={sidebar.resize}
          width={sidebar.width}
        />
        <div className="h-full min-w-0 flex-1">
          {active ?
            <RepositoryView
              key={active.worktree}
              onCloseRepository={closeActive}
              path={active.worktree}
              registerLayoutFlush={registerLayoutFlush}
            />
          : <Launcher
              hasProjects={
                projectsLoading || projectsError !== null || projects.length > 0
              }
            />
          }
        </div>
      </div>
    </SidebarToggleContext.Provider>
  )
}
