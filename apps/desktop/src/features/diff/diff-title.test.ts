import { describe, expect, test } from "bun:test"

import {
  EMPTY_TREE_REF,
  INDEX_REF,
  WORKTREE_REF,
} from "@/lib/repository-constants"
import {
  branchRangeTitle,
  defaultBranchName,
  dependsOnWorktree,
  diffTitle,
  isDefaultBranch,
  refLabel,
  selectedRefs,
  type SelectedRefs,
} from "./diff-title"

const REMOTES = ["origin", "upstream"]

function refs(base: string, head: string, mergeBase = true): SelectedRefs {
  return {
    base,
    head,
    baseLabel: refLabel(base),
    headLabel: refLabel(head),
    mergeBase,
  }
}

describe("refLabel", () => {
  test("shortens a commit to the hash the graph shows", () => {
    expect(refLabel("25745febf1d028f03c9f0a1b2c3d4e5f60718293")).toBe(
      "25745feb",
    )
    expect(refLabel("25745febf1d028f03c9f0a1b2c3d4e5f60718293^")).toBe(
      "25745feb^",
    )
    expect(
      refLabel(
        "25745febf1d028f03c9f0a1b2c3d4e5f6071829325745febf1d028f03c9f0a1b",
      ),
    ).toBe("25745feb")
  })

  test("keeps a ref name whole", () => {
    expect(refLabel("refs/heads/origin/main")).toBe("origin/main")
    expect(refLabel("refs/tags/v1")).toBe("v1")
    expect(refLabel("origin/main")).toBe("origin/main")
    expect(refLabel(EMPTY_TREE_REF)).toBe("empty")
    expect(refLabel(WORKTREE_REF)).toBe("Working tree")
  })
})

describe("defaultBranchName", () => {
  test("names the branch rather than the remote holding it", () => {
    expect(defaultBranchName("origin/main", REMOTES)).toBe("main")
    expect(defaultBranchName("upstream/trunk", REMOTES)).toBe("trunk")
    expect(defaultBranchName("main", REMOTES)).toBe("main")
    expect(defaultBranchName("refs/heads/origin/main", REMOTES)).toBe(
      "origin/main",
    )
    expect(defaultBranchName(null, REMOTES)).toBe("")
  })
})

describe("isDefaultBranch", () => {
  test("knows the default branch by whichever remote names it", () => {
    expect(isDefaultBranch("main", "origin/main", REMOTES)).toBe(true)
    expect(isDefaultBranch("upstream/main", "origin/main", REMOTES)).toBe(true)
    expect(isDefaultBranch("feature", "origin/main", REMOTES)).toBe(false)
    expect(isDefaultBranch("main", null, REMOTES)).toBe(false)
  })

  test("recognizes the default branch by full revision", () => {
    const primary = "refs/remotes/origin/main"

    expect(isDefaultBranch(primary, primary, REMOTES)).toBe(true)
    expect(
      isDefaultBranch("refs/remotes/upstream/main", primary, REMOTES),
    ).toBe(true)
    expect(isDefaultBranch("refs/heads/main", primary, REMOTES)).toBe(true)
    expect(isDefaultBranch("refs/heads/origin/main", primary, REMOTES)).toBe(
      false,
    )
    expect(isDefaultBranch("refs/heads/origin/main", primary, [])).toBe(false)
    expect(isDefaultBranch("origin/main", primary, [])).toBe(true)
    expect(isDefaultBranch("refs/tags/main", primary, REMOTES)).toBe(false)
  })
})

