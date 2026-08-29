import { describe, expect, test } from "bun:test"

import {
  ancestryPath,
  branchesContaining,
  chipName,
  chipWidth,
  commitSelection,
  detachedWorktrees,
  displayRefs,
  fitGraphWidth,
  GRAPH_HEADER_HEIGHT,
  GRAPH_MAX_WIDTH,
  GRAPH_MIN_WIDTH,
  GRAPH_CANVAS_OVERSCAN,
  graphCanvasHeight,
  isCurrentCheckout,
  laneColor,
  parentEdgeColor,
  refSelection,
  refSyncLabel,
  relativeDate,
  remoteBranchName,
  rowChips,
  splitRefLabel,
  startsLane,
  syncDescription,
  unpushedHashes,
  unpushedLanes,
  visibleChipCount,
  worktreeChanges,
  type BranchSync,
  type RowWorktree,
  type StashEntry,
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
    { branch: "main", changedFiles: 0, head: "a", isCurrent: false, isOpen: false, name: "main", path: "/repos/main", pendingOperation: null, untrackedFiles: 0 },
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
      { worktrees }
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
        kind: "branch",
        remote: "origin",
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
        kind: "branch",
        remote: null,
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
        kind: "remote",
        remote: "origin",
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
        kind: "branch",
        remote: null,
        sync: null,
        worktrees: [],
      },
      {
        branch: null,
        label: "v1.0.0",
        checkedOut: false,
        kind: "tag",
        remote: null,
        sync: null,
        worktrees: [],
      },
    ])
  })
})

describe("displayRefs with other remotes", () => {
  const remotes = ["origin", "upstream"]

  test("classifies a ref by the remotes the repository actually has", () => {
    const refs = displayRefs(["upstream/main", "fork/main"], { remotes })
    expect(refs.map((ref) => [ref.label, ref.kind])).toEqual([
      ["fork/main", "branch"],
      ["upstream/main", "remote"],
    ])
  })

  test("pairs a local branch with whichever remote carries it", () => {
    const [ref] = displayRefs(["main", "upstream/main"], { remotes })
    expect(ref.label).toBe("main · upstream")
    expect(ref.branch).toBe("main")
  })

  test("excludes the HEAD of every remote", () => {
    expect(displayRefs(["upstream/HEAD", "upstream/staging"], { remotes }).map((ref) => ref.label)).toEqual([
      "upstream/staging",
    ])
  })

  test("treats a remote-looking ref as a branch without a remote to match it", () => {
    expect(displayRefs(["upstream/main"], { remotes: [] })[0].kind).toBe("branch")
  })
})

describe("pairing a branch with its upstream", () => {
  const remotes = ["origin", "upstream"]
  const tracking = (upstream: string | null) =>
    new Map([["main", { branch: "main", upstream, ahead: 2, behind: 0, isGone: false }]])

  test("names the remote the branch actually tracks", () => {
    const refs = displayRefs(["HEAD -> main", "origin/main", "upstream/main"], { branchSync: tracking("upstream/main"), remotes })
    expect(refs[0].label).toBe("main · upstream")
    expect(refs[0].remote).toBe("upstream")
    // The remote that was not paired keeps a chip of its own rather than being consumed.
    expect(refs.map((ref) => ref.label)).toEqual(["main · upstream", "origin/main"])
  })

  test("pairs with a differently named upstream", () => {
    const refs = displayRefs(["main", "origin/trunk"], { branchSync: tracking("origin/trunk"), remotes })
    expect(refs.map((ref) => ref.label)).toEqual(["main · origin"])
  })

  test("falls back to whichever remote carries the name without tracking data", () => {
    const refs = displayRefs(["main", "upstream/main"], { branchSync: tracking(null), remotes })
    expect(refs[0].label).toBe("main · upstream")
  })
})

