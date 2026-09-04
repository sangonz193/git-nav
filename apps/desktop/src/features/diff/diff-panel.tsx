import { DiffModeEnum, DiffView } from "@git-diff-view/react"
import { invoke } from "@/lib/ipc"
import { useVirtualizer } from "@tanstack/react-virtual"
import type { IDockviewPanelProps } from "dockview-react"
import { Archive, Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Cloud, Columns2, FilePen, Folder, FolderOpen, GitBranch, GitCompareArrows, Hash, PanelLeft, RefreshCw, Rows3, SlidersHorizontal, Tag } from "lucide-react"
import { type ComponentType, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"

import { Button } from "@workspace/shadcn/components/button"
import { ButtonGroup } from "@workspace/shadcn/components/button-group"
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@workspace/shadcn/components/dropdown-menu"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@workspace/shadcn/components/resizable"
import { Tooltip, TooltipContent, TooltipTrigger } from "@workspace/shadcn/components/tooltip"
import { toast } from "@workspace/shadcn/components/sonner"
import { SearchMenu, type SearchMenuItem } from "@/components/search-menu"
import { useTheme } from "@/components/theme-provider"
import { commitFromTuple, type Commit, type CommitBatch, type StashEntry } from "../commit-graph/commit-graph"
import { isRevisionExpression, searchReferences, type HitKind, type Reference, type ReferenceHit, type ResolvedRevision } from "./reference-search"
import { branchRangeTitle, defaultBranchName, diffTitle, isDefaultBranch, rangeMarker, selectedRefs, type SelectedRefs } from "./diff-title"
import { fileName, fileOid, initialDiffLayout, isViewedFile, NARROW_DIFF_PANEL_WIDTH, persistedDiffPanelParams, toggledDiffFileTree, WIDE_DIFF_PANEL_WIDTH, type ChangedFile } from "./diff-panel-state"
import type { DiffPanelParams, DiffPanelUserPreferences } from "../repository/repository-window"

const MAX_CONCURRENT_DIFF_LOADS = 4
const LARGE_DIFF_LINES = 1200
// Monospace runs wider than the interface face, so it is set a step below the interface size to read as the
// same size beside it.
const DIFF_FONT_SIZE = 11
const DIFF_ROW_HEIGHT = DIFF_FONT_SIZE * 1.6
const HUNK_ROW_HEIGHT = 30
const FILE_HEADER_HEIGHT = 30
const COLLAPSED_BODY_HEIGHT = 40
const SEARCH_DEBOUNCE = 120
const PICKER_MENU_WIDTH = 320

const HIT_ICONS: Record<HitKind, ComponentType<{ className?: string }>> = {
  branch: GitBranch,
  commit: GitCompareArrows,
  remote: Cloud,
  revision: Hash,
  stash: Archive,
  tag: Tag,
  worktree: FilePen,
}

// A status is a single letter from git, so the colour has to carry what kind of change it stands for.
const STATUS_COLORS: Record<string, string> = {
  A: "text-emerald-400",
  C: "text-violet-400",
  D: "text-rose-400",
  M: "text-blue-400",
  R: "text-violet-400",
  T: "text-amber-400",
}

type ViewedFile = {
  path: string
  oid: string
}

type Comparison = {
  baseSha: string
  headSha: string
  files: ChangedFile[]
}

type BranchSelection = {
  baseRef: string
  headRef: string
}

type FileDiff = {
  oldFileName: string | null
  newFileName: string | null
  oldContent: string | null
  newContent: string | null
  hunks: string[]
  isBinary: boolean
}

type DiffData = {
  oldFile: { fileName: string | null; content: string | null }
  newFile: { fileName: string | null; content: string | null }
  hunks: string[]
}

type DiffEntry =
  | { state: "loaded"; data: DiffData }
  | { state: "error"; message: string }

type FileTreeNode = {
  name: string
  path: string
  file: ChangedFile | null
  children: FileTreeNode[]
}

type PickerSide = "base" | "head"

function Hinted({ children, hint }: { children: ReactNode; hint: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  )
}

function fileKey(file: ChangedFile) {
  return `${file.status}:${file.oldPath}:${file.newPath}`
}

function statusLetter(file: ChangedFile) {
  return file.status.slice(0, 1).toUpperCase()
}

function isLargeDiff(file: ChangedFile) {
  return file.additions + file.deletions > LARGE_DIFF_LINES
}

function estimatedBodyHeight(file: ChangedFile, mode: DiffModeEnum, collapsed = false) {
  if (collapsed) {
    return 0
  }
  if (file.isBinary || isLargeDiff(file)) {
    return COLLAPSED_BODY_HEIGHT
  }
  const rows = mode & DiffModeEnum.Split ? file.splitRows : file.unifiedRows
  return Math.round(rows * DIFF_ROW_HEIGHT + file.hunkRows * HUNK_ROW_HEIGHT)
}

function fileTree(files: ChangedFile[]) {
  const root: FileTreeNode = { name: "", path: "", file: null, children: [] }
  for (const file of files) {
    const parts = fileName(file).split("/")
    let node = root
    for (const [index, name] of parts.entries()) {
      const path = node.path ? `${node.path}/${name}` : name
      let child = node.children.find((candidate) => candidate.name === name)
      if (!child) {
        child = { name, path, file: null, children: [] }
        node.children.push(child)
      }
      if (index === parts.length - 1) {
        child.file = file
      }
      node = child
    }
  }
  const sort = (nodes: FileTreeNode[]) => {
    nodes.sort((left, right) => Number(left.file !== null) - Number(right.file !== null) || left.name.localeCompare(right.name))
    nodes.forEach((node) => sort(node.children))
  }
  sort(root.children)
  return root.children
}

function changedLines(files: ChangedFile[]) {
  return files.reduce(
    (total, file) => ({ additions: total.additions + file.additions, deletions: total.deletions + file.deletions }),
    { additions: 0, deletions: 0 }
  )
}

function flattenTree(nodes: FileTreeNode[], files: ChangedFile[] = []) {
  for (const node of nodes) {
    if (node.file) {
      files.push(node.file)
    }
    flattenTree(node.children, files)
  }
  return files
}

function FileStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="diff-file-stat">
      <span className="text-emerald-400">+{additions.toLocaleString()}</span>
      <span className="text-rose-400">−{deletions.toLocaleString()}</span>
    </span>
  )
}

