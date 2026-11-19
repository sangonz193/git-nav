import { describe, expect, test } from "bun:test"

import { indexPullRequests } from "./commit-graph"
import type {
  BranchPullRequest,
  BranchSync,
  Commit,
  RowWorktree,
  StashEntry,
} from "./commit-graph"
import {
  activeFilterCount,
  applyViewConfigSetting,
  appendGraphRows,
  branchFilterMetadataKey,
  branchFiltersKey,
  commitChips,
  DEFAULT_BRANCH_FILTERS,
  describeBranchFilters,
  DEFAULT_VIEW_CONFIG,
  isMarkedCommit,
  loadViewConfig,
  rowIndexOfCommit,
  searchGraph,
  type ChipContext,
  viewConfigSettingKeys,
} from "./commit-graph-view"

function commit(
  hash: string,
  refs: string[] = [],
  activeLanes: boolean[] = [true],
): Commit {
  return {
    hash,
    parents: [],
    author: "Ada",
    date: "2026-01-01T00:00:00Z",
    refs,
    subject: `subject ${hash}`,
    lane: 0,
    parentLanes: activeLanes[0] ? [0] : [],
    laneCount: activeLanes.length,
    incomingLanes: [0],
    activeLanes,
  }
}

function context(overrides: Partial<ChipContext> = {}): ChipContext {
  return {
    branchSync: new Map(),
    chipKinds: DEFAULT_VIEW_CONFIG.chipKinds,
    filters: DEFAULT_BRANCH_FILTERS,
    pullRequests: new Map(),
    remotes: ["origin"],
    stashesByBase: new Map(),
    worktreesByHead: new Map(),
    ...overrides,
  }
}

const stash: StashEntry = {
  base: "c",
  branch: "main",
  date: "2026-01-01T00:00:00Z",
  message: "work in progress",
  name: "stash@{0}",
  sha: "s",
}
const worktree: RowWorktree = {
  branch: "feature",
  changedFiles: 0,
  head: "d",
  isCurrent: false,
  isOpen: false,
  name: "feature",
  path: "/tmp/feature",
  pendingOperation: null,
  untrackedFiles: 0,
}

describe("loadViewConfig", () => {
  test("falls back to the defaults when nothing is stored", () => {
    return expect(
      loadViewConfig(
        async () => {
          throw new Error("unreachable")
        },
        async () => undefined,
        null,
        "desktop",
      ),
    ).resolves.toEqual(DEFAULT_VIEW_CONFIG)
  })

  test("falls back to the defaults when the stored value is not readable", () => {
    return expect(
      loadViewConfig(
        async () => {
          throw new Error("unreachable")
        },
        async () => undefined,
        "{oops",
        "desktop",
      ),
    ).resolves.toEqual(DEFAULT_VIEW_CONFIG)
  })

  test("keeps the defaults for anything the legacy value leaves out", async () => {
    const config = await loadViewConfig(
      async () => {
        throw new Error("unreachable")
      },
      async () => undefined,
      JSON.stringify({ chipKinds: { tag: false } }),
      "desktop",
    )
    expect(config.chipKinds).toEqual({
      branch: true,
      remote: true,
      stash: true,
      tag: false,
    })
    expect(config.cleanOptions).toEqual(DEFAULT_VIEW_CONFIG.cleanOptions)
  })

  test("ignores legacy values with the wrong types", async () => {
    const config = await loadViewConfig(
      async () => {
        throw new Error("unreachable")
      },
      async () => undefined,
      JSON.stringify({
        chipKinds: { branch: "yes", tag: false },
        cleanOptions: { deleteMergedBranches: 1 },
      }),
      "desktop",
    )
    expect(config).toEqual({
      chipKinds: { branch: true, remote: true, stash: true, tag: false },
      cleanOptions: DEFAULT_VIEW_CONFIG.cleanOptions,
    })
  })
})

