import { describe, expect, test } from "bun:test"

import {
  ancestryPath,
  commitSelection,
  displayRefs,
  fitGraphWidth,
  GRAPH_HEADER_HEIGHT,
  GRAPH_MAX_WIDTH,
  GRAPH_MIN_WIDTH,
  graphCanvasHeight,
  isCurrentCheckout,
  refSyncLabel,
  relativeDate,
  splitRefLabel,
  syncDescription,
  unpushedHashes,
  type BranchSync,
} from "./commit-graph"

function commit(hash: string, parents: string[] = [], refs: string[] = []) {
  return {
    hash,
    parents,
    author: "Ada",
    date: "2026-01-01T00:00:00Z",
    refs,
    subject: hash,
    lane: 0,
    parentLanes: [],
    laneCount: 1,
    incomingLanes: [],
    activeLanes: [],
  }
}

const linear = [
  commit("a", ["b"]),
  commit("b", ["c"]),
  commit("c", ["d"]),
  commit("d"),
]

const sideBranch = [
  commit("a", ["b"]),
  commit("x", ["c"]),
  commit("b", ["c"]),
  commit("c"),
]

const merged = [
  commit("m", ["f", "g"]),
  commit("f", ["b"]),
  commit("g", ["b"]),
  commit("b", ["c"]),
  commit("c"),
]

describe("ancestryPath", () => {
  test("selects every commit between the endpoints of a linear chain", () => {
    expect(ancestryPath(linear, 0, 2).map((c) => c.hash)).toEqual([
      "a",
      "b",
      "c",
    ])
  })

  test("skips a sibling branch commit that sits between the endpoints", () => {
    expect(ancestryPath(sideBranch, 0, 3).map((c) => c.hash)).toEqual([
      "a",
      "b",
      "c",
    ])
  })

  test("skips a commit reachable from the tip that is not an ancestor of the base", () => {
    expect(ancestryPath(merged, 0, 2).map((c) => c.hash)).toEqual(["m", "g"])
  })

  test("selects nothing for two unrelated sibling tips", () => {
    expect(ancestryPath(sideBranch, 0, 1)).toEqual([])
  })

  test("gives the same result regardless of endpoint order", () => {
    expect(ancestryPath(sideBranch, 3, 0)).toEqual(
      ancestryPath(sideBranch, 0, 3)
    )
  })

  test("selects only the commit itself for a single index", () => {
    expect(ancestryPath(sideBranch, 1, 1).map((c) => c.hash)).toEqual(["x"])
  })

  test("selects both parent lines of a merge in range", () => {
    expect(ancestryPath(merged, 0, 3).map((c) => c.hash)).toEqual([
      "m",
      "f",
      "g",
      "b",
    ])
  })

  test("selects down to a root commit endpoint", () => {
    expect(ancestryPath(linear, 0, 3).map((c) => c.hash)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ])
  })
})

describe("commitSelection", () => {
  test("reports the newest selected commit as the tip", () => {
    expect(commitSelection(linear, 2, 0)?.tip.hash).toBe("a")
  })

  test("resolves the base to the first parent of the oldest selected commit", () => {
    expect(commitSelection(linear, 0, 2)?.base?.hash).toBe("d")
  })

  test("resolves the base to the first parent of an oldest merge commit", () => {
    expect(commitSelection(merged, 0, 0)?.base?.hash).toBe("f")
  })

  test("leaves the base null for a root commit", () => {
    expect(commitSelection(linear, 0, 3)?.base).toBeNull()
  })

  test("leaves the base null when the parent has not streamed in yet", () => {
    expect(commitSelection(linear.slice(0, 3), 0, 2)?.base).toBeNull()
  })

  test("returns null when the endpoints share no ancestry path", () => {
    expect(commitSelection(sideBranch, 0, 1)).toBeNull()
  })
})

