import { describe, expect, test } from "bun:test"

import { WORKTREE_REF } from "../repository/repository-window"
import { branchRangeTitle, diffTitle, refLabel, type SelectedRefs } from "./diff-title"

const REMOTES = ["origin", "upstream"]

function refs(base: string, head: string, mergeBase = true): SelectedRefs {
  return { base, head, baseLabel: refLabel(base), headLabel: refLabel(head), mergeBase }
}

describe("refLabel", () => {
  test("shortens a commit to the hash the graph shows", () => {
    expect(refLabel("25745febf1d028f03c9f0a1b2c3d4e5f60718293")).toBe("25745feb")
    expect(refLabel("25745febf1d028f03c9f0a1b2c3d4e5f60718293^")).toBe("25745feb^")
    expect(refLabel("25745febf1d028f03c9f0a1b2c3d4e5f6071829325745febf1d028f03c9f0a1b")).toBe("25745feb")
  })

  test("keeps a ref name whole", () => {
    expect(refLabel("origin/main")).toBe("origin/main")
    expect(refLabel(WORKTREE_REF)).toBe("Working tree")
  })
})

describe("diffTitle", () => {
  test("names a branch alone when it is measured from the default branch", () => {
    expect(diffTitle(refs("origin/main", "feature"), "origin/main", REMOTES)).toBe("feature")
    expect(diffTitle(refs("main", "feature"), "origin/main", REMOTES)).toBe("feature")
    expect(diffTitle(refs("upstream/main", "feature"), "main", REMOTES)).toBe("feature")
  })

  test("names both ends when the base is not the default branch", () => {
    expect(diffTitle(refs("release", "feature"), "origin/main", REMOTES)).toBe("release...feature")
    expect(diffTitle(refs("origin/mainline", "feature"), "origin/main", REMOTES)).toBe("origin/mainline...feature")
    expect(diffTitle(refs("origin/main", "feature", false), "origin/main", REMOTES)).toBe("origin/main..feature")
  })

  test("keeps the base when the head is the working tree", () => {
    expect(diffTitle(refs("origin/main", WORKTREE_REF), "origin/main", REMOTES)).toBe("origin/main...Working tree")
  })

  test("names both ends when the repository has no default branch to leave out", () => {
    expect(diffTitle(refs("main", "feature"), null, [])).toBe("main...feature")
  })

  test("uses commit hashes rather than picker labels in tab titles", () => {
    const hash = "25745febf1d028f03c9f0a1b2c3d4e5f60718293"
    expect(diffTitle({ base: "origin/main", baseLabel: "origin/main", head: hash, headLabel: "Implement comparison picker", mergeBase: false }, "origin/main", REMOTES))
      .toBe("origin/main..25745feb")
  })
})

describe("branchRangeTitle", () => {
  test("names the branch alone without being told what the default branch is", () => {
    expect(branchRangeTitle(refs("origin/main", "feature"))).toBe("feature")
    expect(branchRangeTitle(refs("main", "feature"))).toBe("feature")
  })

  test("titles a selection the way the repository's own default branch would", () => {
    expect(branchRangeTitle(refs("origin/main", "feature"))).toBe(diffTitle(refs("origin/main", "feature"), "main", REMOTES))
  })
})