describe("loadViewConfig", () => {
  test("migrates a readable legacy value into the client's individual settings", async () => {
    const saved: [string, boolean][] = []
    let removed = false
    const config = await loadViewConfig(
      async () => ({}),
      async (key, value) => {
        saved.push([key, value])
      },
      JSON.stringify({ chipKinds: { tag: false } }),
      "browser-a",
      () => {
        removed = true
      },
    )
    const keys = viewConfigSettingKeys("browser-a")
    expect(config.chipKinds.tag).toBe(false)
    expect(saved).toContainEqual([keys.chipKinds.tag, false])
    expect(saved).toContainEqual([keys.chipKinds.branch, true])
    expect(saved).toHaveLength(7)
    expect(removed).toBe(true)
  })

  test("loads only the requested client's values", async () => {
    const browserA = viewConfigSettingKeys("browser-a")
    const browserB = viewConfigSettingKeys("browser-b")
    const config = await loadViewConfig(
      async () => ({
        [browserA.chipKinds.tag]: false,
        [browserB.chipKinds.tag]: true,
      }),
      async () => undefined,
      null,
      "browser-a",
    )
    expect(config.chipKinds.tag).toBe(false)
  })

  test("loads each setting independently", async () => {
    const keys = viewConfigSettingKeys("desktop")
    const config = await loadViewConfig(
      async () => ({
        [keys.chipKinds.tag]: false,
        [keys.cleanOptions.deleteMergedBranches]: true,
      }),
      async () => undefined,
      null,
      "desktop",
    )
    expect(config.chipKinds.tag).toBe(false)
    expect(config.chipKinds.branch).toBe(true)
    expect(config.cleanOptions.deleteMergedBranches).toBe(true)
  })

  test("ignores a per-setting value with the wrong type", async () => {
    const keys = viewConfigSettingKeys("desktop")
    const config = await loadViewConfig(
      async () => ({ [keys.chipKinds.tag]: "no" }),
      async () => undefined,
      null,
      "desktop",
    )
    expect(config.chipKinds.tag).toBe(true)
  })

  test("does not overwrite settings that already migrated", async () => {
    const keys = viewConfigSettingKeys("desktop")
    const saved: [string, boolean][] = []
    const config = await loadViewConfig(
      async () => ({ [keys.chipKinds.tag]: true }),
      async (key, value) => {
        saved.push([key, value])
      },
      JSON.stringify({ chipKinds: { branch: false, tag: false } }),
      "desktop",
    )
    expect(config.chipKinds).toEqual({
      branch: false,
      remote: true,
      stash: true,
      tag: true,
    })
    expect(saved.some(([key]) => key === keys.chipKinds.tag)).toBe(false)
    expect(saved).toHaveLength(6)
  })

  test("replaces an invalid stored setting during migration", async () => {
    const keys = viewConfigSettingKeys("desktop")
    const saved: [string, boolean][] = []
    const config = await loadViewConfig(
      async () => ({ [keys.chipKinds.tag]: "no" }),
      async (key, value) => {
        saved.push([key, value])
      },
      JSON.stringify({ chipKinds: { tag: false } }),
      "desktop",
    )
    expect(config.chipKinds.tag).toBe(false)
    expect(saved).toContainEqual([keys.chipKinds.tag, false])
    expect(saved).toHaveLength(7)
  })

  test("uses the legacy value when the settings store is unreachable", async () => {
    const config = await loadViewConfig(
      async () => {
        throw new Error("unreachable")
      },
      async () => undefined,
      JSON.stringify({ chipKinds: { stash: false } }),
      "desktop",
    )
    expect(config.chipKinds.stash).toBe(false)
  })

  test("does not migrate an unreadable legacy value", async () => {
    const saved: unknown[] = []
    await loadViewConfig(
      async () => ({}),
      async (key, value) => {
        saved.push([key, value])
      },
      "{oops",
      "desktop",
    )
    expect(saved).toEqual([])
  })

  test("keeps the legacy value when migration fails and reports the error", async () => {
    const failures: unknown[] = []
    let removed = false
    await loadViewConfig(
      async () => ({}),
      async () => {
        throw new Error("unwritable")
      },
      JSON.stringify({ chipKinds: { tag: false } }),
      "desktop",
      () => {
        removed = true
      },
      (error) => {
        failures.push(error)
      },
    )
    expect(failures).toHaveLength(7)
    expect(removed).toBe(false)
  })
})

describe("applyViewConfigSetting", () => {
  test("merges a broadcast setting without replacing other values", () => {
    const keys = viewConfigSettingKeys("desktop")
    const current = {
      ...DEFAULT_VIEW_CONFIG,
      chipKinds: { ...DEFAULT_VIEW_CONFIG.chipKinds, tag: false },
    }
    const next = applyViewConfigSetting(
      current,
      "desktop",
      keys.chipKinds.branch,
      false,
    )
    expect(next.chipKinds).toEqual({
      branch: false,
      remote: true,
      stash: true,
      tag: false,
    })
  })

  test("ignores the emitting window's unchanged value", () => {
    const key = viewConfigSettingKeys("desktop").chipKinds.tag
    expect(
      applyViewConfigSetting(DEFAULT_VIEW_CONFIG, "desktop", key, true),
    ).toBe(DEFAULT_VIEW_CONFIG)
  })
})

