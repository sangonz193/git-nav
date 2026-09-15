import {
  columnResizingFeature,
  columnSizingFeature,
  createColumnHelper,
  tableFeatures,
  useTable,
} from "@tanstack/react-table"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useMutation } from "@tanstack/react-query"
import { invoke } from "@/lib/ipc"
import {
  openPullRequest,
  openWorktree,
  type WorktreeTarget,
} from "@/lib/navigation"
import { Button } from "@workspace/shadcn/components/button"
import { cn } from "@workspace/shadcn/lib/utils"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@workspace/shadcn/components/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@workspace/shadcn/components/dropdown-menu"
import { toast } from "@workspace/shadcn/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/shadcn/components/tooltip"
import type { IDockviewPanelProps } from "dockview-react"
import { ArrowDown, ArrowUp, ChevronsDownUp } from "lucide-react"
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import { BranchCleanupDialog } from "./branch-cleanup-dialog"
import { drawCommitGraph } from "./commit-graph-canvas"
import {
  ancestryPath,
  chipLabel,
  chipName,
  clampGraphWidth,
  displayRefs,
  fitGraphWidth,
  GRAPH_HEADER_HEIGHT,
  GRAPH_WIDTH,
  graphCanvasHeight,
  graphCanvasTop,
  isCurrentCheckout,
  laneColor,
  persistedGraphPanelParams,
  REF_BUDGET_SHARE,
  refName,
  relativeDate,
  ROW_HEIGHT,
  unpushedHashes,
  unpushedLanes,
  visibleChipCount,
  type Commit,
  type Selection,
} from "./commit-graph"
import {
  appendGraphRows,
  CHIP_KINDS,
  activeFilterCount,
  branchFiltersKey,
  commitChips,
  DEFAULT_BRANCH_FILTERS,
  isMarkedCommit,
  rowIndexOfCommit,
  useViewConfig,
  type BranchFilters,
  type ChipContext,
  type GraphRow,
  type GraphRows,
  type SearchHit,
  type ViewConfig,
  type ViewConfigChange,
} from "./commit-graph-view"
import { Hinted } from "@/components/hinted"
import { OperationDialog } from "./commit-operation-menu"
import {
  clearConflictPredictions,
  type CompletedOperation,
  type OperationRequest,
  type RefUpdate,
} from "./commit-operations"
import type { GraphPanelParams } from "@/lib/panel-params"
import { diffTabs } from "./diff-tabs"
import { GraphToolbar } from "./graph-toolbar"
import { RowContextMenuBody } from "./row-context-menu"
import { NARROW_SHEET_PANEL_WIDTH, SelectionSheet } from "./selection-sheet"
import {
  chipMenuEntry,
  dropdownMenuComponents,
  rowChip,
  type ChipMenuContext,
} from "./row-chips"
import { useBranchCleanup } from "./use-branch-cleanup"
import { useGraphData } from "./use-graph-data"
import { useGraphSearch } from "./use-graph-search"
import { useGraphSelection } from "./use-graph-selection"

const EMPTY_COMMITS: Commit[] = []
const DRAG_THRESHOLD = 4
const AUTOSCROLL_EDGE = 24
const AUTOSCROLL_STEP = 18
const COARSE_POINTER_ROW_HEIGHT = 36
const UNDO_TOAST_DURATION = 10_000
const commitTableFeatures = tableFeatures({
  columnSizingFeature,
  columnResizingFeature,
})
const commitColumnHelper = createColumnHelper<
  typeof commitTableFeatures,
  Commit
>()
const commitColumns = commitColumnHelper.columns([
  commitColumnHelper.accessor("subject", {
    header: "Commit",
    maxSize: 1_600,
    minSize: 400,
    size: 760,
  }),
  commitColumnHelper.accessor("author", {
    header: "Author",
    maxSize: 360,
    minSize: 100,
    size: 180,
  }),
  commitColumnHelper.accessor("date", {
    header: "Date",
    maxSize: 180,
    minSize: 80,
    size: 124,
  }),
  commitColumnHelper.accessor("hash", {
    header: "Commit",
    maxSize: 160,
    minSize: 68,
    size: 96,
  }),
])

export function CommitGraphPanel(props: IDockviewPanelProps<GraphPanelParams>) {
  const [config, updateConfig] = useViewConfig()
  if (!config) {
    return (
      <main className="relative flex h-full flex-col overflow-hidden bg-background" />
    )
  }
  return (
    <CommitGraphPanelContent
      {...props}
      config={config}
      updateConfig={updateConfig}
    />
  )
}