describe("remoteBranchName", () => {
  test("strips the remote a ref belongs to, not the repository's primary one", () => {
    const [ref] = displayRefs(["upstream/main"], { remotes: ["origin", "upstream"] })
    expect(remoteBranchName(ref)).toBe("main")
  })

  test("keeps a slash in the branch name", () => {
    const [ref] = displayRefs(["origin/feat/graph"], { remotes: ["origin"] })
    expect(remoteBranchName(ref)).toBe("feat/graph")
  })

  test("reports nothing for a ref that is not on a remote", () => {
    expect(remoteBranchName(displayRefs(["main"])[0])).toBeNull()
    expect(remoteBranchName(displayRefs(["tag: v1"])[0])).toBeNull()
  })
})

describe("rowChips", () => {
  const stash = (name: string): StashEntry => ({ base: "a", branch: "main", date: "", message: `work on ${name}`, name, sha: name })

  test("orders locals and stashes ahead of remotes and tags", () => {
    const refs = displayRefs(["main", "origin/staging", "tag: v1.0.0"])
    const chips = rowChips(refs, [stash("stash@{0}")])
    expect(chips.map((chip) => chip.kind)).toEqual(["branch", "stash", "remote", "tag"])
  })

  test("keeps the current checkout first", () => {
    const refs = displayRefs(["other", "HEAD -> main"])
    expect(rowChips(refs, [stash("stash@{0}")]).map(chipName)).toEqual(["main", "other", "stash@{0}"])
  })
})

describe("detachedWorktrees", () => {
  const worktree = (overrides: Partial<RowWorktree>): RowWorktree => ({
    branch: null, changedFiles: 0, head: "a", isCurrent: false, isOpen: false,
    name: "wt", path: "/wt", pendingOperation: null, untrackedFiles: 0, ...overrides,
  })

  test("leaves out a worktree already drawn inside a branch chip", () => {
    const held = worktree({ branch: "main", name: "main", path: "/repos/main" })
    const refs = displayRefs(["main"], { worktrees: [held] })
    expect(refs[0].worktrees).toEqual([held])
    expect(detachedWorktrees(refs, [held])).toEqual([])
  })

  // A rebase and a bisect both leave the worktree on a detached HEAD, so this is the state an interrupted
  // operation is seen in, not a rare one.
  test("keeps a worktree that holds no branch", () => {
    const parked = worktree({ pendingOperation: "rebase", path: "/wt-rebase" })
    const refs = displayRefs(["main"], { worktrees: [parked] })
    expect(refs[0].worktrees).toEqual([])
    expect(detachedWorktrees(refs, [parked])).toEqual([parked])
  })

  test("counts a worktree's uncommitted work in the chip that holds it", () => {
    const dirty = worktree({ branch: "main", changedFiles: 4, untrackedFiles: 3, name: "main" })
    const [chip] = rowChips(displayRefs(["main"], { worktrees: [dirty] }))
    const [clean] = rowChips(displayRefs(["main"]))
    expect(worktreeChanges(dirty)).toBe(7)
    expect(chipWidth(chip)).toBeGreaterThan(chipWidth(clean))
  })

  test("orders a detached worktree ahead of the branches it is parked beside", () => {
    const parked = worktree({ name: "wt-rebase", path: "/wt-rebase" })
    const chips = rowChips(displayRefs(["main", "tag: v1"]), [], [parked])
    expect(chips.map((chip) => chip.kind)).toEqual(["worktree", "branch", "tag"])
  })

  test("never collapses a worktree into the overflow count", () => {
    const parked = worktree({ name: "wt-rebase", path: "/wt-rebase" })
    const chips = rowChips(displayRefs(["main", "origin/other", "tag: v1.0.0"]), [], [parked])
    const shown = chips.slice(0, visibleChipCount(chips, 200))
    expect(shown.map((chip) => chip.kind)).toEqual(["worktree", "branch"])
  })
})