describe("commitChips", () => {
  test("drops the kinds that are turned off", () => {
    const chips = commitChips(
      commit("a", ["refs/heads/main", "tag: refs/tags/v1.0.0"]),
      context({
        chipKinds: { branch: true, remote: true, stash: true, tag: false },
      }),
    )
    expect(chips.map((chip) => chip.kind)).toEqual(["branch"])
  })

  test("keeps the checked out ref whatever is turned off", () => {
    const chips = commitChips(
      commit("a", ["HEAD -> refs/remotes/origin/main"]),
      context({
        chipKinds: { branch: false, remote: false, stash: false, tag: false },
      }),
    )
    expect(chips).toHaveLength(1)
    expect(chips[0].kind).toBe("remote")
  })

  test("keeps a stash on the commit it was made from", () => {
    const chips = commitChips(
      commit("c"),
      context({ stashesByBase: new Map([["c", [stash]]]) }),
    )
    expect(chips.map((chip) => chip.kind)).toEqual(["stash"])
  })

  function sync(branch: string, overrides: Partial<BranchSync> = {}) {
    return {
      ahead: 0,
      behind: 0,
      branch,
      isGone: false,
      upstream: `origin/${branch}`,
      ...overrides,
    }
  }
  const branchSync = new Map<string, BranchSync>([
    ["gone", sync("gone", { isGone: true })],
    ["local", sync("local", { upstream: null })],
    ["tracked", sync("tracked")],
  ])
  const filtered = commit("a", [
    "refs/heads/gone",
    "refs/heads/local",
    "refs/heads/tracked",
    "refs/remotes/origin/tracked",
    "refs/remotes/origin/other",
    "tag: refs/tags/v1",
  ])
  const labels = (chips: ReturnType<typeof commitChips>) =>
    chips.map((chip) =>
      chip.kind === "stash" ? chip.entry.name
      : chip.kind === "worktree" ? chip.worktree.name
      : chip.ref.label,
    )

  test("keeps only the branches whose upstream is gone", () => {
    const chips = commitChips(
      filtered,
      context({
        branchSync,
        filters: { ...DEFAULT_BRANCH_FILTERS, upstream: "gone" },
      }),
    )
    expect(labels(chips)).toEqual(["gone", "v1"])
  })

  test("keeps only the branches without an upstream", () => {
    const chips = commitChips(
      filtered,
      context({
        branchSync,
        filters: { ...DEFAULT_BRANCH_FILTERS, upstream: "none" },
      }),
    )
    expect(labels(chips)).toEqual(["local", "v1"])
  })

  test("a tracked upstream drops the remote refs alongside the untracked branches", () => {
    const chips = commitChips(
      filtered,
      context({
        branchSync,
        filters: { ...DEFAULT_BRANCH_FILTERS, upstream: "tracked" },
      }),
    )
    expect(labels(chips)).toEqual(["tracked · origin", "v1"])
  })

  const pullRequest = (
    branch: string,
    state: BranchPullRequest["state"],
  ): [string, BranchPullRequest[]] => [
    `origin/${branch}`,
    [
      {
        branch,
        remote: "origin",
        host: "github.com",
        repository: "owner/repo",
        number: 1,
        state,
        title: branch,
        url: "",
      },
    ],
  ]
  const pullRequests = new Map([
    pullRequest("gone", "merged"),
    pullRequest("other", "open"),
  ])

  test("keeps only the refs with a linked pull request in a chosen state", () => {
    const chips = commitChips(
      filtered,
      context({
        branchSync,
        filters: {
          ...DEFAULT_BRANCH_FILTERS,
          pullRequest: "linked",
          pullRequestStates: {
            open: true,
            draft: false,
            merged: false,
            closed: false,
          },
        },
        pullRequests,
      }),
    )
    expect(labels(chips)).toEqual(["origin/other", "v1"])
  })

  test("keeps only the refs without a pull request", () => {
    const chips = commitChips(
      filtered,
      context({
        branchSync,
        filters: { ...DEFAULT_BRANCH_FILTERS, pullRequest: "none" },
        pullRequests,
      }),
    )
    expect(labels(chips)).toEqual(["local", "tracked · origin", "v1"])
  })

  test("matches any PR destination without matching another remote's branch", () => {
    const row = commit("a", [
      "refs/remotes/origin/feature",
      "refs/remotes/upstream/feature",
    ])
    const entry = {
      branch: "feature",
      remote: "origin",
      host: "github.com",
      repository: "owner/repo",
      number: 1,
      state: "closed" as const,
      title: "Feature",
      url: "https://github.com/owner/repo/pull/1",
    }
    const requests = indexPullRequests([
      entry,
      {
        ...entry,
        repository: "fork/repo",
        state: "open",
        url: "https://github.com/fork/repo/pull/1",
      },
      { ...entry, remote: "upstream" },
    ])
    const filters = {
      ...DEFAULT_BRANCH_FILTERS,
      pullRequest: "linked" as const,
      pullRequestStates: {
        open: true,
        draft: false,
        merged: false,
        closed: false,
      },
    }
    expect(
      labels(
        commitChips(
          row,
          context({
            filters,
            pullRequests: requests,
            remotes: ["origin", "upstream"],
          }),
        ),
      ),
    ).toEqual(["origin/feature"])
    expect(branchFilterMetadataKey(filters, new Map(), requests)).not.toBe(
      branchFilterMetadataKey(filters, new Map(), indexPullRequests([entry])),
    )
  })

  test("a branch tracking a differently named upstream carries that upstream's pull request", () => {
    const renamed = commit("a", [
      "refs/heads/local",
      "refs/remotes/origin/pr-branch",
    ])
    const renamedSync = new Map([
      ["local", sync("local", { upstream: "origin/pr-branch" })],
    ])
    const renamedPullRequests = new Map([pullRequest("pr-branch", "open")])
    const linked = commitChips(
      renamed,
      context({
        branchSync: renamedSync,
        filters: { ...DEFAULT_BRANCH_FILTERS, pullRequest: "linked" },
        pullRequests: renamedPullRequests,
      }),
    )
    expect(labels(linked)).toEqual(["local · origin"])
    const none = commitChips(
      renamed,
      context({
        branchSync: renamedSync,
        filters: { ...DEFAULT_BRANCH_FILTERS, pullRequest: "none" },
        pullRequests: renamedPullRequests,
      }),
    )
    expect(labels(none)).toEqual([])
  })

  test("a branch ahead of its upstream still carries that upstream's pull request", () => {
    const ahead = commit("a", ["refs/heads/local"])
    const aheadSync = new Map([
      ["local", sync("local", { ahead: 1, upstream: "origin/pr-branch" })],
    ])
    const chips = commitChips(
      ahead,
      context({
        branchSync: aheadSync,
        filters: { ...DEFAULT_BRANCH_FILTERS, pullRequest: "linked" },
        pullRequests: new Map([pullRequest("pr-branch", "open")]),
      }),
    )
    expect(labels(chips)).toEqual(["local"])
  })

  test("a branch tracking another remote does not carry the pull request of its own name", () => {
    const tracked = commit("a", [
      "refs/heads/local",
      "refs/remotes/upstream/local",
    ])
    const trackedSync = new Map([
      ["local", sync("local", { upstream: "upstream/local" })],
    ])
    const chips = commitChips(
      tracked,
      context({
        branchSync: trackedSync,
        filters: { ...DEFAULT_BRANCH_FILTERS, pullRequest: "linked" },
        pullRequests: new Map([pullRequest("local", "open")]),
        remotes: ["origin", "upstream"],
      }),
    )
    expect(labels(chips)).toEqual([])
  })

  test("the checkout survives a filter it does not match", () => {
    const chips = commitChips(
      commit("a", ["HEAD -> refs/heads/local"]),
      context({
        branchSync,
        filters: { ...DEFAULT_BRANCH_FILTERS, upstream: "gone" },
      }),
    )
    expect(labels(chips)).toEqual(["local"])
  })
})