describe("displayRefs", () => {
  const worktrees = [
    { branch: "main", name: "main", path: "/repos/main", isOpen: false },
  ]

  test("orders the current checkout, other worktrees, locals, remotes and tags", () => {
    const refs = displayRefs(
      [
        "origin/staging",
        "main",
        "origin/main",
        "tag: v1.0.0",
        "HEAD -> feature",
        "origin/feature",
      ],
      worktrees
    )
    expect(refs.map((ref) => ref.label)).toEqual([
      "feature · origin",
      "main · origin",
      "origin/staging",
      "v1.0.0",
    ])
    expect(refs[0].checkedOut).toBe(true)
    expect(refs[1].worktrees).toEqual(worktrees)
  })

  test("pairs a local branch with its remote into one entry", () => {
    expect(displayRefs(["main", "origin/main"])).toEqual([
      {
        branch: "main",
        label: "main · origin",
        checkedOut: false,
        remote: false,
        tag: false,
        sync: null,
        worktrees: [],
      },
    ])
  })

  test("keeps an unpushed local branch and a remote-only branch separate", () => {
    expect(
      displayRefs(["main", "origin/staging"]).map((ref) => ref.label)
    ).toEqual(["main", "origin/staging"])
    expect(
      displayRefs(["main", "origin/staging"]).map((ref) => ref.branch)
    ).toEqual(["main", null])
  })

  test("excludes origin/HEAD", () => {
    expect(
      displayRefs(["origin/HEAD", "origin/staging"]).map((ref) => ref.label)
    ).toEqual(["origin/staging"])
  })

  test("includes the checked out branch even when it has no ref of its own", () => {
    expect(displayRefs(["HEAD -> feature"])).toEqual([
      {
        branch: "feature",
        label: "feature",
        checkedOut: true,
        remote: false,
        tag: false,
        sync: null,
        worktrees: [],
      },
    ])
  })

  test("marks a detached checkout of a remote branch as checked out", () => {
    expect(displayRefs(["HEAD -> origin/main"])).toEqual([
      {
        branch: null,
        label: "origin/main",
        checkedOut: true,
        remote: true,
        tag: false,
        sync: null,
        worktrees: [],
      },
    ])
  })

  test("strips the tag prefix and sorts tags last", () => {
    expect(displayRefs(["tag: v1.0.0", "main"])).toEqual([
      {
        branch: "main",
        label: "main",
        checkedOut: false,
        remote: false,
        tag: false,
        sync: null,
        worktrees: [],
      },
      {
        branch: null,
        label: "v1.0.0",
        checkedOut: false,
        remote: false,
        tag: true,
        sync: null,
        worktrees: [],
      },
    ])
  })
})

describe("splitRefLabel", () => {
  test("keeps a short label whole", () => {
    expect(splitRefLabel("main")).toEqual({ start: "main", end: "" })
  })

  test("keeps a label of exactly the tail length whole", () => {
    expect(splitRefLabel("release1")).toEqual({ start: "release1", end: "" })
  })

  test("splits a longer label into a head and an eight character tail", () => {
    expect(splitRefLabel("feature/authentication")).toEqual({
      start: "feature/authen",
      end: "tication",
    })
  })
})

describe("isCurrentCheckout", () => {
  test("matches a detached HEAD and a HEAD pointing at a branch", () => {
    expect(isCurrentCheckout(["HEAD"])).toBe(true)
    expect(isCurrentCheckout(["origin/main", "HEAD -> main"])).toBe(true)
  })

  test("does not match a branch that merely starts with HEAD", () => {
    expect(isCurrentCheckout(["HEADER", "origin/HEAD"])).toBe(false)
  })
})

describe("relativeDate", () => {
  test("returns the original value when it is not a date", () => {
    expect(relativeDate("not a date")).toBe("not a date")
  })
})

describe("fitGraphWidth", () => {
  test("falls back to the minimum width for a single lane history", () => {
    expect(fitGraphWidth(linear)).toBe(GRAPH_MIN_WIDTH)
  })

  test("covers the widest lane count seen across the commits", () => {
    expect(
      fitGraphWidth([
        { ...commit("a"), laneCount: 3 },
        { ...commit("b"), laneCount: 9 },
        { ...commit("c"), laneCount: 2 },
      ])
    ).toBe(18 + 9 * 14)
  })

  test("covers lanes that only appear as parent or incoming lanes", () => {
    expect(
      fitGraphWidth([{ ...commit("a"), parentLanes: [4], incomingLanes: [6] }])
    ).toBe(18 + 7 * 14)
  })

  test("clamps a very wide history to the maximum width", () => {
    expect(fitGraphWidth([{ ...commit("a"), laneCount: 200 }])).toBe(
      GRAPH_MAX_WIDTH
    )
  })
})