describe("visibleChipCount", () => {
  const chips = (labels: string[]) => rowChips(displayRefs(labels))

  test("shows everything that fits", () => {
    expect(visibleChipCount(chips(["main", "tag: v1"]), 1_000)).toBe(2)
  })

  test("collapses remotes and tags before anything else", () => {
    const all = chips(["main", "release", "origin/staging", "tag: v1.0.0"])
    const shown = all.slice(0, visibleChipCount(all, 200))
    expect(shown.map((chip) => chip.kind)).toEqual(["branch", "branch"])
  })

  test("keeps every local branch even when they overflow on their own", () => {
    const all = chips(["a-long-branch-name", "another-long-branch-name", "a-third-long-branch-name"])
    expect(visibleChipCount(all, 40)).toBe(3)
  })

  test("keeps a stash rather than folding it away", () => {
    const refs = displayRefs(["main", "origin/staging", "tag: v1.0.0"])
    const all = rowChips(refs, [{ base: "a", branch: "main", date: "", message: "set aside", name: "stash@{0}", sha: "s" }])
    const shown = all.slice(0, visibleChipCount(all, 200))
    expect(shown.map((chip) => chip.kind)).toEqual(["branch", "stash"])
  })

  test("counts a long label at the width CSS caps it to", () => {
    const long = rowChips(displayRefs(["a".repeat(200)]))
    const short = rowChips(displayRefs(["a".repeat(60)]))
    expect(chipWidth(long[0])).toBe(chipWidth(short[0]))
  })

  test("keeps chips that fit once long labels stop being over-counted", () => {
    const refs = displayRefs(["HEAD -> main", "origin/main", "origin/other"], { remotes: ["origin"] })
    const chips = rowChips(refs, [{ base: "a", branch: "main", date: "", message: "fix(graph): a stash message about as long as a commit subject", name: "stash@{0}", sha: "s" }])
    expect(visibleChipCount(chips, 460)).toBe(chips.length)
  })

  test("always shows one chip, however narrow the column is", () => {
    expect(visibleChipCount(chips(["origin/a-very-long-remote-branch-name"]), 10)).toBe(1)
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
  test("covers the viewport under the header with a margin at each end", () => {
    expect(graphCanvasHeight(400)).toBe(400 - GRAPH_HEADER_HEIGHT + 2 * GRAPH_CANVAS_OVERSCAN)
  })

  test("uses the active header height for coarse pointers", () => {
    expect(graphCanvasHeight(500, 44)).toBe(500 - 44 + 2 * GRAPH_CANVAS_OVERSCAN)
  })

  test("stays at zero for a viewport shorter than the header", () => {
    expect(graphCanvasHeight(0)).toBe(0)
  })
})

describe("unpushedHashes with other remotes", () => {
  test("counts a commit as pushed when any remote reaches it", () => {
    const commits = [commit("a", ["b"], ["main"]), commit("b", ["c"], ["upstream/main"]), commit("c")]
    expect([...unpushedHashes(commits, ["origin", "upstream"])]).toEqual(["a"])
  })

  test("ignores a remote the repository does not have", () => {
    const commits = [commit("a", ["b"], ["upstream/main"]), commit("b")]
    expect([...unpushedHashes(commits, ["origin"])]).toEqual(["a", "b"])
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
    displayRefs(["feature"], { branchSync: value ? new Map([[value.branch, value]]) : undefined })[0]

  test("attaches sync state to local branches only", () => {
    const refs = displayRefs(["main", "origin/staging", "tag: v1"], { branchSync: new Map([["main", sync({ branch: "main" })]]) })
    expect(refs.map((entry) => entry.sync?.branch ?? null)).toEqual(["main", null, null])
  })

  test("separates standalone remote refs from local branches and tags", () => {
    const refs = displayRefs(["main", "origin/staging", "tag: v1"])
    expect(refs.map((ref) => ref.kind)).toEqual(["branch", "remote", "tag"])
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

describe("branchesContaining", () => {
  const branched = [
    commit("a", ["b"], ["topic"]),
    commit("b", ["c"], ["main"]),
    commit("c", ["d"]),
    commit("d"),
  ]

  test("finds every branch whose tip still reaches the selected commit", () => {
    expect(branchesContaining(branched, 2).map((entry) => entry.branch)).toEqual(["main", "topic"])
  })

  test("ignores branches that cannot reach the selected commit", () => {
    expect(branchesContaining(branched, 0).map((entry) => entry.branch)).toEqual(["topic"])
  })

  test("ignores a branch on an unrelated line of history", () => {
    const forked = [
      commit("a", ["c"], ["topic"]),
      commit("x", ["c"], ["other"]),
      commit("c"),
    ]

    expect(branchesContaining(forked, 0).map((entry) => entry.branch)).toEqual(["topic"])
  })
})

describe("ref kinds", () => {
  test("separates local branches, remote branches and tags", () => {
    const [local] = displayRefs(["main"])
    const [remote] = displayRefs(["origin/release"])
    const [tag] = displayRefs(["tag: v1.0.0"])

    expect(local.kind).toBe("branch")
    expect(remote.kind).toBe("remote")
    expect(tag.kind).toBe("tag")
  })

  test("carries the ref kind into the selection", () => {
    const [tag] = displayRefs(["tag: v1.0.0"])

    expect(refSelection(tag, "abc")).toEqual({ kind: "tag", ref: tag, sha: "abc" })
  })
})

describe("commitSelection", () => {
  test("reports the branches that can carry the selected range", () => {
    const branched = [
      commit("a", ["b"], ["topic"]),
      commit("b", ["c"], ["main"]),
      commit("c"),
    ]

    expect(commitSelection(branched, 1, 1)?.branches.map((entry) => entry.branch)).toEqual(["main", "topic"])
  })
})

describe("unpushedLanes", () => {
  function laned(hash: string, parents: string[], lane: number, parentLanes: number[], activeLanes: boolean[], refs: string[] = []) {
    return { ...commit(hash, parents, refs), lane, parentLanes, activeLanes }
  }

  test("shades a lane on the rows it only passes through", () => {
    const commits = [
      laned("a", ["c"], 0, [0], [true]),
      laned("b", ["c"], 1, [1], [true, true], ["origin/pushed"]),
      laned("c", [], 0, [], []),
    ]

    const masks = unpushedLanes(commits, unpushedHashes(commits))

    expect(masks[0]).toBe(0b1)
    expect(masks[1]).toBe(0b1)
  })

  test("leaves a pushed lane alone", () => {
    const commits = [
      laned("a", ["c"], 0, [0], [true], ["origin/main"]),
      laned("b", ["c"], 1, [1], [true, true]),
      laned("c", [], 0, [], []),
    ]

    const masks = unpushedLanes(commits, unpushedHashes(commits))

    expect(masks[0]).toBe(0)
    expect(masks[1]).toBe(0b10)
  })
})

describe("parentEdgeColor", () => {
  const mergeCommit = { ...commit("m", ["f", "g"]), lane: 3, parentLanes: [3, 4] }

  test("keeps the commit colour on the line it continues", () => {
    expect(parentEdgeColor(mergeCommit, 0, 3)).toBe(laneColor(3))
  })

  test("gives a merged branch the colour of the lane it lands on", () => {
    expect(parentEdgeColor(mergeCommit, 1, 4)).toBe(laneColor(4))
  })

  test("follows a merged branch that bends into another lane", () => {
    expect(parentEdgeColor(mergeCommit, 1, 1)).toBe(laneColor(1))
  })
})

describe("startsLane", () => {
  function laned(hash: string, lane: number, parentLanes: number[], activeLanes: boolean[]) {
    return { ...commit(hash), lane, parentLanes, activeLanes }
  }

  // A merge whose second parent is already awaited by a lane running down the graph joins that lane.
  const joining = [
    laned("above", 4, [4], [true, true, true, true, true]),
    laned("merge", 4, [4, 3], [true, true, true, true, true]),
    laned("parent", 3, [3], [true, true, true, true]),
  ]

  test("counts the lane a commit continues on", () => {
    expect(startsLane(joining, 1, 4)).toBe(true)
  })

  test("leaves a lane that was already carrying a line to the commit that opened it", () => {
    expect(startsLane(joining, 1, 3)).toBe(false)
  })

  test("counts a lane a merge opens for the branch it brings in", () => {
    const opening = [
      laned("above", 4, [4], [false, false, false, false, true]),
      laned("merge", 4, [4, 3], [false, false, false, true, true]),
    ]

    expect(startsLane(opening, 1, 3)).toBe(true)
  })

  test("leaves a joined lane with the state of the line it belongs to", () => {
    const masks = unpushedLanes(joining, new Set(["merge"]))

    expect(masks[1] & 0b1000).toBe(0)
    expect(masks[1] & 0b10000).not.toBe(0)
  })
})
