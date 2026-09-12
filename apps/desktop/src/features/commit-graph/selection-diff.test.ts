import { describe, expect, test } from "bun:test"

import { EMPTY_TREE_REF } from "@/lib/repository-constants"

import { commitSelection, displayRefs, refSelection } from "./commit-graph"
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
    const [main] = displayRefs(["main"])

    expect(canDiffSelection(refSelection(main, "a"), "main")).toBe(false)
  })

  test("allows a ref on another branch", () => {
    const [topic] = displayRefs(["topic"])

    expect(canDiffSelection(refSelection(topic, "a"), "main")).toBe(true)
  })
})

describe("divergenceTargets", () => {
  test("includes the configured upstream before the default branch", () => {
    const [topic] = displayRefs(["topic", "origin/topic"], {
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
    })

    expect(divergenceTargets(topic, "origin/main")).toEqual([
      { label: "origin/topic", reference: "topic@{upstream}" },
      { label: "origin/main", reference: "origin/main" },
    ])
  })

  test("does not duplicate a remote upstream that tracks the default branch", () => {
    const [topic] = displayRefs(["topic", "origin/main"], {
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
    })

    expect(divergenceTargets(topic, "main")).toEqual([
      { label: "origin/main", reference: "topic@{upstream}" },
    ])
  })

  test("compares the default branch with its upstream", () => {
    const [main] = displayRefs(["main", "origin/main"], {
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
    })

    expect(divergenceTargets(main, "main")).toEqual([
      { label: "origin/main", reference: "main@{upstream}" },
    ])
  })

  test("does not compare the default branch without an upstream", () => {
    const [main] = displayRefs(["main"])

    expect(divergenceTargets(main, "main")).toEqual([])
  })

  test("uses the default branch for a remote ref", () => {
    const [topic] = displayRefs(["origin/topic"])

    expect(divergenceTargets(topic, "origin/main")).toEqual([
      { label: "origin/main", reference: "origin/main" },
    ])
  })

  test("uses the default branch when the upstream is gone", () => {
    const [topic] = displayRefs(["topic"], {
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
