import { GRAPH_GUTTER, GRAPH_WIDTH, LANE_WIDTH, laneColor, parentEdgeColor, ROW_HEIGHT, startsLane, type Commit } from "./commit-graph"
import type { GraphRow } from "./commit-graph-view"

// Unpushed work keeps the colour of the branch it belongs to and gives up some of its weight instead.
const UNPUSHED_ALPHA = 0.45
// A collapsed run stands for commits that are not drawn, so the lines crossing it are broken rather than solid.
const COLLAPSED_DASH = [2, 3]
// Fading each stroke on its own would darken every place two of them overlap, so they are collected on one
// layer at full strength and that layer is faded once.
let unpushedLayer: HTMLCanvasElement | null = null

type SquashMergeEdge = { branchLane: number; branchRow: number; isLocal: boolean; targetLane: number; targetRow: number }

type CommitGraphDrawing = {
  canvas: HTMLCanvasElement
  commits: Commit[]
  items: { index: number; start: number }[]
  scrollTop: number
  height: number
  rows: GraphRow[] | null
  squashMergeEdges: SquashMergeEdge[]
  unpushed?: Set<string>
  unpushedLanes?: number[]
  width?: number
  rowHeight?: number
}

function unpushedContext(pixelWidth: number, pixelHeight: number, ratio: number, width: number, height: number) {
  unpushedLayer ??= document.createElement("canvas")
  if (unpushedLayer.width !== pixelWidth || unpushedLayer.height !== pixelHeight) {
    unpushedLayer.width = pixelWidth
    unpushedLayer.height = pixelHeight
  }
  const context = unpushedLayer.getContext("2d")
  if (!context) {
    return null
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, width, height)
  context.lineWidth = 2
  context.lineCap = "round"
  return context
}

