import { describe, expect, test } from "bun:test"

import type { Commit, RowWorktree, StashEntry } from "./commit-graph"
import {
  applyViewConfigSetting,
  appendGraphRows,
  commitChips,
  DEFAULT_VIEW_CONFIG,
  isMarkedCommit,
  loadViewConfig,
  rowIndexOfCommit,
  searchGraph,
  type ChipContext,
  viewConfigSettingKeys,
} from "./commit-graph-view"

function commit(hash: string, refs: string[] = [], activeLanes: boolean[] = [true]): Commit {
  return {
    hash,
    parents: [],
    author: "Ada",
    date: "2026-01-01T00:00:00Z",
    refs,
    subject: `subject ${hash}`,
    lane: 0,
    parentLanes: [],
    laneCount: 1,
    incomingLanes: [],
    activeLanes,
  }
}

function context(overrides: Partial<ChipContext> = {}): ChipContext {
  return {
    branchSync: new Map(),
    chipKinds: DEFAULT_VIEW_CONFIG.chipKinds,
    pullRequests: new Map(),
    remotes: ["origin"],
    stashesByBase: new Map(),
    worktreesByHead: new Map(),
    ...overrides,
  }
}

const stash: StashEntry = { base: "c", branch: "main", date: "2026-01-01T00:00:00Z", message: "work in progress", name: "stash@{0}", sha: "s" }
const worktree: RowWorktree = { branch: "feature", changedFiles: 0, head: "d", isCurrent: false, isOpen: false, name: "feature", path: "/tmp/feature", pendingOperation: null, untrackedFiles: 0 }

describe("loadViewConfig", () => {
  test("falls back to the defaults when nothing is stored", () => {
    return expect(
      loadViewConfig(
        async () => {
          throw new Error("unreachable")
        },
        async () => undefined,
        null,
        "desktop"
      )
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
        "desktop"
      )
    ).resolves.toEqual(DEFAULT_VIEW_CONFIG)
  })

  test("keeps the defaults for anything the legacy value leaves out", async () => {
    const config = await loadViewConfig(
      async () => {
        throw new Error("unreachable")
      },
      async () => undefined,
      JSON.stringify({ chipKinds: { tag: false }, collapseUnmarked: true }),
      "desktop"
    )
    expect(config.chipKinds).toEqual({ branch: true, remote: true, stash: true, tag: false })
    expect(config.collapseUnmarked).toBe(true)
    expect(config.cleanOptions).toEqual(DEFAULT_VIEW_CONFIG.cleanOptions)
  })

  test("ignores legacy values with the wrong types", async () => {
    const config = await loadViewConfig(
      async () => {
        throw new Error("unreachable")
      },
      async () => undefined,
      JSON.stringify({ chipKinds: { branch: "yes", tag: false }, cleanOptions: { deleteMergedBranches: 1 }, collapseUnmarked: "yes" }),
      "desktop"
    )
    expect(config).toEqual({
      chipKinds: { branch: true, remote: true, stash: true, tag: false },
      cleanOptions: DEFAULT_VIEW_CONFIG.cleanOptions,
      collapseUnmarked: false,
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
      }
    )
    const keys = viewConfigSettingKeys("browser-a")
    expect(config.chipKinds.tag).toBe(false)
    expect(saved).toContainEqual([keys.chipKinds.tag, false])
    expect(saved).toContainEqual([keys.chipKinds.branch, true])
    expect(saved).toHaveLength(8)
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
      "browser-a"
    )
    expect(config.chipKinds.tag).toBe(false)
  })

  test("loads each setting independently", async () => {
    const keys = viewConfigSettingKeys("desktop")
    const config = await loadViewConfig(
      async () => ({
        [keys.chipKinds.tag]: false,
        [keys.cleanOptions.deleteMergedBranches]: true,
        [keys.collapseUnmarked]: true,
      }),
      async () => undefined,
      null,
      "desktop"
    )
    expect(config.chipKinds.tag).toBe(false)
    expect(config.chipKinds.branch).toBe(true)
    expect(config.cleanOptions.deleteMergedBranches).toBe(true)
    expect(config.collapseUnmarked).toBe(true)
  })

  test("ignores a per-setting value with the wrong type", async () => {
    const keys = viewConfigSettingKeys("desktop")
    const config = await loadViewConfig(
      async () => ({ [keys.chipKinds.tag]: "no" }),
      async () => undefined,
      null,
      "desktop"
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
      "desktop"
    )
    expect(config.chipKinds).toEqual({ branch: false, remote: true, stash: true, tag: true })
    expect(saved.some(([key]) => key === keys.chipKinds.tag)).toBe(false)
    expect(saved).toHaveLength(7)
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
      "desktop"
    )
    expect(config.chipKinds.tag).toBe(false)
    expect(saved).toContainEqual([keys.chipKinds.tag, false])
    expect(saved).toHaveLength(8)
  })

  test("uses the legacy value when the settings store is unreachable", async () => {
    const config = await loadViewConfig(
      async () => {
        throw new Error("unreachable")
      },
      async () => undefined,
      JSON.stringify({ chipKinds: { stash: false } }),
      "desktop"
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
      "desktop"
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
      JSON.stringify({ collapseUnmarked: true }),
      "desktop",
      () => {
        removed = true
      },
      (error) => {
        failures.push(error)
      }
    )
    expect(failures).toHaveLength(8)
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
      false
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
    expect(applyViewConfigSetting(DEFAULT_VIEW_CONFIG, "desktop", key, true)).toBe(
      DEFAULT_VIEW_CONFIG
    )
  })
})

