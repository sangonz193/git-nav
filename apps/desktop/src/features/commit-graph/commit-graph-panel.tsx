import { columnResizingFeature, columnSizingFeature, createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Channel, invoke } from "@tauri-apps/api/core"
import type { IDockviewPanelProps } from "dockview-react"
import { PanelsTopLeft } from "lucide-react"
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react"

import { drawCommitGraph } from "./commit-graph-canvas"
import { commitFromTuple, displayRefs, GRAPH_COLORS, GRAPH_WIDTH, relativeDate, ROW_HEIGHT, type CheckedOutWorktree, type Commit, type CommitBatch, type SquashMergeInference } from "./commit-graph"
import type { RepositoryPanelParams } from "../repository/repository-window"
import type { Project } from "../repository/project"

const EMPTY_COMMITS: Commit[] = []
const PULL_REQUEST_SYNC_INTERVAL = 60_000
const commitTableFeatures = tableFeatures({ columnSizingFeature, columnResizingFeature })
const commitColumnHelper = createColumnHelper<typeof commitTableFeatures, Commit>()
const commitColumns = commitColumnHelper.columns([
  commitColumnHelper.accessor("refs", { header: "Refs", maxSize: 420, minSize: 120, size: 240 }),
  commitColumnHelper.accessor("subject", { header: "Subject", maxSize: 1_600, minSize: 280, size: 680 }),
  commitColumnHelper.accessor("author", { header: "Author", maxSize: 360, minSize: 100, size: 180 }),
  commitColumnHelper.accessor("date", { header: "Date", maxSize: 180, minSize: 80, size: 110 }),
  commitColumnHelper.accessor("hash", { header: "Commit", maxSize: 160, minSize: 68, size: 84 }),
])

