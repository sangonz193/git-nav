import { DiffModeEnum, DiffView } from "@git-diff-view/react"
import { invoke } from "@tauri-apps/api/core"
import { useVirtualizer } from "@tanstack/react-virtual"
import type { IDockviewPanelProps } from "dockview-react"
import { ChevronDown, ChevronRight, FileCode2, Folder, FolderOpen, WrapText } from "lucide-react"
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react"

import { Button } from "@workspace/shadcn/components/button"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@workspace/shadcn/components/resizable"
import { useTheme } from "@/components/theme-provider"
import { drawCommitGraph } from "../commit-graph/commit-graph-canvas"
import { commitFromTuple, displayRefs, GRAPH_COLORS, ROW_HEIGHT, type Commit, type CommitBatch } from "../commit-graph/commit-graph"
import type { DiffPanelParams } from "../repository/repository-window"

const MAX_CONCURRENT_DIFF_LOADS = 4
const LARGE_DIFF_LINES = 1200
const DIFF_ROW_HEIGHT = 22.4
const HUNK_ROW_HEIGHT = 29
const FILE_HEADER_HEIGHT = 34
const COLLAPSED_BODY_HEIGHT = 44

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

function fileName(file: ChangedFile) {
  return file.newPath ?? file.oldPath ?? "Unknown file"
}

function fileKey(file: ChangedFile) {
  return `${file.status}:${file.oldPath}:${file.newPath}`
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
  const paddingLeft = 8 + level * 16

  if (node.file) {
    const key = fileKey(node.file)
    return (
      <button className={`diff-file${key === activeKey ? " is-selected" : ""}`} key={key} onClick={() => onSelect(node.file!)} style={{ paddingLeft }} type="button">
        <span className="diff-file-status">{node.file.status.slice(0, 1).toUpperCase()}</span>
        <span className="truncate">{node.name}</span>
      </button>
    )
  }

  return (
    <div className="diff-folder">
      <button aria-expanded={open} className="diff-folder-button" onClick={() => setOpen((current) => !current)} style={{ paddingLeft }} type="button">
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {open ? <FolderOpen className="size-4" /> : <Folder className="size-4" />}
        <span className="truncate">{node.name}</span>
      </button>
      {open && <div className="diff-folder-children">
        {node.children.map((child) => <FileTreeNode activeKey={activeKey} key={child.path} level={level + 1} node={child} onSelect={onSelect} />)}
      </div>}
    </div>
  )
}

