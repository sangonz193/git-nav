import { describe, expect, test } from "bun:test"

import type { ChangedFile } from "../diff/diff-panel-state"
import {
  amendMessage,
  canCommit,
  commitLabel,
  filePaths,
  persistedWorkingTreePanelParams,
  workingTreeFileKey,
  workingTreeFiles,
  worktreeName,
  type WorkingTree,
} from "./working-tree-state"

const file = (overrides: Partial<ChangedFile> = {}): ChangedFile => ({
  status: "modified",
  oldPath: "src/index.ts",
  newPath: "src/index.ts",
  oldOid: null,
  newOid: null,
  additions: 1,
  deletions: 0,
  isBinary: false,
  splitRows: 1,
  unifiedRows: 1,
  hunkRows: 2,
  ...overrides,
})

const tree = (overrides: Partial<WorkingTree> = {}): WorkingTree => ({
  branch: "main",
  headSha: "abc",
  headMessage: "first\n\nbody",
  indexFingerprint: "index",
  pendingOperation: null,
  conflicted: [],
  staged: [file()],
  unstaged: [],
  ...overrides,
})

describe("workingTreeFiles", () => {
  test("keeps a partially staged file apart on each side", () => {
    const files = workingTreeFiles(tree({ unstaged: [file()] }))
    expect(files.map((entry) => entry.area)).toEqual(["staged", "unstaged"])
    expect(new Set(files.map(workingTreeFileKey)).size).toBe(2)
  })

  test("lists nothing before the tree is read", () => {
    expect(workingTreeFiles(null)).toEqual([])
  })
})

describe("filePaths", () => {
  test("names both ends of a rename but only the destination of a copy", () => {
    expect(
      filePaths([
        file({ status: "renamed", oldPath: "old.ts", newPath: "new.ts" }),
        file({ status: "copied", oldPath: "source.ts", newPath: "copy.ts" }),
        file({ status: "deleted", oldPath: "gone.ts", newPath: null }),
        file(),
      ]),
    ).toEqual(["old.ts", "new.ts", "copy.ts", "gone.ts", "src/index.ts"])
  })
})

describe("canCommit", () => {
  test("needs a message and something staged", () => {
    expect(canCommit(tree(), "fix", false)).toBe(true)
    expect(canCommit(tree(), "  ", false)).toBe(false)
    expect(canCommit(tree({ staged: [] }), "fix", false)).toBe(false)
    expect(canCommit(null, "fix", false)).toBe(false)
  })

  test("amends without anything staged but never without a commit", () => {
    expect(canCommit(tree({ staged: [] }), "fix", true)).toBe(true)
    expect(canCommit(tree({ staged: [], headSha: null }), "fix", true)).toBe(
      false,
    )
  })

  test("allows a resolved merge with nothing staged", () => {
    const merge = tree({ staged: [], pendingOperation: "merge" })
    expect(canCommit(merge, "merge", false)).toBe(true)
    expect(canCommit(merge, "  ", false)).toBe(false)
    expect(canCommit({ ...merge, conflicted: ["a.ts"] }, "merge", false)).toBe(
      false,
    )
  })

  test("waits for conflicts to be resolved", () => {
    expect(canCommit(tree({ conflicted: ["a.ts"] }), "fix", false)).toBe(false)
  })

  test("blocks commits and amends during sequenced operations", () => {
    for (const pendingOperation of [
      "rebase",
      "cherryPick",
      "bisect",
    ] as const) {
      const pending = tree({ pendingOperation })
      expect(canCommit(pending, "fix", false)).toBe(false)
      expect(canCommit(pending, "fix", true)).toBe(false)
    }
  })
})

describe("amendMessage", () => {
  test("starts an amend from the message the commit has", () => {
    expect(amendMessage("", "first\n\nbody", true)).toBe("first\n\nbody")
  })

  test("keeps a message that is already being written", () => {
    expect(amendMessage("draft", "first", true)).toBe("draft")
    expect(amendMessage("draft", "first", false)).toBe("draft")
  })

  test("clears an untouched amend message when amend is turned off", () => {
    expect(amendMessage("first", "first", false, true)).toBe("")
  })
})

describe("labels", () => {
  test("counts the files a commit will carry", () => {
    expect(commitLabel(0, false)).toBe("Commit")
    expect(commitLabel(1, false)).toBe("Commit 1 file")
    expect(commitLabel(12, false)).toBe("Commit 12 files")
    expect(commitLabel(3, true)).toBe("Amend last commit")
  })

  test("names a worktree by its directory", () => {
    expect(worktreeName("/projects/git-nav/")).toBe("git-nav")
    expect(worktreeName("/projects/git-nav-feature")).toBe("git-nav-feature")
  })
})

describe("persistedWorkingTreePanelParams", () => {
  test("leaves empty preferences out", () => {
    expect(
      persistedWorkingTreePanelParams(
        { name: "git-nav", path: "/projects/git-nav" },
        null,
        {},
      ),
    ).toEqual({
      name: "git-nav",
      path: "/projects/git-nav",
      selectedFilePath: null,
      userPreferences: undefined,
    })
    expect(
      persistedWorkingTreePanelParams(
        { name: "git-nav", path: "/projects/git-nav" },
        "src/index.ts",
        { mode: "unified" },
      ).userPreferences,
    ).toEqual({ mode: "unified" })
  })
})