export function CommitGraphPanel({ params }: IDockviewPanelProps<RepositoryPanelParams>) {
  const [commits, setCommits] = useState<Commit[]>([])
  const [squashMergeInferences, setSquashMergeInferences] = useState<SquashMergeInference[]>([])
  const [error, setError] = useState<string | null>(null)
  const [checkedOutWorktrees, setCheckedOutWorktrees] = useState<CheckedOutWorktree[]>([])
  const scrollElement = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const started = useRef(false)
  const savedScrollTop = useRef(0)
  const isScrollElementVisible = useRef(false)
  const [scroll, setScroll] = useState({ top: 0, height: 0 })
  const scrollFrame = useRef<number | null>(null)
  const table = useTable({
    columnResizeMode: "onChange",
    data: EMPTY_COMMITS,
    features: commitTableFeatures,
    columns: commitColumns,
  })
  const columnTemplate = table.getAllLeafColumns().map((column) => `${column.getSize()}px`).join(" ")
  const tableWidth = GRAPH_WIDTH + table.getTotalSize()
  const rowVirtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => scrollElement.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })
  const virtualRows = rowVirtualizer.getVirtualItems()
  const squashMergeEdges = useMemo(() => {
    if (squashMergeInferences.length === 0) {
      return []
    }
    const indexes = new Map(commits.map((commit, index) => [commit.hash, index]))
    return squashMergeInferences.flatMap(([branchHash, targetHash]) => {
      const branchIndex = indexes.get(branchHash)
      const targetIndex = indexes.get(targetHash)
      return branchIndex === undefined || targetIndex === undefined ? [] : [{ branchIndex, targetIndex }]
    })
  }, [commits, squashMergeInferences])

  const updateScroll = useCallback(() => {
    const element = scrollElement.current
    if (!element) {
      return
    }
    setScroll({ top: element.scrollTop, height: element.clientHeight })
  }, [])

  useEffect(() => {
    const element = scrollElement.current
    if (!element) {
      return
    }
    const observer = new ResizeObserver(updateScroll)
    observer.observe(element)
    updateScroll()
    return () => observer.disconnect()
  }, [updateScroll])

  useEffect(() => {
    const element = scrollElement.current
    if (!element) {
      return
    }
    const observer = new IntersectionObserver(([entry]) => {
      isScrollElementVisible.current = entry.isIntersecting
      if (!entry.isIntersecting) {
        return
      }
      element.scrollTop = savedScrollTop.current
      rowVirtualizer.measure()
      element.dispatchEvent(new Event("scroll"))
      updateScroll()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [rowVirtualizer, updateScroll])

  useEffect(() => {
    if (started.current) {
      return
    }
    started.current = true
    const channel = new Channel<CommitBatch>((batch) => {
      setCommits((existing) => existing.concat(batch.map(commitFromTuple)))
    })
    function refreshSquashMergeInferences() {
      invoke<SquashMergeInference[]>("inferred_squash_merge_edges", { repoPath: params.path })
        .then(setSquashMergeInferences)
        .catch(() => undefined)
    }

    refreshSquashMergeInferences()
    const interval = window.setInterval(refreshSquashMergeInferences, PULL_REQUEST_SYNC_INTERVAL)
    invoke("stream_commit_graph", { repoPath: params.path, onBatch: channel })
      .catch((message: unknown) => setError(String(message)))
    return () => {
      window.clearInterval(interval)
    }
  }, [params.path])

  useEffect(() => {
    let disposed = false
    const refresh = () => invoke<Project>("project_snapshot", { path: params.path })
      .then((project) => {
        if (!disposed) {
          setCheckedOutWorktrees(project.worktrees
            .filter((worktree) => worktree.path !== params.path && !worktree.isPrunable && !worktree.isDetached)
            .map(({ branch, name, path, isOpen }) => ({ branch, name, path, isOpen })))
        }
      })
      .catch((message: unknown) => setError(String(message)))

    refresh()
    window.addEventListener("focus", refresh)
    const interval = window.setInterval(refresh, 10_000)
    return () => {
      disposed = true
      window.removeEventListener("focus", refresh)
      window.clearInterval(interval)
    }
  }, [params.path])

  useEffect(() => {
    if (canvas.current) {
      drawCommitGraph(canvas.current, commits, virtualRows, scroll.top, scroll.height, squashMergeEdges)
    }
  }, [commits, scroll, squashMergeEdges, virtualRows])

  function onScroll() {
    if (scrollFrame.current !== null) {
      return
    }
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null
      if (isScrollElementVisible.current && scrollElement.current) {
        savedScrollTop.current = scrollElement.current.scrollTop
      }
      updateScroll()
    })
  }

  return (
    <main className="flex h-full flex-col overflow-hidden bg-background">
      <div className="commit-graph-scroll" onScroll={onScroll} ref={scrollElement}>
        <div className="commit-graph-header">
          <div className="commit-graph-header-content" style={{ minWidth: tableWidth }}>
            <div className="commit-graph-header-spacer">Graph</div>
            <div className="commit-graph-header-columns" style={{ gridTemplateColumns: columnTemplate }}>
              {table.getFlatHeaders().map((header) => (
                <div className="commit-graph-header-cell" key={header.id}>
                  <table.FlexRender header={header} />
                  {header.column.getCanResize() && (
                    <div
                      aria-label={`Resize ${String(header.column.columnDef.header)} column`}
                      className={`commit-graph-resize-handle${header.column.getIsResizing() ? " is-resizing" : ""}`}
                      onDoubleClick={() => header.column.resetSize()}
                      onMouseDown={(event) => {
                        event.preventDefault()
                        header.getResizeHandler()(event)
                      }}
                      onTouchStart={(event) => {
                        event.preventDefault()
                        header.getResizeHandler()(event)
                      }}
                      role="separator"
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="commit-graph-space" style={{ height: rowVirtualizer.getTotalSize(), minWidth: tableWidth }}>
          <canvas aria-hidden className="commit-graph-canvas" ref={canvas} />
          {virtualRows.map((row) => {
            const commit = commits[row.index]
            const refColor = GRAPH_COLORS[commit.lane % GRAPH_COLORS.length]
            return (
              <article className="commit-graph-row" key={commit.hash} style={{ gridTemplateColumns: columnTemplate, transform: `translateY(${row.start}px)` }}>
                <div className="commit-graph-refs">
                  {displayRefs(commit.refs, checkedOutWorktrees).map((ref, index) => (
                    <span
                      aria-label={ref.checkedOut ? "Currently checked out" : ref.worktrees.length ? "Checked out in another worktree" : undefined}
                      className={`commit-ref${ref.checkedOut ? " commit-ref-current" : ""}`}
                      key={`${ref.label}-${index}`}
                      style={{ "--commit-ref-color": refColor } as CSSProperties}
                      title={ref.worktrees.map((worktree) => `${worktree.isOpen ? "Open in" : "Checked out at"} ${worktree.name}`).join("\n") || undefined}
                    >
                      {ref.checkedOut && <span className="commit-ref-head">HEAD</span>}
                      {ref.label}
                      {ref.worktrees.length > 0 && <PanelsTopLeft aria-hidden className={`size-3 ${ref.worktrees.some((worktree) => worktree.isOpen) ? "text-foreground" : "text-muted-foreground"}`} />}
                    </span>
                  ))}
                </div>
                <span className="truncate font-medium">{commit.subject || "(no subject)"}</span>
                <span className="truncate text-muted-foreground">{commit.author}</span>
                <time className="text-muted-foreground" dateTime={commit.date}>{relativeDate(commit.date)}</time>
                <code className="text-muted-foreground">{commit.hash.slice(0, 8)}</code>
              </article>
            )
          })}
        </div>
      </div>
      {commits.length === 0 && !error && <p className="commit-graph-status">Loading commits…</p>}
      {error && <p className="commit-graph-status text-destructive">{error}</p>}
    </main>
  )
}