describe("diffTitle", () => {
  test("keeps the title of a saved diff that uses short names", () => {
    expect(
      diffTitle(refs("origin/main", "feature"), "origin/main", REMOTES),
    ).toBe("feature")
    expect(diffTitle(refs("main", "feature"), "origin/main", REMOTES)).toBe(
      "feature",
    )
    expect(diffTitle(refs("upstream/main", "feature"), "main", REMOTES)).toBe(
      "feature",
    )
    expect(diffTitle(refs("main", "feature"), "refs/heads/main", REMOTES)).toBe(
      "feature",
    )
    expect(
      diffTitle(
        refs("origin/main", "feature"),
        "refs/remotes/origin/main",
        REMOTES,
      ),
    ).toBe("feature")
  })

  test("keeps a local origin/main in the title when the default is the remote ref", () => {
    expect(
      diffTitle(
        refs("refs/heads/origin/main", "refs/heads/feature"),
        "refs/remotes/origin/main",
        REMOTES,
      ),
    ).toBe("origin/main...feature")
  })

  test("names both ends when the base is not the default branch", () => {
    expect(diffTitle(refs("release", "feature"), "origin/main", REMOTES)).toBe(
      "release...feature",
    )
    expect(
      diffTitle(refs("origin/mainline", "feature"), "origin/main", REMOTES),
    ).toBe("origin/mainline...feature")
    expect(
      diffTitle(refs("origin/main", "feature", false), "origin/main", REMOTES),
    ).toBe("origin/main..feature")
  })

  test("keeps the base when the head is the working tree", () => {
    expect(
      diffTitle(refs("origin/main", WORKTREE_REF), "origin/main", REMOTES),
    ).toBe("origin/main...Working tree")
  })

  test("names both ends when the repository has no default branch to leave out", () => {
    expect(diffTitle(refs("main", "feature"), null, [])).toBe("main...feature")
  })

  test("uses commit hashes rather than picker labels in tab titles", () => {
    const hash = "25745febf1d028f03c9f0a1b2c3d4e5f60718293"
    expect(
      diffTitle(
        {
          base: "origin/main",
          baseLabel: "origin/main",
          head: hash,
          headLabel: "Implement comparison picker",
          mergeBase: false,
        },
        "origin/main",
        REMOTES,
      ),
    ).toBe("origin/main..25745feb")
  })
})

describe("dependsOnWorktree", () => {
  test.each([
    ["HEAD", WORKTREE_REF],
    [INDEX_REF, "main"],
    ["HEAD", "abc123"],
    ["HEAD~1", "HEAD"],
    ["HEAD^", "main"],
    ["@", "main"],
    ["@~2", "main"],
    ["HEAD@{1}", "main"],
    ["ORIG_HEAD", "main"],
    ["main", "MERGE_HEAD"],
    ["FETCH_HEAD~1", "main"],
    ["CHERRY_PICK_HEAD^", "main"],
    ["REVERT_HEAD", "main"],
    ["REBASE_HEAD~2", "main"],
    ["refs/bisect/bad", "main"],
    ["refs/worktree/notes~1", "main"],
  ])("reads the worktree when comparing %s with %s", (base, head) => {
    expect(dependsOnWorktree({ base, head })).toBe(true)
  })

  test.each([
    ["main", "feature/x"],
    ["abc123", "def456"],
    ["main~1", "main"],
    ["HEAD-notes", "main"],
    ["ORIG_HEAD-notes", "main"],
    ["refs/heads/MERGE_HEAD", "main"],
    ["refs/bisect", "main"],
    [EMPTY_TREE_REF, "abc123^"],
  ])("keeps the comparison of %s with %s in the repository", (base, head) => {
    expect(dependsOnWorktree({ base, head })).toBe(false)
  })
})

describe("branchRangeTitle", () => {
  test("names the branch alone without being told what the default branch is", () => {
    expect(branchRangeTitle(refs("origin/main", "feature"))).toBe("feature")
    expect(branchRangeTitle(refs("main", "feature"))).toBe("feature")
  })

  test("titles a selection the way the repository's own default branch would", () => {
    expect(branchRangeTitle(refs("origin/main", "feature"))).toBe(
      diffTitle(refs("origin/main", "feature"), "main", REMOTES),
    )
  })
})

describe("selectedRefs", () => {
  test("restores labels separately from revision identifiers", () => {
    expect(
      selectedRefs(
        "a".repeat(40),
        "b".repeat(40),
        false,
        "Base subject",
        "Head subject",
      ),
    ).toEqual({
      base: "a".repeat(40),
      baseLabel: "Base subject",
      head: "b".repeat(40),
      headLabel: "Head subject",
      mergeBase: false,
    })
  })
})
