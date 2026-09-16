import { DiffModeEnum } from "@git-diff-view/react"
import { invoke } from "@/lib/ipc"
import { INDEX_REF, WORKTREE_REF } from "@/lib/repository-constants"
import { useTabScrollTop } from "@/lib/tab-scroll"
import type { IDockviewPanelProps } from "dockview-react"
import {
  AppWindow,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  PanelLeft,
  RefreshCw,
  Rows3,
  SlidersHorizontal,
} from "lucide-react"
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import { Button } from "@workspace/shadcn/components/button"
import { ButtonGroup } from "@workspace/shadcn/components/button-group"
import { Checkbox } from "@workspace/shadcn/components/checkbox"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/shadcn/components/dropdown-menu"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@workspace/shadcn/components/resizable"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/shadcn/components/tooltip"
import { toast } from "@workspace/shadcn/components/sonner"
import { cn } from "@workspace/shadcn/lib/utils"
import { Hinted } from "@/components/hinted"
import { useTheme } from "@/components/theme-provider"
import { PENDING_OPERATION_LABELS } from "../commit-graph/commit-graph"
import type { OperationResult } from "../commit-graph/commit-operations"
import { FileDiffCard, FileTree } from "../diff/diff-cards"
import { FileStat } from "../diff/file-stat"
import {
  changedLines,
  fileTree,
  flattenTree,
  useDiffCards,
  useDiffLoader,
  type FileDiff,
} from "../diff/diff-files"
import {
  fileName,
  initialDiffLayout,
  NARROW_DIFF_PANEL_WIDTH,
  toggledDiffFileTree,
  type ChangedFile,
} from "../diff/diff-panel-state"
import type {
  WorkingTreePanelParams,
  WorkingTreePanelUserPreferences,
} from "@/lib/panel-params"
import {
  amendMessage,
  areaLabel,
  canCommit,
  commitLabel,
  filePaths,
  pendingOperationBlocksCommit,
  persistedWorkingTreePanelParams,
  selectedFilePathOf,
  workingTreeFileKey,
  workingTreeFiles,
  worktreeName,
  type Area,
  type WorkingTree,
  type WorkingTreeFile,
  type WorktreeStatus,
} from "./working-tree-state"

const FINGERPRINT_INTERVAL = 2_000

type Snapshot = { fingerprint: string; tree: WorkingTree }

// Reading the fingerprint before the tree ensures a later change is detected by the next poll.
async function readSnapshot(path: string): Promise<Snapshot> {
  const fingerprint = await invoke<string>("working_tree_fingerprint", {
    repoPath: path,
  })
  const tree = await invoke<WorkingTree>("working_tree", { repoPath: path })
  return { fingerprint, tree }
}

type Reading = {
  path: string
  snapshot: Snapshot | null
  error: string | null
}

// What was read belongs to the path it was read from, so moving the tab to another worktree shows nothing
// of the old one while the new one is being read.
function useWorkingTree(
  path: string,
  version: number,
  onSnapshot: (snapshot: Snapshot) => void,
) {
  const [reading, setReading] = useState<Reading>({
    path,
    snapshot: null,
    error: null,
  })
  const current = useRef<Snapshot | null>(null)
  const generation = useRef(0)
  const readInFlight = useRef(false)

  const refresh = useCallback(() => {
    const started = ++generation.current
    readInFlight.current = true
    return readSnapshot(path)
      .then((snapshot) => {
        if (generation.current !== started) {
          return
        }
        onSnapshot(snapshot)
        current.current = snapshot
        setReading({ path, snapshot, error: null })
      })
      .catch((message: unknown) => {
        if (generation.current === started) {
          setReading((last) => ({
            path,
            snapshot: last.path === path ? last.snapshot : null,
            error: String(message),
          }))
        }
      })
      .finally(() => {
        if (generation.current === started) {
          readInFlight.current = false
        }
      })
  }, [onSnapshot, path])

  useEffect(() => {
    current.current = null
    void refresh()
  }, [refresh, version])

  // Anything can touch a working tree: an editor, a terminal, an agent. The poll notices, the reload follows.
  useEffect(() => {
    let inFlight = false
    let disposed = false
    const poll = () => {
      if (inFlight || document.hidden) {
        return
      }
      inFlight = true
      invoke<string>("working_tree_fingerprint", { repoPath: path })
        .then((fingerprint) => {
          if (disposed) {
            return
          }
          if (!current.current && !readInFlight.current) {
            void refresh()
          } else if (
            !readInFlight.current &&
            current.current &&
            current.current.fingerprint !== fingerprint
          ) {
            void refresh()
          }
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false
        })
    }
    const interval = window.setInterval(poll, FINGERPRINT_INTERVAL)
    window.addEventListener("focus", poll)
    return () => {
      disposed = true
      window.clearInterval(interval)
      window.removeEventListener("focus", poll)
    }
  }, [path, refresh])

  const shown = reading.path === path ? reading : null
  return {
    error: shown?.error ?? null,
    refresh,
    tree: shown?.snapshot?.tree ?? null,
  }
}

