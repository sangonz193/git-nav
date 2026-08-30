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
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@workspace/shadcn/components/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@workspace/shadcn/components/tooltip"
import type { IDockviewPanelProps } from "dockview-react"
import { AppWindow, Archive, ArrowDown, ArrowUp, Broom, ChevronDown, ChevronsDownUp, Cloud, CodeXml, Copy, ExternalLink, FileDiff, FilePen, FolderOpen, GitBranch, GitCompareArrows, LoaderCircle, RefreshCw, Search, SlidersHorizontal, Tag, Terminal, Undo2, X } from "lucide-react"
import { type CSSProperties, type ReactNode, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type TouchEvent as ReactTouchEvent, useCallback, useEffect, useMemo, useRef, useState } from "react"

import { drawCommitGraph } from "./commit-graph-canvas"
import { ancestryPath, chipLabel, chipName, clampGraphWidth, commitFromTuple, commitSelection, displayRefs, fitGraphWidth, GRAPH_CANVAS_OVERSCAN, GRAPH_HEADER_HEIGHT, GRAPH_WIDTH, graphCanvasHeight, isCurrentCheckout, laneColor, REF_BUDGET_SHARE, refName, refSelection, refSyncLabel, relativeDate, ROW_HEIGHT, splitRefLabel, syncDescription, worktreeChanges, worktreeDescription, unpushedHashes, unpushedLanes, visibleChipCount, type BranchSync, type RowWorktree, type Commit, type CommitBatch, type CommitSelection, type DisplayRef, type RowChip, type PendingOperation, type Selection, type SquashMergeInference, type StashEntry } from "./commit-graph"
import { appendGraphRows, CHIP_KIND_LABELS, commitChips, isMarkedCommit, rowIndexOfCommit, searchGraph, useViewConfig, type ChipContext, type ChipKind, type CleanOptions, type GraphRow, type GraphRows, type SearchHit } from "./commit-graph-view"
import { OperationDialog, OperationMenuItems } from "./commit-operation-menu"
import { clearConflictPredictions, type CompletedOperation, type OperationRequest, type RefMenuComponents, type RefUpdate, type RepositoryState } from "./commit-operations"
import { WORKTREE_REF, type RepositoryPanelParams } from "../repository/repository-window"
import type { Project, Worktree as ProjectWorktree } from "../repository/project"

