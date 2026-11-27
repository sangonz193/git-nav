import { describe, expect, test } from "bun:test"

import { isWorkspaceState, projectAfterRemoving } from "./workspace"

describe("workspace state", () => {
  const project = (name: string) => ({ id: `/${name}/.git`, path: `/${name}` })

  test("removing a project moves to the one below it", () => {
    const projects = [project("a"), project("b"), project("c")]
    expect(projectAfterRemoving(projects, "/b/.git")).toBe(projects[2])
    expect(projectAfterRemoving(projects, "/c/.git")).toBe(projects[1])
    expect(projectAfterRemoving([project("b")], "/b/.git")).toBeUndefined()
    expect(projectAfterRemoving(projects, "/missing/.git")).toBeUndefined()
  })

  test("stored state is only trusted when it has the expected shape", () => {
    expect(isWorkspaceState({ active: { project: "/a/.git" } })).toBeTrue()
    expect(isWorkspaceState({ active: null })).toBeTrue()
    expect(isWorkspaceState({ active: "/a" })).toBeFalse()
    expect(isWorkspaceState({ active: { worktree: "/a" } })).toBeFalse()
    expect(isWorkspaceState(null)).toBeFalse()
  })
})
