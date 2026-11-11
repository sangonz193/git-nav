import { expect, test } from "bun:test"

import { GRAPH_GUTTER, LANE_WIDTH, type Commit } from "./commit-graph"
import { drawCommitGraph } from "./commit-graph-canvas"
import type { GraphRow } from "./commit-graph-view"

type Path = { command: string; values: number[] }

function commit(overrides: Partial<Commit>): Commit {
  return {
    hash: "commit",
    parents: [],
    author: "Ada",
    date: "2026-01-01T00:00:00Z",
    refs: [],
    subject: "commit",
    lane: 0,
    parentLanes: [],
    laneCount: 1,
    incomingLanes: [],
    activeLanes: [],
    ...overrides,
  }
}

function pathsFor(commits: Commit[], rows: GraphRow[] | null = null) {
  const paths: Path[][] = []
  let path: Path[] = []
  const context = {
    beginPath() {
      path = []
    },
    moveTo(...values: number[]) {
      path.push({ command: "moveTo", values })
    },
    lineTo(...values: number[]) {
      path.push({ command: "lineTo", values })
    },
    bezierCurveTo(...values: number[]) {
      path.push({ command: "bezierCurveTo", values })
    },
    arc() {},
    clearRect() {},
    fill() {},
    restore() {},
    save() {},
    setLineDash() {},
    setTransform() {},
    stroke() {
      paths.push(path)
    },
  }
  const canvas = {
    getContext: () => context,
    height: 0,
    style: {},
    width: 0,
  } as unknown as HTMLCanvasElement
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { devicePixelRatio: 1 },
  })
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => canvas },
  })

  try {
    drawCommitGraph({
      canvas,
      commits,
      height: (rows ?? commits).length * 32,
      items: (rows ?? commits).map((_, index) => ({
        index,
        start: index * 32,
      })),
      rows,
      scrollTop: 0,
      squashMergeEdges: [],
    })
  } finally {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    })
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: previousDocument,
    })
  }

  return paths
}

test("does not redraw a merge parent lane as an incoming connector", () => {
  const paths = pathsFor([
    commit({ hash: "above", lane: 1, activeLanes: [false, true, true] }),
    commit({
      hash: "merge",
      lane: 0,
      parentLanes: [0, 1],
      incomingLanes: [1, 2],
      activeLanes: [true, true],
    }),
    commit({
      hash: "branch",
      lane: 1,
      incomingLanes: [1],
      activeLanes: [true, true],
    }),
  ])

  const sourceX = GRAPH_GUTTER
  const targetX = GRAPH_GUTTER + LANE_WIDTH
  const mergeEdge = [
    { command: "moveTo", values: [sourceX, 48] },
    {
      command: "bezierCurveTo",
      values: [sourceX, 64, targetX, 64, targetX, 80],
    },
  ]
  expect(
    paths.filter((path) => JSON.stringify(path) === JSON.stringify(mergeEdge)),
  ).toHaveLength(1)
  expect(paths).not.toContainEqual([
    { command: "moveTo", values: [targetX, 48] },
    { command: "lineTo", values: [targetX, 80] },
  ])
})

test("does not redraw a newly opened lane when it continues on the same lane", () => {
  const paths = pathsFor([
    commit({
      hash: "previous",
      lane: 0,
      parentLanes: [0],
      activeLanes: [true],
    }),
    commit({ hash: "next", lane: 0, incomingLanes: [0], activeLanes: [true] }),
  ])

  const x = GRAPH_GUTTER
  const continuation = [
    { command: "moveTo", values: [x, 16] },
    { command: "lineTo", values: [x, 48] },
  ]
  expect(
    paths.filter(
      (path) => JSON.stringify(path) === JSON.stringify(continuation),
    ),
  ).toHaveLength(1)
})

test("opens a lane above a collapsed run without a second line beside it", () => {
  const paths = pathsFor(
    [
      commit({
        hash: "merge",
        lane: 0,
        parentLanes: [0, 1],
        activeLanes: [true, true],
      }),
      commit({
        hash: "hidden",
        lane: 0,
        parentLanes: [0],
        incomingLanes: [0],
        activeLanes: [true, true],
      }),
      commit({
        hash: "below",
        lane: 1,
        incomingLanes: [1],
        activeLanes: [true],
      }),
    ],
    [
      { hidden: 0, index: 0, lanes: 0 },
      { hidden: 1, index: 1, lanes: 3 },
      { hidden: 0, index: 2, lanes: 0 },
    ],
  )

  const mainX = GRAPH_GUTTER
  const branchX = GRAPH_GUTTER + LANE_WIDTH
  expect(paths).toEqual([
    [
      { command: "moveTo", values: [mainX, 16] },
      { command: "lineTo", values: [mainX, 48] },
    ],
    [
      { command: "moveTo", values: [mainX, 16] },
      {
        command: "bezierCurveTo",
        values: [mainX, 32, branchX, 32, branchX, 48],
      },
    ],
    [
      { command: "moveTo", values: [mainX, 48] },
      { command: "lineTo", values: [mainX, 64] },
    ],
    [
      { command: "moveTo", values: [branchX, 48] },
      { command: "lineTo", values: [branchX, 64] },
    ],
    [
      { command: "moveTo", values: [mainX, 64] },
      { command: "lineTo", values: [mainX, 80] },
    ],
    [
      { command: "moveTo", values: [branchX, 64] },
      { command: "lineTo", values: [branchX, 80] },
    ],
    [
      { command: "moveTo", values: [mainX, 80] },
      { command: "lineTo", values: [mainX, 112] },
    ],
  ])
})

test("draws straight through the header of a revealed run", () => {
  const paths = pathsFor(
    [
      commit({
        hash: "above",
        lane: 0,
        parentLanes: [0],
        activeLanes: [true, true],
      }),
      commit({
        hash: "revealed",
        lane: 1,
        incomingLanes: [1],
        activeLanes: [true],
      }),
    ],
    [
      { hidden: 0, index: 0, lanes: 0 },
      { hidden: 0, index: 1, lanes: 0, revealed: 1 },
      { hidden: 0, index: 1, lanes: 0 },
    ],
  )

  const mainX = GRAPH_GUTTER
  const branchX = GRAPH_GUTTER + LANE_WIDTH
  expect(paths).toEqual([
    [
      { command: "moveTo", values: [mainX, 16] },
      { command: "lineTo", values: [mainX, 80] },
    ],
    [
      { command: "moveTo", values: [branchX, 16] },
      { command: "lineTo", values: [branchX, 80] },
    ],
    [
      { command: "moveTo", values: [mainX, 80] },
      { command: "lineTo", values: [mainX, 112] },
    ],
  ])
})
