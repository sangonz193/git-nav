import type { Project } from "../repository/project"

export type ActiveProject = {
  project: string
}

export type OpenedRepository = ActiveProject & {
  worktree: string | null
}

export type WorkspaceState = {
  active: ActiveProject | null
}

export const EMPTY_WORKSPACE: WorkspaceState = { active: null }

export function projectAfterRemoving<T extends Pick<Project, "id">>(
  projects: T[],
  removed: string,
) {
  const index = projects.findIndex((project) => project.id === removed)
  const remaining = projects.filter((project) => project.id !== removed)
  return index === -1 ? undefined : (remaining[index] ?? remaining.at(-1))
}

export function isWorkspaceState(value: unknown): value is WorkspaceState {
  if (typeof value !== "object" || value === null) return false
  const { active } = value as Record<string, unknown>
  if (active === null) return true
  if (typeof active !== "object" || active === undefined) return false
  return typeof (active as Record<string, unknown>).project === "string"
}
