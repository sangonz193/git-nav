import { describe, expect, test } from "bun:test"

import type { Commit, StashEntry } from "../commit-graph/commit-graph"
import { isRevisionExpression, searchReferences, type Reference, type ReferenceSources } from "./reference-search"

function commit(hash: string, subject: string, refs: string[] = []): Commit {
  return {
    hash,
    parents: [],
    author: "Ada",
    date: "2026-01-01T00:00:00Z",
    refs,
    subject,
    lane: 0,
    parentLanes: [],
    laneCount: 1,
    incomingLanes: [],
    activeLanes: [true],
  }
}

function reference(name: string, kind: Reference["kind"], sha = "sha"): Reference {
  return { date: "2026-01-01T00:00:00Z", kind, name, sha, subject: `subject of ${name}` }
}

function sources(overrides: Partial<ReferenceSources> = {}): ReferenceSources {
  return {
    allowWorktree: true,
    commits: [],
    headDetail: "main",
    references: [],
    remotes: ["origin"],
    revision: null,
    stashes: [],
    ...overrides,
  }
}

describe("isRevisionExpression", () => {
  test("accepts what git could resolve but a name could not", () => {
    expect(["HEAD~1", "main^2", "origin/main@{1}", "deadbeef"].map(isRevisionExpression)).toEqual([true, true, true, true])
  })

  test("rejects a half-typed name", () => {
    expect(["mai", "feature/log", ""].map(isRevisionExpression)).toEqual([false, false, false])
  })
})

describe("searchReferences", () => {
  test("finds a branch the graph window does not reach", () => {
    const hits = searchReferences("ancient", sources({
      commits: [commit("aaa", "recent work")],
      references: [reference("ancient/branch", "branch", "old-sha")],
    }))

    expect(hits.map((hit) => [hit.kind, hit.reference])).toEqual([["branch", "ancient/branch"]])
  })

  test("ranks refs above the commits carrying them and lists each ref once", () => {
    const hits = searchReferences("release", sources({
      commits: [commit("aaa", "start the release", ["release"]), commit("bbb", "release notes")],
      references: [reference("release", "branch", "aaa")],
    }))

    expect(hits.map((hit) => [hit.kind, hit.reference])).toEqual([
      ["branch", "release"],
      ["commit", "aaa"],
      ["commit", "bbb"],
    ])
  })

  test("offers the working tree and HEAD before anything typed narrows them away", () => {
    expect(searchReferences("", sources()).map((hit) => hit.reference)).toEqual([":worktree", "HEAD"])
    expect(searchReferences("", sources({ allowWorktree: false })).map((hit) => hit.reference)).toEqual(["HEAD"])
  })

  test("points a stash hit at the stash rather than the commit it was taken from", () => {
    const stash: StashEntry = { base: "aaa", branch: "main", date: "2026-01-01T00:00:00Z", message: "spike", name: "stash@{0}", sha: "stash-sha" }
    const hits = searchReferences("spike", sources({ commits: [commit("aaa", "base commit")], stashes: [stash] }))

    expect(hits.map((hit) => [hit.kind, hit.reference])).toEqual([["stash", "stash-sha"]])
  })

  test("leads with a resolved revision and says what it resolved to", () => {
    const hits = searchReferences("HEAD~1", sources({ revision: { sha: "0123456789", subject: "the parent" } }))

    expect(hits[0]).toEqual({ branch: null, detail: "01234567 · the parent", kind: "revision", label: "HEAD~1", reference: "HEAD~1" })
  })
})
