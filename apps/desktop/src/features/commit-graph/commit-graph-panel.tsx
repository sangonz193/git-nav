import { columnResizingFeature, columnSizingFeature, createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useMutation } from "@tanstack/react-query"
import { invoke, isDesktop, stream } from "@/lib/ipc"
import { panelId } from "@/lib/panel-id"
import { openWorktree, type WorktreeTarget } from "@/lib/navigation"
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@workspace/shadcn/components/alert-dialog"
import { Button } from "@workspace/shadcn/components/button"
import { ButtonGroup } from "@workspace/shadcn/components/button-group"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger } from "@workspace/shadcn/components/context-menu"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@workspace/shadcn/components/dropdown-menu"
import type { IDockviewPanelProps } from "dockview-react"
import { AppWindow, Archive, ArrowDown, ArrowUp, Broom, ChevronDown, CodeXml, Copy, ExternalLink, FileDiff, FilePen, FolderOpen, GitBranch, GitCompareArrows, LoaderCircle, RefreshCw, Tag, Terminal, Undo2, X } from "lucide-react"
import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type TouchEvent as ReactTouchEvent, useCallback, useEffect, useMemo, useRef, useState } from "react"

import { drawCommitGraph } from "./commit-graph-canvas"
import { ancestryPath, clampGraphWidth, commitFromTuple, commitSelection, displayRefs, fitGraphWidth, GRAPH_CANVAS_OVERSCAN, GRAPH_HEADER_HEIGHT, GRAPH_WIDTH, graphCanvasHeight, isCurrentCheckout, laneColor, refKind, refName, refSelection, refSyncLabel, relativeDate, ROW_HEIGHT, splitRefLabel, syncDescription, unpushedHashes, unpushedLanes, type BranchSync, type CheckedOutWorktree, type Commit, type CommitBatch, type CommitSelection, type DisplayRef, type Selection, type SquashMergeInference } from "./commit-graph"
import { OperationDialog, OperationMenuItems } from "./commit-operation-menu"
import { clearConflictPredictions, PENDING_OPERATION_LABELS, type CompletedOperation, type OperationRequest, type PendingOperation, type RefMenuComponents, type RefUpdate, type RepositoryState, type StashEntry } from "./commit-operations"
import { WORKTREE_REF, type RepositoryPanelParams } from "../repository/repository-window"
import type { Project } from "../repository/project"

const EMPTY_COMMITS: Commit[] = []
const PULL_REQUEST_SYNC_INTERVAL = 60_000
const BROWSER_GRAPH_WINDOW_SIZE = 2_000
const REPOSITORY_FINGERPRINT_INTERVAL = 1_500
const DRAG_THRESHOLD = 4
const AUTOSCROLL_EDGE = 24
const AUTOSCROLL_STEP = 18
const COARSE_POINTER_ROW_HEIGHT = 36
const UNDO_TIMEOUT = 30_000
type BranchCleanup = { candidates: string[], deleted: string[], failed: string[] }
type BranchSelection = { baseSha: string, headSha: string, baseLabel: string, headLabel: string }
type CleanOptions = { deleteMergedPullRequestBranches: boolean, deleteMergedBranches: boolean }
type CleanResult = { report: string } | { result: BranchCleanup }
type CleanupCandidate = { branch: string, reasons: CleanupReason[] }
type CleanupReason = "squashMergedPullRequest" | "mergedIntoDefaultBranch"
type RangeDrag = { anchorIndex: number, focusIndex: number }
type SelectedRef = { ref: DisplayRef, sha: string }
type SelectionRange = { anchorHash: string, focusHash: string }
type WorktreeStatus = { path: string, branch: string, head: string, isDetached: boolean, changedFiles: number, untrackedFiles: number, pendingOperation: PendingOperation | null }
type GraphWindowComplete = { hasMore: boolean }
type ViewMode = "graph" | "branches"
const contextMenuComponents: RefMenuComponents = { Item: ContextMenuItem, Label: ContextMenuLabel, Separator: ContextMenuSeparator, Sub: ContextMenuSub, SubContent: ContextMenuSubContent, SubTrigger: ContextMenuSubTrigger }
const dropdownMenuComponents: RefMenuComponents = { Item: DropdownMenuItem, Label: DropdownMenuLabel, Separator: DropdownMenuSeparator, Sub: DropdownMenuSub, SubContent: DropdownMenuSubContent, SubTrigger: DropdownMenuSubTrigger }
const SELECTION_LABELS = { branch: "Branch", remote: "Remote branch", tag: "Tag" }
const commitTableFeatures = tableFeatures({ columnSizingFeature, columnResizingFeature })
const commitColumnHelper = createColumnHelper<typeof commitTableFeatures, Commit>()
const commitColumns = commitColumnHelper.columns([
  commitColumnHelper.accessor("subject", { header: "Commit", maxSize: 1_600, minSize: 400, size: 920 }),
  commitColumnHelper.accessor("author", { header: "Author", maxSize: 360, minSize: 100, size: 180 }),
  commitColumnHelper.accessor("date", { header: "Date", maxSize: 180, minSize: 80, size: 110 }),
  commitColumnHelper.accessor("hash", { header: "Commit", maxSize: 160, minSize: 68, size: 84 }),
])

