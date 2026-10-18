import type { Project } from "../repository/project"

export type ProjectWorktree = {
  project: string
  worktree: string
}

export type WorkspaceState = {
  active: ProjectWorktree | null
}

export type SidebarWorktree = {
  path: string
  label: string
  detail: string | null
}

export type SidebarProject = {
  id: string
  path: string
  name: string
  worktrees: SidebarWorktree[]
}

export const EMPTY_WORKSPACE: WorkspaceState = { active: null }

export function sidebarProjects(projects: Project[]) {
  return projects.map((project) => ({
    id: project.id,
    path: project.path,
    name: project.name,
    worktrees: project.worktrees
      .filter((worktree) => !worktree.isPrunable)
      .map((worktree) => ({
        path: worktree.path,
        label: worktree.branch,
        detail: worktree.isMain ? null : worktree.name,
      })),
  }))
}

export function projectHome(project: Pick<Project, "id" | "path">) {
  return { project: project.id, worktree: project.path }
}

export function activeAfterRemoving(
  active: ProjectWorktree | null,
  projects: Pick<Project, "id" | "path">[],
  removed: string,
) {
  if (active?.project !== removed) return active
  const index = projects.findIndex((project) => project.id === removed)
  const remaining = projects.filter((project) => project.id !== removed)
  const next = index === -1 ? undefined : (remaining[index] ?? remaining.at(-1))
  return next ? projectHome(next) : null
}

export function isWorkspaceState(value: unknown): value is WorkspaceState {
  if (typeof value !== "object" || value === null) return false
  const { active } = value as Record<string, unknown>
  if (active === null) return true
  if (typeof active !== "object" || active === undefined) return false
  const { project, worktree } = active as Record<string, unknown>
  return typeof project === "string" && typeof worktree === "string"
}