const EMPTY_COMMITS: Commit[] = []
const PULL_REQUEST_SYNC_INTERVAL = 60_000
const BROWSER_GRAPH_WINDOW_SIZE = 2_000
const REPOSITORY_FINGERPRINT_INTERVAL = 1_500
const DRAG_THRESHOLD = 4
const AUTOSCROLL_EDGE = 24
const AUTOSCROLL_STEP = 18
const COARSE_POINTER_ROW_HEIGHT = 36
const UNDO_TIMEOUT = 30_000
const SEARCH_DEBOUNCE = 120
type BranchCleanup = { candidates: string[], deleted: string[], failed: string[] }
type BranchSelection = { baseSha: string, headSha: string, baseLabel: string, headLabel: string }
type CleanResult = { report: string } | { result: BranchCleanup }
type CleanupCandidate = { branch: string, reasons: CleanupReason[] }
type CleanupReason = "squashMergedPullRequest" | "mergedIntoDefaultBranch" | "squashedIntoDefaultBranch"
type RangeDrag = { anchorIndex: number, focusIndex: number }
type SelectedRef = { ref: DisplayRef, sha: string }
type SelectionRange = { anchorHash: string, focusHash: string }
type WorktreeStatus = { path: string, branch: string, head: string, isDetached: boolean, changedFiles: number, untrackedFiles: number, pendingOperation: PendingOperation | null }
type GraphWindowComplete = { hasMore: boolean }
const contextMenuComponents: RefMenuComponents = { Item: ContextMenuItem, Label: ContextMenuLabel, Separator: ContextMenuSeparator, Sub: ContextMenuSub, SubContent: ContextMenuSubContent, SubTrigger: ContextMenuSubTrigger }
const dropdownMenuComponents: RefMenuComponents = { Item: DropdownMenuItem, Label: DropdownMenuLabel, Separator: DropdownMenuSeparator, Sub: DropdownMenuSub, SubContent: DropdownMenuSubContent, SubTrigger: DropdownMenuSubTrigger }
const SELECTION_LABELS = { branch: "Branch", remote: "Remote branch", tag: "Tag" }
const CHIP_KINDS: ChipKind[] = ["branch", "remote", "tag", "stash"]
const CHIP_ICONS = { branch: GitBranch, remote: Cloud, stash: Archive, tag: Tag, worktree: AppWindow }
function Hinted({ children, hint }: { children: ReactNode, hint: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  )
}

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
  const [config, updateConfig] = useViewConfig()
  const cleanOptions = config.cleanOptions
  const [cleanPreview, setCleanPreview] = useState<CleanupCandidate[] | null>(null)
  const [cleanPreviewError, setCleanPreviewError] = useState<string | null>(null)
  const [request, setRequest] = useState<OperationRequest | null>(null)
  const [completed, setCompleted] = useState<CompletedOperation | null>(null)
  const [graphVersion, setGraphVersion] = useState(0)
  const [graphOffset, setGraphOffset] = useState(0)
  const [hasOlderCommits, setHasOlderCommits] = useState(false)
  const [isGraphWindowLoading, setIsGraphWindowLoading] = useState(false)
  const [projectWorktrees, setProjectWorktrees] = useState<ProjectWorktree[]>([])
  const [branchSync, setBranchSync] = useState<Map<string, BranchSync>>(new Map())
  const [worktreeStatuses, setWorktreeStatuses] = useState<WorktreeStatus[]>([])
  const [selectionRange, setSelectionRange] = useState<SelectionRange | null>(null)
  const [selectedRef, setSelectedRef] = useState<SelectedRef | null>(null)
  const [repository, setRepository] = useState<RepositoryState | null>(null)
  const [stashes, setStashes] = useState<StashEntry[]>([])
  const [rangeDrag, setRangeDrag] = useState<RangeDrag | null>(null)
  const [graphWidth, setGraphWidth] = useState(GRAPH_WIDTH)
  const [isResizingGraph, setIsResizingGraph] = useState(false)
  const [rowHeight, setRowHeight] = useState(ROW_HEIGHT)
  // A collapsed run is opened by the commit it starts at, which survives the refresh that rebuilds the runs.
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set())
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [searchInput, setSearchInput] = useState("")
  const [searchQuery, setSearchQuery] = useState("")
  const [searchHitIndex, setSearchHitIndex] = useState(0)
  const scrollElement = useRef<HTMLDivElement>(null)
  const graphSpace = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const searchField = useRef<HTMLInputElement>(null)
  const savedScrollTop = useRef(0)
  const refreshAnchor = useRef<{ hash: string; offset: number } | null>(null)
  const pendingScrollHash = useRef<string | null>(null)
  const commitsRef = useRef(commits)
  const rowsRef = useRef<GraphRow[] | null>(null)
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
    const row = Math.floor(scrollTop / rowHeight)
    const commit = commitsRef.current[rowsRef.current ? rowsRef.current[row]?.index ?? -1 : row]
    refreshAnchor.current = commit ? { hash: commit.hash, offset: scrollTop - row * rowHeight } : null
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
  // Refs share the commit column with the subject, which keeps whatever they do not take.
  const refBudget = table.getAllLeafColumns()[0].getSize() * REF_BUDGET_SHARE
  const tableWidth = graphWidth + table.getTotalSize()
  // Until the repository reports its remotes, refs are classified against the conventional one rather than
  // against none, which would read every remote branch as a local one. Repository state is re-read on a timer,
  // so the list is held by its contents: a fresh array each poll would redraw the whole graph.
  const remoteNames = repository?.remotes?.join("\n")
  const remotes = useMemo(() => remoteNames?.split("\n"), [remoteNames])
  const currentCheckoutIndex = useMemo(() => commits.findIndex((commit) => isCurrentCheckout(commit.refs)), [commits])
  // A worktree's name and openness come from the project snapshot while its uncommitted work and pending
  // operation come from its status, and the two only describe the same checkout once they are joined.
  const worktrees = useMemo(() => {
    const statuses = new Map(worktreeStatuses.map((status) => [status.path, status]))
    return projectWorktrees.map((worktree): RowWorktree => {
      const status = statuses.get(worktree.path)
      return {
        branch: worktree.isDetached ? null : worktree.branch,
        changedFiles: status?.changedFiles ?? 0,
        head: status?.head ?? worktree.head,
        isCurrent: worktree.path === params.path,
        isOpen: worktree.isOpen,
        name: worktree.name,
        path: worktree.path,
        pendingOperation: status?.pendingOperation ?? null,
        untrackedFiles: status?.untrackedFiles ?? 0,
      }
    })
  }, [params.path, projectWorktrees, worktreeStatuses])
  const worktreesByHead = useMemo(() => {
    const byHead = new Map<string, RowWorktree[]>()
    for (const worktree of worktrees) {
      byHead.set(worktree.head, [...(byHead.get(worktree.head) ?? []), worktree])
    }
    return byHead
  }, [worktrees])
  const commitsSelection = useMemo(() => {
    if (rangeDrag) {
      return commitSelection(commits, rangeDrag.anchorIndex, rangeDrag.focusIndex, remotes)
    }
    if (!selectionRange) {
      return null
    }
    const anchorIndex = commits.findIndex((commit) => commit.hash === selectionRange.anchorHash)
    const focusIndex = commits.findIndex((commit) => commit.hash === selectionRange.focusHash)
    return anchorIndex === -1 || focusIndex === -1 ? null : commitSelection(commits, anchorIndex, focusIndex, remotes)
  }, [commits, rangeDrag, remotes, selectionRange])
  // A ref selection outlives the graph it was made on, so it is re-read from the commit it sits on after every
  // refresh and falls back to what it was made from while the graph it belongs to is still streaming in.
  const selection = useMemo<Selection | null>(() => {
    if (!selectedRef) {
      return commitsSelection
    }
    const commit = commits.find((candidate) => candidate.hash === selectedRef.sha)
    const ref = commit && displayRefs(commit.refs, { branchSync, remotes, worktrees: worktreesByHead.get(selectedRef.sha) }).find((candidate) => refName(candidate) === refName(selectedRef.ref))
    return refSelection(ref ?? selectedRef.ref, selectedRef.sha)
  }, [branchSync, commits, commitsSelection, remotes, selectedRef, worktreesByHead])
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
  // A stash is drawn on the commit it was made from, which is the only place in the graph it belongs to.
  const stashesByBase = useMemo(() => {
    const byBase = new Map<string, StashEntry[]>()
    for (const entry of stashes) {
      if (entry.base) {
        byBase.set(entry.base, [...(byBase.get(entry.base) ?? []), entry])
      }
    }
    return byBase
  }, [stashes])
  const unpushed = useMemo(() => unpushedHashes(commits, remotes), [commits, remotes])
  const unpushedLaneMasks = useMemo(() => unpushedLanes(commits, unpushed), [commits, unpushed])
  const chipContext = useMemo<ChipContext>(
    () => ({ branchSync, chipKinds: config.chipKinds, remotes, stashesByBase, worktreesByHead }),
    [branchSync, config.chipKinds, remotes, stashesByBase, worktreesByHead]
  )
  // Worktrees and stashes are re-read on a timer and land as fresh maps every time, so what a run collapses
  // on is held by its contents. Rebuilding the rows for a poll that changed nothing would walk the whole
  // history every few seconds.
  const marksKey = useMemo(() => [
    remoteNames,
    CHIP_KINDS.filter((kind) => config.chipKinds[kind]).join(","),
    [...stashesByBase.keys()].sort().join(","),
    [...worktreesByHead.keys()].sort().join(","),
  ].join("|"), [config.chipKinds, remoteNames, stashesByBase, worktreesByHead])
  // Rows exist only while runs are being collapsed. Without them a row is a commit, which is what the rest of
  // the panel already reads its indexes as.
  const rowsCache = useRef<{ commits: Commit[], marksKey: string, revealed: ReadonlySet<string>, value: GraphRows } | null>(null)
  const rows = useMemo(() => {
    if (!config.collapseUnmarked) {
      rowsCache.current = null
      return null
    }
    const cache = rowsCache.current
    // A batch only ever adds to the end of the graph, so the rows already built stand and only the new tail
    // is scanned. Rebuilding them per batch would walk the whole history once for every five hundred commits.
    const continues = cache !== null
      && cache.marksKey === marksKey
      && cache.revealed === revealed
      && commits.length >= cache.commits.length
      && commits[cache.commits.length - 1] === cache.commits[cache.commits.length - 1]
    const value = appendGraphRows(continues ? cache.value : null, commits, (commit) => isMarkedCommit(commit, chipContext), (hash) => revealed.has(hash))
    rowsCache.current = { commits, marksKey, revealed, value }
    return value.rows
  }, [chipContext, commits, config.collapseUnmarked, marksKey, revealed])
  const searchHits = useMemo(
    () => isSearchOpen ? searchGraph(commits, searchQuery, { remotes, stashesByBase }) : [],
    [commits, isSearchOpen, remotes, searchQuery, stashesByBase]
  )
  const cleanCandidateCount = cleanPreview?.length ?? 0
  const rowCount = rows ? rows.length : commits.length
  const commitIndexAtRow = useCallback((row: number) => rows ? rows[row]?.index ?? 0 : row, [rows])
  const rowOfCommit = useCallback((index: number) => rows ? rowIndexOfCommit(rows, index) : index, [rows])
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollElement.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  })
  const virtualRows = rowVirtualizer.getVirtualItems()
  const currentCheckoutRow = currentCheckoutIndex === -1 ? -1 : rowOfCommit(currentCheckoutIndex)
  // The brackets are drawn on rows while the drag they adjust is anchored on commits, so an endpoint carries both.
  const selectionRowEdges = selectionEdges && {
    bottom: rowOfCommit(selectionEdges.bottom),
    bottomCommit: selectionEdges.bottom,
    top: rowOfCommit(selectionEdges.top),
    topCommit: selectionEdges.top,
  }
  const checkoutScrollDirection = currentCheckoutRow === -1 || scroll.height === 0
    ? null
    : (currentCheckoutRow + 1) * rowHeight < scroll.top + GRAPH_HEADER_HEIGHT
      ? "up"
      : currentCheckoutRow * rowHeight >= scroll.top + scroll.height
        ? "down"
        : null
  // The oldest unpushed commit is the top of the local segment, so it is the useful place to land.
  const oldestUnpushedIndex = useMemo(() => {
    for (let index = commits.length - 1; index >= 0; index -= 1) {
      if (unpushed.has(commits[index].hash)) {
        return index
      }
    }
    return -1
  }, [commits, unpushed])
  const squashMergeEdges = useMemo(() => {
    if (squashMergeInferences.length === 0) {
      return []
    }
    const indexes = new Map(commits.map((commit, index) => [commit.hash, index]))
    return squashMergeInferences.flatMap(([branchHash, targetHash]) => {
      const branchIndex = indexes.get(branchHash)
      const targetIndex = indexes.get(targetHash)
      if (branchIndex === undefined || targetIndex === undefined) {
        return []
      }
      return [{
        branchLane: commits[branchIndex].lane,
        branchRow: rowOfCommit(branchIndex),
        isLocal: unpushed.has(branchHash),
        targetLane: commits[targetIndex].lane,
        targetRow: rowOfCommit(targetIndex),
      }]
    })
  }, [commits, rowOfCommit, squashMergeInferences, unpushed])
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
      if (!Object.values(cleanOptions).some(Boolean)) {
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
    // The count stands until a newer one replaces it, so a refresh does not blank the badge on its way through.
    onMutate: () => setCleanPreviewError(null),
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
    rowsRef.current = rows
  }, [rows])

  // Opening a run moves every row below it, so the commit that asked for the scroll is followed to its new place.
  useEffect(() => {
    const hash = pendingScrollHash.current
    if (!hash) {
      return
    }
    const index = commits.findIndex((commit) => commit.hash === hash)
    if (index === -1) {
      return
    }
    pendingScrollHash.current = null
    rowVirtualizer.scrollToIndex(rowOfCommit(index), { align: "center" })
  }, [commits, rowOfCommit, rowVirtualizer])

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
    element.scrollTop = rowOfCommit(index) * rowHeight + anchor.offset
    refreshAnchor.current = null
  }, [commits, rowHeight, rowOfCommit])

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

  // The badge counts what the dialog would delete, so the candidates are read for the options in force and
  // re-read when the repository changes rather than on a timer of their own.
  useEffect(() => {
    previewCleanCandidates(cleanOptions)
  }, [cleanOptions, graphVersion, previewCleanCandidates])

  useEffect(() => {
    const timeout = window.setTimeout(() => setSearchQuery(searchInput), SEARCH_DEBOUNCE)
    return () => window.clearTimeout(timeout)
  }, [searchInput])

  useEffect(() => {
    setSearchHitIndex(0)
  }, [searchQuery])

  useEffect(() => {
    let disposed = false
    const refresh = () => {
      invoke<Project>("project_snapshot", { path: params.path })
        .then((project) => {
          if (!disposed) {
            setProjectWorktrees(project.worktrees.filter((worktree) => !worktree.isPrunable))
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
      drawCommitGraph({ canvas: canvas.current, commits, items: virtualRows, scrollTop: scroll.top - GRAPH_CANVAS_OVERSCAN, height: graphCanvasHeight(scroll.height), rows, squashMergeEdges, unpushed, unpushedLanes: unpushedLaneMasks, width: graphWidth, rowHeight })
    }
  }, [commits, graphWidth, rowHeight, rows, scroll, squashMergeEdges, unpushed, unpushedLaneMasks, virtualRows])

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
      scrollToCommit(oldestUnpushedIndex)
    }
  }

  // A commit inside a collapsed run has no row of its own, so the run it sits in is opened and the scroll
  // waits for the rows that opening it produces.
  function scrollToCommit(index: number) {
    const row = rowOfCommit(index)
    if (rows && rows[row]?.hidden > 0) {
      const start = commits[rows[row].index].hash
      pendingScrollHash.current = commits[index].hash
      setRevealed((current) => new Set(current).add(start))
      return
    }
    rowVirtualizer.scrollToIndex(row, { align: "center" })
  }

  function collapseUnmarkedCommits(collapse: boolean) {
    const top = commits[commitIndexAtRow(Math.floor((scrollElement.current?.scrollTop ?? 0) / rowHeight))]
    pendingScrollHash.current = top?.hash ?? null
    setRevealed(new Set())
    updateConfig({ collapseUnmarked: collapse })
  }

  function revealRun(startHash: string) {
    setRevealed((current) => new Set(current).add(startHash))
  }

  function openSearch() {
    setIsSearchOpen(true)
    requestAnimationFrame(() => searchField.current?.select())
  }

  function onPanelKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "f") {
      event.preventDefault()
      openSearch()
    }
  }

  function onSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      // The graph clears its selection on Escape, which is not what closing this bar is asking for.
      event.stopPropagation()
      setIsSearchOpen(false)
      return
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (searchHits.length === 0) {
        return
      }
      const step = event.key === "ArrowDown" ? 1 : searchHits.length - 1
      const next = (searchHitIndex + step) % searchHits.length
      setSearchHitIndex(next)
      activateSearchHit(searchHits[next])
      return
    }
    if (event.key === "Enter" && searchHits[searchHitIndex]) {
      event.preventDefault()
      activateSearchHit(searchHits[searchHitIndex])
      setIsSearchOpen(false)
    }
  }

  function activateSearchHit(hit: SearchHit) {
    const commit = commits[hit.commitIndex]
    if (!commit) {
      return
    }
    if (hit.kind === "commit" || hit.kind === "stash") {
      setSelectedRef(null)
      setSelectionRange({ anchorHash: commit.hash, focusHash: commit.hash })
    } else {
      const ref = displayRefs(commit.refs, { branchSync, remotes, worktrees: worktreesByHead.get(commit.hash) }).find((candidate) => refName(candidate) === hit.label)
      if (ref) {
        setSelectionRange(null)
        setSelectedRef({ ref, sha: commit.hash })
      }
    }
    scrollToCommit(hit.commitIndex)
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
    scrollToCommit(currentCheckoutIndex)
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
  function openWorktreeDiff(worktree: RowWorktree) {
    const referencePanel = containerApi.getPanel(api.id)
    if (!referencePanel) {
      setError("Could not open a working tree diff.")
      return
    }
    containerApi.addPanel({
      component: "diff",
      id: panelId("diff"),
      params: { ...params, path: worktree.path, baseRef: worktree.head, headRef: WORKTREE_REF },
      position: { direction: "within", referencePanel },
      title: `Uncommitted: ${worktree.name}`,
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
      return commitIndexAtRow(Math.max(0, Math.min(rowCount - 1, Math.floor(offset / rowHeight))))
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
        {menuHeader(components, reference, syncDescription(ref) ?? SELECTION_LABELS[ref.kind])}
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

  function stashMenuItems(entry: StashEntry, components: RefMenuComponents) {
    const { Item } = components
    return (
      <>
        {menuHeader(components, entry.name, entry.message)}
        <OperationMenuItems components={components} onSelect={setRequest} repository={repository} source={null} target={{ kind: "stash", entry }} />
        <Item onSelect={() => openStashDiff(entry)}>
          <FileDiff />
          Show stashed changes
        </Item>
      </>
    )
  }

  function stashMenuEntry(entry: StashEntry, components: RefMenuComponents) {
    const { Sub, SubContent, SubTrigger } = components
    return (
      <Sub key={entry.sha}>
        <SubTrigger>
          <span className="min-w-0 truncate">{`${entry.name}${entry.branch ? ` · ${entry.branch}` : ""}`}</span>
        </SubTrigger>
        <SubContent>{stashMenuItems(entry, components)}</SubContent>
      </Sub>
    )
  }

  function chipMenuItems(chip: RowChip, sha: string, components: RefMenuComponents) {
    if (chip.kind === "stash") {
      return stashMenuItems(chip.entry, components)
    }
    return chip.kind === "worktree" ? worktreeMenuItems(chip.worktree, components) : refMenuItems(chip.ref, sha, components)
  }

  function chipMenuEntry(chip: RowChip, sha: string, key: string, components: RefMenuComponents) {
    if (chip.kind === "stash") {
      return stashMenuEntry(chip.entry, components)
    }
    return chip.kind === "worktree" ? worktreeMenuEntry(chip.worktree, components) : refMenuEntry(chip.ref, sha, key, components)
  }

  function worktreeMarker(worktree: RowWorktree) {
    const changes = worktreeChanges(worktree)
    const classes = [
      "commit-ref-worktree",
      worktree.isOpen && "commit-ref-worktree-open",
      worktree.pendingOperation && "commit-ref-worktree-pending",
    ].filter(Boolean).join(" ")
    return (
      <span className={classes} key={worktree.path}>
        <span className="commit-ref-worktree-icon">
          <AppWindow />
        </span>
        {changes > 0 && (
          <span className="commit-ref-worktree-changes">
            <FilePen />
            <span className="commit-ref-worktree-count">{changes}</span>
          </span>
        )}
      </span>
    )
  }

  function worktreeOpenItems(worktree: RowWorktree, { Item, Sub, SubContent, SubTrigger }: RefMenuComponents) {
    return (
      <Sub>
        <SubTrigger>
          <ExternalLink />
          Open
        </SubTrigger>
        <SubContent>
          <Item onSelect={() => openWorktreeMutation.mutate({ path: worktree.path, target: "git-nav" })}>
            <AppWindow />
            Git Nav
          </Item>
          <Item onSelect={() => openWorktreeMutation.mutate({ path: worktree.path, target: "vscode" })}>
            <CodeXml />
            VS Code
          </Item>
          <Item onSelect={() => openWorktreeMutation.mutate({ path: worktree.path, target: "terminal" })}>
            <Terminal />
            Terminal
          </Item>
          <Item onSelect={() => openWorktreeMutation.mutate({ path: worktree.path, target: "finder" })}>
            <FolderOpen />
            Finder
          </Item>
        </SubContent>
      </Sub>
    )
  }

  function worktreeMenuItems(worktree: RowWorktree, components: RefMenuComponents) {
    const { Item } = components
    const changes = worktreeChanges(worktree)
    return (
      <>
        {menuHeader(components, worktree.name, worktreeDescription(worktree))}
        {changes > 0 && (
          <Item onSelect={() => openWorktreeDiff(worktree)}>
            <FileDiff />
            {`Show ${changes} uncommitted change${changes === 1 ? "" : "s"}`}
          </Item>
        )}
        {worktreeOpenItems(worktree, components)}
      </>
    )
  }

  function worktreeMenuEntry(worktree: RowWorktree, components: RefMenuComponents) {
    const { Sub, SubContent, SubTrigger } = components
    return (
      <Sub key={worktree.path}>
        <SubTrigger>{worktree.name}</SubTrigger>
        <SubContent>{worktreeMenuItems(worktree, components)}</SubContent>
      </Sub>
    )
  }

  function chipAriaLabel(chip: RowChip) {
    if (chip.kind === "stash") {
      return `Show the changes in ${chip.entry.name}`
    }
    if (chip.kind === "worktree") {
      const changes = worktreeChanges(chip.worktree)
      return changes > 0 ? `Show ${changes} uncommitted change${changes === 1 ? "" : "s"} in ${chip.worktree.name}` : `The ${chip.worktree.name} worktree`
    }
    return chip.ref.checkedOut ? "Currently checked out" : chip.ref.worktrees.length > 0 ? `Checked out in the ${chip.ref.worktrees[0].name} worktree` : undefined
  }

  function chipTitle(chip: RowChip) {
    if (chip.kind === "stash") {
      return [chip.entry.name, chip.entry.message, chip.entry.branch && `On ${chip.entry.branch}`].filter(Boolean).join("\n")
    }
    if (chip.kind === "worktree") {
      return worktreeDescription(chip.worktree)
    }
    return [chip.ref.label, syncDescription(chip.ref), ...chip.ref.worktrees.map(worktreeDescription)].filter(Boolean).join("\n")
  }

  function rowChip(chip: RowChip, sha: string, key?: string) {
    const Icon = CHIP_ICONS[chip.kind]
    const ref = chip.kind === "stash" || chip.kind === "worktree" ? null : chip.ref
    // A ref name is distinguished by its tail, so the middle of it goes first. A stash message and a worktree
    // name read the other way round and keep their opening characters instead.
    const { start, end } = ref ? splitRefLabel(ref.label) : { start: chipLabel(chip), end: "" }
    const sync = ref && refSyncLabel(ref)
    // A worktree holding no branch is a chip of its own; one holding a branch is a marker inside that chip.
    const chipWorktrees = chip.kind === "worktree" ? [chip.worktree] : ref?.worktrees ?? []
    const selected = ref !== null && selectedRef !== null && refName(selectedRef.ref) === refName(ref) && selectedRef.sha === sha
    // Neither a stash nor a worktree has a place in a selection, so their chips go straight to their changes.
    const activate = () => {
      if (chip.kind === "stash") {
        return openStashDiff(chip.entry)
      }
      if (chip.kind === "worktree") {
        return worktreeChanges(chip.worktree) > 0 ? openWorktreeDiff(chip.worktree) : undefined
      }
      return selectRef(chip.ref, sha)
    }
    return (
      <ContextMenu key={key}>
        <Tooltip>
          {/* Radix context menu triggers do not stop propagation, so the row menu would open on top of this one. */}
          <ContextMenuTrigger asChild onContextMenu={(event) => event.stopPropagation()}>
            <TooltipTrigger asChild>
              <button
            aria-label={chipAriaLabel(chip)}
            aria-pressed={ref === null ? undefined : selected}
            className={`commit-ref commit-ref-${chip.kind}${ref?.checkedOut ? " commit-ref-current" : ""}${chip.kind === "worktree" && !chip.worktree.branch ? " commit-ref-detached" : ""}${selected ? " commit-ref-selected" : ""}`}
            // Keyboard activation arrives as a click with no pointer behind it.
            onClick={(event) => event.detail === 0 && activate()}
            onPointerDown={(event) => {
              event.stopPropagation()
              // Acting on click would also answer the stray click a context menu leaves behind when it closes over this chip.
              if (event.button === 0) {
                activate()
              }
            }}
                type="button"
              >
            {ref?.checkedOut && <span className="commit-ref-head">HEAD</span>}
            {chipWorktrees.map(worktreeMarker)}
            <Icon />
            <span className="commit-ref-label">
              <span className="commit-ref-label-start">{start}</span>
              {end && <span className="commit-ref-label-end">{end}</span>}
            </span>
                {sync && <span className={`commit-ref-sync${ref?.sync?.isGone ? " commit-ref-sync-gone" : ""}`}>{sync}</span>}
              </button>
            </TooltipTrigger>
          </ContextMenuTrigger>
          <TooltipContent>{chipTitle(chip)}</TooltipContent>
        </Tooltip>
        <ContextMenuContent>{chipMenuItems(chip, sha, contextMenuComponents)}</ContextMenuContent>
      </ContextMenu>
    )
  }

  return (
    <main className="relative flex h-full flex-col overflow-hidden bg-background" onKeyDown={onPanelKeyDown}>
      <div className="flex items-center justify-between gap-1 border-b px-2 py-1">
        <div className="flex items-center gap-1">
          <DropdownMenu>
            <Tooltip>
              <DropdownMenuTrigger asChild>
                <TooltipTrigger asChild>
                  <Button size="sm" type="button" variant="outline">
                    <SlidersHorizontal />
                    View
                  </Button>
                </TooltipTrigger>
              </DropdownMenuTrigger>
              <TooltipContent>Choose what the graph shows</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Show</DropdownMenuLabel>
              {CHIP_KINDS.map((kind) => (
                <DropdownMenuCheckboxItem
                  checked={config.chipKinds[kind]}
                  key={kind}
                  onCheckedChange={(checked) => updateConfig({ chipKinds: { ...config.chipKinds, [kind]: checked === true } })}
                  onSelect={(event) => event.preventDefault()}
                >
                  {CHIP_KIND_LABELS[kind]}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={config.collapseUnmarked}
                onCheckedChange={(checked) => collapseUnmarkedCommits(checked === true)}
                onSelect={(event) => event.preventDefault()}
              >
                Collapse commits nothing points at
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Hinted hint="Find a branch, tag or commit">
            <Button aria-label="Search the graph" onClick={openSearch} size="icon-sm" type="button" variant="outline">
              <Search />
            </Button>
          </Hinted>
          {unpushed.size > 0 && (
            <Hinted hint="Scroll to the oldest commit that no remote has">
              <Button onClick={scrollToOldestUnpushed} size="sm" type="button" variant="outline">
                {`${unpushed.size} unpushed`}
              </Button>
            </Hinted>
          )}
        </div>
        <div className="flex items-center gap-1">
          {!isDesktop && graphOffset > 0 && (
            <Hinted hint="Show newer commits">
              <Button disabled={isGraphWindowLoading} onClick={() => showGraphWindow(Math.max(0, graphOffset - BROWSER_GRAPH_WINDOW_SIZE))} size="sm" type="button" variant="outline">
                Newer
              </Button>
            </Hinted>
          )}
          {!isDesktop && hasOlderCommits && (
            <Hinted hint="Show older commits">
              <Button disabled={isGraphWindowLoading} onClick={() => showGraphWindow(graphOffset + BROWSER_GRAPH_WINDOW_SIZE)} size="sm" type="button" variant="outline">
                Older
              </Button>
            </Hinted>
          )}
          <DropdownMenu>
            <Tooltip>
              <DropdownMenuTrigger asChild>
                <TooltipTrigger asChild>
                  <Button size="sm" type="button" variant="outline">
                    <Archive />
                    <span className="tabular-nums">{stashes.length > 0 ? stashes.length : "Stash"}</span>
                  </Button>
                </TooltipTrigger>
              </DropdownMenuTrigger>
              <TooltipContent>Stashed changes</TooltipContent>
            </Tooltip>
            <DropdownMenuContent>
              <OperationMenuItems components={dropdownMenuComponents} onSelect={setRequest} repository={repository} source={null} target={{ kind: "worktree" }} />
              {stashes.map((entry) => stashMenuEntry(entry, dropdownMenuComponents))}
              {stashes.length === 0 && !repository?.isDirty && <DropdownMenuItem disabled>Nothing is stashed</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
          <Hinted hint={cleanCandidateCount > 0 ? `${cleanCandidateCount} branch${cleanCandidateCount === 1 ? "" : "es"} can be cleaned` : "Clean merged branches"}>
            <Button aria-label="Clean merged branches" disabled={fetchMutation.isPending || cleanMutation.isPending} onClick={() => setIsCleanConfirmationOpen(true)} size="sm" type="button" variant="outline">
              {cleanMutation.isPending ? <LoaderCircle className="animate-spin" /> : <Broom />}
              {cleanCandidateCount > 0 && <span className="tabular-nums">{cleanCandidateCount}</span>}
            </Button>
          </Hinted>
          <ButtonGroup>
            <Hinted hint="Refresh graph">
              <Button aria-label="Refresh graph" disabled={fetchMutation.isPending || cleanMutation.isPending} onClick={() => refreshGraph()} size="icon-sm" type="button" variant="outline">
                {fetchMutation.isPending ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
              </Button>
            </Hinted>
            <DropdownMenu>
              <Tooltip>
                <DropdownMenuTrigger asChild>
                  <TooltipTrigger asChild>
                    <Button aria-label="Fetch options" className="w-6" disabled={fetchMutation.isPending || cleanMutation.isPending} size="icon-sm" type="button" variant="outline">
                      <ChevronDown />
                    </Button>
                  </TooltipTrigger>
                </DropdownMenuTrigger>
                <TooltipContent>Fetch options</TooltipContent>
              </Tooltip>
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
      {isSearchOpen && (
        <div className="absolute top-11 right-2 z-10 w-80 overflow-hidden rounded-lg border bg-background shadow-lg">
          <div className="flex items-center gap-1 border-b px-2 py-1">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              aria-label="Search refs and commits"
              className="h-7 min-w-0 flex-1 bg-transparent text-sm outline-none"
              onChange={(event) => setSearchInput(event.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Branch, tag or commit"
              ref={searchField}
              value={searchInput}
            />
            {searchHits.length > 0 && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{`${searchHitIndex + 1}/${searchHits.length}`}</span>}
            <Button aria-label="Close search" onClick={() => setIsSearchOpen(false)} size="icon-xs" type="button" variant="ghost">
              <X />
            </Button>
          </div>
          <ul className="max-h-64 overflow-y-auto p-1">
            {searchHits.map((hit, index) => {
              const Icon = hit.kind === "commit" ? GitCompareArrows : CHIP_ICONS[hit.kind]
              return (
                <li key={`${hit.kind}-${hit.commitIndex}-${hit.label}`}>
                  <button
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left ${index === searchHitIndex ? "bg-accent text-accent-foreground" : ""}`}
                    onClick={() => {
                      setSearchHitIndex(index)
                      activateSearchHit(hit)
                    }}
                    type="button"
                  >
                    <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{hit.label}</span>
                      <span className="block truncate text-xs text-muted-foreground">{hit.detail}</span>
                    </span>
                  </button>
                </li>
              )
            })}
            {searchQuery.trim() !== "" && searchHits.length === 0 && <li className="px-2 py-1 text-sm text-muted-foreground">No matches</li>}
          </ul>
        </div>
      )}
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
          </div>
        </div>
        <div className="commit-graph-space" ref={graphSpace} style={{ "--commit-ref-budget": `${refBudget}px`, height: rowVirtualizer.getTotalSize(), minWidth: tableWidth } as CSSProperties}>
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
                  style={{ gridTemplateColumns: `${graphWidth}px ${columnTemplate}`, transform: `translateY(${row.start}px)` }}
                >
                  <div className="commit-graph-graph-cell" />
                  <div role="gridcell">
                    <button className="commit-graph-collapsed-label" onClick={() => revealRun(commit.hash)} type="button">
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
            const canSelectRange = selectionEndpointIndexes && selectionEndpointIndexes.anchor !== -1 && ancestryPath(commits, selectionEndpointIndexes.anchor, index).length > 0
            const chips = commitChips(commit, chipContext)
            const shown = visibleChipCount(chips, refBudget)
            const overflowChips = chips.slice(shown)
            return (
              <ContextMenu key={commit.hash}>
                <ContextMenuTrigger asChild>
                  <article aria-keyshortcuts="Enter Space Shift+Enter Shift+Space" aria-rowindex={row.index + 2} aria-selected={selected} className={`commit-graph-row${currentCheckout ? " commit-graph-row-current" : ""}${selected ? " commit-graph-row-selected" : ""}`} onKeyDown={(event) => selectCommitFromKeyboard(event, index)} onPointerDown={(event) => startRangeDrag(event, index)} role="row" style={{ "--commit-ref-color": refColor, gridTemplateColumns: `${graphWidth}px ${columnTemplate}`, transform: `translateY(${row.start}px)` } as CSSProperties} tabIndex={0}>
                    <div className="commit-graph-graph-cell">
                      {edges?.top === row.index && (
                        <button aria-label="Adjust the newer end of the selected range" className="commit-graph-selection-handle commit-graph-selection-handle-start" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); startRangeDrag(event, index, edges.bottomCommit) }} type="button" />
                      )}
                      {edges?.bottom === row.index && (
                        <button aria-label="Adjust the older end of the selected range" className="commit-graph-selection-handle commit-graph-selection-handle-end" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); startRangeDrag(event, index, edges.topCommit) }} type="button" />
                      )}
                    </div>
                    <div className="commit-graph-summary" role="gridcell">
                  <div className="commit-graph-refs">
                    {chips.slice(0, shown).map((chip, index) => rowChip(chip, commit.hash, `${chipName(chip)}-${index}`))}
                    {overflowChips.length > 0 && (
                      <DropdownMenu>
                        <Tooltip>
                          <DropdownMenuTrigger asChild>
                            <TooltipTrigger asChild>
                              <button aria-label={`Show ${overflowChips.length} more ref${overflowChips.length === 1 ? "" : "s"}`} className="commit-ref commit-ref-more" onPointerDown={(event) => event.stopPropagation()} type="button">
                                {`+${overflowChips.length}`}
                              </button>
                            </TooltipTrigger>
                          </DropdownMenuTrigger>
                          <TooltipContent>{overflowChips.map(chipLabel).join("\n")}</TooltipContent>
                        </Tooltip>
                        <DropdownMenuContent>
                          {overflowChips.map((chip, index) => chipMenuEntry(chip, commit.hash, `${chipName(chip)}-${index}`, dropdownMenuComponents))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                  <span className={`min-w-0 flex-1 truncate ${currentCheckout ? "font-bold" : "font-normal"}`}>{commit.subject || "(no subject)"}</span>
                </div>
                <span className="text-muted-foreground" role="gridcell">{commit.author}</span>
                <time className="text-muted-foreground" dateTime={commit.date} role="gridcell">{relativeDate(commit.date)}</time>
                <code className="text-muted-foreground" role="gridcell">{commit.hash.slice(0, 8)}</code>
                  </article>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  {menuHeader(contextMenuComponents, rowHeader(index), commit.subject || "(no subject)")}
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
                  <OperationMenuItems components={contextMenuComponents} onSelect={setRequest} repository={repository} source={selection} target={rowTarget(index)} />
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
                  {chips.length === 1 && chipMenuEntry(chips[0], commit.hash, chipName(chips[0]), contextMenuComponents)}
                  {chips.length > 1 && (
                    <ContextMenuSub>
                      <ContextMenuSubTrigger>
                        <GitBranch />
                        Refs
                      </ContextMenuSubTrigger>
                      <ContextMenuSubContent>
                        {chips.map((chip, index) => chipMenuEntry(chip, commit.hash, `${chipName(chip)}-${index}`, contextMenuComponents))}
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
        <Hinted hint={`Scroll ${checkoutScrollDirection} to current checkout`}>
          <Button className={`commit-graph-checkout-hint commit-graph-checkout-hint-${checkoutScrollDirection}`} onClick={scrollToCurrentCheckout} size="xs" type="button" variant="outline">
            {checkoutScrollDirection === "up" ? <ArrowUp /> : <ArrowDown />}
            Current checkout
          </Button>
        </Hinted>
      )}
      {selection && (
        <div className="commit-graph-selection-bar">
          <span className="commit-graph-selection-summary">{selectionSummary(selection)}</span>
          {selection.kind === "commits"
            ? (
              <Hinted hint="Diff the selected range">
                <Button disabled={!selection.base} onClick={() => openRangeDiff(selection)} size="xs" type="button" variant="outline">
                  <FileDiff />
                  Diff
                </Button>
              </Hinted>
            )
            : (
              <Hinted hint={`Diff ${refName(selection.ref)} against the default branch`}>
                <Button onClick={() => openRefDiff(refName(selection.ref))} size="xs" type="button" variant="outline">
                  <FileDiff />
                  Diff
                </Button>
              </Hinted>
            )}
          <Hinted hint="Clear the selection">
            <Button onClick={clearSelection} size="xs" type="button" variant="ghost">
              <X />
              Clear
            </Button>
          </Hinted>
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
              <input checked={cleanOptions.deleteMergedPullRequestBranches} className="mt-0.5 size-4 accent-primary" onChange={(event) => updateConfig({ cleanOptions: { ...cleanOptions, deleteMergedPullRequestBranches: event.target.checked } })} type="checkbox" />
              <span>Delete branches whose merged pull request head matches the local tip.</span>
            </label>
            <label className="flex items-start gap-2">
              <input checked={cleanOptions.deleteMergedBranches} className="mt-0.5 size-4 accent-primary" onChange={(event) => updateConfig({ cleanOptions: { ...cleanOptions, deleteMergedBranches: event.target.checked } })} type="checkbox" />
              <span>Delete branches with no commits ahead of the default branch that are not checked out in any worktree.</span>
            </label>
            <label className="flex items-start gap-2">
              <input checked={cleanOptions.deleteSquashMergedBranches} className="mt-0.5 size-4 accent-primary" onChange={(event) => updateConfig({ cleanOptions: { ...cleanOptions, deleteSquashMergedBranches: event.target.checked } })} type="checkbox" />
              <span>Delete branches whose changes already sit on the default branch as one squashed commit, matched by content rather than by a record of the merge.</span>
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
                  ["Squashed into the default branch", "squashedIntoDefaultBranch"],
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
