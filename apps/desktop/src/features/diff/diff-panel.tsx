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

type ChangedFile = {
  status: string
  oldPath: string | null
  newPath: string | null
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

type LoadedFileDiff = FileDiff & {
  key: string
}

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

function FileTree({ files, onSelect, selectedFile }: { files: FileTreeNode[]; onSelect: (file: ChangedFile) => void; selectedFile: ChangedFile | null }) {
  return files.map((node) => <FileTreeNode key={node.path} level={0} node={node} onSelect={onSelect} selectedFile={selectedFile} />)
}

function FileTreeNode({ level, node, onSelect, selectedFile }: { level: number; node: FileTreeNode; onSelect: (file: ChangedFile) => void; selectedFile: ChangedFile | null }) {
  const [open, setOpen] = useState(true)
  const paddingLeft = 8 + level * 16

  if (node.file) {
    return (
      <button className={`diff-file${selectedFile === node.file ? " is-selected" : ""}`} key={fileKey(node.file)} onClick={() => onSelect(node.file!)} style={{ paddingLeft }} type="button">
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
        {node.children.map((child) => <FileTreeNode key={child.path} level={level + 1} node={child} onSelect={onSelect} selectedFile={selectedFile} />)}
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

export function DiffPanel({ params }: IDockviewPanelProps<DiffPanelParams>) {
  const { theme } = useTheme()
  const [refs, setRefs] = useState<SelectedRefs>({
    base: params.baseRef,
    head: params.headRef,
    baseLabel: params.baseRef,
    headLabel: params.headRef,
  })
  const [comparison, setComparison] = useState<Comparison | null>(null)
  const [selectedFile, setSelectedFile] = useState<ChangedFile | null>(null)
  const [diff, setDiff] = useState<LoadedFileDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState(DiffModeEnum.Split)
  const [wrap, setWrap] = useState(false)
  const files = useMemo(() => fileTree(comparison?.files ?? []), [comparison])

  useEffect(() => {
    let cancelled = false
    invoke<Comparison>("compare_refs", { repoPath: params.path, baseRef: refs.base, headRef: refs.head })
      .then((nextComparison) => {
        if (!cancelled) {
          setComparison(nextComparison)
          setSelectedFile(nextComparison.files[0] ?? null)
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
  }, [params.path, refs])

  useEffect(() => {
    if (!comparison || !selectedFile) {
      return
    }
    let cancelled = false
    const selectedKey = fileKey(selectedFile)
    invoke<FileDiff>("diff_file", {
      repoPath: params.path,
      baseSha: comparison.baseSha,
      headSha: comparison.headSha,
      oldPath: selectedFile.oldPath,
      newPath: selectedFile.newPath,
    })
      .then((nextDiff) => {
        if (!cancelled) {
          setDiff({ ...nextDiff, key: selectedKey })
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
  }, [comparison, params.path, selectedFile])

  const selectedDiff = diff?.key === (selectedFile ? fileKey(selectedFile) : null) ? diff : null
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
            <FileTree files={files} onSelect={setSelectedFile} selectedFile={selectedFile} />
            {comparison?.files.length === 0 && <p className="diff-empty">No changed files</p>}
          </nav>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel minSize="40%">
          <div className="diff-view-container">
            {error && <p className="diff-empty text-destructive">{error}</p>}
            {selectedDiff?.isBinary && <p className="diff-empty">Binary file changed</p>}
            {selectedDiff && !selectedDiff.isBinary && <DiffView
              data={{
                oldFile: { fileName: selectedDiff.oldFileName, content: selectedDiff.oldContent },
                newFile: { fileName: selectedDiff.newFileName, content: selectedDiff.newContent },
                hunks: selectedDiff.hunks,
              }}
              diffViewHighlight
              diffViewMode={mode}
              diffViewTheme={theme === "light" || (theme === "system" && !window.matchMedia("(prefers-color-scheme: dark)").matches) ? "light" : "dark"}
              diffViewWrap={wrap}
            />}
            {!comparison && !error && <p className="diff-empty">Loading comparison…</p>}
            {comparison && !selectedFile && comparison.files.length > 0 && <p className="diff-empty">Select a file</p>}
            {selectedFile && !selectedDiff && !error && <p className="diff-empty">Loading file…</p>}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </section>
  )
}
