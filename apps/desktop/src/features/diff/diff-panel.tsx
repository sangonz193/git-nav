import { DiffModeEnum } from "@git-diff-view/react"
import { invoke } from "@/lib/ipc"
import { EMPTY_TREE_REF, WORKTREE_REF } from "@/lib/repository-constants"
import { useTabScrollTop } from "@/lib/tab-scroll"
import type { IDockviewPanelProps } from "dockview-react"
import {
  Archive,
  ChevronDown,
  Cloud,
  Columns2,
  FilePen,
  GitBranch,
  GitCompareArrows,
  Hash,
  PanelLeft,
  RefreshCw,
  Rows3,
  SlidersHorizontal,
  Tag,
} from "lucide-react"
import {
  type ComponentType,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import { Button } from "@workspace/shadcn/components/button"
import { ButtonGroup } from "@workspace/shadcn/components/button-group"
import { Checkbox } from "@workspace/shadcn/components/checkbox"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/shadcn/components/popover"
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
import { Hinted } from "@/components/hinted"
import {
  FoldButtons,
  LabeledRow,
  PanelHeading,
  PanelSection,
  Segmented,
  SwitchRow,
} from "@/components/view-panel"
import { SearchMenu, type SearchMenuItem } from "@/components/search-menu"
import { useTheme } from "@/components/theme-provider"
import {
  commitFromTuple,
  type Commit,
  type CommitBatch,
  type StashEntry,
} from "../commit-graph/commit-graph"
import { getWorktreeStatusCache } from "../commit-graph/worktree-status-cache"
import {
  isRevisionExpression,
  searchReferences,
  worktreeRefLabel,
  type HitKind,
  type Reference,
  type ReferenceHit,
  type ResolvedRevision,
} from "./reference-search"
import {
  branchRangeTitle,
  defaultBranchName,
  diffTitle,
  isDefaultBranch,
  rangeMarker,
  refLabel,
  selectedRefs,
  type SelectedRefs,
} from "./diff-title"
import {
  carriedFolds,
  carriedKeys,
  changedFilesLabel,
  fileIdentity,
  fileName,
  initialDiffLayout,
  isFoldedFile,
  isSameComparison,
  isViewedFile,
  NARROW_DIFF_PANEL_WIDTH,
  persistedDiffPanelParams,
  sameMarks,
  toggledDiffFileTree,
  WIDE_DIFF_PANEL_WIDTH,
  type ChangedFile,
  type Comparison,
} from "./diff-panel-state"
import { FileDiffCard, FileTree } from "./diff-cards"
import {
  changedLines,
  fileTree,
  flattenTree,
  isLargeDiff,
  useDiffCards,
  useDiffLoader,
  type FileDiff,
} from "./diff-files"
import { FileStat } from "./file-stat"
import type {
  DiffPanelParams,
  DiffPanelUserPreferences,
} from "@/lib/panel-params"

const SEARCH_DEBOUNCE = 120
const FINGERPRINT_INTERVAL = 2_000
const LAYOUT_OPTIONS: {
  icon: typeof Columns2
  label: string
  value: "split" | "unified"
}[] = [
  { icon: Columns2, label: "Split", value: "split" },
  { icon: Rows3, label: "Unified", value: "unified" },
]
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

type ViewedFile = {
  path: string
  identity: string
}

type LoadedComparison = {
  comparison: Comparison
  ignoreWhitespace: boolean
  path: string
  refs: SelectedRefs
}

type BranchSelection = {
  baseRef: string
  headRef: string
}

type PickerSide = "base" | "head"

function HeadPickerLabel({
  label,
  reference,
}: {
  label: string
  reference: string
}) {
  const shortRef = refLabel(reference)
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
      <span className="truncate">{label || "(no subject)"}</span>
      {reference !== WORKTREE_REF &&
        shortRef !== reference &&
        shortRef !== label && (
          <code className="shrink-0 text-xs text-muted-foreground">
            {shortRef}
          </code>
        )}
    </span>
  )
}

function fileKey(file: ChangedFile) {
  return `${file.status}:${file.oldPath}:${file.newPath}`
}

