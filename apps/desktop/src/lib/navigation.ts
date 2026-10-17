import type { ProjectWorktree } from "../features/workspace/workspace"
import { invoke, isDesktop } from "./ipc"

export type WorktreeTarget = "git-nav" | "vscode" | "terminal" | "finder"

const openedListeners = new Set<(opened: ProjectWorktree) => void>()

export function repositoryUrl(path: string) {
  return `/?${new URLSearchParams({ repository: path })}`
}

// Browser tabs receive resolved worktrees locally because only desktop windows share backend routing.
export function onRepositoryOpened(
  listener: (opened: ProjectWorktree) => void,
) {
  openedListeners.add(listener)
  return () => {
    openedListeners.delete(listener)
  }
}

function announceOpened(opened: ProjectWorktree) {
  for (const listener of openedListeners) listener(opened)
}

export async function openRepository(path: string) {
  if (isDesktop) {
    return invoke<void>("open_repository", { path })
  }
  announceOpened(await invoke<ProjectWorktree>("open_repository", { path }))
}

export async function openRepositoryInNewWindow(path: string) {
  if (isDesktop) {
    return invoke<void>("open_repository_in_new_window", { path })
  }
  window.open(repositoryUrl(path), "_blank", "noopener")
}

export async function openWorktree(path: string, target: WorktreeTarget) {
  if (isDesktop) {
    return invoke<void>("open_worktree", { path, target })
  }
  const opened = await invoke<ProjectWorktree>("open_worktree", {
    path,
    target,
  })
  if (target === "git-nav") {
    announceOpened(opened)
  }
}

/**
 * A Tauri webview has nowhere to put a second tab, so the desktop app hands the link to the system
 * browser. The served app is already in one.
 */
export async function openPullRequest(url: string) {
  if (isDesktop) {
    return invoke<void>("open_url", { url })
  }
  window.open(url, "_blank", "noopener")
}