export function drawCommitGraph({ canvas, commits, items, scrollTop, height, rows, squashMergeEdges, unpushed, unpushedLanes, width = GRAPH_WIDTH, rowHeight = ROW_HEIGHT }: CommitGraphDrawing) {
  const ratio = window.devicePixelRatio || 1
  const pixelHeight = Math.max(1, Math.ceil(height * ratio))
  const pixelWidth = Math.ceil(width * ratio)

  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth
    canvas.height = pixelHeight
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
  }
  // Sticky would hold the canvas still while the columns scroll out from under it, so the row it belongs to
  // carries it sideways and the scroll offset it was drawn for places it down the page.
  canvas.style.transform = `translateY(${scrollTop}px)`

  const context = canvas.getContext("2d")
  if (!context) {
    return
  }

  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, width, height)
  context.lineWidth = 2
  context.lineCap = "round"

  const local = unpushedContext(pixelWidth, pixelHeight, ratio, width, height)
  let hasLocal = false
  const layerFor = (isLocal: boolean) => {
    hasLocal ||= isLocal && Boolean(local)
    return isLocal && local ? local : context
  }

  const layers = [context, local].filter((layer) => layer !== null)
  for (const layer of layers) {
    layer.lineWidth = 1.5
    layer.setLineDash([3, 4])
  }
  for (const { branchLane, branchRow, isLocal, targetLane, targetRow } of squashMergeEdges) {
    const branchY = branchRow * rowHeight - scrollTop + rowHeight / 2
    const targetY = targetRow * rowHeight - scrollTop + rowHeight / 2
    if (Math.max(branchY, targetY) < 0 || Math.min(branchY, targetY) > height) {
      continue
    }
    const branchX = GRAPH_GUTTER + branchLane * LANE_WIDTH
    const targetX = GRAPH_GUTTER + targetLane * LANE_WIDTH
    const middleY = (branchY + targetY) / 2
    // The edge belongs to the branch that was squashed away, so it carries that branch's weight.
    const layer = layerFor(isLocal)
    layer.strokeStyle = laneColor(branchLane)
    layer.beginPath()
    layer.moveTo(branchX, branchY)
    layer.bezierCurveTo(branchX, middleY, targetX, middleY, targetX, targetY)
    layer.stroke()
  }
  for (const layer of layers) {
    layer.setLineDash([])
    layer.lineWidth = 2
  }

  for (const item of items) {
    const row = rows?.[item.index]
    const commitIndex = row ? row.index : item.index
    const commit = commits[commitIndex]
    if (!commit || (rows && !row)) {
      continue
    }

    const startY = item.start - scrollTop + rowHeight / 2
    const endY = startY + rowHeight
    const startX = GRAPH_GUTTER + commit.lane * LANE_WIDTH
    const isLocal = unpushed?.has(commit.hash) ?? false

    // A collapsed run draws only the lines that reach across it, so the branches on either side stay joined
    // while the commits between them keep no place of their own.
    if (row && row.hidden > 0) {
      const localLanes = unpushedLanes?.[commitIndex] ?? 0
      for (let lane = 0; lane < 31; lane += 1) {
        if (!(row.lanes & (1 << lane))) {
          continue
        }
        const target = layerFor(Boolean(localLanes & (1 << lane)))
        const x = GRAPH_GUTTER + lane * LANE_WIDTH
        target.setLineDash(COLLAPSED_DASH)
        target.strokeStyle = laneColor(lane)
        target.beginPath()
        target.moveTo(x, startY - rowHeight / 2)
        target.lineTo(x, endY - rowHeight / 2)
        target.stroke()
        target.setLineDash([])
      }
      continue
    }

    const previousCommit = commits[commitIndex - 1]
    const previousActiveLanes = previousCommit?.activeLanes ?? []

    const previousLanes = unpushedLanes?.[commitIndex - 1] ?? 0
    for (let lane = 0; lane < previousActiveLanes.length; lane += 1) {
      if (!previousActiveLanes[lane] || startsLane(commits, commitIndex - 1, lane) || !commit.incomingLanes.includes(lane)) {
        continue
      }
      const target = layerFor(Boolean(previousLanes & (1 << lane)))
      const x = GRAPH_GUTTER + lane * LANE_WIDTH
      target.strokeStyle = laneColor(lane)
      target.beginPath()
      target.moveTo(x, startY - rowHeight)
      if (x !== startX) {
        target.bezierCurveTo(x, startY - rowHeight / 2, startX, startY - rowHeight / 2, startX, startY)
      } else {
        target.lineTo(x, startY)
      }
      target.stroke()
    }

    const activeLanes = unpushedLanes?.[commitIndex] ?? 0
    const nextCommit = commits[commitIndex + 1]
    for (let lane = 0; lane < commit.activeLanes.length; lane += 1) {
      if (!commit.activeLanes[lane] || startsLane(commits, commitIndex, lane) || nextCommit?.incomingLanes.includes(lane)) {
        continue
      }
      const target = layerFor(Boolean(activeLanes & (1 << lane)))
      const x = GRAPH_GUTTER + lane * LANE_WIDTH
      target.strokeStyle = laneColor(lane)
      target.beginPath()
      target.moveTo(x, startY)
      target.lineTo(x, endY)
      target.stroke()
    }

    const own = layerFor(isLocal)
    for (const [index, parentLane] of commit.parentLanes.entries()) {
      const endLane = nextCommit?.incomingLanes.includes(parentLane) ? nextCommit.lane : parentLane
      const endX = GRAPH_GUTTER + endLane * LANE_WIDTH
      own.strokeStyle = parentEdgeColor(commit, index, endLane)
      own.beginPath()
      own.moveTo(startX, startY)
      if (startX === endX) {
        own.lineTo(endX, endY)
      } else {
        own.bezierCurveTo(startX, startY + rowHeight / 2, endX, endY - rowHeight / 2, endX, endY)
      }
      own.stroke()
    }

    own.fillStyle = laneColor(commit.lane)
    own.beginPath()
    own.arc(startX, startY, 4, 0, Math.PI * 2)
    own.fill()

    // The canvas sits above the rows, so punching the centre out lets the row background read through as a hollow node.
    if (isLocal) {
      own.save()
      own.globalCompositeOperation = "destination-out"
      own.beginPath()
      own.arc(startX, startY, 2, 0, Math.PI * 2)
      own.fill()
      own.restore()
    }
  }

  if (local && hasLocal) {
    context.globalAlpha = UNPUSHED_ALPHA
    context.drawImage(local.canvas, 0, 0, width, height)
    context.globalAlpha = 1
  }
}