function useWorktrees(path: string, enabled: boolean) {
  const [worktrees, setWorktrees] = useState<WorktreeStatus[]>([])
  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    invoke<WorktreeStatus[]>("worktree_status", { repoPath: path })
      .then((list) => !cancelled && setWorktrees(list))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [enabled, path])
  return worktrees
}

function worktreeDetail(worktree: WorktreeStatus) {
  const changes = worktree.changedFiles + worktree.untrackedFiles
  return [
    worktree.isDetached ? "Detached" : worktree.branch,
    changes > 0 && `${changes.toLocaleString()} uncommitted`,
  ]
    .filter(Boolean)
    .join(" · ")
}

function AreaHeader({
  area,
  count,
  disabled,
  onToggle,
}: {
  area: Area
  count: number
  disabled: boolean
  onToggle: () => void
}) {
  const checked = area === "staged" && count > 0
  return (
    <label className="working-tree-area">
      <Checkbox
        aria-label={checked ? "Unstage all files" : "Stage all files"}
        checked={checked}
        disabled={disabled || count === 0}
        onCheckedChange={onToggle}
      />
      <span>{areaLabel(area, count)}</span>
    </label>
  )
}

export function WorkingTreePanel({
  api,
  params,
}: IDockviewPanelProps<WorkingTreePanelParams>) {
  const theme = useTheme()
  const [version, setVersion] = useState(0)
  const [message, setMessage] = useState("")
  const [amend, setAmend] = useState(false)
  const amendingHead = useRef<Pick<
    WorkingTree,
    "branch" | "headSha" | "headMessage"
  > | null>(null)
  const resetAmend = useCallback((headMessage: string | null) => {
    const wasAmending = amendingHead.current !== null
    amendingHead.current = null
    setAmend(false)
    setMessage((current) =>
      amendMessage(current, headMessage, false, wasAmending),
    )
  }, [])
  const applySnapshot = useCallback(
    (snapshot: Snapshot) => {
      if (
        amendingHead.current &&
        (amendingHead.current.headSha !== snapshot.tree.headSha ||
          amendingHead.current.branch !== snapshot.tree.branch)
      ) {
        resetAmend(amendingHead.current.headMessage)
      }
    },
    [resetAmend],
  )
  const { error, refresh, tree } = useWorkingTree(
    params.path,
    version,
    applySnapshot,
  )
  const [mode, setMode] = useState(
    params.userPreferences?.mode === "unified" ?
      DiffModeEnum.Unified
    : DiffModeEnum.Split,
  )
  const [wrap, setWrap] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [allExpanded, setAllExpanded] = useState<ReadonlySet<string>>(new Set())
  const [handFolds, setHandFolds] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  )
  const [isSidebarOpen, setIsSidebarOpen] = useState(
    params.userPreferences?.fileTreeOpen ?? true,
  )
  const [userPreferences, setUserPreferences] =
    useState<WorkingTreePanelUserPreferences>(
      () => params.userPreferences ?? {},
    )
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(
    params.selectedFilePath ?? null,
  )
  const [busy, setBusy] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [isNarrow, setIsNarrow] = useState(false)
  const [panel, setPanel] = useState<HTMLElement | null>(null)
  const scrollElement = useRef<HTMLDivElement>(null)
  useTabScrollTop(api, scrollElement)
  const userPreferencesRef = useRef(userPreferences)
  const pendingRestoredFilePath = useRef(params.selectedFilePath ?? null)
  const worktrees = useWorktrees(params.path, pickerOpen)

  const allFiles = useMemo(() => workingTreeFiles(tree), [tree])
  const stagedTree = useMemo(
    () => fileTree(allFiles.filter((file) => file.area === "staged")),
    [allFiles],
  )
  const unstagedTree = useMemo(
    () => fileTree(allFiles.filter((file) => file.area === "unstaged")),
    [allFiles],
  )
  const files = useMemo(
    () => [...flattenTree(stagedTree), ...flattenTree(unstagedTree)],
    [stagedTree, unstagedTree],
  )
  const total = useMemo(() => changedLines(allFiles), [allFiles])
  const keyOf = useCallback(
    (file: ChangedFile) => workingTreeFileKey(file as WorkingTreeFile),
    [],
  )
  const areaOf = (file: ChangedFile) => (file as WorkingTreeFile).area

  // A file's diff belongs to the snapshot it was read from, so each snapshot reads its files afresh.
  const loadDiff = useMemo(
    () =>
      tree &&
      ((file: ChangedFile) =>
        invoke<FileDiff>("diff_file", {
          repoPath: params.path,
          baseSha: areaOf(file) === "staged" ? "HEAD" : INDEX_REF,
          headSha: areaOf(file) === "staged" ? INDEX_REF : WORKTREE_REF,
          oldPath: file.oldPath,
          newPath: file.newPath,
          ignoreWhitespace: false,
        })),
    [params.path, tree],
  )
  const { entries, request } = useDiffLoader(keyOf, loadDiff)
  const isFolded = useCallback(
    (file: ChangedFile) => handFolds.get(keyOf(file)) ?? false,
    [handFolds, keyOf],
  )
  const {
    activeKey,
    anchorAt,
    anchorFold,
    clearPendingScroll,
    rowVirtualizer,
    scrollToFile,
    virtualRows,
  } = useDiffCards({
    allExpanded,
    entries,
    expanded,
    files,
    isFolded,
    keyOf,
    mode,
    request,
    resetKey: params.path,
    scrollElement,
    wrap,
  })

  useEffect(() => {
    api.updateParameters(
      persistedWorkingTreePanelParams(
        { name: params.name, path: params.path },
        selectedFilePath,
        userPreferences,
      ),
    )
  }, [api, params.name, params.path, selectedFilePath, userPreferences])

  // A drawer laid over the diff is transient, while side-by-side columns honor an explicit preference.
  useLayoutEffect(() => {
    if (!panel) {
      return
    }
    let narrow: boolean | null = null
    const layOut = (width: number) => {
      if (width === 0) {
        return
      }
      if (narrow === null) {
        const layout = initialDiffLayout(width, userPreferencesRef.current)
        setMode(
          layout.mode === "unified" ? DiffModeEnum.Unified : DiffModeEnum.Split,
        )
        setIsSidebarOpen(layout.fileTreeOpen)
        setWrap(layout.wrap)
      }
      const next = width < NARROW_DIFF_PANEL_WIDTH
      if (narrow !== next) {
        if (narrow !== null) {
          setIsSidebarOpen(
            initialDiffLayout(width, userPreferencesRef.current).fileTreeOpen,
          )
        }
        narrow = next
        setIsNarrow(next)
      }
    }
    layOut(panel.getBoundingClientRect().width)
    const observer = new ResizeObserver(([entry]) =>
      layOut(entry.contentRect.width),
    )
    observer.observe(panel)
    return () => observer.disconnect()
  }, [panel])

  useEffect(() => {
    const path = pendingRestoredFilePath.current
    if (!tree || !path) {
      return
    }
    pendingRestoredFilePath.current = null
    const file = files.find((candidate) => fileName(candidate) === path)
    if (file) {
      scrollToFile(file)
    }
  }, [files, scrollToFile, tree])

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

  function toggleFileTree() {
    const next = toggledDiffFileTree(
      isSidebarOpen,
      isNarrow,
      userPreferencesRef.current,
    )
    if (next.preferences !== userPreferencesRef.current) {
      userPreferencesRef.current = next.preferences
      setUserPreferences(next.preferences)
    }
    setIsSidebarOpen(next.fileTreeOpen)
  }

  function toggleAllExpanded(file: ChangedFile) {
    const key = keyOf(file)
    const next = new Set(allExpanded)
    if (next.delete(key)) {
      anchorFold(file)
    } else {
      next.add(key)
    }
    setAllExpanded(next)
  }

  function toggleCollapsed(file: ChangedFile) {
    const next = new Map(handFolds)
    next.set(keyOf(file), !isFolded(file))
    anchorFold(file)
    setHandFolds(next)
  }

  function collapseAll(collapse: boolean) {
    anchorAt(activeKey)
    setHandFolds(new Map(files.map((file) => [keyOf(file), collapse])))
  }

  const selectFile = useCallback(
    (file: ChangedFile) => {
      pendingRestoredFilePath.current = null
      scrollToFile(file)
      setSelectedFilePath(selectedFilePathOf(file))
      if (isNarrow) {
        setIsSidebarOpen(false)
      }
    },
    [isNarrow, scrollToFile],
  )

  function report(title: string) {
    return (reason: unknown) => {
      toast.error(title, { description: String(reason) })
    }
  }

  function move(files: ChangedFile[], to: Area) {
    if (files.length === 0 || busy) {
      return
    }
    setBusy(true)
    invoke<void>(to === "staged" ? "stage_files" : "unstage_files", {
      repoPath: params.path,
      paths: filePaths(files),
    })
      .catch(
        report(to === "staged" ? "Could not stage." : "Could not unstage."),
      )
      .then(refresh)
      .finally(() => setBusy(false))
  }

  const toggleStaged = (file: ChangedFile) =>
    move([file], areaOf(file) === "staged" ? "unstaged" : "staged")

  function commit() {
    if (!canCommit(tree, message, amend) || busy) {
      return
    }
    setBusy(true)
    invoke<OperationResult>("commit_changes", {
      repoPath: params.path,
      message,
      amend,
      headSha: tree?.headSha,
      branch: tree?.branch,
      indexFingerprint: tree?.indexFingerprint,
    })
      .then((result) => {
        if (result.outcome === "failed") {
          toast.error("Could not commit.", { description: result.message })
          return
        }
        toast(result.summary)
        setMessage("")
        resetAmend(tree?.headMessage ?? null)
      })
      .catch(report("Could not commit."))
      .then(refresh)
      .finally(() => setBusy(false))
  }

  function onMessageKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      commit()
    }
  }

  function setAmending(next: boolean) {
    if (!next) {
      resetAmend(tree?.headMessage ?? null)
      return
    }
    amendingHead.current = {
      branch: tree?.branch ?? null,
      headSha: tree?.headSha ?? null,
      headMessage: tree?.headMessage ?? null,
    }
    setAmend(next)
    setMessage((current) =>
      amendMessage(current, tree?.headMessage ?? null, next, amend),
    )
  }

  // The tab follows the worktree it shows, in its parameters and in its name.
  function selectWorktree(worktree: WorktreeStatus) {
    setPickerOpen(false)
    if (worktree.path === params.path) {
      return
    }
    pendingRestoredFilePath.current = null
    clearPendingScroll()
    setSelectedFilePath(null)
    setHandFolds(new Map())
    setAllExpanded(new Set())
    setExpanded(new Set())
    resetAmend(tree?.headMessage ?? null)
    api.updateParameters({
      ...params,
      path: worktree.path,
      selectedFilePath: null,
    })
    api.setTitle(worktreeName(worktree.path))
  }

  const stagedCount = tree?.staged.length ?? 0
  const unstagedCount = tree?.unstaged.length ?? 0
  const isSplit = (mode & DiffModeEnum.Split) !== 0
  const pending = tree?.pendingOperation
  const commitBlockedByOperation = pendingOperationBlocksCommit(pending)
  const stageCheckbox = (file: ChangedFile) => (
    <Checkbox
      aria-label={areaOf(file) === "staged" ? "Unstage" : "Stage"}
      checked={areaOf(file) === "staged"}
      disabled={busy}
      onCheckedChange={() => toggleStaged(file)}
    />
  )

  const fileList = (
    <>
      <AreaHeader
        area="staged"
        count={stagedCount}
        disabled={busy}
        onToggle={() =>
          move(
            allFiles.filter((file) => file.area === "staged"),
            "unstaged",
          )
        }
      />
      <FileTree
        activeKey={activeKey}
        files={stagedTree}
        keyOf={keyOf}
        leading={stageCheckbox}
        onSelect={selectFile}
      />
      <AreaHeader
        area="unstaged"
        count={unstagedCount}
        disabled={busy}
        onToggle={() =>
          move(
            allFiles.filter((file) => file.area === "unstaged"),
            "staged",
          )
        }
      />
      <FileTree
        activeKey={activeKey}
        files={unstagedTree}
        keyOf={keyOf}
        leading={stageCheckbox}
        onSelect={selectFile}
      />
    </>
  )

  const emptyNotice = tree && files.length === 0 && (
    <p className="diff-empty">
      {tree.conflicted.length > 0 ? "Only conflicts are left" : "No changes"}
    </p>
  )

  const sidebar = (
    <nav aria-label="Working tree" className="diff-file-list">
      <header className="diff-file-total">
        <span>
          {allFiles.length === 1 ?
            "1 file"
          : `${allFiles.length.toLocaleString()} files`}
        </span>
        <FileStat additions={total.additions} deletions={total.deletions} />
      </header>
      <div className="diff-file-tree">
        {tree && tree.conflicted.length > 0 && (
          <div className="working-tree-conflicts">
            <p className="working-tree-area">
              Conflicts ({tree.conflicted.length.toLocaleString()})
            </p>
            {tree.conflicted.map((path) => (
              <p className="working-tree-conflict" key={path}>
                {path}
              </p>
            ))}
            <p className="working-tree-hint">
              Resolve these in an editor, then run <code>git add</code> on them
              in a terminal to mark them resolved.
            </p>
          </div>
        )}
        {fileList}
        {emptyNotice}
      </div>
      <form
        className="working-tree-commit"
        onSubmit={(event) => {
          event.preventDefault()
          commit()
        }}
      >
        <textarea
          aria-label="Commit message"
          className="working-tree-message"
          disabled={busy}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={onMessageKeyDown}
          placeholder={
            tree?.branch ? `Commit to ${tree.branch}` : "Commit message"
          }
          rows={3}
          value={message}
        />
        <div className="working-tree-commit-actions">
          <label
            className={cn(
              "working-tree-amend",
              !tree?.headSha && "text-muted-foreground",
            )}
          >
            <Checkbox
              checked={amend}
              disabled={busy || !tree?.headSha}
              onCheckedChange={(checked) => setAmending(checked === true)}
            />
            Amend
          </label>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            {commitBlockedByOperation && pending && (
              <span className="truncate text-xs text-muted-foreground">
                {`Finish ${PENDING_OPERATION_LABELS[pending]} in a terminal before committing here.`}
              </span>
            )}
            <Button
              disabled={busy || !canCommit(tree, message, amend)}
              size="sm"
              type="submit"
            >
              {commitLabel(stagedCount, amend)}
            </Button>
          </div>
        </div>
      </form>
    </nav>
  )

  const diffScroll = (
    <div className="diff-view-container" ref={scrollElement}>
      {error && <p className="diff-empty text-destructive">{error}</p>}
      {!tree && !error && <p className="diff-empty">Reading working tree…</p>}
      {!error && emptyNotice}
      <div
        className="diff-file-space"
        style={{ height: rowVirtualizer.getTotalSize() }}
      >
        {virtualRows.map((row) => {
          const file = files[row.index]
          const key = keyOf(file)
          return (
            <div
              className="diff-file-row"
              data-index={row.index}
              key={row.key}
              ref={rowVirtualizer.measureElement}
              style={{ top: row.start }}
            >
              <FileDiffCard
                action={
                  <label className="diff-file-card-viewed">
                    Staged
                    {stageCheckbox(file)}
                  </label>
                }
                allExpanded={allExpanded.has(key)}
                collapsed={isFolded(file)}
                entry={entries[key]}
                expanded={expanded.has(key)}
                file={file}
                mode={mode}
                onExpand={() =>
                  setExpanded((current) => new Set(current).add(key))
                }
                onToggleAllExpanded={() => toggleAllExpanded(file)}
                onToggleCollapsed={() => toggleCollapsed(file)}
                theme={theme}
                wrap={wrap}
              />
            </div>
          )
        })}
      </div>
      {files.length > 0 && <div className="diff-scroll-tail" />}
    </div>
  )

  return (
    <section className="diff-panel" ref={setPanel}>
      <div className="diff-toolbar">
        <Hinted
          hint={isSidebarOpen ? "Hide changed files" : "Show changed files"}
        >
          <Button
            aria-expanded={isSidebarOpen}
            aria-label="Toggle changed files"
            onClick={toggleFileTree}
            size="icon-sm"
            type="button"
            variant="outline"
          >
            <PanelLeft />
          </Button>
        </Hinted>
        <DropdownMenu onOpenChange={setPickerOpen} open={pickerOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              className={
                isNarrow ?
                  "min-w-0 flex-1 justify-between"
                : "w-60 justify-between"
              }
              size="sm"
              type="button"
              variant="outline"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <AppWindow className="shrink-0 text-muted-foreground" />
                <span className="truncate">{worktreeName(params.path)}</span>
                {tree && (
                  <span className="truncate text-xs text-muted-foreground">
                    {tree.branch ?? "Detached"}
                  </span>
                )}
              </span>
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuLabel>Worktrees</DropdownMenuLabel>
            {worktrees.map((worktree) => (
              <DropdownMenuItem
                className={cn(worktree.path === params.path && "bg-muted")}
                key={worktree.path}
                onSelect={() => selectWorktree(worktree)}
              >
                <AppWindow />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">
                    {worktreeName(worktree.path)}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {worktreeDetail(worktree)}
                  </span>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {pending && (
          <span className="truncate text-xs text-muted-foreground">
            {`Currently ${PENDING_OPERATION_LABELS[pending]}`}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {!isNarrow && (
            <ButtonGroup>
              <Hinted hint="Show both sides">
                <Button
                  aria-label="Split layout"
                  aria-pressed={isSplit}
                  onClick={() => setPreferredMode("split")}
                  size="icon-sm"
                  type="button"
                  variant="outline"
                >
                  <Columns2 />
                </Button>
              </Hinted>
              <Hinted hint="Show one column">
                <Button
                  aria-label="Unified layout"
                  aria-pressed={!isSplit}
                  onClick={() => setPreferredMode("unified")}
                  size="icon-sm"
                  type="button"
                  variant="outline"
                >
                  <Rows3 />
                </Button>
              </Hinted>
            </ButtonGroup>
          )}
          <DropdownMenu>
            <Tooltip>
              <DropdownMenuTrigger asChild>
                <TooltipTrigger asChild>
                  <Button
                    aria-label="View options"
                    size={isNarrow ? "icon-sm" : "sm"}
                    type="button"
                    variant="outline"
                  >
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
                  <DropdownMenuCheckboxItem
                    checked={isSplit}
                    onCheckedChange={() => setPreferredMode("split")}
                    onSelect={(event) => event.preventDefault()}
                  >
                    <Columns2 />
                    Split
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={!isSplit}
                    onCheckedChange={() => setPreferredMode("unified")}
                    onSelect={(event) => event.preventDefault()}
                  >
                    <Rows3 />
                    Unified
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuCheckboxItem
                checked={wrap}
                onCheckedChange={(checked) =>
                  setPreferredWrap(checked === true)
                }
                onSelect={(event) => event.preventDefault()}
              >
                Wrap long lines
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={files.length === 0}
                onSelect={() => collapseAll(true)}
              >
                <ChevronsDownUp />
                Collapse all files
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={files.length === 0}
                onSelect={() => collapseAll(false)}
              >
                <ChevronsUpDown />
                Expand all files
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Hinted hint="Reread the working tree">
            <Button
              aria-label="Refresh the working tree"
              onClick={() => setVersion((current) => current + 1)}
              size="icon-sm"
              type="button"
              variant="outline"
            >
              <RefreshCw />
            </Button>
          </Hinted>
        </div>
      </div>
      <div className="diff-content">
        {isNarrow ?
          <>
            {isSidebarOpen && (
              <div
                className="diff-drawer-backdrop"
                onClick={() => setIsSidebarOpen(false)}
              />
            )}
            {isSidebarOpen && <div className="diff-drawer">{sidebar}</div>}
            {diffScroll}
          </>
        : <ResizablePanelGroup orientation="horizontal">
            {isSidebarOpen && (
              <>
                <ResizablePanel defaultSize="26%" maxSize="45%" minSize="18%">
                  {sidebar}
                </ResizablePanel>
                <ResizableHandle />
              </>
            )}
            <ResizablePanel minSize="40%">{diffScroll}</ResizablePanel>
          </ResizablePanelGroup>
        }
      </div>
    </section>
  )
}