describe("graphCanvasHeight", () => {
  test("leaves room for the header so the canvas ends at the bottom of the viewport", () => {
    expect(graphCanvasHeight(400) + GRAPH_HEADER_HEIGHT).toBe(400)
  })

  test("stays at zero for a viewport shorter than the header", () => {
    expect(graphCanvasHeight(0)).toBe(0)
  })
})

describe("unpushedHashes", () => {
  test("marks commits above the remote ref", () => {
    const commits = [
      commit("a", ["b"]),
      commit("b", ["c"], ["main"]),
      commit("c", ["d"], ["origin/main"]),
      commit("d"),
    ]

    expect([...unpushedHashes(commits)]).toEqual(["a", "b"])
  })

  test("treats a branch without a remote ref as entirely unpushed", () => {
    expect([...unpushedHashes(linear)]).toEqual(["a", "b", "c", "d"])
  })

  test("carries the remote through a merge to both parents", () => {
    const commits = [
      commit("merge", ["a", "x"], ["origin/main"]),
      commit("a", ["base"]),
      commit("x", ["base"]),
      commit("base"),
    ]

    expect([...unpushedHashes(commits)]).toEqual([])
  })

  test("keeps a side branch unpushed when only the trunk is on the remote", () => {
    const commits = [
      commit("side", ["base"]),
      commit("trunk", ["base"], ["origin/main"]),
      commit("base"),
    ]

    expect([...unpushedHashes(commits)]).toEqual(["side"])
  })

  test("ignores tags and local branches that shadow a remote name", () => {
    const commits = [
      commit("a", ["b"], ["tag: v1"]),
      commit("b", [], ["HEAD -> origin/main"]),
    ]

    expect([...unpushedHashes(commits)]).toEqual(["a"])
  })
})

describe("branch sync", () => {
  const sync = (overrides: Partial<BranchSync> = {}): BranchSync => ({
    branch: "feature",
    upstream: "origin/feature",
    ahead: 0,
    behind: 0,
    isGone: false,
    ...overrides,
  })
  const ref = (value: BranchSync | null) =>
    displayRefs(["feature"], [], value ? new Map([[value.branch, value]]) : undefined)[0]

  test("attaches sync state to local branches only", () => {
    const refs = displayRefs(["main", "origin/staging", "tag: v1"], [], new Map([["main", sync({ branch: "main" })]]))
    expect(refs.map((entry) => entry.sync?.branch ?? null)).toEqual(["main", null, null])
  })

  test("marks standalone remote refs", () => {
    const refs = displayRefs(["main", "origin/staging", "tag: v1"])
    expect(refs.map((entry) => entry.remote)).toEqual([false, true, false])
  })

  test("shows nothing extra when a branch matches its upstream", () => {
    expect(refSyncLabel(ref(sync()))).toBe(null)
    expect(syncDescription(ref(sync()))).toBe("In sync with origin/feature")
  })

  test("counts commits in each direction", () => {
    expect(refSyncLabel(ref(sync({ ahead: 3 })))).toBe("↑3")
    expect(refSyncLabel(ref(sync({ behind: 2 })))).toBe("↓2")
    expect(refSyncLabel(ref(sync({ ahead: 3, behind: 2 })))).toBe("↑3 ↓2")
    expect(syncDescription(ref(sync({ ahead: 3, behind: 2 })))).toBe("origin/feature: 3 ahead, 2 behind")
  })

  test("separates a branch that was never pushed from one whose upstream is gone", () => {
    expect(refSyncLabel(ref(sync({ upstream: null })))).toBe("local")
    expect(syncDescription(ref(sync({ upstream: null })))).toBe("Not pushed to a remote")
    expect(refSyncLabel(ref(sync({ isGone: true })))).toBe("gone")
    expect(syncDescription(ref(sync({ isGone: true })))).toBe("origin/feature is gone from the remote")
  })

  test("reports no state without sync data", () => {
    expect(refSyncLabel(ref(null))).toBe(null)
    expect(syncDescription(ref(null))).toBe(null)
  })
})
