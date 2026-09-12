import { describe, expect, test } from "bun:test"

import { displayRefs } from "./commit-graph"
import { findSelectedRef } from "./use-graph-selection"

function commit(hash: string, refs: string[] = []) {
  return {
    hash,
    parents: [],
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

const context = {
  branchSync: new Map(),
  pullRequests: new Map(),
  remotes: ["origin", "upstream"],
  worktreesByHead: new Map(),
}

describe("findSelectedRef", () => {
  test("keeps a tag distinct from a branch with the same name", () => {
    const refs = ["foo", "tag: foo"]
    const tag = displayRefs(refs, context).find((ref) => ref.kind === "tag")!

    expect(findSelectedRef(tag, [commit("a", refs)], context)).toMatchObject({
      ref: { kind: "tag" },
      sha: "a",
    })
  })

  test("keeps remote refs on different remotes distinct", () => {
    const refs = ["origin/foo", "upstream/foo"]
    const upstream = displayRefs(refs, context).find(
      (ref) => ref.remote === "upstream",
    )!

    expect(
      findSelectedRef(upstream, [commit("a", refs)], context),
    ).toMatchObject({ ref: { remote: "upstream" }, sha: "a" })
  })

  test("finds a branch after it moves to another commit", () => {
    const [branch] = displayRefs(["foo"], context)

    expect(
      findSelectedRef(branch, [commit("new", ["foo"]), commit("old")], context),
    ).toMatchObject({ ref: { kind: "branch" }, sha: "new" })
  })

  test("returns null when the ref is no longer loaded", () => {
    const [branch] = displayRefs(["foo"], context)

    expect(findSelectedRef(branch, [commit("a")], context)).toBeNull()
  })
})
