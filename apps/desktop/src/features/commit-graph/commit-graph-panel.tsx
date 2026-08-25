import { columnResizingFeature, columnSizingFeature, createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useMutation } from "@tanstack/react-query"
import { Channel, invoke } from "@tauri-apps/api/core"
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@workspace/shadcn/components/alert-dialog"
import { Button } from "@workspace/shadcn/components/button"
import { ButtonGroup } from "@workspace/shadcn/components/button-group"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger } from "@workspace/shadcn/components/context-menu"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@workspace/shadcn/components/dropdown-menu"
import type { IDockviewPanelProps } from "dockview-react"
import { AppWindow, ArrowDown, ArrowUp, Broom, ChevronDown, CodeXml, Copy, ExternalLink, FileDiff, FolderOpen, GitBranch, GitCompareArrows, LoaderCircle, RefreshCw, Terminal, Trash2, TriangleAlert, Undo2, X } from "lucide-react"
import { type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type TouchEvent as ReactTouchEvent, useCallback, useEffect, useMemo, useRef, useState } from "react"

import { drawCommitGraph } from "./commit-graph-canvas"
import { ancestryPath, clampGraphWidth, commitFromTuple, commitSelection, displayRefs, fitGraphWidth, GRAPH_COLORS, GRAPH_HEADER_HEIGHT, GRAPH_WIDTH, graphCanvasHeight, isCurrentCheckout, refName, relativeDate, ROW_HEIGHT, splitRefLabel, type CheckedOutWorktree, type Commit, type CommitBatch, type CommitSelection, type DisplayRef, type SquashMergeInference } from "./commit-graph"
import { OperationMenuItems, type OperationPlan, type RebaseResult, type RefMenuComponents, type RefUpdate } from "./commit-operations"
import type { RepositoryPanelParams } from "../repository/repository-window"
import type { Project } from "../repository/project"