describe("branch filters", () => {
  test("counts each narrowed axis once", () => {
    expect(activeFilterCount(DEFAULT_BRANCH_FILTERS)).toBe(0)
    expect(
      activeFilterCount({
        ...DEFAULT_BRANCH_FILTERS,
        pullRequest: "linked",
        upstream: "gone",
      }),
    ).toBe(2)
  })

  test("names each narrowed axis, and the states when not all are chosen", () => {
    expect(describeBranchFilters(DEFAULT_BRANCH_FILTERS)).toBe("")
    expect(
      describeBranchFilters({ ...DEFAULT_BRANCH_FILTERS, upstream: "gone" }),
    ).toBe("Upstream gone")
    expect(
      describeBranchFilters({
        ...DEFAULT_BRANCH_FILTERS,
        pullRequest: "linked",
        upstream: "none",
      }),
    ).toBe("Upstream none · Pull request linked")
    expect(
      describeBranchFilters({
        ...DEFAULT_BRANCH_FILTERS,
        pullRequest: "linked",
        pullRequestStates: {
          open: true,
          draft: false,
          merged: true,
          closed: false,
        },
      }),
    ).toBe("Pull request open, merged")
    expect(
      describeBranchFilters({ ...DEFAULT_BRANCH_FILTERS, pullRequest: "none" }),
    ).toBe("No pull request")
  })

  test("the key changes with the chosen pull request states", () => {
    const linked = { ...DEFAULT_BRANCH_FILTERS, pullRequest: "linked" as const }
    expect(branchFiltersKey(linked)).not.toBe(
      branchFiltersKey({
        ...linked,
        pullRequestStates: { ...linked.pullRequestStates, merged: false },
      }),
    )
  })
})

describe("isMarkedCommit", () => {
  test("a commit nothing points at is not marked", () => {
    expect(isMarkedCommit(commit("a"), context())).toBe(false)
  })

  test("a commit whose only ref is hidden is not marked", () => {
    const hidden = context({
      chipKinds: { branch: true, remote: true, stash: true, tag: false },
    })
    expect(isMarkedCommit(commit("a", ["tag: refs/tags/v1.0.0"]), hidden)).toBe(
      false,
    )
  })

  test("the checkout is marked even with every kind hidden", () => {
    const hidden = context({
      chipKinds: { branch: false, remote: false, stash: false, tag: false },
    })
    expect(
      isMarkedCommit(commit("a", ["HEAD -> refs/heads/main"]), hidden),
    ).toBe(true)
  })

  test("a worktree marks the commit it sits on", () => {
    expect(
      isMarkedCommit(
        commit("d"),
        context({ worktreesByHead: new Map([["d", [worktree]]]) }),
      ),
    ).toBe(true)
  })
})

