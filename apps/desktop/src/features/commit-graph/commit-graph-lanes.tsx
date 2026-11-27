import type { VirtualItem } from "@tanstack/react-virtual"
import { useLayoutEffect, useMemo, useRef } from "react"
import { GRAPH_HEADER_HEIGHT, graphChunk } from "./commit-graph"
import { drawCommitGraph, type CommitGraphDrawing } from "./commit-graph-canvas"

type CommitGraphLanesProps = Omit<
  CommitGraphDrawing,
  "canvas" | "height" | "items" | "top"
> & {
  chunk: number
  measurements: VirtualItem[]
}

export function CommitGraphLanes({
  chunk,
  commits,
  measurements,
  pixelRatio,
  rowHeight,
  rows,
  squashMergeEdges,
  unpushed,
  unpushedLanes,
  width,
}: CommitGraphLanesProps) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const { height, items, top } = useMemo(
    () => graphChunk(chunk, measurements),
    [chunk, measurements],
  )

  useLayoutEffect(() => {
    drawCommitGraph({
      canvas: canvas.current!,
      commits,
      height,
      items,
      pixelRatio,
      rowHeight,
      rows,
      squashMergeEdges,
      top,
      unpushed,
      unpushedLanes,
      width,
    })
  }, [
    commits,
    height,
    items,
    pixelRatio,
    rowHeight,
    rows,
    squashMergeEdges,
    top,
    unpushed,
    unpushedLanes,
    width,
  ])

  return (
    <canvas
      aria-hidden
      className="commit-graph-canvas"
      ref={canvas}
      style={{ transform: `translateY(${top - GRAPH_HEADER_HEIGHT}px)` }}
    />
  )
}
