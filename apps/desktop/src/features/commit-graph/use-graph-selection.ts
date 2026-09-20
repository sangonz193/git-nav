import { createUserWinningRestore } from "@/lib/pending-restore"
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react"

import {
  ancestryPath,
  commitSelection,
  displayRefs,
  persistedSelectionHashes,
  persistedSelectionRestore,
  refName,
  refSelection,
  type BranchPullRequest,
  type BranchSync,
  type Commit,
  type DisplayRef,
  type RowWorktree,
  type Selection,
} from "./commit-graph"

type RangeDrag = { anchorIndex: number; focusIndex: number }
type SelectedRef = { ref: DisplayRef; sha: string }
type SelectionRange = { anchorHash: string; focusHash: string }

export function sameRef(left: DisplayRef, right: DisplayRef) {
  return (
    left.kind === right.kind &&
    refName(left) === refName(right) &&
    (left.kind !== "remote" || left.remote === right.remote)
  )
}

export function findSelectedRef(
  ref: DisplayRef,
  commits: Commit[],
  {
    branchSync,
    pullRequests,
    remotes,
    worktreesByHead,
  }: {
    branchSync: Map<string, BranchSync>
    pullRequests: Map<string, BranchPullRequest[]>
    remotes: string[] | undefined
    worktreesByHead: Map<string, RowWorktree[]>
  },
) {
  for (const commit of commits) {
    if (commit.refs.length === 0) {
      continue
    }
    const match = displayRefs(commit.refs, {
      branchSync,
      pullRequests,
      remotes,
      worktrees: worktreesByHead.get(commit.hash),
    }).find((candidate) => sameRef(candidate, ref))
    if (match) {
      return { ref: match, sha: commit.hash }
    }
  }
  return null
}