describe("commitChips", () => {
  test("drops the kinds that are turned off", () => {
    const chips = commitChips(commit("a", ["main", "tag: v1.0.0"]), context({ chipKinds: { branch: true, remote: true, stash: true, tag: false } }))
    expect(chips.map((chip) => chip.kind)).toEqual(["branch"])
  })

  test("keeps the checked out ref whatever is turned off", () => {
    const chips = commitChips(commit("a", ["HEAD -> origin/main"]), context({ chipKinds: { branch: false, remote: false, stash: false, tag: false } }))
    expect(chips).toHaveLength(1)
    expect(chips[0].kind).toBe("remote")
  })

  test("keeps a stash on the commit it was made from", () => {
    const chips = commitChips(commit("c"), context({ stashesByBase: new Map([["c", [stash]]]) }))
    expect(chips.map((chip) => chip.kind)).toEqual(["stash"])
  })
})

describe("isMarkedCommit", () => {
  test("a commit nothing points at is not marked", () => {
    expect(isMarkedCommit(commit("a"), context())).toBe(false)
  })

  test("a commit whose only ref is hidden is not marked", () => {
    const hidden = context({ chipKinds: { branch: true, remote: true, stash: true, tag: false } })
    expect(isMarkedCommit(commit("a", ["tag: v1.0.0"]), hidden)).toBe(false)
  })

  test("the checkout is marked even with every kind hidden", () => {
    const hidden = context({ chipKinds: { branch: false, remote: false, stash: false, tag: false } })
    expect(isMarkedCommit(commit("a", ["HEAD -> main"]), hidden)).toBe(true)
  })

  test("a worktree marks the commit it sits on", () => {
    expect(isMarkedCommit(commit("d"), context({ worktreesByHead: new Map([["d", [worktree]]]) }))).toBe(true)
  })
})

describe("appendGraphRows", () => {
  const marked = (commit: Commit) => commit.refs.length > 0
  const nothingRevealed = () => false

  test("gathers the commits between two refs into one run", () => {
    const commits = [commit("a", ["main"]), commit("b"), commit("c"), commit("d", ["old"])]
    const { rows } = appendGraphRows(null, commits, marked, nothingRevealed)
    expect(rows).toEqual([
      { hidden: 0, index: 0, lanes: 0 },
      { hidden: 2, index: 1, lanes: 1 },
      { hidden: 0, index: 3, lanes: 0 },
    ])
  })

  test("a lane that stops inside a run does not cross it", () => {
    const commits = [commit("a", ["main"]), commit("b", [], [true, true]), commit("c", [], [true]), commit("d", ["old"])]
    const { rows } = appendGraphRows(null, commits, marked, nothingRevealed)
    expect(rows[1].lanes).toBe(1)
  })

  test("continuing from an earlier batch gives the same rows as one pass", () => {
    const commits = [commit("a", ["main"]), commit("b"), commit("c"), commit("d", ["old"]), commit("e"), commit("f")]
    const first = appendGraphRows(null, commits.slice(0, 2), marked, nothingRevealed)
    const second = appendGraphRows(first, commits.slice(0, 5), marked, nothingRevealed)
    const continued = appendGraphRows(second, commits, marked, nothingRevealed)
    expect(continued.rows).toEqual(appendGraphRows(null, commits, marked, nothingRevealed).rows)
  })

  test("the rows an earlier batch produced are left alone", () => {
    const commits = [commit("a", ["main"]), commit("b"), commit("c")]
    const first = appendGraphRows(null, commits.slice(0, 2), marked, nothingRevealed)
    const before = structuredClone(first.rows)
    appendGraphRows(first, commits, marked, nothingRevealed)
    expect(first.rows).toEqual(before)
  })

  test("a revealed run is shown down to the next ref", () => {
    const commits = [commit("a", ["main"]), commit("b"), commit("c"), commit("d", ["old"]), commit("e"), commit("f")]
    const { rows } = appendGraphRows(null, commits, marked, (hash) => hash === "b")
    expect(rows).toEqual([
      { hidden: 0, index: 0, lanes: 0 },
      { hidden: 0, index: 1, lanes: 0 },
      { hidden: 0, index: 2, lanes: 0 },
      { hidden: 0, index: 3, lanes: 0 },
      { hidden: 2, index: 4, lanes: 1 },
    ])
  })

  test("a revealed run carries across the batch that splits it", () => {
    const commits = [commit("a", ["main"]), commit("b"), commit("c"), commit("d")]
    const first = appendGraphRows(null, commits.slice(0, 3), commit => commit.refs.length > 0, (hash) => hash === "b")
    const continued = appendGraphRows(first, commits, marked, (hash) => hash === "b")
    expect(continued.rows.map((row) => row.hidden)).toEqual([0, 0, 0, 0])
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
    commit("aaaaaaaa", ["HEAD -> main", "origin/main"]),
    commit("bbbbbbbb", ["tag: v1.0.0"]),
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

  test("matches a tag by name", () => {
    expect(searchGraph(commits, "v1.0")).toEqual([{ commitIndex: 1, detail: "subject bbbbbbbb", kind: "tag", label: "v1.0.0" }])
  })

  test("matches a commit by subject and by hash", () => {
    expect(searchGraph(commits, "parser").map((hit) => hit.commitIndex)).toEqual([2])
    expect(searchGraph(commits, "cccc").map((hit) => hit.commitIndex)).toEqual([2])
  })

  test("matches a stash by its message", () => {
    const hits = searchGraph(commits, "progress", { stashesByBase: new Map([["cccccccc", [stash]]]) })
    expect(hits).toEqual([{ commitIndex: 2, detail: "work in progress", kind: "stash", label: "stash@{0}" }])
  })
})