describe("appendGraphRows", () => {
  const marked = (commit: Commit) => commit.refs.length > 0
  const nothingRevealed = () => false

  test("a branch opened by a folded merge joins the lane that merged it", () => {
    const commits = [
      commit("a", ["refs/heads/main"]),
      { ...commit("merge", [], [true, true]), parentLanes: [0, 1] },
      {
        ...commit("branch", ["topic"], [true, true]),
        incomingLanes: [1],
        lane: 1,
        parentLanes: [1],
      },
    ]
    expect(
      appendGraphRows(null, commits, marked, nothingRevealed).rows,
    ).toEqual([
      { hidden: 0, index: 0, lanes: 0 },
      {
        hidden: 1,
        index: 1,
        joins: [{ from: 0, opens: true, to: 1 }],
        lanes: 1,
      },
      { hidden: 0, index: 2, lanes: 0 },
    ])
  })

  test("a branch forked from a folded commit joins the lane it forked from", () => {
    const commits = [
      commit("a", ["refs/heads/main"], [true, true]),
      { ...commit("fork"), incomingLanes: [0, 1], parentLanes: [0] },
      commit("b", ["refs/heads/old"]),
    ]
    expect(
      appendGraphRows(null, commits, marked, nothingRevealed).rows,
    ).toEqual([
      { hidden: 0, index: 0, lanes: 0 },
      {
        hidden: 1,
        index: 1,
        joins: [{ from: 1, opens: false, to: 0 }],
        lanes: 1,
      },
      { hidden: 0, index: 2, lanes: 0 },
    ])
  })

  test("a branch that opens and ends inside a run joins nothing", () => {
    const commits = [
      commit("a", ["refs/heads/main"]),
      { ...commit("merge", [], [true, true]), parentLanes: [0, 1] },
      {
        ...commit("branch", [], [true, true]),
        incomingLanes: [1],
        lane: 1,
        parentLanes: [1],
      },
      { ...commit("fork"), incomingLanes: [0, 1], parentLanes: [0] },
      commit("b", ["refs/heads/old"]),
    ]
    const [, run] = appendGraphRows(null, commits, marked, nothingRevealed).rows
    expect(run).toEqual({ hidden: 3, index: 1, lanes: 1 })
  })

  test("a folded tip reusing a merged branch lane has no opening join", () => {
    const commits = [
      { ...commit("above", ["main"]), parents: ["merge"] },
      {
        ...commit("merge", [], [true, true]),
        parents: ["fork", "branch"],
        parentLanes: [0, 1],
      },
      {
        ...commit("branch", [], [true, true]),
        parents: ["fork"],
        lane: 1,
        incomingLanes: [1],
        parentLanes: [1],
      },
      { ...commit("fork"), parents: ["below"], incomingLanes: [0, 1] },
      {
        ...commit("tip", [], [true, true]),
        parents: ["unrelated"],
        lane: 1,
        incomingLanes: [],
        parentLanes: [1],
      },
      { ...commit("below", ["old"], [true, true]), parents: ["older"] },
    ]
    const [, run] = appendGraphRows(null, commits, marked, nothingRevealed).rows
    expect(run).toEqual({ hidden: 4, index: 1, lanes: 1 })
  })

  test("a closing follows the reused line to its destination below the run", () => {
    const commits = [
      {
        ...commit("above", ["main"], [true, true, true, true]),
        parents: ["first-fork"],
      },
      {
        ...commit("first-fork", [], [true, true, false, true]),
        parents: ["merge"],
        incomingLanes: [0, 2],
      },
      {
        ...commit("merge", [], [true, true, true, true]),
        parents: ["below", "branch"],
        parentLanes: [0, 2],
      },
      {
        ...commit("branch", [], [true, true, true, true]),
        parents: ["inner-fork"],
        lane: 2,
        incomingLanes: [2],
        parentLanes: [2],
      },
      {
        ...commit("inner-fork", [], [true, true, true]),
        parents: ["last-fork"],
        lane: 2,
        incomingLanes: [2, 3],
        parentLanes: [2],
      },
      {
        ...commit("last-fork", [], [true, true]),
        parents: ["branch-parent"],
        lane: 1,
        incomingLanes: [1, 2],
        parentLanes: [1],
      },
      { ...commit("below", ["old"], [true, true]), parents: ["older"] },
    ]
    const [, run] = appendGraphRows(null, commits, marked, nothingRevealed).rows
    expect(run).toEqual({
      hidden: 5,
      index: 1,
      joins: [
        { from: 3, opens: false, to: 1 },
        { from: 2, opens: false, to: 0 },
      ],
      lanes: 3,
    })
  })

  test("a root followed by a tip in the same lane does not draw a straight line", () => {
    const commits = [
      { ...commit("above", ["main"]), parents: ["root"] },
      { ...commit("root", [], []), parentLanes: [] },
      { ...commit("tip"), parents: ["below"], incomingLanes: [] },
      { ...commit("below", ["old"]), parents: ["older"] },
    ]
    const [, run] = appendGraphRows(null, commits, marked, nothingRevealed).rows
    expect(run).toEqual({ hidden: 2, index: 1, lanes: 0 })
  })

  test("chained forks join the outer lane below the run", () => {
    const commits = [
      commit("above", ["refs/heads/main"], [true, true, true]),
      {
        ...commit("inner", [], [true, true]),
        lane: 1,
        incomingLanes: [1, 2],
        parentLanes: [1],
      },
      { ...commit("outer"), incomingLanes: [0, 1], parentLanes: [0] },
      commit("below", ["refs/heads/old"]),
    ]
    const [, run] = appendGraphRows(null, commits, marked, nothingRevealed).rows
    expect(run).toEqual({
      hidden: 2,
      index: 1,
      joins: [
        { from: 1, opens: false, to: 0 },
        { from: 2, opens: false, to: 0 },
      ],
      lanes: 1,
    })
  })

  test("chained merges join the outer lane even after the intermediate lane closes", () => {
    const commits = [
      commit("above", ["refs/heads/main"]),
      { ...commit("outer", [], [true, true]), parentLanes: [0, 1] },
      {
        ...commit("inner", [], [true, true, true]),
        lane: 1,
        incomingLanes: [1],
        parentLanes: [1, 2],
      },
      {
        ...commit("fork", [], [true, false, true]),
        incomingLanes: [0, 1],
        parentLanes: [0],
      },
      commit("below", ["refs/heads/old"], [true, false, true]),
    ]
    const [, run] = appendGraphRows(null, commits, marked, nothingRevealed).rows
    expect(run).toEqual({
      hidden: 3,
      index: 1,
      joins: [{ from: 0, opens: true, to: 2 }],
      lanes: 1,
    })
  })

  test("a lane closed and reopened by the same merge gets both joins", () => {
    const commits = [
      commit("above", ["refs/heads/main"], [true, true]),
      {
        ...commit("merge", [], [true, true]),
        incomingLanes: [0, 1],
        parentLanes: [0, 1],
      },
      commit("below", ["refs/heads/old"], [true, true]),
    ]
    const [, run] = appendGraphRows(null, commits, marked, nothingRevealed).rows
    expect(run).toEqual({
      hidden: 1,
      index: 1,
      joins: [
        { from: 1, opens: false, to: 0 },
        { from: 0, opens: true, to: 1 },
      ],
      lanes: 1,
    })
  })

  test("drops a closing with no active destination below the run", () => {
    const commits = [
      commit("above", ["refs/heads/main"], [true, true]),
      { ...commit("fork", [], []), incomingLanes: [0, 1] },
      commit("below", ["refs/heads/old"], []),
    ]
    const [, run] = appendGraphRows(null, commits, marked, nothingRevealed).rows
    expect(run).toEqual({ hidden: 1, index: 1, lanes: 0 })
  })

  test("a branch opened by the folded default branch tip joins the line that reached the tip", () => {
    const commits = [
      {
        ...commit("feature", ["topic"], [false, true]),
        parents: ["tip"],
        lane: 1,
        incomingLanes: [],
        parentLanes: [1],
      },
      {
        ...commit("tip", [], [true, true]),
        parents: ["main-parent", "branch"],
        incomingLanes: [1],
        parentLanes: [0, 1],
      },
      {
        ...commit("branch", ["old"], [true, true]),
        parents: ["main-parent"],
        lane: 1,
        incomingLanes: [1],
        parentLanes: [1],
      },
    ]
    const [, run] = appendGraphRows(null, commits, marked, nothingRevealed).rows
    expect(run).toEqual({
      hidden: 1,
      index: 1,
      joins: [
        { from: 1, opens: false, to: 0 },
        { from: 1, opens: true, to: 1 },
      ],
      lanes: 0,
    })
  })

  test("a branch opened below the folded default branch tip joins the line that reached the tip", () => {
    const commits = [
      {
        ...commit("feature", ["topic"], [false, true]),
        parents: ["tip"],
        lane: 1,
        incomingLanes: [],
        parentLanes: [1],
      },
      { ...commit("tip"), parents: ["merge"], incomingLanes: [1] },
      {
        ...commit("merge", [], [true, true]),
        parents: ["main-parent", "branch"],
        parentLanes: [0, 1],
      },
      {
        ...commit("branch", ["old"], [true, true]),
        parents: ["main-parent"],
        lane: 1,
        incomingLanes: [1],
        parentLanes: [1],
      },
    ]
    const [, run] = appendGraphRows(null, commits, marked, nothingRevealed).rows
    expect(run).toEqual({
      hidden: 2,
      index: 1,
      joins: [
        { from: 1, opens: false, to: 0 },
        { from: 1, opens: true, to: 1 },
      ],
      lanes: 0,
    })
  })

  test("a fork that also takes in a folded tip passes the line above it on to the branch it merges", () => {
    const commits = [
      {
        ...commit("feature", ["feature"], [true, true, true]),
        parents: ["fork"],
        lane: 2,
        incomingLanes: [],
        parentLanes: [2],
      },
      {
        ...commit("old-root", ["old"], [true, false, true]),
        lane: 1,
        incomingLanes: [1],
        parentLanes: [],
      },
      {
        ...commit("tip", [], [true, true, true]),
        parents: ["fork"],
        lane: 1,
        incomingLanes: [],
        parentLanes: [1],
      },
      {
        ...commit("fork", [], [true, true]),
        parents: ["merge"],
        lane: 1,
        incomingLanes: [1, 2],
        parentLanes: [1],
      },
      {
        ...commit("merge", [], [true, true, true]),
        parents: ["main-parent", "branch"],
        lane: 1,
        incomingLanes: [1],
        parentLanes: [1, 2],
      },
      {
        ...commit("branch", ["topic"], [true, true, true]),
        parents: ["main-parent"],
        lane: 2,
        incomingLanes: [2],
        parentLanes: [2],
      },
    ]
    const [, , run] = appendGraphRows(
      null,
      commits,
      marked,
      nothingRevealed,
    ).rows
    expect(run).toEqual({
      hidden: 3,
      index: 2,
      joins: [
        { from: 2, opens: false, to: 1 },
        { from: 2, opens: true, to: 2 },
      ],
      lanes: 1,
    })
  })

  test("a merge whose own line ends inside the run joins the line it merged", () => {
    const commits = [
      { ...commit("above", ["main"]), parents: ["merge"], incomingLanes: [] },
      {
        ...commit("topic", ["topic"], [true, true]),
        parents: ["branch"],
        lane: 1,
        incomingLanes: [],
        parentLanes: [1],
      },
      {
        ...commit("merge", [], [true, true]),
        parents: ["root", "branch"],
        parentLanes: [0, 1],
      },
      commit("root", [], [false, true]),
      {
        ...commit("branch", ["old"], [false, true]),
        parents: ["older"],
        lane: 1,
        incomingLanes: [1],
        parentLanes: [1],
      },
    ]
    const [, , run] = appendGraphRows(
      null,
      commits,
      marked,
      nothingRevealed,
    ).rows
    expect(run).toEqual({
      hidden: 2,
      index: 2,
      joins: [{ from: 0, opens: false, to: 1 }],
      lanes: 2,
    })
  })

  test.each([31, 32, 33])(
    "joining lane %i preserves the lower lane mask",
    (lane) => {
      const active = Array.from(
        { length: lane + 1 },
        (_, index) => index === 0 || index === 1 || index === lane,
      )
      const commits = [
        commit("above", ["refs/heads/main"], active),
        {
          ...commit("merge", [], active),
          incomingLanes: [0, lane],
          parentLanes: [0, lane],
        },
        commit("below", ["refs/heads/old"], active),
      ]
      const [, run] = appendGraphRows(
        null,
        commits,
        marked,
        nothingRevealed,
      ).rows
      expect(run.lanes).toBe(3)
      expect(run.joins).toEqual([
        { from: lane, opens: false, to: 0 },
        { from: 0, opens: true, to: lane },
      ])
    },
  )

  test("gathers the commits between two refs into one run", () => {
    const commits = [
      commit("a", ["refs/heads/main"]),
      commit("b"),
      commit("c"),
      commit("d", ["refs/heads/old"]),
    ]
    const { rows } = appendGraphRows(null, commits, marked, nothingRevealed)
    expect(rows).toEqual([
      { hidden: 0, index: 0, lanes: 0 },
      { hidden: 2, index: 1, lanes: 1 },
      { hidden: 0, index: 3, lanes: 0 },
    ])
  })

  test("a lane that stops inside a run does not cross it", () => {
    const commits = [
      commit("a", ["refs/heads/main"]),
      commit("b", [], [true, true]),
      commit("c", [], [true]),
      commit("d", ["refs/heads/old"]),
    ]
    const { rows } = appendGraphRows(null, commits, marked, nothingRevealed)
    expect(rows[1].lanes).toBe(1)
  })

  test("continuing from an earlier batch gives the same rows as one pass", () => {
    const commits = [
      commit("a", ["refs/heads/main"]),
      commit("b"),
      commit("c"),
      commit("d", ["refs/heads/old"]),
      commit("e"),
      commit("f"),
    ]
    const first = appendGraphRows(
      null,
      commits.slice(0, 2),
      marked,
      nothingRevealed,
    )
    const second = appendGraphRows(
      first,
      commits.slice(0, 5),
      marked,
      nothingRevealed,
    )
    const continued = appendGraphRows(second, commits, marked, nothingRevealed)
    expect(continued.rows).toEqual(
      appendGraphRows(null, commits, marked, nothingRevealed).rows,
    )
  })

  test("the rows an earlier batch produced are left alone", () => {
    const commits = [commit("a", ["refs/heads/main"]), commit("b"), commit("c")]
    const first = appendGraphRows(
      null,
      commits.slice(0, 2),
      marked,
      nothingRevealed,
    )
    const before = structuredClone(first.rows)
    appendGraphRows(first, commits, marked, nothingRevealed)
    expect(first.rows).toEqual(before)
  })

  test("a revealed run is shown down to the next ref", () => {
    const commits = [
      commit("a", ["refs/heads/main"]),
      commit("b"),
      commit("c"),
      commit("d", ["refs/heads/old"]),
      commit("e"),
      commit("f"),
    ]
    const { rows } = appendGraphRows(
      null,
      commits,
      marked,
      (hash) => hash === "b",
    )
    expect(rows).toEqual([
      { hidden: 0, index: 0, lanes: 0 },
      { hidden: 0, index: 1, lanes: 0, revealed: 2 },
      { hidden: 0, index: 1, lanes: 0 },
      { hidden: 0, index: 2, lanes: 0 },
      { hidden: 0, index: 3, lanes: 0 },
      { hidden: 2, index: 4, lanes: 1 },
    ])
    expect(rowIndexOfCommit(rows, 1)).toBe(2)
  })

  test("a revealed run carries across the batch that splits it", () => {
    const commits = [
      commit("a", ["refs/heads/main"]),
      commit("b"),
      commit("c"),
      commit("d"),
    ]
    const first = appendGraphRows(
      null,
      commits.slice(0, 3),
      (commit) => commit.refs.length > 0,
      (hash) => hash === "b",
    )
    const continued = appendGraphRows(
      first,
      commits,
      marked,
      (hash) => hash === "b",
    )
    expect(first.rows[1]).toEqual({
      hidden: 0,
      index: 1,
      lanes: 0,
      revealed: 2,
    })
    expect(continued.rows).toEqual([
      { hidden: 0, index: 0, lanes: 0 },
      { hidden: 0, index: 1, lanes: 0, revealed: 3 },
      { hidden: 0, index: 1, lanes: 0 },
      { hidden: 0, index: 2, lanes: 0 },
      { hidden: 0, index: 3, lanes: 0 },
    ])
  })

  test("nothing revealed leaves the graph fully folded", () => {
    const commits = [commit("a", ["refs/heads/main"]), commit("b")]
    expect(
      appendGraphRows(null, commits, marked, nothingRevealed).hasRevealedRuns,
    ).toBe(false)
  })

  test("a revealed run is reported without another pass over the earlier batches", () => {
    const commits = [
      commit("a", ["refs/heads/main"]),
      commit("b"),
      commit("c", ["refs/heads/old"]),
      commit("d"),
      commit("e"),
    ]
    const revealed = (hash: string) => hash === "b"
    const first = appendGraphRows(null, commits.slice(0, 4), marked, revealed)
    expect(first.hasRevealedRuns).toBe(true)
    const scanned: string[] = []
    const continued = appendGraphRows(
      first,
      commits,
      (commit) => {
        scanned.push(commit.hash)
        return marked(commit)
      },
      revealed,
    )
    expect(continued.hasRevealedRuns).toBe(true)
    expect(scanned).toEqual(["d", "e"])
  })

  test("a reveal left on a commit that is now marked is not a revealed run", () => {
    const commits = [
      commit("a", ["refs/heads/main"]),
      commit("b"),
      commit("c", ["refs/heads/old"]),
    ]
    const revealed = (hash: string) => hash === "b"
    expect(
      appendGraphRows(null, commits, marked, revealed).hasRevealedRuns,
    ).toBe(true)
    expect(
      appendGraphRows(null, commits, () => true, revealed).hasRevealedRuns,
    ).toBe(false)
  })

  test("a reveal the loaded commits do not hold is not a revealed run", () => {
    const commits = [commit("a", ["refs/heads/main"]), commit("b")]
    expect(
      appendGraphRows(null, commits, marked, (hash) => hash === "z")
        .hasRevealedRuns,
    ).toBe(false)
  })
})