export function useGraphSelection({
  branchSync,
  commits,
  isGraphWindowLoading,
  persist,
  persistedHashes,
  pullRequests,
  remotes,
  worktreesByHead,
}: {
  branchSync: Map<string, BranchSync>
  commits: Commit[]
  isGraphWindowLoading: boolean
  persist: (selectedCommitHashes: string[]) => void
  persistedHashes: string[] | undefined
  pullRequests: Map<string, BranchPullRequest[]>
  remotes: string[] | undefined
  worktreesByHead: Map<string, RowWorktree[]>
}) {
  const [selectionRange, setSelectionRange] = useState<SelectionRange | null>(
    null,
  )
  const [selectedRefState, setSelectedRef] = useState<SelectedRef | null>(null)
  const [rangeDrag, setRangeDrag] = useState<RangeDrag | null>(null)
  const [selectionRestore] = useState(() =>
    createUserWinningRestore(persistedHashes !== undefined),
  )
  const [selectionRestored, setSelectionRestored] = useState(
    !selectionRestore.pending,
  )
  const beginUserSelection = useCallback(() => {
    selectionRestore.userAction(() => setSelectionRestored(true))
  }, [selectionRestore])
  const clearSelection = useCallback(() => {
    beginUserSelection()
    setSelectionRange(null)
    setSelectedRef(null)
  }, [beginUserSelection])
  const commitsSelection = useMemo(() => {
    if (rangeDrag) {
      return commitSelection(
        commits,
        rangeDrag.anchorIndex,
        rangeDrag.focusIndex,
        remotes,
      )
    }
    if (!selectionRange) {
      return null
    }
    const anchorIndex = commits.findIndex(
      (commit) => commit.hash === selectionRange.anchorHash,
    )
    const focusIndex = commits.findIndex(
      (commit) => commit.hash === selectionRange.focusHash,
    )
    return anchorIndex === -1 || focusIndex === -1 ?
        null
      : commitSelection(commits, anchorIndex, focusIndex, remotes)
  }, [commits, rangeDrag, remotes, selectionRange])
  const resolvedRef = useMemo(
    () =>
      selectedRefState ?
        findSelectedRef(selectedRefState.ref, commits, {
          branchSync,
          pullRequests,
          remotes,
          worktreesByHead,
        })
      : null,
    [
      branchSync,
      commits,
      pullRequests,
      remotes,
      selectedRefState,
      worktreesByHead,
    ],
  )
  const selectedRef =
    resolvedRef ?? (isGraphWindowLoading ? selectedRefState : null)
  // A ref selection outlives the graph it was made on, so it is re-read across the loaded graph after every
  // refresh and falls back to what it was made from while the graph it belongs to is still streaming in.
  const selection = useMemo<Selection | null>(() => {
    if (!selectedRef) {
      return commitsSelection
    }
    return refSelection(selectedRef.ref, selectedRef.sha)
  }, [commitsSelection, selectedRef])
  const selectedHashes = useMemo(
    () => new Set(commitsSelection?.commits.map((commit) => commit.hash)),
    [commitsSelection],
  )
  const selectedCommitHashes = useMemo(
    () => persistedSelectionHashes(selectionRange),
    [selectionRange],
  )

  useEffect(() => {
    if (!selectionRestore.pending || persistedHashes === undefined) {
      return
    }
    const restored = persistedSelectionRestore(
      commits,
      persistedHashes,
      isGraphWindowLoading,
    )
    if (restored === undefined) {
      return
    }
    selectionRestore.restore(() => {
      persist(restored.selectedCommitHashes)
      setSelectionRange(restored.range)
      setSelectionRestored(true)
    })
  }, [
    commits,
    isGraphWindowLoading,
    persist,
    persistedHashes,
    selectionRestore,
  ])

  useEffect(() => {
    if (!selectionRestored) {
      return
    }
    persist(selectedCommitHashes)
  }, [persist, selectedCommitHashes, selectionRestored])

  useEffect(() => {
    if (!selectedRefState || resolvedRef || isGraphWindowLoading) {
      return
    }
    // The ref was removed after its graph stream finished.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedRef(null)
  }, [isGraphWindowLoading, resolvedRef, selectedRefState])
  const selectionEndpointIndexes = useMemo(
    () =>
      selectionRange ?
        {
          anchor: commits.findIndex(
            (commit) => commit.hash === selectionRange.anchorHash,
          ),
          focus: commits.findIndex(
            (commit) => commit.hash === selectionRange.focusHash,
          ),
        }
      : null,
    [commits, selectionRange],
  )
  // The dragged end can be either the newer or the older one, so the brackets follow the rows, not the anchor.
  // A drag in flight is read from the drag itself, so the bracket stays under the pointer moving it.
  const selectionEdges = useMemo(() => {
    if (!commitsSelection) {
      return null
    }
    const ends =
      rangeDrag ?
        { anchor: rangeDrag.anchorIndex, focus: rangeDrag.focusIndex }
      : selectionEndpointIndexes
    if (!ends || ends.anchor === -1 || ends.focus === -1) {
      return null
    }
    return {
      top: Math.min(ends.anchor, ends.focus),
      bottom: Math.max(ends.anchor, ends.focus),
    }
  }, [commitsSelection, rangeDrag, selectionEndpointIndexes])

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
  }, [clearSelection, selection])

  const selectRef = useCallback(
    (ref: DisplayRef, sha: string) => {
      beginUserSelection()
      setSelectionRange(null)
      setSelectedRef((current) =>
        current && sameRef(current.ref, ref) && current.sha === sha ?
          null
        : { ref, sha },
      )
    },
    [beginUserSelection],
  )

  // Right-clicking inside the selection keeps it whole, and right-clicking outside it acts on the row under the pointer.
  function rowTarget(index: number) {
    return selectedHashes.has(commits[index].hash) && commitsSelection ?
        commitsSelection
      : commitSelection(commits, index, index)!
  }

  function canSelectRange(index: number) {
    return (
      selectionEndpointIndexes !== null &&
      selectionEndpointIndexes.anchor !== -1 &&
      ancestryPath(commits, selectionEndpointIndexes.anchor, index).length > 0
    )
  }

  const selectCommit = useCallback(
    (commit: Commit) => {
      beginUserSelection()
      setSelectedRef(null)
      setSelectionRange({ anchorHash: commit.hash, focusHash: commit.hash })
    },
    [beginUserSelection],
  )

  function selectRangeTo(commit: Commit) {
    if (!selectionEndpointIndexes) {
      return
    }
    beginUserSelection()
    setSelectedRef(null)
    setSelectionRange({
      anchorHash: commits[selectionEndpointIndexes.anchor].hash,
      focusHash: commit.hash,
    })
  }

  function selectCommitFromKeyboard(
    event: ReactKeyboardEvent<HTMLElement>,
    index: number,
  ) {
    if (
      event.target !== event.currentTarget ||
      (event.key !== "Enter" && event.key !== " ")
    ) {
      return
    }
    event.preventDefault()
    const anchorIndex =
      event.shiftKey && selectionRange ?
        commits.findIndex((commit) => commit.hash === selectionRange.anchorHash)
      : index
    const rangeAnchorIndex = anchorIndex === -1 ? index : anchorIndex
    if (ancestryPath(commits, rangeAnchorIndex, index).length > 0) {
      beginUserSelection()
      setSelectedRef(null)
      setSelectionRange({
        anchorHash: commits[rangeAnchorIndex].hash,
        focusHash: commits[index].hash,
      })
    }
  }

  return {
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
  }
}