function CommitGraphPanelContent({
  api,
  containerApi,
  params,
  config,
  updateConfig,
}: IDockviewPanelProps<GraphPanelParams> & {
  config: ViewConfig
  updateConfig: (change: ViewConfigChange) => void
}) {
  const operationToastId = `commit-graph-operation-${api.id}`
  const undoInFlight = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const cleanOptions = config.cleanOptions
  const [request, setRequest] = useState<OperationRequest | null>(null)
  const [graphWidth, setGraphWidth] = useState(GRAPH_WIDTH)
  const [isResizingGraph, setIsResizingGraph] = useState(false)
  const [rowHeight, setRowHeight] = useState(ROW_HEIGHT)
  const [columnSizing, setColumnSizing] = useState<Record<string, number>>(
    () => params.userPreferences?.columnWidths ?? {},
  )
  const [collapseUnmarked, setCollapseUnmarked] = useState(
    params.userPreferences?.collapseUnmarked ?? true,
  )
  // A filter is a task rather than a preference, so it starts clear on every open.
  const [filters, setFilters] = useState<BranchFilters>(DEFAULT_BRANCH_FILTERS)
  const [detailsExpanded, setDetailsExpanded] = useState(
    params.userPreferences?.detailsExpanded ?? false,
  )
  // A collapsed run is opened by the commit it starts at, which survives the refresh that rebuilds the runs.
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set())
  const scrollElement = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const savedScrollTop = useRef(0)
  const refreshAnchor = useRef<{
    commits: Commit[]
    hash: string
    offset: number
  } | null>(null)
  const pendingScrollHash = useRef<string | null>(null)
  const rowsRef = useRef<GraphRow[] | null>(null)
  const isScrollElementVisible = useRef(false)
  const [scroll, setScroll] = useState({
    top: 0,
    height: 0,
    width: 0,
    scrollbarHeight: 0,
  })
  const [sheetPeekHeight, setSheetPeekHeight] = useState(0)
  const scrollFrame = useRef<number | null>(null)
  const captureScrollAnchor = useCallback(() => {
    const scrollTop = scrollElement.current?.scrollTop ?? savedScrollTop.current
    const row = Math.floor(scrollTop / rowHeight)
    const commit =
      commitsRef.current[
        rowsRef.current ? (rowsRef.current[row]?.index ?? -1) : row
      ]
    refreshAnchor.current =
      commit ?
        {
          commits: commitsRef.current,
          hash: commit.hash,
          offset: scrollTop - row * rowHeight,
        }
      : null
  }, [rowHeight])
  const {
    branchSync,
    commits,
    graphOffset,
    graphVersion,
    hasOlderCommits,
    isGraphWindowLoading,
    pullRequests,
    refreshGraph,
    refreshWorktreeStatus,
    remoteNames,
    remotes,
    repository,
    setGraphOffset,
    squashMergeInferences,
    stashes,
    stashesByBase,
    worktreesByHead,
  } = useGraphData({
    onBeforeReload: captureScrollAnchor,
    onError: setError,
    repoPath: params.path,
  })
  const commitsRef = useRef(commits)
  const persistSelection = useCallback(
    (selectedCommitHashes: string[]) =>
      api.updateParameters(
        persistedGraphPanelParams(
          params.name,
          params.path,
          selectedCommitHashes,
          {
            collapseUnmarked,
            columnWidths: columnSizing,
            detailsExpanded,
          },
        ),
      ),
    [
      api,
      collapseUnmarked,
      columnSizing,
      detailsExpanded,
      params.name,
      params.path,
    ],
  )
  const {
    beginUserSelection,
    canSelectRange,
    clearSelection,
    commitsSelection,
    rangeDrag,
    rowTarget,
    selectCommit,
    selectCommitFromKeyboard,
    selectRangeTo,
    selectRef,
    selectedHashes,
    selectedRef,
    selection,
    selectionEdges,
    selectionRange,
    setRangeDrag,
    setSelectedRef,
    setSelectionRange,
  } = useGraphSelection({
    branchSync,
    commits,
    isGraphWindowLoading,
    persist: persistSelection,
    persistedHashes: params.selectedCommitHashes,
    pullRequests,
    remotes,
    worktreesByHead,
  })
  const table = useTable({
    columnResizeMode: "onChange",
    onColumnSizingChange: setColumnSizing,
    data: EMPTY_COMMITS,
    features: commitTableFeatures,
    columns: commitColumns,
    state: { columnSizing },
  })
  const columnTemplate = table
    .getAllLeafColumns()
    .map((column) => `${column.getSize()}px`)
    .join(" ")
  // Refs share the commit column with the subject, which keeps whatever they do not take.
  const refBudget = table.getAllLeafColumns()[0].getSize() * REF_BUDGET_SHARE
  const tableWidth = graphWidth + table.getTotalSize()
  const commitIndexesByHash = useMemo(
    () => new Map(commits.map((commit, index) => [commit.hash, index])),
    [commits],
  )
  const currentCheckoutIndex = useMemo(
    () => commits.findIndex((commit) => isCurrentCheckout(commit.refs)),
    [commits],
  )

  const search = useGraphSearch({ commits, remotes, stashesByBase })
  const unpushed = useMemo(
    () => unpushedHashes(commits, remotes),
    [commits, remotes],
  )
  const unpushedLaneMasks = useMemo(
    () => unpushedLanes(commits, unpushed),
    [commits, unpushed],
  )
  const chipContext = useMemo<ChipContext>(
    () => ({
      branchSync,
      chipKinds: config.chipKinds,
      filters,
      pullRequests,
      remotes,
      stashesByBase,
      worktreesByHead,
    }),
    [
      branchSync,
      config.chipKinds,
      filters,
      pullRequests,
      remotes,
      stashesByBase,
      worktreesByHead,
    ],
  )
  // Worktrees and stashes are re-read on a timer and land as fresh maps every time, so what a run collapses
  // on is held by its contents. Rebuilding the rows for a poll that changed nothing would walk the whole
  // history every few seconds.
  const marksKey = useMemo(
    () =>
      [
        remoteNames,
        CHIP_KINDS.filter((kind) => config.chipKinds[kind]).join(","),
        branchFiltersKey(filters),
        [...stashesByBase.keys()].sort().join(","),
        [...worktreesByHead.keys()].sort().join(","),
      ].join("|"),
    [config.chipKinds, filters, remoteNames, stashesByBase, worktreesByHead],
  )
  // Rows exist only while runs are being collapsed. Without them a row is a commit, which is what the rest of
  // the panel already reads its indexes as.
  const rowsCache = useRef<{
    commits: Commit[]
    marksKey: string
    revealed: ReadonlySet<string>
    value: GraphRows
  } | null>(null)
  const rows = useMemo(() => {
    if (!collapseUnmarked) {
      rowsCache.current = null
      return null
    }
    const cache = rowsCache.current
    // A batch only ever adds to the end of the graph, so the rows already built stand and only the new tail
    // is scanned. Rebuilding them per batch would walk the whole history once for every five hundred commits.
    const continues =
      cache !== null &&
      cache.marksKey === marksKey &&
      cache.revealed === revealed &&
      commits.length >= cache.commits.length &&
      commits[cache.commits.length - 1] ===
        cache.commits[cache.commits.length - 1]
    const value = appendGraphRows(
      continues ? cache.value : null,
      commits,
      (commit) => isMarkedCommit(commit, chipContext),
      (hash) => revealed.has(hash),
    )
    rowsCache.current = { commits, marksKey, revealed, value }
    return value.rows
  }, [chipContext, collapseUnmarked, commits, marksKey, revealed])
  const rowCount = rows ? rows.length : commits.length
  const commitIndexAtRow = useCallback(
    (row: number) => (rows ? (rows[row]?.index ?? 0) : row),
    [rows],
  )
  const rowOfCommit = useCallback(
    (index: number) => (rows ? rowIndexOfCommit(rows, index) : index),
    [rows],
  )
  const expandedSheet = selection !== null && detailsExpanded
  const expandedSheetHeight = Math.floor(scroll.height * 0.7) + sheetPeekHeight
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollElement.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    // Room past the last row reserves the expanded sheet, otherwise half the viewport, so rows can clear it.
    paddingEnd: Math.max(
      0,
      expandedSheet ? expandedSheetHeight : (
        Math.floor((scroll.height - GRAPH_HEADER_HEIGHT) / 2)
      ),
    ),
    scrollMargin: GRAPH_HEADER_HEIGHT,
    scrollPaddingStart: GRAPH_HEADER_HEIGHT,
  })
  const virtualRows = rowVirtualizer.getVirtualItems()
  const virtualScrollTop = rowVirtualizer.scrollOffset ?? 0
  const graphScrollTop = graphCanvasTop(
    virtualScrollTop,
    scroll.height,
    rowVirtualizer.getTotalSize(),
  )
  const currentCheckoutRow =
    currentCheckoutIndex === -1 ? -1 : rowOfCommit(currentCheckoutIndex)
  // The brackets are drawn on rows while the drag they adjust is anchored on commits, so an endpoint carries both.
  const selectionRowEdges = selectionEdges && {
    bottom: rowOfCommit(selectionEdges.bottom),
    bottomCommit: selectionEdges.bottom,
    top: rowOfCommit(selectionEdges.top),
    topCommit: selectionEdges.top,
  }
  const checkoutScrollDirection =
    currentCheckoutRow === -1 || scroll.height === 0 ? null
    : (currentCheckoutRow + 1) * rowHeight < scroll.top ? "up"
    : (
      currentCheckoutRow * rowHeight + GRAPH_HEADER_HEIGHT >=
      scroll.top + scroll.height
    ) ?
      "down"
    : null
  const squashMergeEdges = useMemo(() => {
    if (squashMergeInferences.length === 0) {
      return []
    }
    return squashMergeInferences.flatMap(([branchHash, targetHash]) => {
      const branchIndex = commitIndexesByHash.get(branchHash)
      const targetIndex = commitIndexesByHash.get(targetHash)
      if (branchIndex === undefined || targetIndex === undefined) {
        return []
      }
      return [
        {
          branchLane: commits[branchIndex].lane,
          branchRow: rowOfCommit(branchIndex),
          isLocal: unpushed.has(branchHash),
          targetLane: commits[targetIndex].lane,
          targetRow: rowOfCommit(targetIndex),
        },
      ]
    })
  }, [
    commitIndexesByHash,
    commits,
    rowOfCommit,
    squashMergeInferences,
    unpushed,
  ])
  const fetchMutation = useMutation({
    mutationFn: () =>
      invoke("fetch_and_sync_pull_requests", { repoPath: params.path }),
    onMutate: () => setError(null),
    onSuccess: () => refreshGraph(),
    onError: (message) => setError(String(message)),
  })
  const { mutate: mutateWorktree } = useMutation({
    mutationFn: ({ path, target }: { path: string; target: WorktreeTarget }) =>
      openWorktree(path, target),
    onError: (message) => setError(String(message)),
  })
  const { mutate: mutatePullRequest } = useMutation({
    mutationFn: (url: string) => openPullRequest(url),
    onError: (message) => setError(String(message)),
  })
  const undoMutation = useMutation({
    mutationFn: (updates: RefUpdate[]) =>
      invoke("undo_ref_updates", { repoPath: params.path, updates }),
    onSuccess: () => {
      undoInFlight.current = false
      toast.dismiss(operationToastId)
      refreshGraph()
    },
    onError: (message) => {
      undoInFlight.current = false
      setError(String(message))
    },
  })
  const {
    openCommitDiff,
    openRangeDiff,
    openRefDiff,
    openStashDiff,
    openWorkingTree,
    openWorktreeDiff,
  } = useMemo(
    () =>
      diffTabs({
        containerApi,
        name: params.name,
        onError: setError,
        panel: api.id,
        repoPath: params.path,
      }),
    [api.id, containerApi, params.name, params.path],
  )
  const cleanup = useBranchCleanup({
    cleanOptions,
    graphVersion,
    onError: setError,
    refreshGraph,
    repoPath: params.path,
  })

  const updateScroll = useCallback(() => {
    const element = scrollElement.current
    if (!element) {
      return
    }
    setScroll({
      top: element.scrollTop,
      height: element.clientHeight,
      width: element.clientWidth,
      scrollbarHeight: element.offsetHeight - element.clientHeight,
    })
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
    const query = window.matchMedia("(pointer: coarse)")
    const updateRowHeight = () =>
      setRowHeight(query.matches ? COARSE_POINTER_ROW_HEIGHT : ROW_HEIGHT)
    updateRowHeight()
    query.addEventListener("change", updateRowHeight)
    return () => query.removeEventListener("change", updateRowHeight)
  }, [])

  useEffect(() => {
    rowVirtualizer.measure()
  }, [rowHeight, rowVirtualizer])

  useEffect(() => {
    commitsRef.current = commits
  }, [commits])

  useEffect(() => {
    rowsRef.current = rows
  }, [rows])

  // Opening a run moves every row below it, so the commit that asked for the scroll is followed to its new place.
  useEffect(() => {
    const hash = pendingScrollHash.current
    if (!hash) {
      return
    }
    const index = commitIndexesByHash.get(hash)
    if (index === undefined) {
      return
    }
    pendingScrollHash.current = null
    rowVirtualizer.scrollToIndex(rowOfCommit(index), {
      align: detailsExpanded ? "start" : "center",
    })
  }, [commitIndexesByHash, detailsExpanded, rowOfCommit, rowVirtualizer])

  useEffect(() => {
    const anchor = refreshAnchor.current
    const element = scrollElement.current
    // The graph it was captured on stays up until the refresh lands, and it is only restored on the replacement.
    if (!anchor || !element || commits === anchor.commits) {
      return
    }
    const index = commits.findIndex((commit) => commit.hash === anchor.hash)
    if (index === -1) {
      return
    }
    element.scrollTop = rowOfCommit(index) * rowHeight + anchor.offset
    refreshAnchor.current = null
  }, [commits, rowHeight, rowOfCommit])

  useEffect(() => {
    if (canvas.current) {
      drawCommitGraph({
        canvas: canvas.current,
        commits,
        items: virtualRows,
        scrollTop: graphScrollTop,
        height: graphCanvasHeight(scroll.height),
        rows,
        squashMergeEdges,
        unpushed,
        unpushedLanes: unpushedLaneMasks,
        width: graphWidth,
        rowHeight,
      })
    }
  }, [
    commits,
    graphScrollTop,
    graphWidth,
    rowHeight,
    rows,
    scroll.height,
    squashMergeEdges,
    unpushed,
    unpushedLaneMasks,
    virtualRows,
    drawCommitGraph,
  ])

  function startGraphResize(
    event: ReactMouseEvent<HTMLElement> | ReactTouchEvent<HTMLElement>,
  ) {
    const originX =
      "touches" in event ? event.touches[0].clientX : event.clientX
    const originWidth = graphWidth
    setIsResizingGraph(true)

    const onMove = (moveEvent: MouseEvent | TouchEvent) => {
      const clientX =
        "touches" in moveEvent ?
          moveEvent.touches[0]?.clientX
        : moveEvent.clientX
      if (clientX !== undefined) {
        setGraphWidth(clampGraphWidth(originWidth + clientX - originX))
      }
    }

    const onEnd = () => {
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onEnd)
      window.removeEventListener("touchmove", onMove)
      window.removeEventListener("touchend", onEnd)
      setIsResizingGraph(false)
    }

    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onEnd)
    window.addEventListener("touchmove", onMove)
    window.addEventListener("touchend", onEnd)
  }

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

  // A commit inside a collapsed run has no row of its own, so the run it sits in is opened and the scroll
  // waits for the rows that opening it produces.
  const scrollToCommit = useCallback(
    (index: number) => {
      const row = rowOfCommit(index)
      if (rows && rows[row]?.hidden > 0) {
        const start = commits[rows[row].index].hash
        pendingScrollHash.current = commits[index].hash
        setRevealed((current) => new Set(current).add(start))
        return
      }
      rowVirtualizer.scrollToIndex(row, {
        align: detailsExpanded ? "start" : "center",
      })
    },
    [commits, detailsExpanded, rowOfCommit, rows, rowVirtualizer],
  )

  function collapseUnmarkedCommits(collapse: boolean) {
    const top =
      commits[
        commitIndexAtRow(
          Math.floor((scrollElement.current?.scrollTop ?? 0) / rowHeight),
        )
      ]
    pendingScrollHash.current = top?.hash ?? null
    setRevealed(new Set())
    setCollapseUnmarked(collapse)
  }

  // A filter that hides labels without folding the rows between them reads as labels going missing, so
  // narrowing the graph brings the collapse with it.
  function updateFilters(change: Partial<BranchFilters>) {
    const next = { ...filters, ...change }
    if (
      !collapseUnmarked &&
      activeFilterCount(next) > 0 &&
      activeFilterCount(filters) === 0
    ) {
      collapseUnmarkedCommits(true)
    }
    setFilters(next)
  }

  function revealRun(startHash: string) {
    setRevealed((current) => new Set(current).add(startHash))
  }

  function onPanelKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "f") {
      event.preventDefault()
      search.open()
    }
  }

  function activateSearchHit(hit: SearchHit) {
    const commit = commits[hit.commitIndex]
    if (!commit) {
      return
    }
    beginUserSelection()
    if (hit.kind === "commit" || hit.kind === "stash") {
      setSelectedRef(null)
      setSelectionRange({ anchorHash: commit.hash, focusHash: commit.hash })
    } else {
      const ref = displayRefs(commit.refs, {
        branchSync,
        pullRequests,
        remotes,
        worktrees: worktreesByHead.get(commit.hash),
      }).find(
        (candidate) =>
          candidate.kind === hit.kind && refName(candidate) === hit.label,
      )
      if (ref) {
        setSelectionRange(null)
        setSelectedRef({ ref, sha: commit.hash })
      }
    }
    scrollToCommit(hit.commitIndex)
  }

  function showGraphWindow(offset: number) {
    beginUserSelection()
    setSelectedRef(null)
    setSelectionRange(null)
    setGraphOffset(offset)
    rowVirtualizer.scrollToIndex(0)
  }

  const canSelectCommitByHash = useCallback(
    (hash: string) => commitIndexesByHash.has(hash),
    [commitIndexesByHash],
  )
  const selectCommitByHash = useCallback(
    (hash: string) => {
      const index = commitIndexesByHash.get(hash)
      if (index === undefined) {
        return
      }
      selectCommit(commits[index])
      scrollToCommit(index)
    },
    [commitIndexesByHash, commits, scrollToCommit, selectCommit],
  )
  const commitByHash = useCallback(
    (hash: string) => {
      const index = commitIndexesByHash.get(hash)
      return index === undefined ? null : (commits[index] ?? null)
    },
    [commitIndexesByHash, commits],
  )

  function scrollToCurrentCheckout() {
    if (currentCheckoutIndex === -1) {
      return
    }
    scrollToCommit(currentCheckoutIndex)
  }

  const copyText = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
    } catch (message) {
      setError(String(message))
    }
  }, [])

  function onOperationCompleted(result: CompletedOperation) {
    setRequest(null)
    toast(result.summary, {
      action:
        result.updates.length > 0 ?
          {
            label: "Undo",
            onClick: (event) => {
              event.preventDefault()
              if (undoInFlight.current) {
                return
              }
              undoInFlight.current = true
              undoMutation.mutate(result.updates)
            },
          }
        : undefined,
      duration: UNDO_TOAST_DURATION,
      id: operationToastId,
    })
    clearConflictPredictions()
    refreshWorktreeStatus()
    refreshGraph()
  }

  function startRangeDrag(
    event: ReactPointerEvent<HTMLElement>,
    index: number,
    anchorIndex?: number,
  ) {
    const scroll = scrollElement.current
    if (
      event.button !== 0 ||
      !scroll ||
      (event.target as HTMLElement).closest(".commit-ref")
    ) {
      return
    }
    // A menu opened from this row renders in a portal, and React bubbles its events back through here,
    // so a click on a menu item would otherwise start a drag anchored on the row behind it.
    if (!event.currentTarget.contains(event.target as Node)) {
      return
    }
    // Dragging a finger across the rows scrolls the graph, so touch only adjusts a range from a handle.
    if (anchorIndex === undefined && event.pointerType !== "mouse") {
      return
    }
    beginUserSelection()
    setSelectedRef(null)
    const selectionAnchorIndex =
      anchorIndex ??
      (event.shiftKey && selectionRange ?
        commits.findIndex((commit) => commit.hash === selectionRange.anchorHash)
      : index)
    const rangeAnchorIndex =
      selectionAnchorIndex === -1 ? index : selectionAnchorIndex
    const originX = event.clientX
    const originY = event.clientY
    let pointerY = event.clientY
    let dragging = false
    let frame: number | null = null

    const focusIndexAt = () => {
      const offset =
        scroll.scrollTop +
        pointerY -
        scroll.getBoundingClientRect().top -
        GRAPH_HEADER_HEIGHT
      return commitIndexAtRow(
        Math.max(0, Math.min(rowCount - 1, Math.floor(offset / rowHeight))),
      )
    }

    const autoScroll = () => {
      const rect = scroll.getBoundingClientRect()
      // The sticky header covers the top row of the scroll box.
      const overTop =
        pointerY - (rect.top + GRAPH_HEADER_HEIGHT + AUTOSCROLL_EDGE)
      const overBottom = pointerY - (rect.bottom - AUTOSCROLL_EDGE)
      const distance =
        overTop < 0 ? overTop
        : overBottom > 0 ? overBottom
        : 0
      if (distance !== 0) {
        scroll.scrollTop += Math.max(
          -AUTOSCROLL_STEP,
          Math.min(AUTOSCROLL_STEP, distance),
        )
        setRangeDrag({
          anchorIndex: rangeAnchorIndex,
          focusIndex: focusIndexAt(),
        })
      }
      frame = requestAnimationFrame(autoScroll)
    }

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== event.pointerId) {
        return
      }
      pointerY = moveEvent.clientY
      if (!dragging) {
        if (
          Math.abs(moveEvent.clientX - originX) < DRAG_THRESHOLD &&
          Math.abs(moveEvent.clientY - originY) < DRAG_THRESHOLD
        ) {
          return
        }
        dragging = true
        window.getSelection()?.removeAllRanges()
        frame = requestAnimationFrame(autoScroll)
      }
      setRangeDrag({
        anchorIndex: rangeAnchorIndex,
        focusIndex: focusIndexAt(),
      })
    }

    const cleanUp = () => {
      window.removeEventListener("pointermove", onPointerMove)
      window.removeEventListener("pointerup", onPointerUp)
      window.removeEventListener("pointercancel", onPointerCancel)
      window.getSelection()?.removeAllRanges()
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
    }

    const onPointerUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== event.pointerId) {
        return
      }
      pointerY = upEvent.clientY
      cleanUp()
      const focusIndex = focusIndexAt()
      const path = ancestryPath(commits, rangeAnchorIndex, focusIndex)
      if (path.length > 0) {
        setSelectionRange({
          anchorHash: commits[rangeAnchorIndex].hash,
          focusHash: commits[focusIndex].hash,
        })
      } else if (anchorIndex === undefined && !event.shiftKey) {
        setSelectionRange(null)
      }
      setRangeDrag(null)
    }

    // A touch that turns into a system gesture never reports a pointerup.
    const onPointerCancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId !== event.pointerId) {
        return
      }
      cleanUp()
      setRangeDrag(null)
    }

    window.addEventListener("pointermove", onPointerMove)
    window.addEventListener("pointerup", onPointerUp)
    window.addEventListener("pointercancel", onPointerCancel)
  }

  const triggerWorktree = useCallback(
    (path: string, target: WorktreeTarget) => mutateWorktree({ path, target }),
    [mutateWorktree],
  )
  const menus = useMemo<ChipMenuContext>(
    () => ({
      copyText,
      openPullRequest: mutatePullRequest,
      openRefDiff,
      openStashDiff,
      openWorkingTree,
      openWorktree: triggerWorktree,
      openWorktreeDiff,
      repository,
      selectRef,
      selectedRef,
      selection,
      setRequest,
    }),
    [
      copyText,
      mutatePullRequest,
      openRefDiff,
      openStashDiff,
      openWorkingTree,
      triggerWorktree,
      openWorktreeDiff,
      repository,
      selectRef,
      selectedRef,
      selection,
      setRequest,
    ],
  )
  const openSelectionDiff = useCallback(
    (selected: Selection, filePath?: string) => {
      if (selected.kind !== "commits") {
        return openRefDiff(refName(selected.ref))
      }
      return selected.commits.length === 1 ?
          openCommitDiff(selected.tip, filePath)
        : openRangeDiff(selected, filePath)
    },
    [openCommitDiff, openRangeDiff, openRefDiff],
  )

  return (
    <main
      className="relative flex h-full flex-col overflow-hidden bg-background"
      onKeyDown={onPanelKeyDown}
      style={
        {
          "--commit-graph-sheet-peek": `${selection ? sheetPeekHeight + scroll.scrollbarHeight : 0}px`,
        } as CSSProperties
      }
    >
      <GraphToolbar
        cleanup={cleanup}
        collapseUnmarked={collapseUnmarked}
        config={config}
        fetch={() => fetchMutation.mutate()}
        filters={filters}
        graphOffset={graphOffset}
        hasOlderCommits={hasOlderCommits}
        isFetching={fetchMutation.isPending}
        isGraphWindowLoading={isGraphWindowLoading}
        menus={menus}
        onActivateSearchHit={activateSearchHit}
        onCollapseUnmarked={collapseUnmarkedCommits}
        pullRequestCount={pullRequests.size}
        refreshGraph={refreshGraph}
        search={search}
        showGraphWindow={showGraphWindow}
        stashes={stashes}
        updateConfig={updateConfig}
        updateFilters={updateFilters}
      />
      <div
        aria-label="Commit history. Click a commit to select it. Shift-click, or press Shift+Enter or Shift+Space, to extend the selection through related commits."
        aria-multiselectable
        className={cn(
          "commit-graph-scroll",
          rangeDrag && "is-selecting",
          rangeDrag && !selection && "is-unrelated",
        )}
        onScroll={onScroll}
        ref={scrollElement}
        role="grid"
        style={
          {
            "--commit-row-height": `${rowHeight}px`,
            "--graph-width": `${graphWidth}px`,
          } as CSSProperties
        }
      >
        <div className="commit-graph-header">
          <div
            className="commit-graph-header-content"
            role="row"
            style={{ minWidth: tableWidth }}
          >
            <div
              aria-label="Graph"
              className="commit-graph-header-spacer"
              role="columnheader"
            >
              <div
                aria-label="Resize Graph column"
                className={cn(
                  "commit-graph-resize-handle",
                  isResizingGraph && "is-resizing",
                )}
                onDoubleClick={() => setGraphWidth(fitGraphWidth(commits))}
                onMouseDown={(event) => {
                  event.preventDefault()
                  startGraphResize(event)
                }}
                onTouchStart={(event) => {
                  event.preventDefault()
                  startGraphResize(event)
                }}
                role="separator"
              />
            </div>
            <div
              className="commit-graph-header-columns"
              style={{ gridTemplateColumns: columnTemplate }}
            >
              {table.getFlatHeaders().map((header) => (
                <div
                  className="commit-graph-header-cell"
                  key={header.id}
                  role="columnheader"
                >
                  <table.FlexRender header={header} />
                  {header.column.getCanResize() && (
                    <div
                      aria-label={`Resize ${String(header.column.columnDef.header)} column`}
                      className={cn(
                        "commit-graph-resize-handle",
                        header.column.getIsResizing() && "is-resizing",
                      )}
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
        <div
          className="commit-graph-space"
          style={
            {
              "--commit-ref-budget": `${refBudget}px`,
              height: rowVirtualizer.getTotalSize(),
              minWidth: tableWidth,
            } as CSSProperties
          }
        >
          <canvas aria-hidden className="commit-graph-canvas" ref={canvas} />
          {virtualRows.map((row) => {
            const graphRow = rows?.[row.index]
            const index = graphRow ? graphRow.index : row.index
            const commit = commits[index]
            if (!commit) {
              return null
            }
            if (graphRow && graphRow.hidden > 0) {
              return (
                <div
                  aria-rowindex={row.index + 2}
                  className="commit-graph-row commit-graph-row-collapsed"
                  key={commit.hash}
                  role="row"
                  style={{
                    gridTemplateColumns: `${graphWidth}px ${columnTemplate}`,
                    transform: `translateY(${row.start - GRAPH_HEADER_HEIGHT}px)`,
                  }}
                >
                  <div className="commit-graph-graph-cell" />
                  <div role="gridcell">
                    <button
                      className="commit-graph-collapsed-label"
                      onClick={() => revealRun(commit.hash)}
                      type="button"
                    >
                      <ChevronsDownUp />
                      {`${graphRow.hidden} commit${graphRow.hidden === 1 ? "" : "s"}`}
                    </button>
                  </div>
                </div>
              )
            }
            const refColor = laneColor(commit.lane)
            const currentCheckout = isCurrentCheckout(commit.refs)
            const selected = selectedHashes.has(commit.hash)
            const edges = selectionRowEdges
            const chips = commitChips(commit, chipContext)
            const shown = visibleChipCount(chips, refBudget)
            const overflowChips = chips.slice(shown)
            return (
              <ContextMenu key={commit.hash}>
                <ContextMenuTrigger asChild>
                  <article
                    aria-keyshortcuts="Enter Space Shift+Enter Shift+Space"
                    aria-rowindex={row.index + 2}
                    aria-selected={selected}
                    className={cn(
                      "commit-graph-row",
                      currentCheckout && "commit-graph-row-current",
                      selected && "commit-graph-row-selected",
                    )}
                    onKeyDown={(event) =>
                      selectCommitFromKeyboard(event, index)
                    }
                    onPointerDown={(event) => startRangeDrag(event, index)}
                    role="row"
                    style={
                      {
                        "--commit-ref-color": refColor,
                        gridTemplateColumns: `${graphWidth}px ${columnTemplate}`,
                        transform: `translateY(${row.start - GRAPH_HEADER_HEIGHT}px)`,
                      } as CSSProperties
                    }
                    tabIndex={0}
                  >
                    <div className="commit-graph-graph-cell">
                      {edges?.top === row.index && (
                        <button
                          aria-label="Adjust the newer end of the selected range"
                          className="commit-graph-selection-handle commit-graph-selection-handle-start"
                          onPointerDown={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            startRangeDrag(event, index, edges.bottomCommit)
                          }}
                          type="button"
                        />
                      )}
                      {edges?.bottom === row.index && (
                        <button
                          aria-label="Adjust the older end of the selected range"
                          className="commit-graph-selection-handle commit-graph-selection-handle-end"
                          onPointerDown={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            startRangeDrag(event, index, edges.topCommit)
                          }}
                          type="button"
                        />
                      )}
                    </div>
                    <div className="commit-graph-summary" role="gridcell">
                      <div className="commit-graph-refs">
                        {chips
                          .slice(0, shown)
                          .map((chip, index) =>
                            rowChip(
                              menus,
                              chip,
                              commit.hash,
                              `${chipName(chip)}-${index}`,
                            ),
                          )}
                        {overflowChips.length > 0 && (
                          <DropdownMenu>
                            <Tooltip>
                              <DropdownMenuTrigger asChild>
                                <TooltipTrigger asChild>
                                  <button
                                    aria-label={`Show ${overflowChips.length} more ref${overflowChips.length === 1 ? "" : "s"}`}
                                    className="commit-ref commit-ref-more"
                                    onPointerDown={(event) =>
                                      event.stopPropagation()
                                    }
                                    type="button"
                                  >
                                    {`+${overflowChips.length}`}
                                  </button>
                                </TooltipTrigger>
                              </DropdownMenuTrigger>
                              <TooltipContent>
                                {overflowChips.map(chipLabel).join("\n")}
                              </TooltipContent>
                            </Tooltip>
                            <DropdownMenuContent>
                              {overflowChips.map((chip, index) =>
                                chipMenuEntry(
                                  menus,
                                  chip,
                                  commit.hash,
                                  `${chipName(chip)}-${index}`,
                                  dropdownMenuComponents,
                                ),
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                      <span
                        className={`min-w-0 flex-1 truncate ${currentCheckout ? "font-bold" : "font-normal"}`}
                      >
                        {commit.subject || "(no subject)"}
                      </span>
                    </div>
                    <span className="text-muted-foreground" role="gridcell">
                      {commit.author}
                    </span>
                    <time
                      className="text-muted-foreground"
                      dateTime={commit.date}
                      role="gridcell"
                    >
                      {relativeDate(commit.date)}
                    </time>
                    <code className="text-muted-foreground" role="gridcell">
                      {commit.hash.slice(0, 8)}
                    </code>
                  </article>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <RowContextMenuBody
                    canSelectRange={canSelectRange}
                    chips={chips}
                    commit={commit}
                    diffSelectedRange={selected ? commitsSelection : null}
                    index={index}
                    menus={menus}
                    openCommitDiff={openCommitDiff}
                    openRangeDiff={openRangeDiff}
                    selectCommit={selectCommit}
                    selectRangeTo={selectRangeTo}
                    selected={selected}
                    targetForRow={rowTarget}
                  />
                </ContextMenuContent>
              </ContextMenu>
            )
          })}
        </div>
      </div>
      {checkoutScrollDirection && (
        <Hinted hint={`Scroll ${checkoutScrollDirection} to current checkout`}>
          <Button
            className={`commit-graph-checkout-hint commit-graph-checkout-hint-${checkoutScrollDirection}`}
            onClick={scrollToCurrentCheckout}
            size="xs"
            type="button"
            variant="outline"
          >
            {checkoutScrollDirection === "up" ?
              <ArrowUp />
            : <ArrowDown />}
            Current checkout
          </Button>
        </Hinted>
      )}
      {selection && scroll.height > 0 && (
        <SelectionSheet
          bottomOffset={scroll.scrollbarHeight}
          canSelectCommit={canSelectCommitByHash}
          clearSelection={clearSelection}
          expanded={detailsExpanded}
          isRangeDragging={rangeDrag !== null}
          maxBodyHeight={Math.floor(scroll.height * 0.7)}
          menus={menus}
          narrow={scroll.width < NARROW_SHEET_PANEL_WIDTH}
          onExpandedChange={setDetailsExpanded}
          onPeekHeightChange={setSheetPeekHeight}
          openSelectionDiff={openSelectionDiff}
          repoPath={params.path}
          refreshKey={graphVersion}
          selectCommit={selectCommitByHash}
          selection={selection}
          tipCommit={
            selection.kind === "commits" ? null : commitByHash(selection.sha)
          }
        />
      )}
      {commits.length === 0 && !error && (
        <p className="commit-graph-status">Loading commits…</p>
      )}
      {error && (
        <p className="commit-graph-error" role="alert">
          {error}
        </p>
      )}
      <BranchCleanupDialog
        cleanOptions={cleanOptions}
        cleanup={cleanup}
        updateConfig={updateConfig}
        updateFilters={updateFilters}
      />
      {request && (
        <OperationDialog
          onClose={() => setRequest(null)}
          onCompleted={onOperationCompleted}
          onFailed={(message) => {
            setRequest(null)
            setError(message)
          }}
          repoPath={params.path}
          request={request}
        />
      )}
    </main>
  )
}
