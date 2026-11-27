import { describe, expect, test } from "bun:test"

import { worktreeGraphPanelId } from "./worktree-graph-tab"

describe("worktreeGraphPanelId", () => {
  test("returns the graph already on the worktree", () => {
    expect(
      worktreeGraphPanelId(
        [
          { id: "graph-1", path: "/code/app" },
          { id: "graph-2", path: "/code/app-feature" },
        ],
        "/code/app-feature",
        undefined,
      ),
    ).toBe("graph-2")
  })

  test("prefers the active graph on the worktree", () => {
    const graphs = [
      { id: "graph-1", path: "/code/app-feature" },
      { id: "graph-2", path: "/code/app-feature" },
    ]
    expect(worktreeGraphPanelId(graphs, "/code/app-feature", "graph-2")).toBe(
      "graph-2",
    )
    expect(worktreeGraphPanelId(graphs, "/code/app-feature", "other")).toBe(
      "graph-1",
    )
  })

  test("returns undefined when only other worktrees have a graph", () => {
    expect(
      worktreeGraphPanelId(
        [{ id: "graph-1", path: "/code/app" }],
        "/code/app-feature",
        "graph-1",
      ),
    ).toBeUndefined()
  })

  test("returns undefined when the window has no graph", () => {
    expect(
      worktreeGraphPanelId([], "/code/app-feature", undefined),
    ).toBeUndefined()
  })
})