// Branches move on commit or fetch, and the working tree on any edit.
function comparisonFingerprint(path: string, head: string) {
  return Promise.all([
    invoke<string>("repository_fingerprint", { repoPath: path }),
    head === WORKTREE_REF ?
      invoke<string>("working_tree_fingerprint", { repoPath: path })
    : null,
  ]).then((parts) => parts.join(":"))
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
    const settle = <T,>(value: T, apply: (value: T) => void) =>
      !cancelled && apply(value)
    invoke<Reference[]>("repository_references", { repoPath: path })
      .then((value) => settle(value, setReferences))
      .catch(() => undefined)
    invoke<StashEntry[]>("stash_list", { repoPath: path })
      .then((value) => settle(value, setStashes))
      .catch(() => undefined)
    invoke<CommitBatch>("reference_picker_commits", { repoPath: path })
      .then((batch) => settle(batch.map(commitFromTuple), setCommits))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [enabled, path, version])

  return useMemo(
    () => ({ commits, references, stashes }),
    [commits, references, stashes],
  )
}

export function DiffPanel({
  api,
  params,
}: IDockviewPanelProps<DiffPanelParams>) {
  const theme = useTheme()
  const [refs, setRefs] = useState<SelectedRefs>(
    selectedRefs(
      params.baseRef,
      params.headRef,
      params.mergeBase ?? false,
      params.baseLabel,
      params.headLabel,
    ),
  )
  const [worktreePath, setWorktreePath] = useState(params.path)
  const [loadedComparison, setLoadedComparison] =
    useState<LoadedComparison | null>(null)
  const comparison = loadedComparison?.comparison ?? null
  const [error, setError] = useState<string | null>(null)
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
  const [viewed, setViewed] = useState<ReadonlyMap<string, string>>(new Map())
  const [hideViewed, setHideViewed] = useState(
    params.userPreferences?.hideViewed ?? false,
  )
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(
    params.userPreferences?.ignoreWhitespace ?? false,
  )
  const [version, setVersion] = useState(0)
  const [picker, setPicker] = useState<PickerSide | null>(null)
  const [searchInput, setSearchInput] = useState("")
  const [searchQuery, setSearchQuery] = useState("")
  const [hitIndex, setHitIndex] = useState(0)
  const [resolvedRevision, setResolvedRevision] = useState<{
    query: string
    revision: ResolvedRevision
  } | null>(null)
  const [isSidebarOpen, setIsSidebarOpen] = useState(
    params.userPreferences?.fileTreeOpen ?? true,
  )
  const [userPreferences, setUserPreferences] =
    useState<DiffPanelUserPreferences>(() => params.userPreferences ?? {})
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(
    params.selectedFilePath ?? null,
  )
  const [isNarrow, setIsNarrow] = useState(false)
  const [isDrawerLayout, setIsDrawerLayout] = useState(false)
  const [panelWidth, setPanelWidth] = useState(0)
  const [panel, setPanel] = useState<HTMLElement | null>(null)
  const [toolbarElement, setToolbarElement] = useState<HTMLDivElement | null>(
    null,
  )
  const initializedLayout = useRef(false)
  const scrollElement = useRef<HTMLDivElement>(null)
  useTabScrollTop(api, scrollElement)
  const marksDuringLoad = useRef<Map<string, string | null> | null>(null)
  const shownFingerprint = useRef<string | null>(null)
  const userPreferencesRef = useRef(userPreferences)
  const pendingRestoredFilePath = useRef(params.selectedFilePath ?? null)
  const loadDiff = useMemo(
    () =>
      loadedComparison &&
      ((file: ChangedFile) =>
        invoke<FileDiff>("diff_file", {
          repoPath: loadedComparison.path,
          baseSha: loadedComparison.comparison.baseSha,
          headSha: loadedComparison.comparison.headSha,
          oldPath: file.oldPath,
          newPath: file.newPath,
          ignoreWhitespace: loadedComparison.ignoreWhitespace,
        })),
    [loadedComparison],
  )
  // Only moving an end starts the list over; a reread keeps the scroll position and the loaded diffs.
  const comparisonScope = loadedComparison?.refs ?? null
  const { entries, isOutdated, request, retryFailed } = useDiffLoader(
    fileKey,
    loadDiff,
    comparisonScope,
    comparison?.files,
  )
  const worktreeStatusCache = getWorktreeStatusCache(worktreePath)
  const { currentBranch, defaultBranch, remotes, worktrees } =
    useSyncExternalStore(
      worktreeStatusCache.subscribe,
      worktreeStatusCache.getDiffSnapshot,
      worktreeStatusCache.getDiffSnapshot,
    )
  const currentWorktree = { branch: currentBranch, path: worktreePath }
  const baseLabel = worktreeRefLabel(refs.base, refs.baseLabel, currentWorktree)
  const headLabel = worktreeRefLabel(refs.head, refs.headLabel, currentWorktree)
  const pickerOpen = picker !== null
  const sources = useReferenceSources(worktreePath, pickerOpen, version)

  useEffect(() => {
    void worktreeStatusCache.refresh("repository", version > 0)
  }, [worktreeStatusCache, version])
  useEffect(() => {
    if (pickerOpen) void worktreeStatusCache.refresh("project")
  }, [pickerOpen, worktreeStatusCache, version])

  const shownFiles = useMemo(
    () =>
      hideViewed ?
        (comparison?.files ?? []).filter(
          (file) => !isViewedFile(file, refs.head, viewed),
        )
      : (comparison?.files ?? []),
    [comparison, hideViewed, refs.head, viewed],
  )
  const tree = useMemo(() => fileTree(shownFiles), [shownFiles])
  const files = useMemo(() => flattenTree(tree), [tree])
  const total = useMemo(
    () => changedLines(comparison?.files ?? []),
    [comparison],
  )
  const viewedCount = useMemo(
    () =>
      (comparison?.files ?? []).filter((file) =>
        isViewedFile(file, refs.head, viewed),
      ).length,
    [comparison, refs.head, viewed],
  )
  const changedCount = comparison?.files.length ?? 0

  const isFolded = useCallback(
    (file: ChangedFile) =>
      isFoldedFile(file, refs.head, viewed, handFolds, fileKey(file)),
    [handFolds, refs.head, viewed],
  )
  const folds = useMemo(() => {
    let folded = 0
    for (const file of files) {
      if (isFolded(file)) {
        folded += 1
      }
    }
    return {
      allCollapsed: files.length > 0 && folded === files.length,
      allExpanded: files.length > 0 && folded === 0,
    }
  }, [files, isFolded])
  // Until the comparison for the current ends lands, the files on screen belong to the previous one, and
  // a fold set across all of them would be carried onto whichever files the next one happens to share.
  const isComparisonStale =
    loadedComparison !== null && loadedComparison.refs !== refs

  function toggleFileTree() {
    const next = toggledDiffFileTree(
      isSidebarOpen,
      isDrawerLayout,
      userPreferencesRef.current,
    )
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

  function setPreferredHideViewed(hidden: boolean) {
    const next = { ...userPreferencesRef.current, hideViewed: hidden }
    userPreferencesRef.current = next
    setUserPreferences(next)
    setHideViewed(hidden)
  }

  function setPreferredIgnoreWhitespace(ignoreWhitespace: boolean) {
    const next = { ...userPreferencesRef.current, ignoreWhitespace }
    userPreferencesRef.current = next
    setUserPreferences(next)
    setIgnoreWhitespace(ignoreWhitespace)
  }

  useEffect(() => {
    api.updateParameters(
      persistedDiffPanelParams(
        { name: params.name, path: worktreePath },
        refs,
        selectedFilePath,
        userPreferences,
      ),
    )
  }, [api, params.name, worktreePath, refs, selectedFilePath, userPreferences])

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
    keyOf: fileKey,
    mode,
    request,
    resetKey: comparisonScope,
    scrollElement,
    wrap,
  })

  // The working tree's marks are only ever held here, so a reload has nothing to read them back from.
  useEffect(() => {
    if (refs.head === WORKTREE_REF) {
      return
    }
    let cancelled = false
    const marked = new Map<string, string | null>()
    marksDuringLoad.current = marked
    invoke<ViewedFile[]>("viewed_files", {
      repoPath: worktreePath,
      baseRef: refs.base,
      headRef: refs.head,
      mergeBase: refs.mergeBase,
    })
      .then((marks) => {
        if (cancelled) {
          return
        }
        const stored = new Map(marks.map((mark) => [mark.path, mark.identity]))
        // A file marked while the store was being read is the newer answer of the two.
        for (const [path, identity] of marked) {
          if (identity === null) {
            stored.delete(path)
          } else {
            stored.set(path, identity)
          }
        }
        setViewed((current) => (sameMarks(current, stored) ? current : stored))
      })
      .catch(() => undefined)
      .finally(() => {
        if (marksDuringLoad.current === marked) {
          marksDuringLoad.current = null
        }
      })
    return () => {
      cancelled = true
    }
  }, [worktreePath, refs.base, refs.head, refs.mergeBase, version])

  // Fingerprint first, so a change landing during the comparison is caught by the next poll.
  useEffect(() => {
    let cancelled = false
    let compared = false
    shownFingerprint.current = null
    // A joined fingerprint always holds a ":", so an empty string never matches one and the next poll reloads.
    const fingerprint = comparisonFingerprint(worktreePath, refs.head).catch(
      () => "",
    )
    fingerprint
      .then(() =>
        invoke<Comparison>("compare_refs", {
          repoPath: worktreePath,
          baseRef: refs.base,
          headRef: refs.head,
          mergeBase: refs.mergeBase,
          ignoreWhitespace,
        }),
      )
      .then((nextComparison) => {
        compared = true
        if (!cancelled) {
          const keys = nextComparison.files.map(fileKey)
          setExpanded((current) => carriedKeys(current, keys))
          setAllExpanded((current) => carriedKeys(current, keys))
          setHandFolds((current) => carriedFolds(current, keys))
          setLoadedComparison((current) =>
            (
              current?.refs === refs &&
              current.ignoreWhitespace === ignoreWhitespace &&
              current.path === worktreePath &&
              isSameComparison(current.comparison, nextComparison)
            ) ?
              current
            : {
                comparison: nextComparison,
                ignoreWhitespace,
                path: worktreePath,
                refs,
              },
          )
          setError(null)
        }
      })
      .catch((message: unknown) => {
        if (!cancelled) {
          setError(String(message))
        }
      })
      .finally(() =>
        fingerprint.then((value) => {
          if (!cancelled) {
            shownFingerprint.current = compared ? value : ""
          }
        }),
      )
    return () => {
      cancelled = true
    }
  }, [ignoreWhitespace, worktreePath, refs, version])

  useEffect(() => {
    let disposed = false
    let inFlight = false
    const poll = () => {
      const shown = shownFingerprint.current
      if (inFlight || shown === null || document.hidden || !api.isVisible) {
        return
      }
      inFlight = true
      comparisonFingerprint(worktreePath, refs.head)
        .then((fingerprint) => {
          if (
            !disposed &&
            shownFingerprint.current === shown &&
            fingerprint !== shown
          ) {
            shownFingerprint.current = null
            setVersion((current) => current + 1)
          }
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false
        })
    }
    const interval = window.setInterval(poll, FINGERPRINT_INTERVAL)
    window.addEventListener("focus", poll)
    const visibility = api.onDidVisibilityChange(
      ({ isVisible }) => isVisible && poll(),
    )
    return () => {
      disposed = true
      window.clearInterval(interval)
      window.removeEventListener("focus", poll)
      visibility.dispose()
    }
  }, [api, refs.head, worktreePath])

  // A drawer laid over the diff is transient, while side-by-side columns honor an explicit preference.
  useLayoutEffect(() => {
    const element = panel
    if (!element || !toolbarElement) {
      return
    }
    let narrow: boolean | null = null
    const layOut = () => {
      const width = element.getBoundingClientRect().width
      const mainWidth = toolbarElement.getBoundingClientRect().width
      // A panel that has not been laid out yet, or whose tab is hidden, measures zero. That is not a
      // width to fold the toolbar for, and it is certainly not one to settle the whole layout on.
      if (width === 0 || mainWidth === 0) {
        return
      }
      setPanelWidth(mainWidth)
      setIsNarrow(mainWidth < NARROW_DIFF_PANEL_WIDTH)
      if (!initializedLayout.current) {
        const layout = initialDiffLayout(
          width,
          userPreferencesRef.current,
          mainWidth,
        )
        setMode(
          layout.mode === "unified" ? DiffModeEnum.Unified : DiffModeEnum.Split,
        )
        setWrap(layout.wrap)
        initializedLayout.current = true
      }
      const next = width < NARROW_DIFF_PANEL_WIDTH
      if (narrow !== next) {
        setIsSidebarOpen(
          initialDiffLayout(width, userPreferencesRef.current).fileTreeOpen,
        )
        narrow = next
        setIsDrawerLayout(next)
      }
    }
    layOut()
    const observer = new ResizeObserver(layOut)
    observer.observe(element)
    observer.observe(toolbarElement)
    return () => observer.disconnect()
  }, [panel, toolbarElement])

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setSearchQuery(searchInput)
      setHitIndex(0)
    }, SEARCH_DEBOUNCE)
    return () => window.clearTimeout(timeout)
  }, [searchInput])

  // Only an expression git could resolve is worth asking about, so half-typed names never reach it. An
  // answer names the query it was for, so the one for a query that has moved on is not shown against it.
  useEffect(() => {
    if (!isRevisionExpression(searchQuery)) {
      return
    }
    let cancelled = false
    invoke<ResolvedRevision>("resolve_revision", {
      repoPath: worktreePath,
      revision: searchQuery.trim(),
    })
      .then(
        (revision) =>
          !cancelled && setResolvedRevision({ query: searchQuery, revision }),
      )
      .catch(() => !cancelled && setResolvedRevision(null))
    return () => {
      cancelled = true
    }
  }, [worktreePath, searchQuery])
  const revision =
    resolvedRevision?.query === searchQuery ? resolvedRevision.revision : null

  const hits = useMemo(
    () =>
      picker === null ?
        []
      : searchReferences(searchQuery, {
          ...sources,
          allowWorktree: picker === "head",
          currentWorktree: {
            branch: currentBranch,
            path: worktreePath,
          },
          revision,
          worktrees,
        }),
    [
      currentBranch,
      picker,
      revision,
      searchQuery,
      sources,
      worktreePath,
      worktrees,
    ],
  )
  const clearFileSelection = useCallback(() => {
    pendingRestoredFilePath.current = null
    clearPendingScroll()
    setSelectedFilePath(null)
  }, [clearPendingScroll])
  const selectAheadRange = useCallback(
    (reference: string, path: string) => {
      invoke<BranchSelection>("select_branch_range", {
        repoPath: path,
        reference,
      })
        .then((selection) => {
          const selected = selectedRefs(
            selection.baseRef,
            selection.headRef,
            true,
          )
          clearFileSelection()
          setViewed(new Map())
          setHandFolds(new Map())
          setExpanded(new Set())
          setAllExpanded(new Set())
          setRefs(selected)
          setWorktreePath(path)
          api.setTitle(branchRangeTitle(selected))
        })
        .catch((message: unknown) => setError(String(message)))
      setPicker(null)
    },
    [api, clearFileSelection],
  )
  // Measuring a branch from where it forked moves both ends of the comparison, which is only what the
  // head end is asking for. Naming the branch it forked from is what keeps that from being a surprise.
  const forkBase = defaultBranchName(defaultBranch, remotes)
  const menuItems = useMemo(
    () =>
      hits.map((hit, index): SearchMenuItem => ({
        action:
          (
            picker !== "head" ||
            hit.branch === null ||
            isDefaultBranch(hit.branch, defaultBranch, remotes)
          ) ?
            undefined
          : {
              hint: `Changes on ${hit.label} since it forked from ${forkBase || "the default branch"}`,
              icon: GitCompareArrows,
              label: forkBase ? `vs ${forkBase}` : "vs default",
              onSelect: () =>
                selectAheadRange(
                  hit.branch as string,
                  hit.worktreePath ?? worktreePath,
                ),
            },
        detail: hit.detail,
        icon: HIT_ICONS[hit.kind],
        key: `${hit.kind}-${hit.reference}-${index}`,
        label: hit.label,
      })),
    [
      defaultBranch,
      forkBase,
      hits,
      picker,
      remotes,
      selectAheadRange,
      worktreePath,
    ],
  )

  function toggleAllExpanded(file: ChangedFile) {
    const key = fileKey(file)
    const next = new Set(allExpanded)
    if (next.delete(key)) {
      anchorFold(file)
    } else {
      next.add(key)
    }
    setAllExpanded(next)
  }

  function toggleCollapsed(file: ChangedFile) {
    if (isComparisonStale) {
      return
    }
    const key = fileKey(file)
    const next = new Map(handFolds)
    next.set(key, !isFolded(file))
    anchorFold(file)
    setHandFolds(next)
  }

  // Reading a file is what folding it away means here, so the two move together. Only a file with a blob
  // behind it can be remembered, which leaves the working tree marked for as long as the tab is open.
  function toggleViewed(file: ChangedFile) {
    if (isComparisonStale) {
      return
    }
    const path = fileName(file)
    const identity = fileIdentity(file, refs.head)
    const wasViewed = isViewedFile(file, refs.head, viewed)
    const nextViewed = new Map(viewed)
    if (wasViewed) {
      nextViewed.delete(path)
    } else {
      nextViewed.set(path, identity)
    }
    marksDuringLoad.current?.set(path, wasViewed ? null : identity)
    setViewed(nextViewed)
    // The mark decides the fold, so a fold that was set by hand has been answered.
    const next = new Map(handFolds)
    next.delete(fileKey(file))
    anchorFold(file)
    setHandFolds(next)
    if (identity) {
      invoke("set_file_viewed", {
        repoPath: worktreePath,
        baseRef: refs.base,
        headRef: refs.head,
        mergeBase: refs.mergeBase,
        path,
        identity,
        viewed: !wasViewed,
      }).catch((message: unknown) =>
        toast.error("Could not save which files were viewed.", {
          description: String(message),
        }),
      )
    }
  }

  function collapseAll(collapse: boolean) {
    anchorAt(activeKey)
    setHandFolds(new Map(files.map((file) => [fileKey(file), collapse])))
  }

  const selectFile = useCallback(
    (file: ChangedFile) => {
      pendingRestoredFilePath.current = null
      scrollToFile(file)
      setSelectedFilePath(fileName(file))
      if (isDrawerLayout) {
        setIsSidebarOpen(false)
      }
    },
    [isDrawerLayout, scrollToFile],
  )

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
  const fileList = useMemo(
    () => (
      <FileTree
        activeKey={activeKey}
        files={tree}
        isDimmed={(file) => isViewedFile(file, refs.head, viewed)}
        keyOf={fileKey}
        onSelect={selectFile}
      />
    ),
    [activeKey, refs.head, selectFile, tree, viewed],
  )

  function openPicker(side: PickerSide) {
    setPicker(side)
    setSearchInput("")
    setSearchQuery("")
    setHitIndex(0)
  }

  // Where the ends sit cannot say whether a tab still carries the name it opened with, since a
  // comparison can be pointed back at the ends it opened from. Moving an end is what retitles the tab.
  // Moving either end of the comparison leaves behind marks, folds and expanded files that were made against
  // a different one.
  function moveRefs(next: SelectedRefs, path: string) {
    clearFileSelection()
    setViewed(new Map())
    setHandFolds(new Map())
    setExpanded(new Set())
    setAllExpanded(new Set())
    setRefs(next)
    setWorktreePath(path)
    api.setTitle(diffTitle(next, defaultBranch, remotes))
  }

  function selectHit(hit: ReferenceHit) {
    moveRefs(
      picker === "base" ?
        { ...refs, base: hit.reference, baseLabel: hit.label }
      : { ...refs, head: hit.reference, headLabel: hit.label },
      hit.worktreePath ?? worktreePath,
    )
    setPicker(null)
  }

  const isSplit = (mode & DiffModeEnum.Split) !== 0
  // The pair only fits the toolbar once the panel is wide; until then it sits with the other view options.
  const inlineFolds = panelWidth >= WIDE_DIFF_PANEL_WIDTH
  const foldButtons = (
    <FoldButtons
      allCollapsed={folds.allCollapsed}
      allExpanded={folds.allExpanded}
      collapseHint="Collapse all files"
      disabled={files.length === 0 || isComparisonStale}
      expandHint="Expand all files"
      onCollapse={() => collapseAll(true)}
      onExpand={() => collapseAll(false)}
      size={inlineFolds ? "icon-sm" : "icon-xs"}
    />
  )

  const emptyNotice =
    comparison &&
    files.length === 0 &&
    (changedCount === 0 ?
      <p className="diff-empty">No changed files</p>
    : <p className="diff-empty flex items-center gap-3">
        {changedCount === 1 ?
          "The only changed file has been viewed"
        : `All ${changedCount.toLocaleString()} changed files have been viewed`}
        <Button
          onClick={() => setPreferredHideViewed(false)}
          size="xs"
          type="button"
          variant="outline"
        >
          Show viewed files
        </Button>
      </p>)
  const sidebar = (
    <nav aria-label="Changed files" className="diff-file-list">
      <header className="diff-file-total">
        <span>{changedFilesLabel(files.length, changedCount)}</span>
        {viewedCount > 0 && (
          <span>{`${viewedCount.toLocaleString()} viewed`}</span>
        )}
        <FileStat additions={total.additions} deletions={total.deletions} />
      </header>
      <div className="diff-file-tree">
        {fileList}
        {emptyNotice}
      </div>
    </nav>
  )
  const diffScroll = (
    <div className="diff-view-container" ref={scrollElement}>
      {error && <p className="diff-empty text-destructive">{error}</p>}
      {!comparison && !error && (
        <p className="diff-empty">Loading comparison…</p>
      )}
      {!error && emptyNotice}
      <div
        className="diff-file-space"
        style={{ height: rowVirtualizer.getTotalSize() }}
      >
        {virtualRows.map((row) => {
          const file = files[row.index]
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
                    Viewed
                    <Checkbox
                      checked={isViewedFile(file, refs.head, viewed)}
                      disabled={
                        isOutdated(file) &&
                        !isFolded(file) &&
                        (!isLargeDiff(file) || expanded.has(fileKey(file)))
                      }
                      onCheckedChange={() => toggleViewed(file)}
                    />
                  </label>
                }
                allExpanded={allExpanded.has(fileKey(file))}
                collapsed={isFolded(file)}
                dimmed={isViewedFile(file, refs.head, viewed)}
                entry={entries[fileKey(file)]}
                expanded={expanded.has(fileKey(file))}
                file={file}
                mode={mode}
                onExpand={() =>
                  setExpanded((current) => new Set(current).add(fileKey(file)))
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

  const pickerMenu = (side: PickerSide) => (
    <PopoverContent
      align="start"
      className="w-auto"
      collisionBoundary={panel}
      collisionPadding={8}
      onOpenAutoFocus={(event) => event.preventDefault()}
      style={{ width: isNarrow ? panelWidth - 16 : PICKER_MENU_WIDTH }}
    >
      <SearchMenu
        activeIndex={hitIndex}
        emptyMessage="No branch, tag, commit or revision matches"
        inputLabel={
          side === "base" ?
            "Search for a base to compare from"
          : "Search for a head to compare to"
        }
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
    </PopoverContent>
  )

  const toolbar = (
    <div className="diff-toolbar" ref={setToolbarElement}>
      <Hinted
        hint={isSidebarOpen ? "Hide changed files" : "Show changed files"}
      >
        <Button
          aria-expanded={isSidebarOpen}
          aria-label="Toggle changed files"
          onClick={() => {
            toggleFileTree()
          }}
          size="icon-sm"
          type="button"
          variant="outline"
        >
          <PanelLeft />
        </Button>
      </Hinted>
      <Popover
        onOpenChange={(open) => (open ? openPicker("base") : setPicker(null))}
        open={picker === "base"}
      >
        <PopoverTrigger asChild>
          <Button
            className={
              isNarrow ?
                "min-w-0 flex-1 justify-between"
              : "w-45 justify-between"
            }
            size="sm"
            type="button"
            variant="outline"
          >
            <span className="truncate">{baseLabel}</span>
            <ChevronDown />
          </Button>
        </PopoverTrigger>
        {pickerMenu("base")}
      </Popover>
      <Hinted
        hint={
          refs.base === EMPTY_TREE_REF ?
            "There is no fork point for an empty base."
          : refs.mergeBase ?
            `Changes on ${headLabel} since it forked from ${baseLabel}`
          : `Changes between ${baseLabel} and ${headLabel}`
        }
      >
        <span className="inline-flex">
          <Button
            aria-label="Compare since the two sides forked"
            aria-pressed={refs.mergeBase}
            disabled={refs.base === EMPTY_TREE_REF}
            onClick={() =>
              moveRefs({ ...refs, mergeBase: !refs.mergeBase }, worktreePath)
            }
            size="sm"
            type="button"
            variant="ghost"
          >
            <span className="text-muted-foreground">{rangeMarker(refs)}</span>
            {panelWidth >= WIDE_DIFF_PANEL_WIDTH &&
              (refs.mergeBase ? "Since fork" : "Direct")}
          </Button>
        </span>
      </Hinted>
      <Popover
        onOpenChange={(open) => (open ? openPicker("head") : setPicker(null))}
        open={picker === "head"}
      >
        <PopoverTrigger asChild>
          <Button
            className={
              isNarrow ?
                "min-w-0 flex-1 justify-between"
              : "w-45 justify-between"
            }
            size="sm"
            type="button"
            variant="outline"
          >
            <HeadPickerLabel label={headLabel} reference={refs.head} />
            <ChevronDown />
          </Button>
        </PopoverTrigger>
        {pickerMenu("head")}
      </Popover>
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
        {inlineFolds && foldButtons}
        <Popover>
          <Tooltip>
            <PopoverTrigger asChild>
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
            </PopoverTrigger>
            <TooltipContent>Choose how the diff is laid out</TooltipContent>
          </Tooltip>
          <PopoverContent align="end" className="w-64 p-0">
            <PanelSection>
              <PanelHeading>Layout</PanelHeading>
              {isNarrow && (
                <LabeledRow label="Columns">
                  <Segmented
                    onChange={setPreferredMode}
                    options={LAYOUT_OPTIONS}
                    value={isSplit ? "split" : "unified"}
                  />
                </LabeledRow>
              )}
              <SwitchRow
                checked={wrap}
                id="diff-view-wrap"
                label="Wrap long lines"
                onCheckedChange={setPreferredWrap}
              />
              <SwitchRow
                checked={ignoreWhitespace}
                id="diff-view-ignore-whitespace"
                label="Ignore whitespace"
                onCheckedChange={setPreferredIgnoreWhitespace}
              />
            </PanelSection>
            <PanelSection>
              <PanelHeading>Files</PanelHeading>
              <SwitchRow
                checked={!hideViewed}
                id="diff-view-viewed-files"
                label="Viewed files"
                onCheckedChange={(shown) => setPreferredHideViewed(!shown)}
              />
              {!inlineFolds && (
                <LabeledRow label="Fold">{foldButtons}</LabeledRow>
              )}
            </PanelSection>
          </PopoverContent>
        </Popover>
        <Hinted hint="Reread this comparison">
          <Button
            aria-label="Refresh the comparison"
            onClick={() => {
              retryFailed()
              setVersion((current) => current + 1)
            }}
            size="icon-sm"
            type="button"
            variant="outline"
          >
            <RefreshCw />
          </Button>
        </Hinted>
      </div>
    </div>
  )

  const narrowContent = (
    <div className="diff-content">
      {isSidebarOpen && (
        <div
          className="diff-drawer-backdrop"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}
      {isSidebarOpen && <div className="diff-drawer">{sidebar}</div>}
      {diffScroll}
    </div>
  )

  return (
    <section className="diff-panel" ref={setPanel}>
      {isDrawerLayout ?
        <>
          {toolbar}
          {narrowContent}
        </>
      : <ResizablePanelGroup orientation="horizontal">
          {isSidebarOpen && (
            <>
              <ResizablePanel defaultSize={280} maxSize={480} minSize={200}>
                {sidebar}
              </ResizablePanel>
              <ResizableHandle />
            </>
          )}
          <ResizablePanel minSize="40%">
            <div className="diff-main">
              {toolbar}
              {diffScroll}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      }
    </section>
  )
}
