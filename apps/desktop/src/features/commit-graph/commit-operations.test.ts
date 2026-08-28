import { describe, expect, test } from "bun:test"

import { commitSelection, displayRefs, refSelection, type BranchSync, type Commit, type Selection } from "./commit-graph"
import { applicableOperations, OPERATION_GROUPS, type Operand, type RepositoryState } from "./commit-operations"

function commit(hash: string, parents: string[] = [], refs: string[] = []): Commit {
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

const history = [
  commit("a", ["b"], ["HEAD -> main", "origin/main"]),
  commit("b", ["c"], ["topic"]),
  commit("c", ["d"], ["tag: v1.0.0"]),
  commit("d"),
]

const repository: RepositoryState = {
  currentBranch: "main",
  defaultBranch: "origin/main",
  headSha: "a",
  isDetached: false,
  isDirty: false,
  pendingOperation: null,
  remote: "origin",
}

function ref(labels: string[], sha: string, sync?: BranchSync) {
  const [entry] = displayRefs(labels, [], sync ? new Map([[sync.branch, sync]]) : undefined)
  return refSelection(entry, sha)
}

function ids(source: Selection | null, target: Operand) {
  return applicableOperations(repository, source, target).map(({ operation }) => operation.id)
}

function labelOf(source: Selection | null, target: Operand, id: string) {
  const entry = applicableOperations(repository, source, target).find(({ operation }) => operation.id === id)
  return entry ? entry.operation.label(entry.request) : null
}

const topic = ref(["topic"], "b")
const tag = ref(["tag: v1.0.0"], "c")
const remote = ref(["origin/release"], "b")
const range = commitSelection(history, 1, 2)!

describe("applicableOperations", () => {
  test("offers branch operations on a local branch", () => {
    expect(ids(null, topic)).toEqual(["checkout", "push", "merge", "createBranch", "createTag", "renameBranch", "resetCurrent", "deleteBranch"])
  })

  test("drops the operations a tag cannot take part in", () => {
    const offered = ids(null, tag)

    expect(offered).not.toContain("push")
    expect(offered).not.toContain("renameBranch")
    expect(offered).not.toContain("deleteBranch")
    expect(offered).toContain("deleteTag")
    expect(offered).toContain("pushTag")
  })

  test("offers a remote branch its own delete rather than the local one", () => {
    const offered = ids(null, remote)

    expect(offered).toContain("deleteRemoteRef")
    expect(offered).not.toContain("deleteBranch")
    expect(offered).not.toContain("renameBranch")
  })

  test("rebases a selected range onto the clicked ref", () => {
    expect(labelOf(range, tag, "rebaseOnto")).toBe("Rebase topic (2 commits) onto here")
  })

  test("refuses to move a tag onto something else", () => {
    expect(ids(tag, topic)).not.toContain("rebaseOnto")
  })

  test("names both operands when a selection meets a branch", () => {
    expect(labelOf(topic, ref(["main"], "a"), "merge")).toBe("Merge topic here")
  })

  test("merges into the current branch when nothing is selected", () => {
    expect(labelOf(null, topic, "merge")).toBe("Merge into main")
  })

  test("offers commit operations on a selected range", () => {
    const offered = ids(range, range)

    expect(offered).toContain("dropCommits")
    expect(offered).toContain("cherryPick")
    expect(offered).toContain("revert")
    expect(offered).not.toContain("rebaseOnto")
  })

  test("only offers a stash its own operations", () => {
    const entry = { branch: "main", date: "2026-01-01T00:00:00Z", message: "work", name: "stash@{0}", sha: "s1" }

    expect(ids(null, { kind: "stash", entry })).toEqual(["stashApply", "stashPop", "stashDrop"])
  })

  test("offers stashing only while the working tree is dirty", () => {
    expect(applicableOperations({ ...repository, isDirty: true }, null, { kind: "worktree" }).map(({ operation }) => operation.id)).toEqual(["stashChanges"])
    expect(ids(null, { kind: "worktree" })).toEqual([])
  })
})

describe("blocks", () => {
  function blocksFor(source: Selection | null, target: Operand, id: string, values: Record<string, string> = {}) {
    const entry = applicableOperations(repository, source, target).find(({ operation }) => operation.id === id)!
    return entry.operation.blocks(entry.request, { branch: null, mergeBase: null, prediction: null }, values).map((block) => block.reason)
  }

  test("blocks checking out the branch that is already checked out", () => {
    expect(blocksFor(null, ref(["HEAD -> main"], "a"), "checkout")).toEqual(["main is already checked out here"])
  })

  test("blocks pushing a branch the remote already has", () => {
    const synced = ref(["feature"], "b", { branch: "feature", upstream: "origin/feature", ahead: 0, behind: 0, isGone: false })

    expect(blocksFor(null, synced, "push")).toEqual(["origin/feature already has these commits"])
  })

  test("blocks a fast-forward that would need a merge", () => {
    const diverged = ref(["feature"], "b", { branch: "feature", upstream: "origin/feature", ahead: 2, behind: 3, isGone: false })

    expect(blocksFor(null, diverged, "pull")).toEqual(["feature and origin/feature have both moved, which needs a merge or a rebase"])
  })

  test("blocks rebasing a range onto a ref inside it", () => {
    expect(blocksFor(range, topic, "rebaseOnto")).toContain("the target is inside the selection")
  })
})

describe("menu order", () => {
  test("runs from what a click navigates to through what it destroys", () => {
    const groups = applicableOperations(repository, null, topic).map(({ operation }) => OPERATION_GROUPS.indexOf(operation.group))

    expect(groups).toEqual([...groups].sort((left, right) => left - right))
  })

  test("keeps every operation in a group a menu knows how to place", () => {
    const offered = applicableOperations(repository, range, topic)

    expect(offered.every(({ operation }) => OPERATION_GROUPS.includes(operation.group))).toBe(true)
  })
})