export function CommitGraphPanel({ api, containerApi, params }: IDockviewPanelProps<RepositoryPanelParams>) {
  const [commits, setCommits] = useState<Commit[]>([])
  const [squashMergeInferences, setSquashMergeInferences] = useState<SquashMergeInference[]>([])
  const [error, setError] = useState<string | null>(null)
  const [cleanupReport, setCleanupReport] = useState<string | null>(null)
  const [isCleanConfirmationOpen, setIsCleanConfirmationOpen] = useState(false)
  const [cleanOptions, setCleanOptions] = useState<CleanOptions>({ deleteMergedPullRequestBranches: true, deleteMergedBranches: false })
  const [cleanPreview, setCleanPreview] = useState<CleanupCandidate[] | null>(null)
  const [cleanPreviewError, setCleanPreviewError] = useState<string | null>(null)
  const [request, setRequest] = useState<OperationRequest | null>(null)
  const [completed, setCompleted] = useState<CompletedOperation | null>(null)
  const [graphVersion, setGraphVersion] = useState(0)
  const [graphOffset, setGraphOffset] = useState(0)
  const [hasOlderCommits, setHasOlderCommits] = useState(false)
  const [isGraphWindowLoading, setIsGraphWindowLoading] = useState(false)
  const [checkedOutWorktrees, setCheckedOutWorktrees] = useState<CheckedOutWorktree[]>([])
  const [branchSync, setBranchSync] = useState<Map<string, BranchSync>>(new Map())
  const [worktreeStatuses, setWorktreeStatuses] = useState<WorktreeStatus[]>([])
  const [selectionRange, setSelectionRange] = useState<SelectionRange | null>(null)
  const [selectedRef, setSelectedRef] = useState<SelectedRef | null>(null)
  const [repository, setRepository] = useState<RepositoryState | null>(null)
  const [stashes, setStashes] = useState<StashEntry[]>([])
  const [rangeDrag, setRangeDrag] = useState<RangeDrag | null>(null)
  const [graphWidth, setGraphWidth] = useState(GRAPH_WIDTH)
  const [isResizingGraph, setIsResizingGraph] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>("graph")
  const [rowHeight, setRowHeight] = useState(ROW_HEIGHT)
  const scrollElement = useRef<HTMLDivElement>(null)
  const graphSpace = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const savedScrollTop = useRef(0)
  const refreshAnchor = useRef<{ hash: string; offset: number } | null>(null)
  const commitsRef = useRef(commits)
  const fingerprint = useRef<string | null>(null)
  const fingerprintGeneration = useRef(0)
  const isScrollElementVisible = useRef(false)
  const [scroll, setScroll] = useState({ top: 0, height: 0 })
  const scrollFrame = useRef<number | null>(null)
  const refreshGraph = useCallback((clearReport = true) => {
    setError(null)
    if (clearReport) {
      setCleanupReport(null)
    }
    const scrollTop = scrollElement.current?.scrollTop ?? savedScrollTop.current
    const index = Math.floor(scrollTop / rowHeight)
    const commit = commitsRef.current[index]
    refreshAnchor.current = commit ? { hash: commit.hash, offset: scrollTop - index * rowHeight } : null
    // The next poll adopts whatever the re-stream lands on rather than refreshing again on top of it.
    fingerprint.current = null
    fingerprintGeneration.current += 1
    setGraphOffset(0)
    setGraphVersion((version) => version + 1)
  }, [rowHeight])
  // HEAD moves with every commit, so these markers stay anchored to a stale commit until the refs are re-read.
  const refreshWorktreeStatus = useCallback(() => {
    invoke<WorktreeStatus[]>("worktree_status", { repoPath: params.path })
      .then(setWorktreeStatuses)
      .catch(() => undefined)
    invoke<RepositoryState>("repository_state", { repoPath: params.path })
      .then(setRepository)
      .catch(() => undefined)
    invoke<StashEntry[]>("stash_list", { repoPath: params.path })
      .then(setStashes)
      .catch(() => undefined)
  }, [params.path])
  const table = useTable({
    columnResizeMode: "onChange",
    data: EMPTY_COMMITS,
    features: commitTableFeatures,
    columns: commitColumns,
  })
  const columnTemplate = table.getAllLeafColumns().map((column) => `${column.getSize()}px`).join(" ")
  const tableWidth = viewMode === "graph" ? graphWidth + table.getTotalSize() : graphWidth
  const rowVirtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => scrollElement.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  })
  const virtualRows = rowVirtualizer.getVirtualItems()
  const currentCheckoutIndex = useMemo(() => commits.findIndex((commit) => isCurrentCheckout(commit.refs)), [commits])
  const checkoutScrollDirection = currentCheckoutIndex === -1 || scroll.height === 0
    ? null
    : (currentCheckoutIndex + 1) * rowHeight < scroll.top + GRAPH_HEADER_HEIGHT
      ? "up"
      : currentCheckoutIndex * rowHeight >= scroll.top + scroll.height
        ? "down"
        : null
  const commitsSelection = useMemo(() => {
    if (rangeDrag) {
      return commitSelection(commits, rangeDrag.anchorIndex, rangeDrag.focusIndex)
    }
    if (!selectionRange) {
      return null
    }
    const anchorIndex = commits.findIndex((commit) => commit.hash === selectionRange.anchorHash)
    const focusIndex = commits.findIndex((commit) => commit.hash === selectionRange.focusHash)
    return anchorIndex === -1 || focusIndex === -1 ? null : commitSelection(commits, anchorIndex, focusIndex)
  }, [commits, rangeDrag, selectionRange])
  // A ref selection outlives the graph it was made on, so it is re-read from the commit it sits on after every
  // refresh and falls back to what it was made from while the graph it belongs to is still streaming in.
  const selection = useMemo<Selection | null>(() => {
    if (!selectedRef) {
      return commitsSelection
    }
    const commit = commits.find((candidate) => candidate.hash === selectedRef.sha)
    const ref = commit && displayRefs(commit.refs, checkedOutWorktrees, branchSync).find((candidate) => refName(candidate) === refName(selectedRef.ref))
    return refSelection(ref ?? selectedRef.ref, selectedRef.sha)
  }, [branchSync, checkedOutWorktrees, commits, commitsSelection, selectedRef])
  const selectedHashes = useMemo(() => new Set(commitsSelection?.commits.map((commit) => commit.hash)), [commitsSelection])
  const selectionEndpointIndexes = useMemo(() => selectionRange
    ? { anchor: commits.findIndex((commit) => commit.hash === selectionRange.anchorHash), focus: commits.findIndex((commit) => commit.hash === selectionRange.focusHash) }
    : null, [commits, selectionRange])
  // The dragged end can be either the newer or the older one, so the brackets follow the rows, not the anchor.
  // A drag in flight is read from the drag itself, so the bracket stays under the pointer moving it.
  const selectionEdges = useMemo(() => {
    if (!commitsSelection) {
      return null
    }
    const ends = rangeDrag
      ? { anchor: rangeDrag.anchorIndex, focus: rangeDrag.focusIndex }
      : selectionEndpointIndexes
    if (!ends || ends.anchor === -1 || ends.focus === -1) {
      return null
    }
    return { top: Math.min(ends.anchor, ends.focus), bottom: Math.max(ends.anchor, ends.focus) }
  }, [commitsSelection, rangeDrag, selectionEndpointIndexes])
  const unpushed = useMemo(() => unpushedHashes(commits), [commits])
  const unpushedLaneMasks = useMemo(() => unpushedLanes(commits, unpushed), [commits, unpushed])
  // The oldest unpushed commit is the top of the local segment, so it is the useful place to land.
  const oldestUnpushedIndex = useMemo(() => {
    for (let index = commits.length - 1; index >= 0; index -= 1) {
      if (unpushed.has(commits[index].hash)) {
        return index
      }
    }
    return -1
  }, [commits, unpushed])
  const worktreeStatusesByHead = useMemo(() => {
    const byHead = new Map<string, WorktreeStatus[]>()
    for (const status of worktreeStatuses) {
      if (status.changedFiles + status.untrackedFiles === 0 && !status.pendingOperation) {
        continue
      }
      byHead.set(status.head, [...(byHead.get(status.head) ?? []), status])
    }
    return byHead
  }, [worktreeStatuses])
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
  const fetchMutation = useMutation({
    mutationFn: () => invoke("fetch_and_sync_pull_requests", { repoPath: params.path }),
    onMutate: () => {
      setError(null)
      setCleanupReport(null)
    },
    onSuccess: () => refreshGraph(),
    onError: (message) => setError(String(message)),
  })
  const cleanMutation = useMutation({
    mutationFn: async (): Promise<CleanResult> => {
      if (!cleanOptions.deleteMergedPullRequestBranches && !cleanOptions.deleteMergedBranches) {
        return { report: "Select at least one cleanup option." }
      }
      return { result: await invoke<BranchCleanup>("delete_squashed_branches", { repoPath: params.path, options: cleanOptions }) }
    },
    onMutate: () => {
      setError(null)
      setCleanupReport(null)
    },
    onSuccess: (outcome) => {
      setIsCleanConfirmationOpen(false)
      if ("report" in outcome) {
        setCleanupReport(outcome.report)
        return
      }
      const { result } = outcome
      const details = [
        result.deleted.length ? `Deleted ${result.deleted.length} merged PR branch${result.deleted.length === 1 ? "" : "es"}.` : null,
        result.failed.length ? `Could not delete: ${result.failed.join(", ")}` : null,
        !result.deleted.length && !result.failed.length ? "No branches were deleted because the candidate list changed." : null,
      ].filter(Boolean)
      setCleanupReport(details.join("\n"))
      refreshGraph(false)
    },
    onError: (message) => setError(String(message)),
  })
  const { isPending: isCleanPreviewPending, mutate: previewCleanCandidates } = useMutation({
    mutationFn: (options: CleanOptions) => invoke<CleanupCandidate[]>("preview_cleanup_candidates", { repoPath: params.path, options }),
    onMutate: () => {
      setCleanPreview(null)
      setCleanPreviewError(null)
    },
    onSuccess: setCleanPreview,
    onError: (message) => setCleanPreviewError(String(message)),
  })
  const openWorktreeMutation = useMutation({
    mutationFn: ({ path, target }: { path: string, target: WorktreeTarget }) => openWorktree(path, target),
    onError: (message) => setError(String(message)),
  })
  const undoMutation = useMutation({
    mutationFn: (updates: RefUpdate[]) => invoke("undo_ref_updates", { repoPath: params.path, updates }),
    onSuccess: () => {
      setCompleted(null)
      refreshGraph()
    },
    onError: (message) => setError(String(message)),
  })

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
    let disposed = false
    let inferenceInterval: number | null = null
    let inferenceTimeout: number | null = null
    setCommits([])
    setHasOlderCommits(false)
    setIsGraphWindowLoading(true)
    function refreshSquashMergeInferences() {
      invoke<SquashMergeInference[]>("inferred_squash_merge_edges", { repoPath: params.path })
        .then(setSquashMergeInferences)
        .catch(() => undefined)
    }
    function scheduleSquashMergeInferences() {
      if (inferenceTimeout !== null || inferenceInterval !== null) {
        return
      }
      inferenceTimeout = window.setTimeout(() => {
        inferenceTimeout = null
        refreshSquashMergeInferences()
        inferenceInterval = window.setInterval(refreshSquashMergeInferences, PULL_REQUEST_SYNC_INTERVAL)
      })
    }

    if (graphOffset === 0) {
      invoke<BranchSync[]>("branch_sync", { repoPath: params.path })
        .then((entries) => {
          if (!disposed) {
            setBranchSync(new Map(entries.map((entry) => [entry.branch, entry])))
          }
        })
        .catch(() => undefined)
    }
    const stopStream = stream<CommitBatch>(
      "stream_commit_graph",
      isDesktop
        ? { repoPath: params.path }
        : { repoPath: params.path, offset: graphOffset, limit: BROWSER_GRAPH_WINDOW_SIZE },
      (batch) => {
        if (!disposed) {
          setCommits((existing) => existing.concat(batch.map(commitFromTuple)))
          if (graphOffset === 0) {
            scheduleSquashMergeInferences()
          }
        }
      },
      (message) => {
        if (!disposed) {
          setError(message)
          setIsGraphWindowLoading(false)
        }
      },
      (data) => {
        if (!disposed) {
          if (!isDesktop && typeof data === "object" && data !== null && "hasMore" in data) {
            setHasOlderCommits((data as GraphWindowComplete).hasMore)
          }
          setIsGraphWindowLoading(false)
        }
      }
    )
    return () => {
      disposed = true
      stopStream()
      if (inferenceTimeout !== null) {
        window.clearTimeout(inferenceTimeout)
      }
      if (inferenceInterval !== null) {
        window.clearInterval(inferenceInterval)
      }
    }
  }, [graphOffset, graphVersion, params.path, refreshWorktreeStatus])

  useEffect(() => {
    const query = window.matchMedia("(pointer: coarse)")
    const updateRowHeight = () => setRowHeight(query.matches ? COARSE_POINTER_ROW_HEIGHT : ROW_HEIGHT)
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
    let disposed = false
    const poll = () => {
      const generation = fingerprintGeneration.current
      return invoke<string>("repository_fingerprint", { repoPath: params.path })
        .then((value) => {
          // A refresh that started while this was in flight already invalidated the answer.
          if (disposed || generation !== fingerprintGeneration.current) {
            return
          }
          if (fingerprint.current !== null && fingerprint.current !== value) {
            refreshGraph(false)
          }
          fingerprint.current = value
        })
        .catch(() => undefined)
    }

    poll()
    const interval = window.setInterval(poll, REPOSITORY_FINGERPRINT_INTERVAL)
    window.addEventListener("focus", poll)
    return () => {
      disposed = true
      window.clearInterval(interval)
      window.removeEventListener("focus", poll)
    }
  }, [params.path, refreshGraph])

  useEffect(() => {
    const anchor = refreshAnchor.current
    const element = scrollElement.current
    if (!anchor || !element) {
      return
    }
    const index = commits.findIndex((commit) => commit.hash === anchor.hash)
    if (index === -1) {
      return
    }
    element.scrollTop = index * rowHeight + anchor.offset
    refreshAnchor.current = null
  }, [commits])

  useEffect(() => {
    if (!cleanupReport) {
      return
    }
    const timeout = window.setTimeout(() => setCleanupReport(null), 6_000)
    return () => window.clearTimeout(timeout)
  }, [cleanupReport])

  useEffect(() => {
    if (!completed) {
      return
    }
    const timeout = window.setTimeout(() => setCompleted(null), UNDO_TIMEOUT)
    return () => window.clearTimeout(timeout)
  }, [completed])

  useEffect(() => {
    if (isCleanConfirmationOpen) {
      previewCleanCandidates(cleanOptions)
    }
  }, [cleanOptions, isCleanConfirmationOpen, previewCleanCandidates])

  useEffect(() => {
    let disposed = false
    const refresh = () => {
      invoke<Project>("project_snapshot", { path: params.path })
        .then((project) => {
          if (!disposed) {
            setCheckedOutWorktrees(project.worktrees
              .filter((worktree) => worktree.path !== params.path && !worktree.isPrunable && !worktree.isDetached)
              .map(({ branch, name, path, isOpen }) => ({ branch, name, path, isOpen })))
          }
        })
        .catch((message: unknown) => setError(String(message)))
      refreshWorktreeStatus()
    }

    refresh()
    window.addEventListener("focus", refresh)
    const interval = window.setInterval(refresh, 10_000)
    return () => {
      disposed = true
      window.removeEventListener("focus", refresh)
      window.clearInterval(interval)
    }
  }, [params.path, refreshWorktreeStatus])

  useEffect(() => {
    if (!selection) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearSelection()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [selection])

  useEffect(() => {
    if (canvas.current) {
      drawCommitGraph({ canvas: canvas.current, commits, items: virtualRows, scrollTop: scroll.top - GRAPH_CANVAS_OVERSCAN, height: graphCanvasHeight(scroll.height), squashMergeEdges, unpushed, unpushedLanes: unpushedLaneMasks, width: graphWidth, rowHeight })
    }
  }, [commits, graphWidth, scroll, squashMergeEdges, unpushed, unpushedLaneMasks, virtualRows])

  function startGraphResize(event: ReactMouseEvent<HTMLElement> | ReactTouchEvent<HTMLElement>) {
    const originX = "touches" in event ? event.touches[0].clientX : event.clientX
    const originWidth = graphWidth
    setIsResizingGraph(true)

    const onMove = (moveEvent: MouseEvent | TouchEvent) => {
      const clientX = "touches" in moveEvent ? moveEvent.touches[0]?.clientX : moveEvent.clientX
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

  function scrollToOldestUnpushed() {
    if (oldestUnpushedIndex !== -1) {
      rowVirtualizer.scrollToIndex(oldestUnpushedIndex, { align: "center" })
    }
  }

  function showGraphWindow(offset: number) {
    setSelectedRef(null)
    setSelectionRange(null)
    setGraphOffset(offset)
    rowVirtualizer.scrollToIndex(0)
  }

  function scrollToCurrentCheckout() {
    if (currentCheckoutIndex === -1) {
      return
    }
    rowVirtualizer.scrollToIndex(currentCheckoutIndex, { align: "center" })
  }

  async function openRefDiff(reference: string) {
    try {
      const selection = await invoke<BranchSelection>("select_branch_range", { repoPath: params.path, reference })
      const referencePanel = containerApi.getPanel(api.id)
      if (!referencePanel) {
        throw new Error("Could not open a diff tab.")
      }
      containerApi.addPanel({
        component: "diff",
        id: panelId("diff"),
        params: { ...params, baseRef: selection.baseSha, headRef: selection.headSha },
        position: { direction: "within", referencePanel },
        title: `Diff: ${reference}`,
      })
    } catch (message) {
      setError(String(message))
    }
  }

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value)
    } catch (message) {
      setError(String(message))
    }
  }

  function openCommitDiff(commit: Commit) {
    const baseRef = commit.parents[0]
    const referencePanel = containerApi.getPanel(api.id)
    if (!baseRef || !referencePanel) {
      setError("Could not open a commit diff.")
      return
    }
    containerApi.addPanel({
      component: "diff",
      id: panelId("diff"),
      params: { ...params, baseRef, headRef: commit.hash },
      position: { direction: "within", referencePanel },
      title: `Diff: ${commit.hash.slice(0, 8)}`,
    })
  }

  // The diff is scoped to the dirty worktree, which is not always the one this panel was opened on.
  function openWorktreeDiff(status: WorktreeStatus, name: string) {
    const referencePanel = containerApi.getPanel(api.id)
    if (!referencePanel) {
      setError("Could not open a working tree diff.")
      return
    }
    containerApi.addPanel({
      component: "diff",
      id: panelId("diff"),
      params: { ...params, path: status.path, baseRef: status.head, headRef: WORKTREE_REF },
      position: { direction: "within", referencePanel },
      title: `Uncommitted: ${name}`,
    })
  }

  // A stash entry records the working tree against the commit it was made from, which is its first parent.
  function openStashDiff(entry: StashEntry) {
    const referencePanel = containerApi.getPanel(api.id)
    if (!referencePanel) {
      setError("Could not open a stash diff.")
      return
    }
    containerApi.addPanel({
      component: "diff",
      id: panelId("diff"),
      params: { ...params, baseRef: `${entry.sha}^`, headRef: entry.sha },
      position: { direction: "within", referencePanel },
      title: `Stash: ${entry.name}`,
    })
  }

  function openRangeDiff({ base, tip }: CommitSelection) {
    const referencePanel = containerApi.getPanel(api.id)
    if (!base || !referencePanel) {
      setError("Could not open a range diff.")
      return
    }
    containerApi.addPanel({
      component: "diff",
      id: panelId("diff"),
      params: { ...params, baseRef: base.hash, headRef: tip.hash },
      position: { direction: "within", referencePanel },
      title: `Diff: ${base.hash.slice(0, 8)}..${tip.hash.slice(0, 8)}`,
    })
  }

  function selectionSummary(selection: Selection) {
    return selection.kind === "commits"
      ? `${selection.commits.length} commit${selection.commits.length === 1 ? "" : "s"}${selection.branches[0] ? ` · ${selection.branches[0].branch}` : ""}`
      : `${SELECTION_LABELS[selection.kind]} · ${refName(selection.ref)}`
  }

  function clearSelection() {
    setSelectionRange(null)
    setSelectedRef(null)
  }

  function selectRef(ref: DisplayRef, sha: string) {
    setSelectionRange(null)
    setSelectedRef((current) => current && refName(current.ref) === refName(ref) && current.sha === sha ? null : { ref, sha })
  }

  function onOperationCompleted(result: CompletedOperation) {
    setRequest(null)
    setCompleted(result)
    clearConflictPredictions()
    refreshWorktreeStatus()
    refreshGraph()
  }

  function rowHeader(index: number) {
    const target = rowTarget(index)
    return target.commits.length === 1 ? target.tip.hash.slice(0, 8) : `${target.commits.length} commits`
  }

  // Right-clicking inside the selection keeps it whole, and right-clicking outside it acts on the row under the pointer.
  function rowTarget(index: number) {
    return selectedHashes.has(commits[index].hash) && commitsSelection ? commitsSelection : commitSelection(commits, index, index)!
  }

  function startRangeDrag(event: ReactPointerEvent<HTMLElement>, index: number, anchorIndex?: number) {
    const scroll = scrollElement.current
    const space = graphSpace.current
    if (event.button !== 0 || !scroll || !space || (event.target as HTMLElement).closest(".commit-ref")) {
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
    setSelectedRef(null)
    const selectionAnchorIndex = anchorIndex ?? (event.shiftKey && selectionRange
      ? commits.findIndex((commit) => commit.hash === selectionRange.anchorHash)
      : index)
    const rangeAnchorIndex = selectionAnchorIndex === -1 ? index : selectionAnchorIndex
    const originX = event.clientX
    const originY = event.clientY
    let pointerY = event.clientY
    let dragging = false
    let frame: number | null = null

    const focusIndexAt = () => {
      const offset = pointerY - space.getBoundingClientRect().top
      return Math.max(0, Math.min(commits.length - 1, Math.floor(offset / rowHeight)))
    }

    const autoScroll = () => {
      const rect = scroll.getBoundingClientRect()
      // The sticky header covers the top row of the scroll box.
      const overTop = pointerY - (rect.top + GRAPH_HEADER_HEIGHT + AUTOSCROLL_EDGE)
      const overBottom = pointerY - (rect.bottom - AUTOSCROLL_EDGE)
      const distance = overTop < 0 ? overTop : overBottom > 0 ? overBottom : 0
      if (distance !== 0) {
        scroll.scrollTop += Math.max(-AUTOSCROLL_STEP, Math.min(AUTOSCROLL_STEP, distance))
        setRangeDrag({ anchorIndex: rangeAnchorIndex, focusIndex: focusIndexAt() })
      }
      frame = requestAnimationFrame(autoScroll)
    }

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== event.pointerId) {
        return
      }
      pointerY = moveEvent.clientY
      if (!dragging) {
        if (Math.abs(moveEvent.clientX - originX) < DRAG_THRESHOLD && Math.abs(moveEvent.clientY - originY) < DRAG_THRESHOLD) {
          return
        }
        dragging = true
        window.getSelection()?.removeAllRanges()
        frame = requestAnimationFrame(autoScroll)
      }
      setRangeDrag({ anchorIndex: rangeAnchorIndex, focusIndex: focusIndexAt() })
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
        setSelectionRange({ anchorHash: commits[rangeAnchorIndex].hash, focusHash: commits[focusIndex].hash })
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

  function selectCommitFromKeyboard(event: ReactKeyboardEvent<HTMLElement>, index: number) {
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) {
      return
    }
    event.preventDefault()
    const anchorIndex = event.shiftKey && selectionRange
      ? commits.findIndex((commit) => commit.hash === selectionRange.anchorHash)
      : index
    const rangeAnchorIndex = anchorIndex === -1 ? index : anchorIndex
    if (ancestryPath(commits, rangeAnchorIndex, index).length > 0) {
      setSelectedRef(null)
      setSelectionRange({ anchorHash: commits[rangeAnchorIndex].hash, focusHash: commits[index].hash })
    }
  }

  function menuHeader({ Label, Separator }: RefMenuComponents, name: string, detail?: string | null) {
    return (
      <>
        <Label>
          <span className="block max-w-64 truncate text-foreground">{name}</span>
          {detail && <span className="block max-w-64 truncate font-normal">{detail}</span>}
        </Label>
        <Separator />
      </>
    )
  }

  function refMenuItems(ref: DisplayRef, sha: string, components: RefMenuComponents) {
    const { Item, Sub, SubContent, SubTrigger } = components
    const reference = refName(ref)
    return (
      <>
        {menuHeader(components, reference, syncDescription(ref) ?? SELECTION_LABELS[refKind(ref)])}
        <OperationMenuItems components={components} onSelect={setRequest} repository={repository} source={selection} target={refSelection(ref, sha)} />
        <Item onSelect={() => openRefDiff(reference)}>
          <GitCompareArrows />
          {`Compare with ${repository?.defaultBranch ?? "the default branch"}`}
        </Item>
        <Item onSelect={() => copyText(reference)}>
          <Copy />
          Copy ref name
        </Item>
        {ref.worktrees.length > 0 && (
          <Sub>
            <SubTrigger>
              <ExternalLink />
              Open
            </SubTrigger>
            <SubContent>
              {ref.worktrees.flatMap((worktree) => {
                const suffix = ref.worktrees.length > 1 ? ` (${worktree.name})` : ""
                return [
                  <Item key={`${worktree.path}-git-nav`} onSelect={() => openWorktreeMutation.mutate({ path: worktree.path, target: "git-nav" })}>
                    <AppWindow />
                    {`Git Nav${suffix}`}
                  </Item>,
                  <Item key={`${worktree.path}-vscode`} onSelect={() => openWorktreeMutation.mutate({ path: worktree.path, target: "vscode" })}>
                    <CodeXml />
                    {`VS Code${suffix}`}
                  </Item>,
                  <Item key={`${worktree.path}-terminal`} onSelect={() => openWorktreeMutation.mutate({ path: worktree.path, target: "terminal" })}>
                    <Terminal />
                    {`Terminal${suffix}`}
                  </Item>,
                  <Item key={`${worktree.path}-finder`} onSelect={() => openWorktreeMutation.mutate({ path: worktree.path, target: "finder" })}>
                    <FolderOpen />
                    {`Finder${suffix}`}
                  </Item>,
                ]
              })}
            </SubContent>
          </Sub>
        )}
      </>
    )
  }

  function refMenuEntry(ref: DisplayRef, sha: string, key: string, components: RefMenuComponents) {
    const { Item, Sub, SubContent, SubTrigger } = components
    return (
      <Sub key={key}>
        <SubTrigger>{ref.label}</SubTrigger>
        <SubContent>
          <Item onSelect={() => selectRef(ref, sha)}>
            <GitBranch />
            {`Select ${refName(ref)}`}
          </Item>
          {refMenuItems(ref, sha, components)}
        </SubContent>
      </Sub>
    )
  }

  function stashMenuEntry(entry: StashEntry, components: RefMenuComponents) {
    const { Item, Sub, SubContent, SubTrigger } = components
    return (
      <Sub key={entry.sha}>
        <SubTrigger>
          <span className="min-w-0 truncate">{`${entry.name}${entry.branch ? ` · ${entry.branch}` : ""}`}</span>
        </SubTrigger>
        <SubContent>
          {menuHeader(components, entry.name, entry.message)}
          <OperationMenuItems components={components} onSelect={setRequest} repository={repository} source={null} target={{ kind: "stash", entry }} />
          <Item onSelect={() => openStashDiff(entry)}>
            <FileDiff />
            Show stashed changes
          </Item>
        </SubContent>
      </Sub>
    )
  }

  function worktreeChips(hash: string) {
    return (worktreeStatusesByHead.get(hash) ?? []).flatMap((status) => {
      const name = status.path.split("/").pop() ?? status.path
      const changes = status.changedFiles + status.untrackedFiles
      const details = [status.changedFiles && `${status.changedFiles} changed`, status.untrackedFiles && `${status.untrackedFiles} untracked`].filter(Boolean).join(", ")
      return [
        changes > 0 && (
          <button
            aria-label={`Show ${changes} uncommitted change${changes === 1 ? "" : "s"} in ${name}`}
            className="commit-ref commit-ref-changes"
            key={`${status.path}-changes`}
            onClick={() => openWorktreeDiff(status, name)}
            onPointerDown={(event) => event.stopPropagation()}
            title={`${name}: ${details}`}
            type="button"
          >
            <FilePen />
            {changes}
          </button>
        ),
        status.pendingOperation && (
          <span
            className="commit-ref commit-ref-operation"
            key={`${status.path}-operation`}
            title={`${name} is ${PENDING_OPERATION_LABELS[status.pendingOperation]}`}
          >
            {PENDING_OPERATION_LABELS[status.pendingOperation]}
          </span>
        ),
      ].filter(Boolean)
    })
  }

  function refChip(ref: DisplayRef, sha: string, key?: string) {
    const { start, end } = splitRefLabel(ref.label)
    const sync = refSyncLabel(ref)
    const kind = refKind(ref)
    const [worktree] = ref.worktrees
    const selected = selectedRef !== null && refName(selectedRef.ref) === refName(ref) && selectedRef.sha === sha
    return (
      <ContextMenu key={key}>
        {/* Radix context menu triggers do not stop propagation, so the row menu would open on top of this one. */}
        <ContextMenuTrigger asChild onContextMenu={(event) => event.stopPropagation()}>
          <button
            aria-label={ref.checkedOut ? "Currently checked out" : ref.worktrees.length ? "Checked out in another worktree" : undefined}
            aria-pressed={selected}
            className={`commit-ref commit-ref-${kind}${ref.checkedOut ? " commit-ref-current" : ""}${selected ? " commit-ref-selected" : ""}`}
            // Keyboard activation arrives as a click with no pointer behind it.
            onClick={(event) => event.detail === 0 && selectRef(ref, sha)}
            onPointerDown={(event) => {
              event.stopPropagation()
              // Selecting on click would also answer the stray click a context menu leaves behind when it closes over this chip.
              if (event.button === 0) {
                selectRef(ref, sha)
              }
            }}
            title={[ref.label, syncDescription(ref), ...ref.worktrees.map((worktree) => `${worktree.isOpen ? "Open in" : "Checked out at"} ${worktree.name}`)].filter(Boolean).join("\n")}
            type="button"
          >
            {ref.checkedOut && <span className="commit-ref-head">HEAD</span>}
            {!ref.checkedOut && worktree && <span className="commit-ref-worktree">{worktree.name}</span>}
            {kind === "tag" && <Tag />}
            <span className="commit-ref-label">
              <span className="commit-ref-label-start">{start}</span>
              {end && <span className="commit-ref-label-end">{end}</span>}
            </span>
            {sync && <span className={`commit-ref-sync${ref.sync?.isGone ? " commit-ref-sync-gone" : ""}`}>{sync}</span>}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>{refMenuItems(ref, sha, contextMenuComponents)}</ContextMenuContent>
      </ContextMenu>
    )
  }

  return (
    <main className="relative flex h-full flex-col overflow-hidden bg-background">
      <div className="flex items-center justify-between gap-1 border-b px-2 py-1">
        <ButtonGroup aria-label="View mode">
          <Button aria-pressed={viewMode === "graph"} onClick={() => setViewMode("graph")} size="sm" type="button" variant={viewMode === "graph" ? "outline" : "ghost"}>
            Graph
          </Button>
          <Button aria-pressed={viewMode === "branches"} onClick={() => setViewMode("branches")} size="sm" type="button" variant={viewMode === "branches" ? "outline" : "ghost"}>
            Branches
          </Button>
        </ButtonGroup>
        <div className="flex items-center gap-1">
          {unpushed.size > 0 && (
            <Button onClick={scrollToOldestUnpushed} size="sm" title="Scroll to the oldest commit that no remote has" type="button" variant="ghost">
              {`${unpushed.size} unpushed`}
            </Button>
          )}
          {!isDesktop && graphOffset > 0 && (
            <Button disabled={isGraphWindowLoading} onClick={() => showGraphWindow(Math.max(0, graphOffset - BROWSER_GRAPH_WINDOW_SIZE))} size="sm" title="Show newer commits" type="button" variant="ghost">
              Newer
            </Button>
          )}
          {!isDesktop && hasOlderCommits && (
            <Button disabled={isGraphWindowLoading} onClick={() => showGraphWindow(graphOffset + BROWSER_GRAPH_WINDOW_SIZE)} size="sm" title="Show older commits" type="button" variant="ghost">
              Older
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" title="Stashed changes" type="button" variant="ghost">
                <Archive />
                {stashes.length > 0 ? stashes.length : "Stash"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <OperationMenuItems components={dropdownMenuComponents} onSelect={setRequest} repository={repository} source={null} target={{ kind: "worktree" }} />
              {stashes.map((entry) => stashMenuEntry(entry, dropdownMenuComponents))}
              {stashes.length === 0 && !repository?.isDirty && <DropdownMenuItem disabled>Nothing is stashed</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button aria-label="Clean merged branches" disabled={fetchMutation.isPending || cleanMutation.isPending} onClick={() => setIsCleanConfirmationOpen(true)} size="icon" title="Clean merged branches" type="button" variant="ghost">
            {cleanMutation.isPending ? <LoaderCircle className="animate-spin" /> : <Broom />}
          </Button>
          <ButtonGroup>
            <Button aria-label="Refresh graph" disabled={fetchMutation.isPending || cleanMutation.isPending} onClick={() => refreshGraph()} size="icon" title="Refresh graph" type="button" variant="ghost">
              {fetchMutation.isPending ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button aria-label="Fetch options" className="w-6" disabled={fetchMutation.isPending || cleanMutation.isPending} size="icon" title="Fetch options" type="button" variant="ghost">
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem disabled={fetchMutation.isPending} onSelect={() => fetchMutation.mutate()}>
                  <RefreshCw />
                  Fetch from origin
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </ButtonGroup>
        </div>
      </div>
      <div aria-label="Commit history. Click a commit to select it. Shift-click, or press Shift+Enter or Shift+Space, to extend the selection through related commits." aria-multiselectable className={`commit-graph-scroll${rangeDrag ? " is-selecting" : ""}${rangeDrag && !selection ? " is-unrelated" : ""}`} onScroll={onScroll} ref={scrollElement} role="grid" style={{ "--commit-row-height": `${rowHeight}px`, "--graph-width": `${graphWidth}px` } as CSSProperties}>
        <div className="commit-graph-header">
          <div className="commit-graph-header-content" role="row" style={{ minWidth: tableWidth }}>
            <div className="commit-graph-header-spacer" role="columnheader">
              Graph
              <div
                aria-label="Resize Graph column"
                className={`commit-graph-resize-handle${isResizingGraph ? " is-resizing" : ""}`}
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
            {viewMode === "graph" ? (
              <div className="commit-graph-header-columns" style={{ gridTemplateColumns: columnTemplate }}>
                {table.getFlatHeaders().map((header) => (
                  <div className="commit-graph-header-cell" key={header.id} role="columnheader">
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
            ) : <div className="commit-graph-header-cell" role="columnheader">Branches</div>}
          </div>
        </div>
        <div className="commit-graph-space" ref={graphSpace} style={{ height: rowVirtualizer.getTotalSize(), minWidth: tableWidth }}>
          <canvas aria-hidden className="commit-graph-canvas" ref={canvas} />
          {virtualRows.map((row) => {
            const commit = commits[row.index]
            const refColor = laneColor(commit.lane)
            const currentCheckout = isCurrentCheckout(commit.refs)
            const selected = selectedHashes.has(commit.hash)
            const edges = selectionEdges
            const canSelectRange = selectionEndpointIndexes && selectionEndpointIndexes.anchor !== -1 && ancestryPath(commits, selectionEndpointIndexes.anchor, row.index).length > 0
            const refs = displayRefs(commit.refs, checkedOutWorktrees, branchSync)
            const [primaryRef, ...overflowRefs] = refs
            return (
              <ContextMenu key={commit.hash}>
                <ContextMenuTrigger asChild>
                  <article aria-keyshortcuts="Enter Space Shift+Enter Shift+Space" aria-rowindex={row.index + 2} aria-selected={selected} className={`commit-graph-row${viewMode === "branches" ? " commit-graph-row-branches" : ""}${currentCheckout ? " commit-graph-row-current" : ""}${selected ? " commit-graph-row-selected" : ""}`} onKeyDown={(event) => selectCommitFromKeyboard(event, row.index)} onPointerDown={(event) => startRangeDrag(event, row.index)} role="row" style={{ "--commit-ref-color": refColor, gridTemplateColumns: `${graphWidth}px ${viewMode === "graph" ? columnTemplate : "max-content"}`, transform: `translateY(${row.start}px)` } as CSSProperties} tabIndex={0}>
                    <div className="commit-graph-graph-cell">
                      {edges?.top === row.index && (
                        <button aria-label="Adjust the newer end of the selected range" className="commit-graph-selection-handle commit-graph-selection-handle-start" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); startRangeDrag(event, row.index, edges.bottom) }} type="button" />
                      )}
                      {edges?.bottom === row.index && (
                        <button aria-label="Adjust the older end of the selected range" className="commit-graph-selection-handle commit-graph-selection-handle-end" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); startRangeDrag(event, row.index, edges.top) }} type="button" />
                      )}
                    </div>
                    <div className="commit-graph-summary" role="gridcell">
                  <div className="commit-graph-refs">
                    {viewMode === "branches" ? refs.map((ref, index) => refChip(ref, commit.hash, `${ref.label}-${index}`)) : primaryRef && refChip(primaryRef, commit.hash)}
                    {viewMode === "graph" && overflowRefs.length > 0 && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button className="commit-ref" onPointerDown={(event) => event.stopPropagation()} title={overflowRefs.map((ref) => ref.label).join("\n")} type="button">
                            {`+${overflowRefs.length}`}
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          {overflowRefs.map((ref, index) => refMenuEntry(ref, commit.hash, `${ref.label}-${index}`, dropdownMenuComponents))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                    {worktreeChips(commit.hash)}
                  </div>
                  {viewMode === "graph" && <span className={`min-w-0 flex-1 truncate ${currentCheckout ? "font-bold" : "font-normal"}`}>{commit.subject || "(no subject)"}</span>}
                </div>
                {viewMode === "graph" && <>
                  <span className="truncate text-muted-foreground" role="gridcell">{commit.author}</span>
                  <time className="text-muted-foreground" dateTime={commit.date} role="gridcell">{relativeDate(commit.date)}</time>
                  <code className="text-muted-foreground" role="gridcell">{commit.hash.slice(0, 8)}</code>
                </>}
                  </article>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  {menuHeader(contextMenuComponents, rowHeader(row.index), commit.subject || "(no subject)")}
                  <ContextMenuItem onSelect={() => { setSelectedRef(null); setSelectionRange({ anchorHash: commit.hash, focusHash: commit.hash }) }}>
                    <GitCompareArrows />
                    Select commit
                  </ContextMenuItem>
                  {canSelectRange && selectionEndpointIndexes && (
                    <ContextMenuItem onSelect={() => { setSelectedRef(null); setSelectionRange({ anchorHash: commits[selectionEndpointIndexes.anchor].hash, focusHash: commit.hash }) }}>
                      <GitCompareArrows />
                      Select range to here
                    </ContextMenuItem>
                  )}
                  <OperationMenuItems components={contextMenuComponents} onSelect={setRequest} repository={repository} source={selection} target={rowTarget(row.index)} />
                  <ContextMenuItem disabled={commit.parents.length === 0} onSelect={() => openCommitDiff(commit)}>
                    <FileDiff />
                    Show commit diff
                  </ContextMenuItem>
                  {selected && commitsSelection && commitsSelection.commits.length > 1 && (
                    <ContextMenuItem disabled={!commitsSelection.base} onSelect={() => openRangeDiff(commitsSelection)}>
                      <GitCompareArrows />
                      Diff selected range
                    </ContextMenuItem>
                  )}
                  {refs.length === 1 && refMenuEntry(refs[0], commit.hash, refs[0].label, contextMenuComponents)}
                  {refs.length > 1 && (
                    <ContextMenuSub>
                      <ContextMenuSubTrigger>
                        <GitBranch />
                        Refs
                      </ContextMenuSubTrigger>
                      <ContextMenuSubContent>
                        {refs.map((ref, index) => refMenuEntry(ref, commit.hash, `${ref.label}-${index}`, contextMenuComponents))}
                      </ContextMenuSubContent>
                    </ContextMenuSub>
                  )}
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => copyText(commit.hash)}>
                    <Copy />
                    Copy SHA
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => copyText(commit.subject)}>
                    <Copy />
                    Copy commit subject
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            )
          })}
        </div>
      </div>
      {checkoutScrollDirection && (
        <Button className={`commit-graph-checkout-hint commit-graph-checkout-hint-${checkoutScrollDirection}`} onClick={scrollToCurrentCheckout} size="xs" title={`Scroll ${checkoutScrollDirection} to current checkout`} type="button" variant="outline">
          {checkoutScrollDirection === "up" ? <ArrowUp /> : <ArrowDown />}
          Current checkout
        </Button>
      )}
      {selection && (
        <div className="commit-graph-selection-bar">
          <span className="commit-graph-selection-summary">{selectionSummary(selection)}</span>
          {selection.kind === "commits"
            ? (
              <Button disabled={!selection.base} onClick={() => openRangeDiff(selection)} size="xs" title="Diff the selected range" type="button" variant="outline">
                <FileDiff />
                Diff
              </Button>
            )
            : (
              <Button onClick={() => openRefDiff(refName(selection.ref))} size="xs" title={`Diff ${refName(selection.ref)} against the default branch`} type="button" variant="outline">
                <FileDiff />
                Diff
              </Button>
            )}
          <Button onClick={clearSelection} size="xs" title="Clear the selection" type="button" variant="ghost">
            <X />
            Clear
          </Button>
        </div>
      )}
      {commits.length === 0 && !error && <p className="commit-graph-status">Loading commits…</p>}
      {error && <p className="commit-graph-error" role="alert">{error}</p>}
      {cleanupReport && <p className="commit-graph-cleanup-report">{cleanupReport}</p>}
      {completed && (
        <div className="commit-graph-cleanup-report flex items-center gap-3">
          <span>{completed.summary}</span>
          {completed.updates.length > 0 && (
            <Button disabled={undoMutation.isPending} onClick={() => undoMutation.mutate(completed.updates)} size="xs" type="button" variant="outline">
              <Undo2 />
              {undoMutation.isPending ? "Undoing…" : "Undo"}
            </Button>
          )}
        </div>
      )}
      <AlertDialog onOpenChange={setIsCleanConfirmationOpen} open={isCleanConfirmationOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clean merged branches?</AlertDialogTitle>
            <AlertDialogDescription>Selected local branches will be permanently deleted.</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-3 text-sm">
            <label className="flex items-start gap-2">
              <input checked={cleanOptions.deleteMergedPullRequestBranches} className="mt-0.5 size-4 accent-primary" onChange={(event) => setCleanOptions((options) => ({ ...options, deleteMergedPullRequestBranches: event.target.checked }))} type="checkbox" />
              <span>Delete branches whose merged pull request head matches the local tip.</span>
            </label>
            <label className="flex items-start gap-2">
              <input checked={cleanOptions.deleteMergedBranches} className="mt-0.5 size-4 accent-primary" onChange={(event) => setCleanOptions((options) => ({ ...options, deleteMergedBranches: event.target.checked }))} type="checkbox" />
              <span>Delete branches with no commits ahead of the default branch that are not checked out in any worktree.</span>
            </label>
          </div>
          <div className="max-h-52 overflow-y-auto rounded-lg border p-3 text-sm">
            {isCleanPreviewPending && <p className="text-muted-foreground">Finding branches to clean…</p>}
            {cleanPreviewError && <p className="text-destructive">{cleanPreviewError}</p>}
            {cleanPreview?.length === 0 && <p className="text-muted-foreground">No branches match the selected cleanup options.</p>}
            {cleanPreview && cleanPreview.length > 0 && (
              <div className="grid gap-3">
                {[
                  ["Squash-merged pull requests", "squashMergedPullRequest"],
                  ["Merged into the default branch", "mergedIntoDefaultBranch"],
                ].map(([label, reason]) => {
                  const candidates = cleanPreview.filter((candidate) => candidate.reasons.includes(reason as CleanupReason))
                  return candidates.length === 0 ? null : (
                    <section className="grid gap-1" key={reason}>
                      <h3 className="font-medium">{label}</h3>
                      <ul className="font-mono text-xs text-muted-foreground">
                        {candidates.map((candidate) => <li key={candidate.branch}>{candidate.branch}</li>)}
                      </ul>
                    </section>
                  )
                })}
              </div>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cleanMutation.isPending}>Cancel</AlertDialogCancel>
            <Button disabled={cleanMutation.isPending || !cleanPreview || cleanPreview.length === 0 || Boolean(cleanPreviewError)} onClick={() => cleanMutation.mutate()} type="button" variant="destructive">
              {cleanMutation.isPending ? "Cleaning…" : "Clean branches"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