function FileTree({ files, onSelect, activeKey, viewed }: { files: FileTreeNode[]; onSelect: (file: ChangedFile) => void; activeKey: string | null; viewed: ReadonlyMap<string, string> }) {
  return files.map((node) => <FileTreeNode activeKey={activeKey} key={node.path} level={0} node={node} onSelect={onSelect} viewed={viewed} />)
}

function FileTreeNode({ level, node, onSelect, activeKey, viewed }: { level: number; node: FileTreeNode; onSelect: (file: ChangedFile) => void; activeKey: string | null; viewed: ReadonlyMap<string, string> }) {
  const [open, setOpen] = useState(true)
  const paddingLeft = 6 + level * 14

  if (node.file) {
    const key = fileKey(node.file)
    return (
      <button className={`diff-file${key === activeKey ? " is-selected" : ""}${isViewedFile(node.file, viewed) ? " is-viewed" : ""}`} key={key} onClick={() => onSelect(node.file!)} style={{ paddingLeft }} type="button">
        <span className={`diff-file-status ${STATUS_COLORS[statusLetter(node.file)] ?? "text-muted-foreground"}`}>{statusLetter(node.file)}</span>
        <span className="truncate">{node.name}</span>
        {!node.file.isBinary && <FileStat additions={node.file.additions} deletions={node.file.deletions} />}
      </button>
    )
  }

  return (
    <div className="diff-folder">
      <button aria-expanded={open} className="diff-folder-button" onClick={() => setOpen((current) => !current)} style={{ paddingLeft }} type="button">
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        {open ? <FolderOpen className="size-3.5" /> : <Folder className="size-3.5" />}
        <span className="truncate">{node.name}</span>
      </button>
      {open && <div className="diff-folder-children">
        {node.children.map((child) => <FileTreeNode activeKey={activeKey} key={child.path} level={level + 1} node={child} onSelect={onSelect} viewed={viewed} />)}
      </div>}
    </div>
  )
}

/**
 * What the repository itself is, rather than what it holds. A title names a comparison the moment it is
 * chosen, so this is read up front instead of alongside the picker it would otherwise be tied to.
 */
