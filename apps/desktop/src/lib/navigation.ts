import { invoke, isDesktop } from "./ipc"

export type WorktreeTarget = "git-nav" | "vscode" | "terminal" | "finder"

function repositoryUrl(path: string) {
  return `/?${new URLSearchParams({ repository: path })}`
}

/**
 * The desktop app opens repositories in native windows. The browser has no such handle, so the
 * server resolves and records the path and the client navigates there itself.
 */
export async function openRepository(path: string) {
  if (isDesktop) {
    return invoke<void>("open_repository", { path })
  }
  const { path: resolved } = await invoke<{ path: string }>("open_repository", { path })
  window.location.assign(repositoryUrl(resolved))
}

export async function openWorktree(path: string, target: WorktreeTarget) {
  if (isDesktop) {
    return invoke<void>("open_worktree", { path, target })
  }
  const { path: resolved } = await invoke<{ path: string }>("open_worktree", { path, target })
  if (target === "git-nav") {
    window.open(repositoryUrl(resolved), "_blank")
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
