import { DiffModeEnum, DiffView } from "@git-diff-view/react"
import { invoke } from "@/lib/ipc"
import { useVirtualizer } from "@tanstack/react-virtual"
import type { IDockviewPanelProps } from "dockview-react"
import { Archive, ChevronDown, ChevronRight, Cloud, Columns2, FilePen, Folder, FolderOpen, GitBranch, GitCompareArrows, Hash, PanelLeft, RefreshCw, Rows3, SlidersHorizontal, Tag } from "lucide-react"
import { type ComponentType, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"

import { Button } from "@workspace/shadcn/components/button"
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@workspace/shadcn/components/dropdown-menu"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@workspace/shadcn/components/resizable"
import { Tooltip, TooltipContent, TooltipTrigger } from "@workspace/shadcn/components/tooltip"
import { SearchMenu, type SearchMenuItem } from "@/components/search-menu"
import { useTheme } from "@/components/theme-provider"
import { commitFromTuple, type Commit, type CommitBatch, type StashEntry } from "../commit-graph/commit-graph"
import { isRevisionExpression, searchReferences, type HitKind, type Reference, type ReferenceHit, type ResolvedRevision } from "./reference-search"
import { WORKTREE_REF, type DiffPanelParams } from "../repository/repository-window"

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
const NARROW_PANEL_WIDTH = 620
const SPLIT_PANEL_WIDTH = 900
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

type ChangedFile = {
  status: string
  oldPath: string | null
  newPath: string | null
  additions: number
  deletions: number
  isBinary: boolean
  splitRows: number
  unifiedRows: number
  hunkRows: number
}

type Comparison = {
  baseSha: string
  headSha: string
  files: ChangedFile[]
}

type BranchSelection = {
  baseSha: string
  headSha: string
  baseLabel: string
  headLabel: string
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

type SelectedRefs = {
  base: string
  head: string
  baseLabel: string
  headLabel: string
}

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

function refLabel(reference: string) {
  return reference === WORKTREE_REF ? "Working tree" : reference
}

function fileName(file: ChangedFile) {
  return file.newPath ?? file.oldPath ?? "Unknown file"
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

function estimatedBodyHeight(file: ChangedFile, mode: DiffModeEnum) {
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

function flattenTree(nodes: FileTreeNode[], files: ChangedFile[] = []) {
  for (const node of nodes) {
    if (node.file) {
      files.push(node.file)
    }
    flattenTree(node.children, files)
  }
  return files
}

function FileTree({ files, onSelect, activeKey }: { files: FileTreeNode[]; onSelect: (file: ChangedFile) => void; activeKey: string | null }) {
  return files.map((node) => <FileTreeNode activeKey={activeKey} key={node.path} level={0} node={node} onSelect={onSelect} />)
}

function FileTreeNode({ level, node, onSelect, activeKey }: { level: number; node: FileTreeNode; onSelect: (file: ChangedFile) => void; activeKey: string | null }) {
  const [open, setOpen] = useState(true)
  const paddingLeft = 6 + level * 14

  if (node.file) {
    const key = fileKey(node.file)
    return (
      <button className={`diff-file${key === activeKey ? " is-selected" : ""}`} key={key} onClick={() => onSelect(node.file!)} style={{ paddingLeft }} type="button">
        <span className={`diff-file-status ${STATUS_COLORS[statusLetter(node.file)] ?? "text-muted-foreground"}`}>{statusLetter(node.file)}</span>
        <span className="truncate">{node.name}</span>
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
        {node.children.map((child) => <FileTreeNode activeKey={activeKey} key={child.path} level={level + 1} node={child} onSelect={onSelect} />)}
      </div>}
    </div>
  )
}

/**
 * Everything a diff side can be pointed at. Refs come from the repository rather than the graph window,
 * so a branch is reachable however far back its tip sits.
 */
function useReferenceSources(path: string, enabled: boolean, version: number) {
  const [commits, setCommits] = useState<Commit[]>([])
  const [headDetail, setHeadDetail] = useState<string | null>(null)
  const [references, setReferences] = useState<Reference[]>([])
  const [remotes, setRemotes] = useState<string[]>()
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
    invoke<{ currentBranch: string | null; remotes: string[] }>("repository_state", { repoPath: path })
      .then((state) => {
        settle(state.remotes, setRemotes)
        settle(state.currentBranch ?? "Detached head", setHeadDetail)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [enabled, path, version])

  return useMemo(() => ({ commits, headDetail, references, remotes, stashes }), [commits, headDetail, references, remotes, stashes])
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

function FileDiffCard({ entry, expanded, file, mode, onExpand, theme, wrap }: { entry: DiffEntry | undefined; expanded: boolean; file: ChangedFile; mode: DiffModeEnum; onExpand: () => void; theme: "light" | "dark"; wrap: boolean }) {
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
        <span className={`diff-file-status ${STATUS_COLORS[statusLetter(file)] ?? "text-muted-foreground"}`}>{statusLetter(file)}</span>
        <span className="diff-file-card-path truncate">{fileName(file)}</span>
        {!file.isBinary && <span className="diff-file-card-stat">
          <span className="text-emerald-400">+{file.additions}</span>
          <span className="text-rose-400">−{file.deletions}</span>
        </span>}
      </header>
      {body()}
    </article>
  )
}

export function DiffPanel({ params }: IDockviewPanelProps<DiffPanelParams>) {
  const theme = useTheme()
  const [refs, setRefs] = useState<SelectedRefs>({
    base: params.baseRef,
    head: params.headRef,
    baseLabel: refLabel(params.baseRef),
    headLabel: refLabel(params.headRef),
  })
  const [comparison, setComparison] = useState<Comparison | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState(DiffModeEnum.Split)
  const [wrap, setWrap] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [version, setVersion] = useState(0)
  const [picker, setPicker] = useState<PickerSide | null>(null)
  const [searchInput, setSearchInput] = useState("")
  const [searchQuery, setSearchQuery] = useState("")
  const [hitIndex, setHitIndex] = useState(0)
  const [revision, setRevision] = useState<ResolvedRevision | null>(null)
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [isNarrow, setIsNarrow] = useState(false)
  const [panelWidth, setPanelWidth] = useState(0)
  const panel = useRef<HTMLElement>(null)
  const pickerButtons = useRef<Record<PickerSide, HTMLButtonElement | null>>({ base: null, head: null })
  const scrollElement = useRef<HTMLDivElement>(null)
  const pendingScroll = useRef<string | null>(null)
  const { entries, request, reset } = useDiffLoader(params.path, comparison)
  const sources = useReferenceSources(params.path, picker !== null, version)
  const tree = useMemo(() => fileTree(comparison?.files ?? []), [comparison])
  const files = useMemo(() => flattenTree(tree), [tree])

  const rowVirtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => scrollElement.current,
    estimateSize: (index) => FILE_HEADER_HEIGHT + estimatedBodyHeight(files[index], mode),
    getItemKey: (index) => fileKey(files[index]),
    overscan: 2,
  })
  const virtualRows = rowVirtualizer.getVirtualItems()

  useEffect(() => {
    let cancelled = false
    invoke<Comparison>("compare_refs", { repoPath: params.path, baseRef: refs.base, headRef: refs.head })
      .then((nextComparison) => {
        if (!cancelled) {
          reset()
          setExpanded(new Set())
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

  // A drawer laid over the diff is not somewhere to leave the tree parked, so the layout it belongs to
  // decides whether it is open. The side-by-side columns only get a starting say, so resizing never
  // undoes a layout that was picked deliberately. The panel is measured before it is painted, so the
  // toolbar is never laid out for a width the panel does not have.
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
        setMode(width < SPLIT_PANEL_WIDTH ? DiffModeEnum.Unified : DiffModeEnum.Split)
        setWrap(width < NARROW_PANEL_WIDTH)
      }
      const next = width < NARROW_PANEL_WIDTH
      if (narrow !== next) {
        narrow = next
        setIsNarrow(next)
        setIsSidebarOpen(!next)
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

  useEffect(() => {
    rowVirtualizer.measure()
  }, [mode, rowVirtualizer, wrap])

  useEffect(() => {
    request(virtualRows.map((row) => files[row.index]).filter((file) => !file.isBinary && (!isLargeDiff(file) || expanded.has(fileKey(file)))))
  }, [expanded, files, request, virtualRows])

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
    () => picker === null ? [] : searchReferences(searchQuery, { ...sources, allowWorktree: picker === "head", revision }),
    [picker, revision, searchQuery, sources]
  )
  const selectAheadRange = useCallback((reference: string) => {
    invoke<BranchSelection>("select_branch_range", { repoPath: params.path, reference })
      .then((selection) => setRefs({
        base: selection.baseSha,
        head: selection.headSha,
        baseLabel: selection.baseLabel,
        headLabel: selection.headLabel,
      }))
      .catch((message: unknown) => setError(String(message)))
    setPicker(null)
  }, [params.path])
  const menuItems = useMemo(
    () => hits.map((hit, index): SearchMenuItem => ({
      action: hit.branch === null ? undefined : {
        hint: `Compare what ${hit.branch} is ahead of the default branch by`,
        icon: GitCompareArrows,
        onSelect: () => selectAheadRange(hit.branch as string),
      },
      detail: hit.detail,
      icon: HIT_ICONS[hit.kind],
      key: `${hit.kind}-${hit.reference}-${index}`,
      label: hit.label,
    })),
    [hits, selectAheadRange]
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

  const selectFile = useCallback((file: ChangedFile) => {
    scrollToFile(file)
    if (isNarrow) {
      setIsSidebarOpen(false)
    }
  }, [isNarrow, scrollToFile])
  const fileList = useMemo(() => <FileTree activeKey={activeKey} files={tree} onSelect={selectFile} />, [activeKey, selectFile, tree])

  function openPicker(side: PickerSide) {
    setPicker(side)
    setSearchInput("")
    setSearchQuery("")
    setHitIndex(0)
  }

  function selectHit(hit: ReferenceHit) {
    setRefs((current) => picker === "base"
      ? { ...current, base: hit.reference, baseLabel: hit.label }
      : { ...current, head: hit.reference, headLabel: hit.label })
    setPicker(null)
  }

  const isSplit = (mode & DiffModeEnum.Split) !== 0
  const pickerAnchor = pickerButtons.current[picker ?? "base"]
  const pickerLeft = isNarrow || !pickerAnchor
    ? 8
    : Math.max(8, Math.min(pickerAnchor.offsetLeft, panelWidth - PICKER_MENU_WIDTH - 8))

  const sidebar = (
    <nav aria-label="Changed files" className="diff-file-list">
      {fileList}
      {comparison?.files.length === 0 && <p className="diff-empty">No changed files</p>}
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
                entry={entries[fileKey(file)]}
                expanded={expanded.has(fileKey(file))}
                file={file}
                mode={mode}
                onExpand={() => setExpanded((current) => new Set(current).add(fileKey(file)))}
                theme={theme}
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
          <Button aria-expanded={isSidebarOpen} aria-label="Toggle changed files" onClick={() => setIsSidebarOpen((current) => !current)} size="icon-sm" type="button" variant="outline">
            <PanelLeft />
          </Button>
        </Hinted>
        <Button aria-expanded={picker === "base"} className={isNarrow ? "min-w-0 flex-1 justify-between" : "w-45 justify-between"} onClick={() => openPicker("base")} ref={(element) => { pickerButtons.current.base = element }} size="sm" type="button" variant="outline">
          <span className="truncate">{refs.baseLabel}</span>
          <ChevronDown />
        </Button>
        <span className="shrink-0 text-muted-foreground">…</span>
        <Button aria-expanded={picker === "head"} className={isNarrow ? "min-w-0 flex-1 justify-between" : "w-45 justify-between"} onClick={() => openPicker("head")} ref={(element) => { pickerButtons.current.head = element }} size="sm" type="button" variant="outline">
          <span className="truncate">{refs.headLabel}</span>
          <ChevronDown />
        </Button>
        <div className="ml-auto flex shrink-0 items-center gap-1">
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
              <DropdownMenuLabel>Layout</DropdownMenuLabel>
              <DropdownMenuCheckboxItem checked={isSplit} onCheckedChange={() => setMode(DiffModeEnum.Split)} onSelect={(event) => event.preventDefault()}>
                <Columns2 />
                Split
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={!isSplit} onCheckedChange={() => setMode(DiffModeEnum.Unified)} onSelect={(event) => event.preventDefault()}>
                <Rows3 />
                Unified
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem checked={wrap} onCheckedChange={(checked) => setWrap(checked === true)} onSelect={(event) => event.preventDefault()}>
                Wrap long lines
              </DropdownMenuCheckboxItem>
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