const EMPTY_COMMITS: Commit[] = []
const PULL_REQUEST_SYNC_INTERVAL = 60_000
const DRAG_THRESHOLD = 4
const AUTOSCROLL_EDGE = 24
const AUTOSCROLL_STEP = 18
const REBASE_UNDO_TIMEOUT = 30_000
type BranchCleanup = { candidates: string[], deleted: string[], failed: string[] }
type BranchSelection = { baseSha: string, headSha: string, baseLabel: string, headLabel: string }
type CleanOptions = { deleteMergedPullRequestBranches: boolean, deleteMergedBranches: boolean }
type CleanResult = { report: string } | { result: BranchCleanup }
type CleanupCandidate = { branch: string, reasons: CleanupReason[] }
type CleanupReason = "squashMergedPullRequest" | "mergedIntoDefaultBranch"
type RangeDrag = { anchorIndex: number, focusIndex: number }
type RebaseUndo = { branch: string, onto: string, updates: RefUpdate[] }
type SelectionRange = { anchorHash: string, focusHash: string }
type WorktreeTarget = "git-nav" | "vscode" | "terminal" | "finder"
const contextMenuComponents: RefMenuComponents = { Item: ContextMenuItem, Sub: ContextMenuSub, SubContent: ContextMenuSubContent, SubTrigger: ContextMenuSubTrigger }
const dropdownMenuComponents: RefMenuComponents = { Item: DropdownMenuItem, Sub: DropdownMenuSub, SubContent: DropdownMenuSubContent, SubTrigger: DropdownMenuSubTrigger }
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
  const [branchToDelete, setBranchToDelete] = useState<string | null>(null)
  const [rebasePlan, setRebasePlan] = useState<OperationPlan | null>(null)
  const [rebaseUndo, setRebaseUndo] = useState<RebaseUndo | null>(null)
  const [graphVersion, setGraphVersion] = useState(0)
  const [checkedOutWorktrees, setCheckedOutWorktrees] = useState<CheckedOutWorktree[]>([])
  const [selectionRange, setSelectionRange] = useState<SelectionRange | null>(null)
  const [rangeDrag, setRangeDrag] = useState<RangeDrag | null>(null)
  const [graphWidth, setGraphWidth] = useState(GRAPH_WIDTH)
  const [isResizingGraph, setIsResizingGraph] = useState(false)
  const scrollElement = useRef<HTMLDivElement>(null)
  const graphSpace = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const savedScrollTop = useRef(0)
  const refreshAnchor = useRef<{ hash: string; offset: number } | null>(null)
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
  const tableWidth = graphWidth + table.getTotalSize()
  const rowVirtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => scrollElement.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })
  const virtualRows = rowVirtualizer.getVirtualItems()
  const currentCheckoutIndex = useMemo(() => commits.findIndex((commit) => isCurrentCheckout(commit.refs)), [commits])
  const checkoutScrollDirection = currentCheckoutIndex === -1 || scroll.height === 0
    ? null
    : (currentCheckoutIndex + 1) * ROW_HEIGHT < scroll.top + ROW_HEIGHT
      ? "up"
      : currentCheckoutIndex * ROW_HEIGHT >= scroll.top + scroll.height
        ? "down"
        : null
  const selection = useMemo(() => {
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
  const selectedHashes = useMemo(() => new Set(selection?.commits.map((commit) => commit.hash)), [selection])
  const selectionBranch = selection && displayRefs(selection.tip.refs).find((ref) => ref.branch)?.branch
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
    mutationFn: ({ path, target }: { path: string, target: WorktreeTarget }) => invoke("open_worktree", { path, target }),
    onError: (message) => setError(String(message)),
  })
  const deleteBranchMutation = useMutation({
    mutationFn: (branch: string) => invoke("delete_branch", { repoPath: params.path, branch }),
    onSuccess: () => {
      setBranchToDelete(null)
      refreshGraph()
    },
    onError: (message) => setError(String(message)),
  })
  const rebaseMutation = useMutation({
    mutationFn: (plan: OperationPlan) => invoke<RebaseResult>("rebase_onto", { repoPath: params.path, onto: plan.onto, upstream: plan.upstream, branch: plan.branch }),
    onMutate: () => {
      setError(null)
      setRebaseUndo(null)
    },
    onSuccess: (result, plan) => {
      setRebasePlan(null)
      if (result.outcome === "failed") {
        setError([result.message, ...result.files].join("\n"))
        return
      }
      setRebaseUndo({ branch: result.branch, onto: plan.onto, updates: result.updates })
      refreshGraph()
    },
    onError: (message) => setError(String(message)),
  })
  const undoRebaseMutation = useMutation({
    mutationFn: (updates: RefUpdate[]) => invoke("undo_ref_updates", { repoPath: params.path, updates }),
    onSuccess: () => {
      setRebaseUndo(null)
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
    setCommits([])
    const channel = new Channel<CommitBatch>((batch) => {
      if (!disposed) {
        setCommits((existing) => existing.concat(batch.map(commitFromTuple)))
      }
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
      disposed = true
      window.clearInterval(interval)
    }
  }, [graphVersion, params.path])

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
    element.scrollTop = index * ROW_HEIGHT + anchor.offset
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
    if (!rebaseUndo) {
      return
    }
    const timeout = window.setTimeout(() => setRebaseUndo(null), REBASE_UNDO_TIMEOUT)
    return () => window.clearTimeout(timeout)
  }, [rebaseUndo])

  useEffect(() => {
    if (isCleanConfirmationOpen) {
      previewCleanCandidates(cleanOptions)
    }
  }, [cleanOptions, isCleanConfirmationOpen, previewCleanCandidates])

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
    if (!selectionRange) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectionRange(null)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [selectionRange])

  useEffect(() => {
    if (canvas.current) {
      drawCommitGraph(canvas.current, commits, virtualRows, scroll.top, graphCanvasHeight(scroll.height), squashMergeEdges, graphWidth)
    }
  }, [commits, graphWidth, scroll, squashMergeEdges, virtualRows])

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

  function scrollToCurrentCheckout() {
    if (currentCheckoutIndex === -1) {
      return
    }
    rowVirtualizer.scrollToIndex(currentCheckoutIndex, { align: "center" })
  }

  function refreshGraph(clearReport = true) {
    setError(null)
    if (clearReport) {
      setCleanupReport(null)
    }
    const scrollTop = scrollElement.current?.scrollTop ?? savedScrollTop.current
    const index = Math.floor(scrollTop / ROW_HEIGHT)
    const commit = commits[index]
    refreshAnchor.current = commit ? { hash: commit.hash, offset: scrollTop - index * ROW_HEIGHT } : null
    setGraphVersion((version) => version + 1)
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
        id: `repository-diff-${crypto.randomUUID()}`,
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
      id: `repository-diff-${crypto.randomUUID()}`,
      params: { ...params, baseRef, headRef: commit.hash },
      position: { direction: "within", referencePanel },
      title: `Diff: ${commit.hash.slice(0, 8)}`,
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
      id: `repository-diff-${crypto.randomUUID()}`,
      params: { ...params, baseRef: base.hash, headRef: tip.hash },
      position: { direction: "within", referencePanel },
      title: `Diff: ${base.hash.slice(0, 8)}..${tip.hash.slice(0, 8)}`,
    })
  }

  function startRangeDrag(event: ReactPointerEvent<HTMLElement>, index: number) {
    const scroll = scrollElement.current
    const space = graphSpace.current
    if (event.button !== 0 || !scroll || !space || (event.target as HTMLElement).closest(".commit-ref")) {
      return
    }
    const originX = event.clientX
    const originY = event.clientY
    let pointerY = event.clientY
    let dragging = false
    let frame: number | null = null

    const focusIndexAt = () => {
      const offset = pointerY - space.getBoundingClientRect().top
      return Math.max(0, Math.min(commits.length - 1, Math.floor(offset / ROW_HEIGHT)))
    }

    const autoScroll = () => {
      const rect = scroll.getBoundingClientRect()
      // The sticky header covers the top row of the scroll box.
      const overTop = pointerY - (rect.top + ROW_HEIGHT + AUTOSCROLL_EDGE)
      const overBottom = pointerY - (rect.bottom - AUTOSCROLL_EDGE)
      const distance = overTop < 0 ? overTop : overBottom > 0 ? overBottom : 0
      if (distance !== 0) {
        scroll.scrollTop += Math.max(-AUTOSCROLL_STEP, Math.min(AUTOSCROLL_STEP, distance))
        setRangeDrag({ anchorIndex: index, focusIndex: focusIndexAt() })
      }
      frame = requestAnimationFrame(autoScroll)
    }

    const onPointerMove = (moveEvent: PointerEvent) => {
      pointerY = moveEvent.clientY
      if (!dragging) {
        if (Math.abs(moveEvent.clientX - originX) < DRAG_THRESHOLD && Math.abs(moveEvent.clientY - originY) < DRAG_THRESHOLD) {
          return
        }
        dragging = true
        window.getSelection()?.removeAllRanges()
        frame = requestAnimationFrame(autoScroll)
      }
      setRangeDrag({ anchorIndex: index, focusIndex: focusIndexAt() })
    }

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove)
      window.removeEventListener("pointerup", onPointerUp)
      window.getSelection()?.removeAllRanges()
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
      const focusIndex = focusIndexAt()
      const path = dragging ? ancestryPath(commits, index, focusIndex) : []
      setSelectionRange(path.length === 0 ? null : { anchorHash: commits[index].hash, focusHash: commits[focusIndex].hash })
      setRangeDrag(null)
    }

    window.addEventListener("pointermove", onPointerMove)
    window.addEventListener("pointerup", onPointerUp)
  }

  function refMenuItems(ref: DisplayRef, sha: string, components: RefMenuComponents) {
    const { Item, Sub, SubContent, SubTrigger } = components
    const { branch } = ref
    const reference = refName(ref)
    return (
      <>
        <Item onSelect={() => openRefDiff(reference)}>
          <GitCompareArrows />
          Compare with main
        </Item>
        <Item onSelect={() => copyText(reference)}>
          <Copy />
          Copy ref name
        </Item>
        <OperationMenuItems components={components} onConfirm={setRebasePlan} repoPath={params.path} source={selection} targetRef={ref} targetSha={sha} />
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
        {branch && !ref.checkedOut && ref.worktrees.length === 0 && (
          <Item onSelect={() => setBranchToDelete(branch)}>
            <Trash2 />
            Delete branch
          </Item>
        )}
      </>
    )
  }

  function refMenuEntry(ref: DisplayRef, sha: string, key: string, components: RefMenuComponents) {
    const { Sub, SubContent, SubTrigger } = components
    return (
      <Sub key={key}>
        <SubTrigger>{ref.label}</SubTrigger>
        <SubContent>{refMenuItems(ref, sha, components)}</SubContent>
      </Sub>
    )
  }

  function refChip(ref: DisplayRef, sha: string) {
    const { start, end } = splitRefLabel(ref.label)
    const chip = (
      <span
        aria-label={ref.checkedOut ? "Currently checked out" : ref.worktrees.length ? "Checked out in another worktree" : undefined}
        className={`commit-ref${ref.checkedOut ? " commit-ref-current" : ""}`}
        title={[ref.label, ...ref.worktrees.map((worktree) => `${worktree.isOpen ? "Open in" : "Checked out at"} ${worktree.name}`)].join("\n")}
      >
        {ref.checkedOut && <span className="commit-ref-head">HEAD</span>}
        <span className="commit-ref-label">
          <span className="commit-ref-label-start">{start}</span>
          {end && <span className="commit-ref-label-end">{end}</span>}
        </span>
      </span>
    )
    return (
      <DropdownMenu>
        <ContextMenu>
          {/* Radix context menu triggers do not stop propagation, so the row menu would open on top of this one. */}
          <ContextMenuTrigger asChild onContextMenu={(event) => event.stopPropagation()}>
            <DropdownMenuTrigger asChild>{chip}</DropdownMenuTrigger>
          </ContextMenuTrigger>
          <ContextMenuContent>{refMenuItems(ref, sha, contextMenuComponents)}</ContextMenuContent>
        </ContextMenu>
        <DropdownMenuContent>{refMenuItems(ref, sha, dropdownMenuComponents)}</DropdownMenuContent>
      </DropdownMenu>
    )
  }

  return (
    <main className="relative flex h-full flex-col overflow-hidden bg-background">
      <div className="flex items-center justify-end gap-1 border-b p-1">
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
      <div className={`commit-graph-scroll${rangeDrag ? " is-selecting" : ""}${rangeDrag && !selection ? " is-unrelated" : ""}`} onScroll={onScroll} ref={scrollElement} style={{ "--graph-header-height": `${GRAPH_HEADER_HEIGHT}px`, "--graph-width": `${graphWidth}px` } as CSSProperties}>
        <div className="commit-graph-header">
          <div className="commit-graph-header-content" style={{ minWidth: tableWidth }}>
            <div className="commit-graph-header-spacer">
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
        <div className="commit-graph-space" ref={graphSpace} style={{ height: rowVirtualizer.getTotalSize(), minWidth: tableWidth }}>
          <canvas aria-hidden className="commit-graph-canvas" ref={canvas} />
          {virtualRows.map((row) => {
            const commit = commits[row.index]
            const refColor = GRAPH_COLORS[commit.lane % GRAPH_COLORS.length]
            const currentCheckout = isCurrentCheckout(commit.refs)
            const selected = selectedHashes.has(commit.hash)
            const refs = displayRefs(commit.refs, checkedOutWorktrees)
            const [primaryRef, ...overflowRefs] = refs
            return (
              <ContextMenu key={commit.hash}>
                <ContextMenuTrigger asChild>
                  <article className={`commit-graph-row${currentCheckout ? " commit-graph-row-current" : ""}${selected ? " commit-graph-row-selected" : ""}`} onPointerDown={(event) => startRangeDrag(event, row.index)} style={{ "--commit-ref-color": refColor, gridTemplateColumns: columnTemplate, transform: `translateY(${row.start}px)` } as CSSProperties}>
                <div className="commit-graph-summary">
                  <div className="commit-graph-refs">
                    {primaryRef && refChip(primaryRef, commit.hash)}
                    {overflowRefs.length > 0 && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <span className="commit-ref">{`+${overflowRefs.length}`}</span>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          {overflowRefs.map((ref, index) => refMenuEntry(ref, commit.hash, `${ref.label}-${index}`, dropdownMenuComponents))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                  <span className={`min-w-0 flex-1 truncate ${currentCheckout ? "font-bold" : "font-normal"}`}>{commit.subject || "(no subject)"}</span>
                </div>
                <span className="truncate text-muted-foreground">{commit.author}</span>
                <time className="text-muted-foreground" dateTime={commit.date}>{relativeDate(commit.date)}</time>
                <code className="text-muted-foreground">{commit.hash.slice(0, 8)}</code>
                  </article>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onSelect={() => copyText(commit.hash)}>
                    <Copy />
                    Copy SHA
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => copyText(commit.subject)}>
                    <Copy />
                    Copy commit subject
                  </ContextMenuItem>
                  <ContextMenuItem disabled={commit.parents.length === 0} onSelect={() => openCommitDiff(commit)}>
                    <FileDiff />
                    Show commit diff
                  </ContextMenuItem>
                  {selected && selection && (
                    <ContextMenuItem disabled={!selection.base} onSelect={() => openRangeDiff(selection)}>
                      <GitCompareArrows />
                      Diff selected range
                    </ContextMenuItem>
                  )}
                  {refs.length > 0 && (
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
          <span className="commit-graph-selection-summary">
            {`${selection.commits.length} commit${selection.commits.length === 1 ? "" : "s"}${selectionBranch ? ` · ${selectionBranch}` : ""}`}
          </span>
          <Button disabled={!selection.base} onClick={() => openRangeDiff(selection)} size="xs" title="Diff the selected range" type="button" variant="outline">
            <FileDiff />
            Diff
          </Button>
          <Button onClick={() => setSelectionRange(null)} size="xs" title="Clear the selection" type="button" variant="ghost">
            <X />
            Clear
          </Button>
        </div>
      )}
      {commits.length === 0 && !error && <p className="commit-graph-status">Loading commits…</p>}
      {error && <p className="commit-graph-status text-destructive">{error}</p>}
      {cleanupReport && <p className="commit-graph-cleanup-report">{cleanupReport}</p>}
      {rebaseUndo && (
        <div className="commit-graph-cleanup-report flex items-center gap-3">
          <span>{`Rebased ${rebaseUndo.branch} onto ${rebaseUndo.onto}.`}</span>
          <Button disabled={undoRebaseMutation.isPending} onClick={() => undoRebaseMutation.mutate(rebaseUndo.updates)} size="xs" type="button" variant="outline">
            <Undo2 />
            {undoRebaseMutation.isPending ? "Undoing…" : "Undo"}
          </Button>
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
      <AlertDialog onOpenChange={(open) => !open && setBranchToDelete(null)} open={branchToDelete !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {branchToDelete}?</AlertDialogTitle>
            <AlertDialogDescription>This permanently deletes the local branch.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBranchMutation.isPending}>Cancel</AlertDialogCancel>
            <Button disabled={deleteBranchMutation.isPending} onClick={() => branchToDelete && deleteBranchMutation.mutate(branchToDelete)} type="button" variant="destructive">
              {deleteBranchMutation.isPending ? "Deleting…" : "Delete branch"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog onOpenChange={(open) => !open && setRebasePlan(null)} open={rebasePlan !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rebase {rebasePlan?.branch} onto {rebasePlan?.onto}?</AlertDialogTitle>
            <AlertDialogDescription>This rewrites the selected commits and moves {rebasePlan?.branch} to the result.</AlertDialogDescription>
          </AlertDialogHeader>
          {rebasePlan && rebasePlan.warnings.length > 0 && (
            <ul className="grid gap-2 text-sm">
              {rebasePlan.warnings.map((warning) => (
                <li className="flex items-start gap-2" key={warning.message}>
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-400" />
                  <div className="min-w-0">
                    <p>{warning.message}</p>
                    {warning.files && (
                      <ul className="font-mono text-xs text-muted-foreground">
                        {warning.files.map((file) => <li key={file}>{file}</li>)}
                      </ul>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <code className="overflow-x-auto rounded-lg border p-3 font-mono text-xs whitespace-pre">{rebasePlan?.argv.join(" ")}</code>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rebaseMutation.isPending}>Cancel</AlertDialogCancel>
            <Button disabled={rebaseMutation.isPending} onClick={() => rebasePlan && rebaseMutation.mutate(rebasePlan)} type="button">
              {rebaseMutation.isPending ? "Rebasing…" : "Rebase"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  )
}