function ReferencePicker({ label, onCommit, onBranch, path }: { label: string; onCommit: (commit: Commit) => void; onBranch: (reference: string) => void; path: string }) {
  const [open, setOpen] = useState(false)
  const [commits, setCommits] = useState<Commit[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const scrollElement = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [scroll, setScroll] = useState({ top: 0, height: 0 })
  const rowVirtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => scrollElement.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })
  const virtualRows = rowVirtualizer.getVirtualItems()
  const updateScroll = useCallback(() => {
    const element = scrollElement.current
    if (element) {
      setScroll({ top: element.scrollTop, height: element.clientHeight })
    }
  }, [])

  useEffect(() => {
    if (!open || loaded) {
      return
    }
    let cancelled = false
    invoke<CommitBatch>("reference_picker_commits", { repoPath: path })
      .then((batch) => {
        if (!cancelled) {
          setCommits(batch.map(commitFromTuple))
          setError(null)
          setLoaded(true)
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
  }, [loaded, open, path])

  useEffect(() => {
    const element = scrollElement.current
    if (!open || !element) {
      return
    }
    const observer = new ResizeObserver(updateScroll)
    observer.observe(element)
    return () => observer.disconnect()
  }, [open, updateScroll])

  useEffect(() => {
    if (canvas.current && scroll.height > 0) {
      drawCommitGraph(canvas.current, commits, virtualRows, scroll.top, scroll.height, [])
    }
  }, [commits, scroll, virtualRows])

  return (
    <div className="diff-reference-picker">
      <Button aria-expanded={open} className="w-45 justify-between" onClick={() => setOpen((current) => !current)} type="button" variant="outline">
        <span className="truncate">{label}</span>
        <ChevronDown />
      </Button>
      {open && <div className="diff-picker-menu">
        <header className="diff-picker-header">Select a commit, or select a ref to compare its ahead range</header>
        <div className="diff-picker-graph-header">
          <span>Graph</span>
          <span>Refs</span>
          <span>Subject</span>
          <span>Commit</span>
        </div>
        <div className="diff-picker-scroll" onScroll={updateScroll} ref={scrollElement}>
          <div className="diff-picker-space" style={{ height: rowVirtualizer.getTotalSize() }}>
            <canvas aria-hidden className="diff-picker-graph-canvas" ref={canvas} />
            {virtualRows.map((row) => {
              const commit = commits[row.index]
              const refColor = GRAPH_COLORS[commit.lane % GRAPH_COLORS.length]
              return (
                <article className="diff-picker-row" key={commit.hash} onClick={() => {
                  onCommit(commit)
                  setOpen(false)
                }} style={{ transform: `translateY(${row.start}px)` }}>
                  <div className="diff-picker-row-refs">
                    {displayRefs(commit.refs).map((ref, index) => (
                      <button className="diff-picker-ref" key={`${ref.label}-${index}`} onClick={(event) => {
                        event.stopPropagation()
                        onBranch(ref.label.replace(" · origin", ""))
                        setOpen(false)
                      }} style={{ "--commit-ref-color": refColor } as CSSProperties} type="button">
                        {ref.checkedOut && <span className="commit-ref-head">HEAD</span>}
                        {ref.label}
                      </button>
                    ))}
                  </div>
                  <span className="truncate font-medium">{commit.subject || "(no subject)"}</span>
                  <code className="text-muted-foreground">{commit.hash.slice(0, 8)}</code>
                </article>
              )
            })}
          </div>
          {!error && commits.length === 0 && <p className="diff-picker-empty">Loading graph…</p>}
          {error && <p className="diff-picker-empty text-destructive">{error}</p>}
        </div>
      </div>}
    </div>
  )
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
      return <DiffView data={entry.data} diffViewHighlight diffViewMode={mode} diffViewTheme={theme} diffViewWrap={wrap} />
    }
    if (isLargeDiff(file) && !expanded) {
      return (
        <p className="diff-file-card-notice">
          Large diff with {(file.additions + file.deletions).toLocaleString()} changed lines
          <Button onClick={onExpand} size="sm" type="button" variant="outline">Show diff</Button>
        </p>
      )
    }
    return <div style={{ height: estimatedBodyHeight(file, mode) }} />
  }

  return (
    <article className="diff-file-card">
      <header className="diff-file-card-header">
        <span className="diff-file-status">{file.status.slice(0, 1).toUpperCase()}</span>
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
  const { theme } = useTheme()
  const [refs, setRefs] = useState<SelectedRefs>({
    base: params.baseRef,
    head: params.headRef,
    baseLabel: params.baseRef,
    headLabel: params.headRef,
  })
  const [comparison, setComparison] = useState<Comparison | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState(DiffModeEnum.Split)
  const [wrap, setWrap] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const scrollElement = useRef<HTMLDivElement>(null)
  const pendingScroll = useRef<string | null>(null)
  const { entries, request, reset } = useDiffLoader(params.path, comparison)
  const tree = useMemo(() => fileTree(comparison?.files ?? []), [comparison])
  const files = useMemo(() => flattenTree(tree), [tree])
  const diffTheme = theme === "light" || (theme === "system" && !window.matchMedia("(prefers-color-scheme: dark)").matches) ? "light" : "dark"

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
  }, [params.path, refs, reset])

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
  const fileList = useMemo(() => <FileTree activeKey={activeKey} files={tree} onSelect={scrollToFile} />, [activeKey, scrollToFile, tree])

  const selectCommit = (side: "base" | "head", commit: Commit) => {
    setRefs((current) => side === "base"
      ? { ...current, base: commit.hash, baseLabel: commit.hash.slice(0, 8) }
      : { ...current, head: commit.hash, headLabel: commit.hash.slice(0, 8) })
  }
  const selectBranch = (reference: string) => {
    invoke<BranchSelection>("select_branch_range", { repoPath: params.path, reference })
      .then((selection) => setRefs({
        base: selection.baseSha,
        head: selection.headSha,
        baseLabel: selection.baseLabel,
        headLabel: selection.headLabel,
      }))
      .catch((message: unknown) => setError(String(message)))
  }

  return (
    <section className="diff-panel">
      <div className="diff-toolbar">
        <ReferencePicker label={refs.baseLabel} onBranch={selectBranch} onCommit={(commit) => selectCommit("base", commit)} path={params.path} />
        <span className="text-muted-foreground">…</span>
        <ReferencePicker label={refs.headLabel} onBranch={selectBranch} onCommit={(commit) => selectCommit("head", commit)} path={params.path} />
        <div className="ml-auto flex items-center gap-1">
          <Button aria-label="Toggle unified view" onClick={() => setMode((current) => current === DiffModeEnum.Split ? DiffModeEnum.Unified : DiffModeEnum.Split)} size="icon" type="button">
            <FileCode2 />
          </Button>
          <Button aria-label="Toggle line wrapping" onClick={() => setWrap((current) => !current)} size="icon" type="button" variant={wrap ? "secondary" : "ghost"}>
            <WrapText />
          </Button>
        </div>
      </div>
      <ResizablePanelGroup className="diff-content" orientation="horizontal">
        <ResizablePanel defaultSize="22%" maxSize="40%" minSize="15%">
          <nav aria-label="Changed files" className="diff-file-list">
            {fileList}
            {comparison?.files.length === 0 && <p className="diff-empty">No changed files</p>}
          </nav>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel minSize="40%">
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
                      theme={diffTheme}
                      wrap={wrap}
                    />
                  </div>
                )
              })}
            </div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </section>
  )
}
