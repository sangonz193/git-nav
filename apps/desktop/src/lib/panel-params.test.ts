import { describe, expect, test } from "bun:test"

import { WORKTREE_REF } from "./repository-constants"
import { newTabParams } from "./panel-params"

describe("newTabParams", () => {
  const repository = { name: "app", path: "/code/app" }

  test("opens on the active tab's worktree", () => {
    expect(
      newTabParams(repository, {
        name: "app",
        path: "/code/app-fix",
      }),
    ).toEqual({ name: "app", path: "/code/app-fix" })
  })

  test("opens on the repository without an active tab", () => {
    expect(newTabParams(repository, undefined)).toEqual(repository)
  })

  test("opens on the active diff tab's worktree when the diff depends on it", () => {
    expect(
      newTabParams(repository, {
        name: "app",
        path: "/code/app-fix",
        baseRef: "refs/heads/main",
        headRef: WORKTREE_REF,
      }),
    ).toEqual({ name: "app", path: "/code/app-fix" })
  })

  test("opens on the repository when the active diff tab does not depend on its worktree", () => {
    expect(
      newTabParams(repository, {
        name: "app",
        path: "/code/app-fix",
        baseRef: "refs/heads/main",
        headRef: "refs/heads/feature",
      }),
    ).toEqual(repository)
  })
})
