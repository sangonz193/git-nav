import { GRAPH_COLORS, GRAPH_GUTTER, GRAPH_WIDTH, isCurrentCheckout, LANE_WIDTH, ROW_HEIGHT, type Commit } from "./commit-graph"

export function drawCommitGraph(canvas: HTMLCanvasElement, commits: Commit[], items: { index: number; start: number }[], scrollTop: number, height: number, squashMergeEdges: { branchIndex: number; targetIndex: number }[], width = GRAPH_WIDTH) {
  const ratio = window.devicePixelRatio || 1
  const pixelHeight = Math.max(1, Math.ceil(height * ratio))
  const pixelWidth = Math.ceil(width * ratio)

  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth
    canvas.height = pixelHeight
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
  }

  const context = canvas.getContext("2d")
  if (!context) {
    return
  }

  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, width, height)
  context.lineWidth = 2
  context.lineCap = "round"

  context.lineWidth = 1.5
  context.setLineDash([3, 4])
  for (const { branchIndex, targetIndex } of squashMergeEdges) {
    const branchY = branchIndex * ROW_HEIGHT - scrollTop + ROW_HEIGHT / 2
    const targetY = targetIndex * ROW_HEIGHT - scrollTop + ROW_HEIGHT / 2
    if (Math.max(branchY, targetY) < 0 || Math.min(branchY, targetY) > height) {
      continue
    }
    const branch = commits[branchIndex]
    const target = commits[targetIndex]
    const branchX = GRAPH_GUTTER + branch.lane * LANE_WIDTH
    const targetX = GRAPH_GUTTER + target.lane * LANE_WIDTH
    const middleY = (branchY + targetY) / 2
    context.strokeStyle = GRAPH_COLORS[branch.lane % GRAPH_COLORS.length]
    context.beginPath()
    context.moveTo(branchX, branchY)
    context.bezierCurveTo(branchX, middleY, targetX, middleY, targetX, targetY)
    context.stroke()
  }
  context.setLineDash([])
  context.lineWidth = 2

  for (const item of items) {
    const commit = commits[item.index]
    if (!commit) {
      continue
    }

    const startY = item.start - scrollTop + ROW_HEIGHT / 2
    const endY = startY + ROW_HEIGHT
    const startX = GRAPH_GUTTER + commit.lane * LANE_WIDTH
    const color = GRAPH_COLORS[commit.lane % GRAPH_COLORS.length]
    const previousCommit = commits[item.index - 1]
    const previousActiveLanes = previousCommit?.activeLanes ?? []

    for (let lane = 0; lane < previousActiveLanes.length; lane += 1) {
      if (!previousActiveLanes[lane] || previousCommit?.parentLanes.includes(lane) || !commit.incomingLanes.includes(lane)) {
        continue
      }
      const x = GRAPH_GUTTER + lane * LANE_WIDTH
      context.strokeStyle = GRAPH_COLORS[lane % GRAPH_COLORS.length]
      context.beginPath()
      context.moveTo(x, startY - ROW_HEIGHT)
      if (x !== startX) {
        context.bezierCurveTo(x, startY - ROW_HEIGHT / 2, startX, startY - ROW_HEIGHT / 2, startX, startY)
      } else {
        context.lineTo(x, startY)
      }
      context.stroke()
    }

    const nextCommit = commits[item.index + 1]
    for (let lane = 0; lane < commit.activeLanes.length; lane += 1) {
      if (!commit.activeLanes[lane] || commit.parentLanes.includes(lane) || nextCommit?.incomingLanes.includes(lane)) {
        continue
      }
      const x = GRAPH_GUTTER + lane * LANE_WIDTH
      context.strokeStyle = GRAPH_COLORS[lane % GRAPH_COLORS.length]
      context.beginPath()
      context.moveTo(x, startY)
      context.lineTo(x, endY)
      context.stroke()
    }

    for (const parentLane of commit.parentLanes) {
      const endLane = nextCommit?.incomingLanes.includes(parentLane) ? nextCommit.lane : parentLane
      const endX = GRAPH_GUTTER + endLane * LANE_WIDTH
      context.strokeStyle = color
      context.beginPath()
      context.moveTo(startX, startY)
      if (startX === endX) {
        context.lineTo(endX, endY)
      } else {
        context.bezierCurveTo(startX, startY + ROW_HEIGHT / 2, endX, endY - ROW_HEIGHT / 2, endX, endY)
      }
      context.stroke()
    }

    if (isCurrentCheckout(commit.refs)) {
      context.fillStyle = "#f4f4f5"
      context.beginPath()
      context.arc(startX, startY, 7, 0, Math.PI * 2)
      context.fill()
    }

    context.fillStyle = color
    context.beginPath()
    context.arc(startX, startY, 4, 0, Math.PI * 2)
    context.fill()
  }
}
