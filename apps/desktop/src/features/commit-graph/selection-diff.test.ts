import { describe, expect, test } from "bun:test"

import { EMPTY_TREE_REF } from "@/lib/repository-constants"

import { persistedDiffPanelParams } from "../diff/diff-panel-state"
import { branchRangeTitle, selectedRefs } from "../diff/diff-title"
import {
  commitSelection,
  displayRefs,
  refRevision,
  refSelection,
} from "./commit-graph"
import {
  canDiffSelection,
  divergenceTargets,
  rangeBaseHash,
} from "./selection-diff"

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

const history = [commit("a", ["b"]), commit("b", ["c"]), commit("c")]

describe("rangeBaseHash", () => {
  test("prefers the loaded base and falls back to the oldest parent", () => {
    expect(rangeBaseHash(commitSelection(history, 0, 1)!)).toBe("c")
    expect(rangeBaseHash(commitSelection(history.slice(0, 2), 0, 1)!)).toBe("c")
    expect(rangeBaseHash(commitSelection(history, 0, 2)!)).toBe(EMPTY_TREE_REF)
  })
})

describe("canDiffSelection", () => {
  test("allows a single commit with a parent", () => {
    expect(canDiffSelection(commitSelection(history, 0, 0)!, "main")).toBe(true)
  })

  test("allows a root commit against the empty tree", () => {
    expect(canDiffSelection(commitSelection(history, 2, 2)!, "main")).toBe(true)
  })

  test("allows a range with a loaded base", () => {
    expect(canDiffSelection(commitSelection(history, 0, 1)!, "main")).toBe(true)
  })

  test("allows a range whose base sits outside the loaded graph", () => {
    expect(
      canDiffSelection(commitSelection(history.slice(0, 2), 0, 1)!, "main"),
    ).toBe(true)
  })

  test("allows a range that reaches a root commit against the empty tree", () => {
    expect(canDiffSelection(commitSelection(history, 0, 2)!, "main")).toBe(true)
  })

  test("disallows a ref on the default branch", () => {
    const [main] = displayRefs(["refs/heads/main"])

    expect(canDiffSelection(refSelection(main, "a"), "main")).toBe(false)
  })

  test("allows a ref on another branch", () => {
    const [topic] = displayRefs(["refs/heads/topic"])

    expect(canDiffSelection(refSelection(topic, "a"), "main")).toBe(true)
  })

  test("distinguishes the default remote ref from a same-named local branch", () => {
    const [local, remote] = displayRefs([
      "refs/heads/origin/main",
      "refs/remotes/origin/main",
    ])
    const primary = "refs/remotes/origin/main"

    expect(canDiffSelection(refSelection(local, "a"), primary)).toBe(true)
    expect(canDiffSelection(refSelection(remote, "b"), primary)).toBe(false)
    expect(divergenceTargets(local, primary)).toEqual([
      { label: "origin/main", reference: primary },
    ])
  })
})

test("persists the remote diff revision with its short display label", () => {
  const [local] = displayRefs(["refs/heads/origin/topic"])
  const [remote] = displayRefs(["refs/remotes/origin/topic"])
  const refs = selectedRefs(
    "refs/remotes/origin/main",
    refRevision(remote),
    true,
  )
  const persisted = persistedDiffPanelParams(
    { name: "repo", path: "/repo" },
    refs,
    null,
    {},
  )

  expect(refRevision(local)).toBe("origin/topic")
  expect(persisted).toMatchObject({
    baseRef: "refs/remotes/origin/main",
    baseLabel: "origin/main",
    headRef: "refs/remotes/origin/topic",
    headLabel: "origin/topic",
  })
  expect(branchRangeTitle(refs)).toBe("origin/topic")
})

describe("divergenceTargets", () => {
  test("includes the configured upstream before the default branch", () => {
    const [topic] = displayRefs(
      ["refs/heads/topic", "refs/remotes/origin/topic"],
      {
        branchSync: new Map([
          [
            "topic",
            {
              branch: "topic",
              upstream: "origin/topic",
              ahead: 0,
              behind: 0,
              isGone: false,
            },
          ],
        ]),
      },
    )

    expect(divergenceTargets(topic, "origin/main")).toEqual([
      { label: "origin/topic", reference: "topic@{upstream}" },
      { label: "origin/main", reference: "origin/main" },
    ])
  })

  test("does not duplicate a remote upstream that tracks the default branch", () => {
    const [topic] = displayRefs(
      ["refs/heads/topic", "refs/remotes/origin/main"],
      {
        branchSync: new Map([
          [
            "topic",
            {
              branch: "topic",
              upstream: "origin/main",
              ahead: 0,
              behind: 0,
              isGone: false,
            },
          ],
        ]),
      },
    )

    expect(divergenceTargets(topic, "main")).toEqual([
      { label: "origin/main", reference: "topic@{upstream}" },
    ])
    expect(divergenceTargets(topic, "refs/remotes/origin/main")).toEqual([
      { label: "origin/main", reference: "topic@{upstream}" },
    ])
  })

  test("keeps a remote default distinct from an upstream with a repeated remote name", () => {
    const [local] = displayRefs(
      ["refs/heads/origin/main", "refs/remotes/origin/origin/main"],
      {
        branchSync: new Map([
          [
            "origin/main",
            {
              branch: "origin/main",
              upstream: "origin/origin/main",
              ahead: 0,
              behind: 0,
              isGone: false,
            },
          ],
        ]),
      },
    )
    const primary = "refs/remotes/origin/main"

    expect(divergenceTargets(local, primary)).toEqual([
      { label: "origin/origin/main", reference: "origin/main@{upstream}" },
      { label: "origin/main", reference: primary },
    ])
  })

  test("compares the default branch with its upstream", () => {
    const [main] = displayRefs(
      ["refs/heads/main", "refs/remotes/origin/main"],
      {
        branchSync: new Map([
          [
            "main",
            {
              branch: "main",
              upstream: "origin/main",
              ahead: 0,
              behind: 0,
              isGone: false,
            },
          ],
        ]),
      },
    )

    expect(divergenceTargets(main, "main")).toEqual([
      { label: "origin/main", reference: "main@{upstream}" },
    ])
  })

  test("does not compare the default branch without an upstream", () => {
    const [main] = displayRefs(["refs/heads/main"])

    expect(divergenceTargets(main, "main")).toEqual([])
  })

  test("uses the default branch for a remote ref", () => {
    const [topic] = displayRefs(["refs/remotes/origin/topic"])

    expect(divergenceTargets(topic, "origin/main")).toEqual([
      { label: "origin/main", reference: "origin/main" },
    ])
  })

  test("uses the default branch when the upstream is gone", () => {
    const [topic] = displayRefs(["refs/heads/topic"], {
      branchSync: new Map([
        [
          "topic",
          {
            branch: "topic",
            upstream: "origin/topic",
            ahead: 0,
            behind: 0,
            isGone: true,
          },
        ],
      ]),
    })

    expect(divergenceTargets(topic, "origin/main")).toEqual([
      { label: "origin/main", reference: "origin/main" },
    ])
  })
})
