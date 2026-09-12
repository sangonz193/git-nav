import { describe, expect, test } from "bun:test"

import { commitSelection, displayRefs, refSelection } from "./commit-graph"
import { canDiffSelection, rangeBaseHash } from "./selection-diff"

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
    expect(rangeBaseHash(commitSelection(history, 0, 2)!)).toBeNull()
  })
})

describe("canDiffSelection", () => {
  test("allows a single commit with a parent", () => {
    expect(canDiffSelection(commitSelection(history, 0, 0)!, "main")).toBe(true)
  })

  test("disallows a root commit", () => {
    expect(canDiffSelection(commitSelection(history, 2, 2)!, "main")).toBe(
      false,
    )
  })

  test("allows a range with a loaded base", () => {
    expect(canDiffSelection(commitSelection(history, 0, 1)!, "main")).toBe(true)
  })

  test("allows a range whose base sits outside the loaded graph", () => {
    expect(
      canDiffSelection(commitSelection(history.slice(0, 2), 0, 1)!, "main"),
    ).toBe(true)
  })

  test("disallows a range that reaches a root commit", () => {
    expect(canDiffSelection(commitSelection(history, 0, 2)!, "main")).toBe(
      false,
    )
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