describe("collapsed graph state", () => {
  test("invalidates cached rows when filtered branch metadata arrives", () => {
    const filters = { ...DEFAULT_BRANCH_FILTERS, upstream: "gone" as const }
    const before = branchFilterMetadataKey(filters, new Map(), new Map())
    const after = branchFilterMetadataKey(
      filters,
      new Map([
        [
          "feature",
          {
            ahead: 0,
            behind: 0,
            branch: "feature",
            isGone: true,
            upstream: "origin/feature",
          },
        ],
      ]),
      new Map(),
    )

    expect(after).not.toBe(before)
  })

  test("invalidates cached rows when filtered pull-request metadata refreshes", () => {
    const filters = {
      ...DEFAULT_BRANCH_FILTERS,
      pullRequest: "linked" as const,
    }
    const before = branchFilterMetadataKey(
      filters,
      new Map(),
      indexPullRequests([
        {
          branch: "feature",
          remote: "origin",
          host: "github.com",
          repository: "owner/repo",
          number: 1,
          state: "open" as const,
          title: "Feature",
          url: "https://example.com/pull/1",
        },
      ]),
    )
    const after = branchFilterMetadataKey(
      filters,
      new Map(),
      indexPullRequests([
        {
          branch: "feature",
          remote: "origin",
          host: "github.com",
          repository: "owner/repo",
          number: 1,
          state: "closed" as const,
          title: "Feature",
          url: "https://example.com/pull/1",
        },
      ]),
    )

    expect(after).not.toBe(before)
  })

  test("invalidates cached rows when branch sync lands after the pull requests it pairs", () => {
    const filters = { ...DEFAULT_BRANCH_FILTERS, pullRequest: "none" as const }
    const row = commit("a", ["refs/heads/local", "refs/remotes/origin/feature"])
    const pullRequests = indexPullRequests([
      {
        branch: "feature",
        remote: "origin",
        host: "github.com",
        repository: "owner/repo",
        number: 1,
        state: "open" as const,
        title: "Feature",
        url: "https://example.com/pull/1",
      },
    ])
    const branchSync = new Map([
      [
        "local",
        {
          ahead: 0,
          behind: 0,
          branch: "local",
          isGone: false,
          upstream: "origin/feature",
        },
      ],
    ])

    expect(isMarkedCommit(row, context({ filters, pullRequests }))).toBe(true)
    expect(
      isMarkedCommit(row, context({ branchSync, filters, pullRequests })),
    ).toBe(false)
    expect(branchFilterMetadataKey(filters, branchSync, pullRequests)).not.toBe(
      branchFilterMetadataKey(filters, new Map(), pullRequests),
    )
  })
})

