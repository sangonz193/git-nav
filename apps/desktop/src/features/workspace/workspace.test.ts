import { describe, expect, test } from "bun:test"

import type { Project } from "../repository/project"
import {
  activeAfterRemoving,
  isWorkspaceState,
  sidebarProjects,
} from "./workspace"

function worktree(path: string, branch: string, isMain: boolean) {
  return {
    path,
    name: path.split("/").at(-1)!,
    branch,
    head: "",
    isMain,
    isDetached: false,
    isLocked: false,
    isPrunable: false,
    isOpen: false,
  }
}

const app: Project = {
  id: "/code/app/.git",
  name: "app",
  path: "/code/app",
  worktrees: [
    worktree("/code/app", "main", true),
    worktree("/code/app-fix", "fix", false),
    { ...worktree("/code/app-gone", "gone", false), isPrunable: true },
  ],
}

describe("workspace state", () => {
  const project = (name: string) => ({ id: `/${name}/.git`, path: `/${name}` })

  test("removing the project in view moves to the one below it", () => {
    const projects = [project("a"), project("b"), project("c")]
    const active = { project: "/b/.git", worktree: "/b-fix" }
    expect(activeAfterRemoving(active, projects, "/b/.git")).toEqual({
      project: "/c/.git",
      worktree: "/c",
    })
    expect(
      activeAfterRemoving(
        { project: "/c/.git", worktree: "/c" },
        projects,
        "/c/.git",
      ),
    ).toEqual({ project: "/b/.git", worktree: "/b" })
    expect(activeAfterRemoving(active, [project("b")], "/b/.git")).toBeNull()
  })

  test("removing another project keeps the one in view", () => {
    const active = { project: "/b/.git", worktree: "/b" }
    expect(
      activeAfterRemoving(active, [project("a"), project("b")], "/a/.git"),
    ).toBe(active)
    expect(activeAfterRemoving(null, [project("a")], "/a/.git")).toBeNull()
  })

  test("a project lists its worktrees that still exist", () => {
    expect(sidebarProjects([app])).toEqual([
      {
        id: "/code/app/.git",
        path: "/code/app",
        name: "app",
        worktrees: [
          { path: "/code/app", label: "main", detail: null },
          { path: "/code/app-fix", label: "fix", detail: "app-fix" },
        ],
      },
    ])
  })

  test("stored state is only trusted when it has the expected shape", () => {
    expect(
      isWorkspaceState({ active: { project: "/a", worktree: "/a" } }),
    ).toBeTrue()
    expect(isWorkspaceState({ active: null })).toBeTrue()
    expect(isWorkspaceState({ active: "/a" })).toBeFalse()
    expect(isWorkspaceState(null)).toBeFalse()
  })
})
