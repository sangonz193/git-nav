import { describe, expect, test } from "bun:test"

import { WORKTREE_REF } from "@/lib/repository-constants"
import { fileIdentity, initialDiffLayout, isViewedFile, NARROW_DIFF_PANEL_WIDTH, persistedDiffPanelParams, toggledDiffFileTree, type ChangedFile } from "./diff-panel-state"

describe("initialDiffLayout", () => {
  test("uses explicit preferences without treating responsive state as one", () => {
    expect(initialDiffLayout(500, { fileTreeOpen: true, mode: "split" })).toEqual({ fileTreeOpen: false, mode: "split", wrap: true })
    expect(initialDiffLayout(700, { fileTreeOpen: false, mode: "unified" })).toEqual({ fileTreeOpen: false, mode: "unified", wrap: false })
    expect(initialDiffLayout(700, { fileTreeOpen: true, mode: "unified" })).toEqual({ fileTreeOpen: true, mode: "unified", wrap: false })
    expect(initialDiffLayout(1000, { wrap: true })).toEqual({ fileTreeOpen: true, mode: "split", wrap: true })
    expect(initialDiffLayout(500, { wrap: false })).toEqual({ fileTreeOpen: false, mode: "unified", wrap: false })
  })

  test("derives every unpreferred layout value from the current width", () => {
    expect(initialDiffLayout(NARROW_DIFF_PANEL_WIDTH - 1, {})).toEqual({ fileTreeOpen: false, mode: "unified", wrap: true })
    expect(initialDiffLayout(NARROW_DIFF_PANEL_WIDTH, {})).toEqual({ fileTreeOpen: true, mode: "unified", wrap: false })
    expect(initialDiffLayout(1000, {})).toEqual({ fileTreeOpen: true, mode: "split", wrap: false })
  })
})

describe("toggledDiffFileTree", () => {
  test("does not turn a transient narrow drawer state into a preference", () => {
    const preferences = { fileTreeOpen: true, mode: "unified" as const }

    expect(toggledDiffFileTree(true, true, preferences)).toEqual({ fileTreeOpen: false, preferences })
    expect(toggledDiffFileTree(false, true, {})).toEqual({ fileTreeOpen: true, preferences: {} })
  })

  test("persists an explicit file tree toggle on a wide panel", () => {
    expect(toggledDiffFileTree(true, false, { mode: "split" })).toEqual({
      fileTreeOpen: false,
      preferences: { fileTreeOpen: false, mode: "split" },
    })
  })
})

describe("isViewedFile", () => {
  const file = (overrides: Partial<ChangedFile> = {}): ChangedFile => ({
    status: "modified",
    oldPath: "src/index.ts",
    newPath: "src/index.ts",
    oldOid: "a".repeat(40),
    newOid: "b".repeat(40),
    additions: 1,
    deletions: 1,
    isBinary: false,
    splitRows: 2,
    unifiedRows: 2,
    hunkRows: 1,
    ...overrides,
  })

  test("holds a mark only while the file is still the patch it was read at", () => {
    const viewed = new Map([["src/index.ts", fileIdentity(file(), "feature")]])
    expect(isViewedFile(file(), "feature", viewed)).toBe(true)
    expect(isViewedFile(file({ newOid: "c".repeat(40) }), "feature", viewed)).toBe(false)
    expect(isViewedFile(file({ newPath: "src/other.ts" }), "feature", viewed)).toBe(false)
  })

  test("drops a mark when the base moves under a head that has not", () => {
    const viewed = new Map([["src/index.ts", fileIdentity(file(), "feature")]])
    expect(isViewedFile(file({ oldOid: "c".repeat(40) }), "feature", viewed)).toBe(false)
  })

  test("drops a mark when the same blobs stop being the entry that was read", () => {
    const renamed = file({ status: "renamed", oldPath: "src/old.ts" })
    const viewed = new Map([["src/index.ts", fileIdentity(renamed, "feature")]])
    expect(isViewedFile(renamed, "feature", viewed)).toBe(true)
    expect(isViewedFile(file(), "feature", viewed)).toBe(false)
  })

  test("reads a deleted file at the blob it was deleted from", () => {
    const deleted = file({ newPath: null, newOid: null })
    expect(isViewedFile(deleted, "feature", new Map([["src/index.ts", fileIdentity(deleted, "feature")]]))).toBe(true)
  })

  test("keeps a working tree mark only in memory", () => {
    expect(isViewedFile(file({ newOid: null }), WORKTREE_REF, new Map([["src/index.ts", ""]]))).toBe(true)
    expect(isViewedFile(file({ newOid: null }), WORKTREE_REF, new Map([["src/index.ts", "a".repeat(40)]]))).toBe(false)
  })

  test("never carries a mark for a file with no blob behind it", () => {
    expect(isViewedFile(file({ oldOid: null, newOid: null }), "feature", new Map())).toBe(false)
  })
})

describe("persistedDiffPanelParams", () => {
  const repository = { name: "git-nav", path: "/projects/git-nav" }
  const refs = { base: "a".repeat(40), baseLabel: "Base subject", head: "b".repeat(40), headLabel: "Stash changes", mergeBase: false }

  test("keeps labels and only explicit user preferences", () => {
    expect(persistedDiffPanelParams(repository, refs, "src/index.ts", { fileTreeOpen: true, mode: "split" })).toEqual({
      ...repository,
      baseRef: refs.base,
      baseLabel: "Base subject",
      headRef: refs.head,
      headLabel: "Stash changes",
      mergeBase: false,
      selectedFilePath: "src/index.ts",
      userPreferences: { fileTreeOpen: true, mode: "split" },
    })
  })

  test("cannot promote a width-derived layout into a preference", () => {
    expect(persistedDiffPanelParams(repository, refs, null, {})).toEqual({
      ...repository,
      baseRef: refs.base,
      baseLabel: "Base subject",
      headRef: refs.head,
      headLabel: "Stash changes",
      mergeBase: false,
      selectedFilePath: null,
      userPreferences: undefined,
    })
  })
})