describe("rowIndexOfCommit", () => {
  const rows = [
    { hidden: 0, index: 0, lanes: 0 },
    { hidden: 3, index: 1, lanes: 1 },
    { hidden: 0, index: 4, lanes: 0 },
  ]

  test("finds the row a visible commit has", () => {
    expect(rowIndexOfCommit(rows, 0)).toBe(0)
    expect(rowIndexOfCommit(rows, 4)).toBe(2)
  })

  test("finds the run a hidden commit sits in", () => {
    expect(rowIndexOfCommit(rows, 1)).toBe(1)
    expect(rowIndexOfCommit(rows, 3)).toBe(1)
  })
})

describe("searchGraph", () => {
  const commits = [
    commit("aaaaaaaa", ["HEAD -> refs/heads/main", "refs/remotes/origin/main"]),
    commit("bbbbbbbb", ["tag: refs/tags/v1.0.0"]),
    commit("cccccccc"),
  ]
  commits[2].subject = "Fix the parser"

  test("an empty query matches nothing", () => {
    expect(searchGraph(commits, "  ")).toEqual([])
  })

  test("ranks refs ahead of the commits carrying them", () => {
    const hits = searchGraph(commits, "main")
    expect(hits.map((hit) => hit.kind)).toEqual(["branch", "remote"])
    expect(hits[0].label).toBe("main")
  })

  test("finds branches ending in /HEAD and skips remote HEAD aliases", () => {
    const refs = [
      "refs/remotes/origin/HEAD",
      "refs/remotes/team/fork/HEAD",
      "refs/remotes/origin/release/HEAD",
    ]
    const hits = searchGraph([commit("aaaaaaaa", refs)], "HEAD", {
      remotes: ["origin", "team/fork"],
    })

    expect(hits.map((hit) => hit.label)).toEqual(["origin/release/HEAD"])
  })

  test("matches a tag by name", () => {
    expect(searchGraph(commits, "v1.0")).toEqual([
      {
        commitIndex: 1,
        detail: "subject bbbbbbbb",
        kind: "tag",
        label: "v1.0.0",
      },
    ])
  })

  test("matches a commit by subject and by hash", () => {
    expect(
      searchGraph(commits, "parser").map((hit) => hit.commitIndex),
    ).toEqual([2])
    expect(searchGraph(commits, "cccc").map((hit) => hit.commitIndex)).toEqual([
      2,
    ])
  })

  test("matches a stash by its message", () => {
    const hits = searchGraph(commits, "progress", {
      stashesByBase: new Map([["cccccccc", [stash]]]),
    })
    expect(hits).toEqual([
      {
        commitIndex: 2,
        detail: "work in progress",
        kind: "stash",
        label: "stash@{0}",
      },
    ])
  })
})