function useRepositoryMetadata(path: string, version: number) {
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null)
  const [headDetail, setHeadDetail] = useState<string | null>(null)
  const [remotes, setRemotes] = useState<string[]>()

  useEffect(() => {
    let cancelled = false
    invoke<{ currentBranch: string | null; defaultBranch: string | null; remotes: string[] }>("repository_state", { repoPath: path })
      .then((state) => {
        if (!cancelled) {
          setDefaultBranch(state.defaultBranch)
          setRemotes(state.remotes)
          setHeadDetail(state.currentBranch ?? "Detached head")
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [path, version])

  return useMemo(() => ({ defaultBranch, headDetail, remotes }), [defaultBranch, headDetail, remotes])
}

/**
 * Everything a diff side can be pointed at. Refs come from the repository rather than the graph window,
 * so a branch is reachable however far back its tip sits.
 */
function useReferenceSources(path: string, enabled: boolean, version: number) {
  const [commits, setCommits] = useState<Commit[]>([])
  const [references, setReferences] = useState<Reference[]>([])
  const [stashes, setStashes] = useState<StashEntry[]>([])

  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    const settle = <T,>(value: T, apply: (value: T) => void) => !cancelled && apply(value)
    invoke<Reference[]>("repository_references", { repoPath: path }).then((value) => settle(value, setReferences)).catch(() => undefined)
    invoke<StashEntry[]>("stash_list", { repoPath: path }).then((value) => settle(value, setStashes)).catch(() => undefined)
    invoke<CommitBatch>("reference_picker_commits", { repoPath: path })
      .then((batch) => settle(batch.map(commitFromTuple), setCommits))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [enabled, path, version])

  return useMemo(() => ({ commits, references, stashes }), [commits, references, stashes])
}

function useDiffLoader(repoPath: string, comparison: Comparison | null) {
  const [entries, setEntries] = useState<Record<string, DiffEntry>>({})
  const loader = useRef({ queued: [] as ChangedFile[], started: new Set<string>(), inFlight: 0 })

  const reset = useCallback(() => {
    loader.current = { queued: [], started: new Set(), inFlight: 0 }
    setEntries({})
  }, [])

  // A request replaces the queue, so files scrolled past before a worker picked them up free their slot.
  const request = useCallback((files: ChangedFile[]) => {
    if (!comparison) {
      return
    }
    const state = loader.current
    state.queued = files.filter((file) => !state.started.has(fileKey(file)))
    const drain = async () => {
      for (let file = state.queued.shift(); file; file = state.queued.shift()) {
        const key = fileKey(file)
        state.started.add(key)
        const entry = await invoke<FileDiff>("diff_file", {
          repoPath,
          baseSha: comparison.baseSha,
          headSha: comparison.headSha,
          oldPath: file.oldPath,
          newPath: file.newPath,
        })
          .then((diff): DiffEntry => ({
            state: "loaded",
            data: {
              oldFile: { fileName: diff.oldFileName, content: diff.oldContent },
              newFile: { fileName: diff.newFileName, content: diff.newContent },
              hunks: diff.hunks,
            },
          }))
          .catch((message: unknown): DiffEntry => ({ state: "error", message: String(message) }))
        if (loader.current !== state) {
          return
        }
        setEntries((current) => ({ ...current, [key]: entry }))
      }
    }
    while (state.inFlight < MAX_CONCURRENT_DIFF_LOADS && state.queued.length > 0) {
      state.inFlight += 1
      void drain().finally(() => {
        state.inFlight -= 1
      })
    }
  }, [comparison, repoPath])

  return { entries, request, reset }
}

function FileDiffCard({ collapsed, entry, expanded, file, mode, onExpand, onToggleCollapsed, onToggleViewed, theme, viewed, wrap }: { collapsed: boolean; entry: DiffEntry | undefined; expanded: boolean; file: ChangedFile; mode: DiffModeEnum; onExpand: () => void; onToggleCollapsed: () => void; onToggleViewed: () => void; theme: "light" | "dark"; viewed: boolean; wrap: boolean }) {
  const body = () => {
    if (file.isBinary) {
      return <p className="diff-file-card-notice">Binary file changed</p>
    }
    if (entry?.state === "error") {
      return <p className="diff-file-card-notice text-destructive">{entry.message}</p>
    }
    if (entry?.state === "loaded") {
      return <DiffView data={entry.data} diffViewFontSize={DIFF_FONT_SIZE} diffViewHighlight diffViewMode={mode} diffViewTheme={theme} diffViewWrap={wrap} />
    }
    if (isLargeDiff(file) && !expanded) {
      return (
        <p className="diff-file-card-notice">
          Large diff with {(file.additions + file.deletions).toLocaleString()} changed lines
          <Button onClick={onExpand} size="xs" type="button" variant="outline">Show diff</Button>
        </p>
      )
    }
    return <div style={{ height: estimatedBodyHeight(file, mode) }} />
  }

  return (
    <article className="diff-file-card">
      <header className="diff-file-card-header">
        <button aria-expanded={!collapsed} className="diff-file-card-toggle" onClick={onToggleCollapsed} type="button">
          {collapsed ? <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />}
          <span className={`diff-file-status ${STATUS_COLORS[statusLetter(file)] ?? "text-muted-foreground"}`}>{statusLetter(file)}</span>
          <span className="diff-file-card-path truncate">{fileName(file)}</span>
        </button>
        {!file.isBinary && <FileStat additions={file.additions} deletions={file.deletions} />}
        <Hinted hint={viewed ? "Mark as not viewed" : "Mark as viewed"}>
          <Button aria-label="Viewed" aria-pressed={viewed} className={viewed ? "bg-muted" : undefined} onClick={onToggleViewed} size="icon-xs" type="button" variant="ghost">
            <Check className={viewed ? "text-emerald-400" : "text-muted-foreground"} />
          </Button>
        </Hinted>
      </header>
      {!collapsed && body()}
    </article>
  )
}

export function DiffPanel({ api, params }: IDockviewPanelProps<DiffPanelParams>) {
  const theme = useTheme()
  const [refs, setRefs] = useState<SelectedRefs>(selectedRefs(params.baseRef, params.headRef, params.mergeBase ?? false, params.baseLabel, params.headLabel))
  const [comparison, setComparison] = useState<Comparison | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState(params.userPreferences?.mode === "unified" ? DiffModeEnum.Unified : DiffModeEnum.Split)
  const [wrap, setWrap] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [viewed, setViewed] = useState<ReadonlyMap<string, string>>(new Map())
  const [hideViewed, setHideViewed] = useState(false)
  const [version, setVersion] = useState(0)
  const [picker, setPicker] = useState<PickerSide | null>(null)
  const [searchInput, setSearchInput] = useState("")
  const [searchQuery, setSearchQuery] = useState("")
  const [hitIndex, setHitIndex] = useState(0)
  const [revision, setRevision] = useState<ResolvedRevision | null>(null)
  const [isSidebarOpen, setIsSidebarOpen] = useState(params.userPreferences?.fileTreeOpen ?? true)
  const [userPreferences, setUserPreferences] = useState<DiffPanelUserPreferences>(() => params.userPreferences ?? {})
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(params.selectedFilePath ?? null)
  const [isNarrow, setIsNarrow] = useState(false)
  const [panelWidth, setPanelWidth] = useState(0)
  const panel = useRef<HTMLElement>(null)
  const pickerButtons = useRef<Record<PickerSide, HTMLButtonElement | null>>({ base: null, head: null })
  const scrollElement = useRef<HTMLDivElement>(null)
  const pendingScroll = useRef<string | null>(null)
  const pendingAnchor = useRef<string | null>(null)
  const userPreferencesRef = useRef(userPreferences)
  const pendingRestoredFilePath = useRef(params.selectedFilePath ?? null)
  const { entries, request, reset } = useDiffLoader(params.path, comparison)
  const metadata = useRepositoryMetadata(params.path, version)
  const sources = useReferenceSources(params.path, picker !== null, version)
  const shownFiles = useMemo(
    () => hideViewed ? (comparison?.files ?? []).filter((file) => !isViewedFile(file, viewed)) : comparison?.files ?? [],
    [comparison, hideViewed, viewed]
  )
  const tree = useMemo(() => fileTree(shownFiles), [shownFiles])
  const files = useMemo(() => flattenTree(tree), [tree])
  const total = useMemo(() => changedLines(files), [files])
  const viewedCount = useMemo(() => (comparison?.files ?? []).filter((file) => isViewedFile(file, viewed)).length, [comparison, viewed])

  function toggleFileTree() {
    const next = toggledDiffFileTree(isSidebarOpen, isNarrow, userPreferencesRef.current)
    if (next.preferences !== userPreferencesRef.current) {
      userPreferencesRef.current = next.preferences
      setUserPreferences(next.preferences)
    }
    setIsSidebarOpen(next.fileTreeOpen)
  }

  function setPreferredMode(mode: "split" | "unified") {
    const next = { ...userPreferencesRef.current, mode }
    userPreferencesRef.current = next
    setUserPreferences(next)
    setMode(mode === "split" ? DiffModeEnum.Split : DiffModeEnum.Unified)
  }

  function setPreferredWrap(wrap: boolean) {
    const next = { ...userPreferencesRef.current, wrap }
    userPreferencesRef.current = next
    setUserPreferences(next)
    setWrap(wrap)
  }

  useEffect(() => {
    api.updateParameters(persistedDiffPanelParams({ name: params.name, path: params.path }, refs, selectedFilePath, userPreferences))
  }, [api, params.name, params.path, refs, selectedFilePath, userPreferences])

  const rowVirtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => scrollElement.current,
    estimateSize: (index) => FILE_HEADER_HEIGHT + estimatedBodyHeight(files[index], mode, collapsed.has(fileKey(files[index]))),
    getItemKey: (index) => fileKey(files[index]),
    overscan: 2,
  })
  const virtualRows = rowVirtualizer.getVirtualItems()

  useEffect(() => {
    let cancelled = false
    setViewed(new Map())
    invoke<ViewedFile[]>("viewed_files", { repoPath: params.path, baseRef: refs.base, headRef: refs.head })
      .then((marks) => !cancelled && setViewed(new Map(marks.map((mark) => [mark.path, mark.oid]))))
      .catch(() => undefined)
    invoke<Comparison>("compare_refs", { repoPath: params.path, baseRef: refs.base, headRef: refs.head, mergeBase: refs.mergeBase })
      .then((nextComparison) => {
        if (!cancelled) {
          reset()
          setExpanded(new Set())
          setCollapsed(new Set())
          setComparison(nextComparison)
          setError(null)
        }
      })
      .catch((message: unknown) => {
        if (!cancelled) {
          setError(String(message))
        }
      })
    return () => {
      cancelled = true
    }
  }, [params.path, refs, reset, version])

  // A drawer laid over the diff is transient, while side-by-side columns honor an explicit preference.
  useLayoutEffect(() => {
    const element = panel.current
    if (!element) {
      return
    }
    let narrow: boolean | null = null
    const layOut = (width: number) => {
      // A panel that has not been laid out yet, or whose tab is hidden, measures zero. That is not a
      // width to fold the toolbar for, and it is certainly not one to settle the whole layout on.
      if (width === 0) {
        return
      }
      setPanelWidth(width)
      if (narrow === null) {
        const layout = initialDiffLayout(width, userPreferencesRef.current)
        setMode(layout.mode === "unified" ? DiffModeEnum.Unified : DiffModeEnum.Split)
        setIsSidebarOpen(layout.fileTreeOpen)
        setWrap(layout.wrap)
      }
      const next = width < NARROW_DIFF_PANEL_WIDTH
      if (narrow !== next) {
        if (narrow !== null) {
          setIsSidebarOpen(initialDiffLayout(width, userPreferencesRef.current).fileTreeOpen)
        }
        narrow = next
        setIsNarrow(next)
      }
    }
    layOut(element.getBoundingClientRect().width)
    const observer = new ResizeObserver(([entry]) => layOut(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Measured heights belong to the previous comparison or layout, so drop them and start over.
  useEffect(() => {
    rowVirtualizer.measure()
    rowVirtualizer.scrollToOffset(0)
  }, [comparison, rowVirtualizer])

  // A fold changes the heights the scroller was measured at, so they are dropped and taken again. Only a
  // fold that moved what sits above the scroller asks to be put back where it was.
  useEffect(() => {
    rowVirtualizer.measure()
    const key = pendingAnchor.current
    if (key) {
      pendingAnchor.current = null
      rowVirtualizer.scrollToIndex(files.findIndex((file) => fileKey(file) === key), { align: "start" })
    }
  }, [collapsed, files, mode, rowVirtualizer, wrap])

  useEffect(() => {
    request(virtualRows.map((row) => files[row.index]).filter((file) => !file.isBinary && !collapsed.has(fileKey(file)) && (!isLargeDiff(file) || expanded.has(fileKey(file)))))
  }, [collapsed, expanded, files, request, virtualRows])

  useEffect(() => {
    const timeout = window.setTimeout(() => setSearchQuery(searchInput), SEARCH_DEBOUNCE)
    return () => window.clearTimeout(timeout)
  }, [searchInput])

  useEffect(() => {
    setHitIndex(0)
  }, [searchQuery])

  // Only an expression git could resolve is worth asking about, so half-typed names never reach it.
  useEffect(() => {
    if (!isRevisionExpression(searchQuery)) {
      setRevision(null)
      return
    }
    let cancelled = false
    invoke<ResolvedRevision>("resolve_revision", { repoPath: params.path, revision: searchQuery.trim() })
      .then((resolved) => !cancelled && setRevision(resolved))
      .catch(() => !cancelled && setRevision(null))
    return () => {
      cancelled = true
    }
  }, [params.path, searchQuery])

  const hits = useMemo(
    () => picker === null ? [] : searchReferences(searchQuery, { ...sources, ...metadata, allowWorktree: picker === "head", revision }),
    [metadata, picker, revision, searchQuery, sources]
  )
  const clearFileSelection = useCallback(() => {
    pendingRestoredFilePath.current = null
    pendingScroll.current = null
    setSelectedFilePath(null)
  }, [])
  const selectAheadRange = useCallback((reference: string) => {
    invoke<BranchSelection>("select_branch_range", { repoPath: params.path, reference })
      .then((selection) => {
        const range = selectedRefs(selection.baseRef, selection.headRef, true)
        clearFileSelection()
        setRefs(range)
        api.setTitle(branchRangeTitle(range))
      })
      .catch((message: unknown) => setError(String(message)))
    setPicker(null)
  }, [api, clearFileSelection, params.path])
  // Measuring a branch from where it forked moves both ends of the comparison, which is only what the
  // head end is asking for. Naming the branch it forked from is what keeps that from being a surprise.
  const forkBase = defaultBranchName(metadata.defaultBranch, metadata.remotes ?? [])
  const menuItems = useMemo(
    () => hits.map((hit, index): SearchMenuItem => ({
      action: picker !== "head" || hit.branch === null || isDefaultBranch(hit.branch, metadata.defaultBranch, metadata.remotes ?? []) ? undefined : {
        hint: `Changes on ${hit.branch} since it forked from ${forkBase || "the default branch"}`,
        icon: GitCompareArrows,
        label: forkBase ? `vs ${forkBase}` : "vs default",
        onSelect: () => selectAheadRange(hit.branch as string),
      },
      detail: hit.detail,
      icon: HIT_ICONS[hit.kind],
      key: `${hit.kind}-${hit.reference}-${index}`,
      label: hit.label,
    })),
    [forkBase, hits, metadata.defaultBranch, metadata.remotes, picker, selectAheadRange]
  )

  const scrollOffset = rowVirtualizer.scrollOffset ?? 0
  const activeIndex = virtualRows.find((row) => row.end > scrollOffset + 1)?.index
  const activeKey = activeIndex === undefined ? null : fileKey(files[activeIndex])
  const scrollToFile = useCallback((file: ChangedFile) => {
    pendingScroll.current = fileKey(file)
    rowVirtualizer.scrollToIndex(files.indexOf(file), { align: "start" })
  }, [files, rowVirtualizer])

  // The first scroll aims at estimated heights, so aim again once the target has rendered its real diff.
  useEffect(() => {
    const key = pendingScroll.current
    if (key && entries[key]) {
      pendingScroll.current = null
      rowVirtualizer.scrollToIndex(files.findIndex((file) => fileKey(file) === key), { align: "start" })
    }
  }, [entries, files, rowVirtualizer])

  // Folding only moves what sits under the card, so the scroller is left alone. The exception is a card
  // the scroller is already inside, where the sticky header stands in for a top that is far above.
  function anchorFold(file: ChangedFile) {
    const key = fileKey(file)
    const row = virtualRows.find((candidate) => fileKey(files[candidate.index]) === key)
    pendingAnchor.current = row && row.start < scrollOffset ? key : null
  }

  function toggleCollapsed(file: ChangedFile) {
    const key = fileKey(file)
    const next = new Set(collapsed)
    if (!next.delete(key)) {
      next.add(key)
    }
    anchorFold(file)
    setCollapsed(next)
  }

  // Reading a file is what folding it away means here, so the two move together. Only a file with a blob
  // behind it can be remembered, which leaves the working tree marked for as long as the tab is open.
  function toggleViewed(file: ChangedFile) {
    const path = fileName(file)
    const oid = fileOid(file)
    const wasViewed = isViewedFile(file, viewed)
    const nextViewed = new Map(viewed)
    if (wasViewed) {
      nextViewed.delete(path)
    } else {
      nextViewed.set(path, oid)
    }
    setViewed(nextViewed)
    const key = fileKey(file)
    const nextCollapsed = new Set(collapsed)
    if (wasViewed) {
      nextCollapsed.delete(key)
    } else {
      nextCollapsed.add(key)
    }
    anchorFold(file)
    setCollapsed(nextCollapsed)
    if (oid) {
      invoke("set_file_viewed", { repoPath: params.path, baseRef: refs.base, headRef: refs.head, path, oid, viewed: !wasViewed })
        .catch((message: unknown) => toast.error("Could not save which files were viewed.", { description: String(message) }))
    }
  }

  function collapseAll(collapse: boolean) {
    pendingAnchor.current = activeKey
    setCollapsed(collapse ? new Set(files.map(fileKey)) : new Set())
  }

  const selectFile = useCallback((file: ChangedFile) => {
    pendingRestoredFilePath.current = null
    scrollToFile(file)
    setSelectedFilePath(fileName(file))
    if (isNarrow) {
      setIsSidebarOpen(false)
    }
  }, [isNarrow, scrollToFile])

  useEffect(() => {
    const path = pendingRestoredFilePath.current
    if (!comparison || !path) {
      return
    }
    pendingRestoredFilePath.current = null
    const file = files.find((candidate) => fileName(candidate) === path)
    if (file) {
      scrollToFile(file)
    }
  }, [comparison, files, scrollToFile])
  const fileList = useMemo(() => <FileTree activeKey={activeKey} files={tree} onSelect={selectFile} viewed={viewed} />, [activeKey, selectFile, tree, viewed])

  function openPicker(side: PickerSide) {
    setPicker(side)
    setSearchInput("")
    setSearchQuery("")
    setHitIndex(0)
  }

  // Where the ends sit cannot say whether a tab still carries the name it opened with, since a
  // comparison can be pointed back at the ends it opened from. Moving an end is what retitles the tab.
  function moveRefs(next: SelectedRefs) {
    clearFileSelection()
    setRefs(next)
    api.setTitle(diffTitle(next, metadata.defaultBranch, metadata.remotes ?? []))
  }

  function selectHit(hit: ReferenceHit) {
    moveRefs(picker === "base"
      ? { ...refs, base: hit.reference, baseLabel: hit.label }
      : { ...refs, head: hit.reference, headLabel: hit.label })
    setPicker(null)
  }

  const isSplit = (mode & DiffModeEnum.Split) !== 0
  const pickerAnchor = pickerButtons.current[picker ?? "base"]
  const pickerLeft = isNarrow || !pickerAnchor
    ? 8
    : Math.max(8, Math.min(pickerAnchor.offsetLeft, panelWidth - PICKER_MENU_WIDTH - 8))

  const sidebar = (
    <nav aria-label="Changed files" className="diff-file-list">
      <header className="diff-file-total">
        <span>{files.length === 1 ? "1 file" : `${files.length.toLocaleString()} files`}</span>
        {viewedCount > 0 && <span>{`${viewedCount.toLocaleString()} viewed`}</span>}
        <FileStat additions={total.additions} deletions={total.deletions} />
      </header>
      <div className="diff-file-tree">
        {fileList}
        {comparison?.files.length === 0 && <p className="diff-empty">No changed files</p>}
      </div>
    </nav>
  )
  const diffScroll = (
    <div className="diff-view-container" ref={scrollElement}>
      {error && <p className="diff-empty text-destructive">{error}</p>}
      {!comparison && !error && <p className="diff-empty">Loading comparison…</p>}
      <div className="diff-file-space" style={{ height: rowVirtualizer.getTotalSize() }}>
        {virtualRows.map((row) => {
          const file = files[row.index]
          return (
            <div className="diff-file-row" data-index={row.index} key={row.key} ref={rowVirtualizer.measureElement} style={{ top: row.start }}>
              <FileDiffCard
                collapsed={collapsed.has(fileKey(file))}
                entry={entries[fileKey(file)]}
                expanded={expanded.has(fileKey(file))}
                file={file}
                mode={mode}
                onExpand={() => setExpanded((current) => new Set(current).add(fileKey(file)))}
                onToggleCollapsed={() => toggleCollapsed(file)}
                onToggleViewed={() => toggleViewed(file)}
                theme={theme}
                viewed={isViewedFile(file, viewed)}
                wrap={wrap}
              />
            </div>
          )
        })}
      </div>
    </div>
  )

  return (
    <section className="diff-panel" ref={panel}>
      <div className="diff-toolbar">
        <Hinted hint={isSidebarOpen ? "Hide changed files" : "Show changed files"}>
          <Button aria-expanded={isSidebarOpen} aria-label="Toggle changed files" onClick={() => {
            toggleFileTree()
          }} size="icon-sm" type="button" variant="outline">
            <PanelLeft />
          </Button>
        </Hinted>
        <Button aria-expanded={picker === "base"} className={isNarrow ? "min-w-0 flex-1 justify-between" : "w-45 justify-between"} onClick={() => openPicker("base")} ref={(element) => { pickerButtons.current.base = element }} size="sm" type="button" variant="outline">
          <span className="truncate">{refs.baseLabel}</span>
          <ChevronDown />
        </Button>
        <Hinted hint={refs.mergeBase ? `Changes on ${refs.headLabel} since it forked from ${refs.baseLabel}` : `Changes between ${refs.baseLabel} and ${refs.headLabel}`}>
          <Button aria-label="Compare since the two sides forked" aria-pressed={refs.mergeBase} className={refs.mergeBase ? "bg-muted" : undefined} onClick={() => moveRefs({ ...refs, mergeBase: !refs.mergeBase })} size="sm" type="button" variant="ghost">
            <span className="text-muted-foreground">{rangeMarker(refs)}</span>
            {panelWidth >= WIDE_DIFF_PANEL_WIDTH && (refs.mergeBase ? "Since fork" : "Direct")}
          </Button>
        </Hinted>
        <Button aria-expanded={picker === "head"} className={isNarrow ? "min-w-0 flex-1 justify-between" : "w-45 justify-between"} onClick={() => openPicker("head")} ref={(element) => { pickerButtons.current.head = element }} size="sm" type="button" variant="outline">
          <span className="truncate">{refs.headLabel}</span>
          <ChevronDown />
        </Button>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {!isNarrow && (
            <ButtonGroup>
              <Hinted hint="Show both sides">
                <Button aria-label="Split layout" aria-pressed={isSplit} className={isSplit ? "bg-muted" : undefined} onClick={() => setPreferredMode("split")} size="icon-sm" type="button" variant="outline">
                  <Columns2 />
                </Button>
              </Hinted>
              <Hinted hint="Show one column">
                <Button aria-label="Unified layout" aria-pressed={!isSplit} className={isSplit ? undefined : "bg-muted"} onClick={() => setPreferredMode("unified")} size="icon-sm" type="button" variant="outline">
                  <Rows3 />
                </Button>
              </Hinted>
            </ButtonGroup>
          )}
          <DropdownMenu>
            <Tooltip>
              <DropdownMenuTrigger asChild>
                <TooltipTrigger asChild>
                  <Button aria-label="View options" size={isNarrow ? "icon-sm" : "sm"} type="button" variant="outline">
                    <SlidersHorizontal />
                    {!isNarrow && "View"}
                  </Button>
                </TooltipTrigger>
              </DropdownMenuTrigger>
              <TooltipContent>Choose how the diff is laid out</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end">
              {isNarrow && (
                <>
                  <DropdownMenuLabel>Layout</DropdownMenuLabel>
                  <DropdownMenuCheckboxItem checked={isSplit} onCheckedChange={() => setPreferredMode("split")} onSelect={(event) => event.preventDefault()}>
                    <Columns2 />
                    Split
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem checked={!isSplit} onCheckedChange={() => setPreferredMode("unified")} onSelect={(event) => event.preventDefault()}>
                    <Rows3 />
                    Unified
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuCheckboxItem checked={wrap} onCheckedChange={(checked) => setPreferredWrap(checked === true)} onSelect={(event) => event.preventDefault()}>
                Wrap long lines
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={hideViewed} onCheckedChange={(checked) => setHideViewed(checked === true)} onSelect={(event) => event.preventDefault()}>
                Hide viewed files
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={files.length === 0} onSelect={() => collapseAll(true)}>
                <ChevronsDownUp />
                Collapse all files
              </DropdownMenuItem>
              <DropdownMenuItem disabled={collapsed.size === 0} onSelect={() => collapseAll(false)}>
                <ChevronsUpDown />
                Expand all files
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Hinted hint="Reread this comparison">
            <Button aria-label="Refresh the comparison" onClick={() => setVersion((current) => current + 1)} size="icon-sm" type="button" variant="outline">
              <RefreshCw />
            </Button>
          </Hinted>
        </div>
      </div>
      {picker !== null && (
        <div className="absolute top-11 z-20" style={{ left: pickerLeft, right: isNarrow ? 8 : undefined, width: isNarrow ? undefined : PICKER_MENU_WIDTH }}>
          <SearchMenu
            activeIndex={hitIndex}
            emptyMessage="No branch, tag, commit or revision matches"
            inputLabel={picker === "base" ? "Search for a base to compare from" : "Search for a head to compare to"}
            items={menuItems}
            onClose={() => setPicker(null)}
            onHighlight={setHitIndex}
            onQueryChange={setSearchInput}
            onSelect={(index) => {
              setHitIndex(index)
              selectHit(hits[index])
            }}
            placeholder="Branch, tag, commit or revision"
            query={searchInput}
          />
        </div>
      )}
      <div className="diff-content">
        {isNarrow ? (
          <>
            {isSidebarOpen && <div className="diff-drawer-backdrop" onClick={() => setIsSidebarOpen(false)} />}
            {isSidebarOpen && <div className="diff-drawer">{sidebar}</div>}
            {diffScroll}
          </>
        ) : (
          <ResizablePanelGroup orientation="horizontal">
            {isSidebarOpen && (
              <>
                <ResizablePanel defaultSize="22%" maxSize="40%" minSize="15%">{sidebar}</ResizablePanel>
                <ResizableHandle withHandle />
              </>
            )}
            <ResizablePanel minSize="40%">{diffScroll}</ResizablePanel>
          </ResizablePanelGroup>
        )}
      </div>
    </section>
  )
}
