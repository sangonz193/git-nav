import { GRAPH_GUTTER, GRAPH_WIDTH, LANE_WIDTH, laneColor, parentEdgeColor, ROW_HEIGHT, startsLane, type Commit } from "./commit-graph"

// Unpushed work keeps the colour of the branch it belongs to and gives up some of its weight instead.
const UNPUSHED_ALPHA = 0.45
// Fading each stroke on its own would darken every place two of them overlap, so they are collected on one
// layer at full strength and that layer is faded once.
let unpushedLayer: HTMLCanvasElement | null = null

type CommitGraphDrawing = {
  canvas: HTMLCanvasElement
  commits: Commit[]
  items: { index: number; start: number }[]
  scrollTop: number
  height: number
  squashMergeEdges: { branchIndex: number; targetIndex: number }[]
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

export function drawCommitGraph({ canvas, commits, items, scrollTop, height, squashMergeEdges, unpushed, unpushedLanes, width = GRAPH_WIDTH, rowHeight = ROW_HEIGHT }: CommitGraphDrawing) {
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
  for (const { branchIndex, targetIndex } of squashMergeEdges) {
    const branchY = branchIndex * rowHeight - scrollTop + rowHeight / 2
    const targetY = targetIndex * rowHeight - scrollTop + rowHeight / 2
    if (Math.max(branchY, targetY) < 0 || Math.min(branchY, targetY) > height) {
      continue
    }
    const branch = commits[branchIndex]
    const target = commits[targetIndex]
    const branchX = GRAPH_GUTTER + branch.lane * LANE_WIDTH
    const targetX = GRAPH_GUTTER + target.lane * LANE_WIDTH
    const middleY = (branchY + targetY) / 2
    // The edge belongs to the branch that was squashed away, so it carries that branch's weight.
    const layer = layerFor(unpushed?.has(branch.hash) ?? false)
    layer.strokeStyle = laneColor(branch.lane)
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
    const commit = commits[item.index]
    if (!commit) {
      continue
    }

    const startY = item.start - scrollTop + rowHeight / 2
    const endY = startY + rowHeight
    const startX = GRAPH_GUTTER + commit.lane * LANE_WIDTH
    const isLocal = unpushed?.has(commit.hash) ?? false
    const previousCommit = commits[item.index - 1]
    const previousActiveLanes = previousCommit?.activeLanes ?? []

    const previousLanes = unpushedLanes?.[item.index - 1] ?? 0
    for (let lane = 0; lane < previousActiveLanes.length; lane += 1) {
      if (!previousActiveLanes[lane] || startsLane(commits, item.index - 1, lane) || !commit.incomingLanes.includes(lane)) {
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

    const activeLanes = unpushedLanes?.[item.index] ?? 0
    const nextCommit = commits[item.index + 1]
    for (let lane = 0; lane < commit.activeLanes.length; lane += 1) {
      if (!commit.activeLanes[lane] || startsLane(commits, item.index, lane) || nextCommit?.incomingLanes.includes(lane)) {
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
