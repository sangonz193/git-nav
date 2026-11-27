import { invoke, isDesktop, stream } from "@/lib/ipc"
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import {
  commitFromTuple,
  indexPullRequests,
  parseRef,
  type BranchPullRequest,
  type BranchSync,
  type Commit,
  type CommitBatch,
  type RowWorktree,
  type SquashMergeInference,
  type StashEntry,
  worktreeBranchState,
} from "./commit-graph"
import type { SyncKind } from "./repository-sync"
import { useRepositorySync } from "./use-repository-sync"
import {
  getWorktreeStatusCache,
  type WorktreeStatusScope,
} from "./worktree-status-cache"

export const BROWSER_GRAPH_WINDOW_SIZE = 2_000
const REPOSITORY_FINGERPRINT_INTERVAL = 1_500
const REPOSITORY_FOCUS_DEBOUNCE = 150
type GraphWindowComplete = { hasMore: boolean }
const EMPTY_GRAPH = {
  commits: [] as Commit[],
  offset: 0,
  hasOlderCommits: false,
  version: 0,
}

export function useGraphData({
  onError,
  repoPath,
}: {
  onError: (message: string | null) => void
  repoPath: string
}) {
  const [graph, setGraph] = useState(EMPTY_GRAPH)
  const [squashMergeInferences, setSquashMergeInferences] = useState<
    SquashMergeInference[]
  >([])
  const [request, setRequest] = useState({
    offset: null as number | null,
    refresh: true,
  })
  const requestedWindow = useRef({ request, pending: true })
  const displayedOffset = useRef<number | null>(null)
  const [isGraphWindowLoading, setIsGraphWindowLoading] = useState(true)
  const worktreeStatusCache = getWorktreeStatusCache(repoPath)
  const { isLoaded, projectWorktrees, worktreeStatuses, repository, stashes } =
    useSyncExternalStore(
      worktreeStatusCache.subscribe,
      worktreeStatusCache.getSnapshot,
      worktreeStatusCache.getSnapshot,
    )
  const [branchSync, setBranchSync] = useState<Map<string, BranchSync>>(
    new Map(),
  )
  const [pullRequests, setPullRequests] = useState<
    Map<string, BranchPullRequest[]>
  >(new Map())
  const [pullRequestVersion, setPullRequestVersion] = useState(0)
  const fingerprint = useRef<string | null>(null)
  const fingerprintGeneration = useRef(0)
  const squashMergeInferenceGeneration = useRef(0)
  const squashMergeInferenceRequest = useRef<{
    window: typeof request
    request: Promise<SquashMergeInference[] | null>
  } | null>(null)
  const refreshSquashMergeInferencesRef = useRef<(() => void) | null>(null)
  // The backend syncs GitHub once per repository however many windows show it, and says when it has.
  const sync = useRepositorySync({
    repoPath,
    onSynced: useCallback((kind: SyncKind) => {
      if (kind === "pullRequests") {
        setPullRequestVersion((version) => version + 1)
        squashMergeInferenceGeneration.current += 1
        squashMergeInferenceRequest.current = null
        refreshSquashMergeInferencesRef.current?.()
      }
    }, []),
  })
  const setGraphOffset = useCallback(
    (offset: number | null, refresh = false) => {
      const current = requestedWindow.current
      const next = {
        offset,
        refresh: refresh || (current.pending && current.request.refresh),
      }
      requestedWindow.current = { request: next, pending: true }
      setRequest(next)
      setIsGraphWindowLoading(true)
      onError(null)
    },
    [onError],
  )
  const refreshGraph = useCallback(() => {
    // The next poll adopts whatever the re-stream lands on rather than refreshing again on top of it.
    fingerprint.current = null
    fingerprintGeneration.current += 1
    const current = requestedWindow.current
    setGraphOffset(current.pending ? current.request.offset : null, true)
  }, [setGraphOffset])
  // HEAD moves with every commit, so these markers stay anchored to a stale commit until the refs are re-read.
  const refreshWorktreeStatus = useCallback(
    (
      scope: WorktreeStatusScope = "all",
      isDisposed?: () => boolean,
      afterOperation = false,
    ) => {
      return worktreeStatusCache
        .refresh(scope, afterOperation)
        .then((message) => {
          if (message !== null && !isDisposed?.()) {
            onError(message)
          }
        })
    },
    [onError, worktreeStatusCache],
  )
  // Until the repository reports its remotes, branches are paired with their remote copies through the
  // conventional one rather than through none. Repository state is re-read on a timer, so the list is held by
  // its contents: a fresh array each poll would redraw the whole graph.
  const remoteNames = repository?.remotes?.join("\n")
  const remotes = useMemo(() => remoteNames?.split("\n"), [remoteNames])
  // A worktree's name and openness come from the project snapshot while its uncommitted work and pending
  // operation come from its status, and the two only describe the same checkout once they are joined.
  const worktrees = useMemo(() => {
    const statuses = new Map(
      worktreeStatuses.map((status) => [status.path, status]),
    )
    return projectWorktrees.map((worktree): RowWorktree => {
      const status = statuses.get(worktree.path)
      return {
        branch: worktree.isDetached ? null : worktree.branch,
        changedFiles: status?.changedFiles ?? 0,
        head: worktree.head,
        isCurrent: worktree.path === repoPath,
        name: worktree.name,
        path: worktree.path,
        pendingOperation: status?.pendingOperation ?? null,
        untrackedFiles: status?.untrackedFiles ?? 0,
      }
    })
  }, [repoPath, projectWorktrees, worktreeStatuses])
  const worktreesByHead = useMemo(() => {
    const byHead = new Map<string, RowWorktree[]>()
    for (const worktree of worktrees) {
      byHead.set(worktree.head, [
        ...(byHead.get(worktree.head) ?? []),
        worktree,
      ])
    }
    return byHead
  }, [worktrees])
  // Until every worktree has been read once, the state would pass through partial values on its way in, and
  // each would start a cleanup and fast-forward computation of its own.
  const worktreeState = useMemo(
    () => (isLoaded ? worktreeBranchState(worktrees) : null),
    [isLoaded, worktrees],
  )
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

  const needsBranchStatus = useEffectEvent((commits: Commit[]) =>
    commits.some((commit) =>
      commit.refs.some((decoration) => {
        const ref = parseRef(decoration)
        return ref?.kind === "branch" && !branchSync.has(ref.name)
      }),
    ),
  )

  useEffect(() => {
    let disposed = false
    let finished = false
    let inferenceTimeout: number | null = null
    const isCurrent = () =>
      !disposed && requestedWindow.current.request === request
    const previousOffset = displayedOffset.current
    const offset = request.offset ?? previousOffset ?? 0
    const buffer = previousOffset !== null || offset > 0
    let replacement: Commit[] = []
    function refreshSquashMergeInferences() {
      if (document.hidden || (buffer && !finished)) {
        return
      }
      const current = squashMergeInferenceRequest.current
      const generation = squashMergeInferenceGeneration.current
      const inference =
        current?.window === request ?
          current.request
        : invoke<SquashMergeInference[]>("inferred_squash_merge_edges", {
            repoPath,
          }).catch(() => null)
      squashMergeInferenceRequest.current = {
        window: request,
        request: inference,
      }
      inference.finally(() => {
        if (squashMergeInferenceRequest.current?.request === inference) {
          squashMergeInferenceRequest.current = null
        }
      })
      return inference.then((inferences) => {
        if (
          isCurrent() &&
          generation === squashMergeInferenceGeneration.current &&
          inferences !== null
        ) {
          setSquashMergeInferences(inferences)
        }
      })
    }
    function scheduleSquashMergeInferences() {
      if (
        inferenceTimeout !== null ||
        refreshSquashMergeInferencesRef.current !== null
      ) {
        return
      }
      inferenceTimeout = window.setTimeout(() => {
        inferenceTimeout = null
        refreshSquashMergeInferences()
        refreshSquashMergeInferencesRef.current = refreshSquashMergeInferences
      })
    }
    const refreshSquashMergeInferencesOnVisibility = () => {
      if (!document.hidden) {
        refreshSquashMergeInferences()
      }
    }
    document.addEventListener(
      "visibilitychange",
      refreshSquashMergeInferencesOnVisibility,
    )

    let nextStatus: Map<string, BranchSync> | undefined
    const status =
      (request.refresh || offset === 0) &&
      invoke<BranchSync[]>("branch_sync", { repoPath })
        .then((entries) => {
          nextStatus = new Map(entries.map((entry) => [entry.branch, entry]))
          if (isCurrent() && (!buffer || finished)) setBranchSync(nextStatus)
        })
        .catch(() => undefined)
    const stopStream = stream<CommitBatch, GraphWindowComplete>(
      "stream_commit_graph",
      isDesktop ?
        { repoPath }
      : {
          repoPath,
          offset,
          limit: BROWSER_GRAPH_WINDOW_SIZE,
        },
      (batch) => {
        if (!isCurrent() || finished || batch.length === 0) return
        const rows = batch.map(commitFromTuple)
        if (buffer) {
          replacement.push(...rows)
        } else {
          displayedOffset.current = offset
          setGraph((current) => ({
            ...current,
            commits: current.commits.concat(rows),
          }))
          if (offset === 0) scheduleSquashMergeInferences()
        }
      },
      (message) => {
        if (!isCurrent() || finished) return
        replacement = []
        requestedWindow.current.pending = false
        onError(message)
        setIsGraphWindowLoading(false)
      },
      async (data) => {
        if (!isCurrent() || finished) return
        if (!isDesktop && offset > 0 && replacement.length === 0) {
          setGraphOffset(0)
          return
        }
        if (buffer && status && !nextStatus && needsBranchStatus(replacement)) {
          await status
          if (!isCurrent()) return
        }
        if (buffer && nextStatus) setBranchSync(nextStatus)
        if (buffer && offset === 0) scheduleSquashMergeInferences()
        finished = true
        const received = replacement
        replacement = []
        displayedOffset.current = offset
        requestedWindow.current.pending = false
        setGraph((current) => ({
          commits: buffer ? received : current.commits,
          offset,
          hasOlderCommits: data.hasMore,
          version: current.version + Number(buffer && request.refresh),
        }))
        setIsGraphWindowLoading(false)
      },
    )
    return () => {
      disposed = true
      stopStream()
      replacement = []
      if (inferenceTimeout !== null) {
        window.clearTimeout(inferenceTimeout)
      }
      refreshSquashMergeInferencesRef.current = null
      document.removeEventListener(
        "visibilitychange",
        refreshSquashMergeInferencesOnVisibility,
      )
    }
  }, [onError, repoPath, request, setGraphOffset])

  useEffect(() => {
    let disposed = false
    let isPolling = false
    let focusTimeout: number | null = null
    const poll = () => {
      if (isPolling || document.hidden) {
        return
      }
      isPolling = true
      const generation = fingerprintGeneration.current
      return invoke<string>("repository_fingerprint", { repoPath })
        .then((value) => {
          // A refresh that started while this was in flight already invalidated the answer.
          if (disposed || generation !== fingerprintGeneration.current) {
            return
          }
          if (fingerprint.current !== null && fingerprint.current !== value) {
            refreshGraph()
          }
          fingerprint.current = value
        })
        .catch(() => undefined)
        .finally(() => {
          isPolling = false
        })
    }
    const pollOnFocus = () => {
      if (focusTimeout !== null) {
        window.clearTimeout(focusTimeout)
      }
      focusTimeout = window.setTimeout(() => {
        focusTimeout = null
        poll()
      }, REPOSITORY_FOCUS_DEBOUNCE)
    }

    poll()
    const interval = window.setInterval(poll, REPOSITORY_FINGERPRINT_INTERVAL)
    window.addEventListener("focus", pollOnFocus)
    return () => {
      disposed = true
      window.clearInterval(interval)
      if (focusTimeout !== null) {
        window.clearTimeout(focusTimeout)
      }
      window.removeEventListener("focus", pollOnFocus)
    }
  }, [repoPath, refreshGraph])

  useEffect(() => {
    let disposed = false
    let isRefreshing = false
    let intervalTicks = 0
    const refresh = (isInterval = false) => {
      if (isRefreshing || document.hidden) {
        return
      }
      const scope = isInterval && ++intervalTicks % 6 !== 0 ? "current" : "all"
      isRefreshing = true
      return refreshWorktreeStatus(scope, () => disposed).finally(() => {
        isRefreshing = false
      })
    }

    refresh()
    const refreshOnFocus = () => refresh()
    window.addEventListener("focus", refreshOnFocus)
    const refreshOnVisibility = () => {
      if (!document.hidden) {
        refresh()
      }
    }
    document.addEventListener("visibilitychange", refreshOnVisibility)
    const interval = window.setInterval(() => refresh(true), 10_000)
    return () => {
      disposed = true
      window.removeEventListener("focus", refreshOnFocus)
      document.removeEventListener("visibilitychange", refreshOnVisibility)
      window.clearInterval(interval)
    }
  }, [repoPath, refreshWorktreeStatus])

  // Answered from what the backend has stored, so a read is cheap and only worth repeating once a sync lands.
  useEffect(() => {
    let disposed = false
    invoke<BranchPullRequest[]>("branch_pull_requests", {
      repoPath,
    })
      .then((entries) => {
        if (!disposed) {
          setPullRequests(indexPullRequests(entries))
        }
      })
      .catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [graph.version, pullRequestVersion, repoPath])

  return {
    branchSync,
    commits: graph.commits,
    graphOffset: graph.offset,
    graphVersion: graph.version,
    hasOlderCommits: graph.hasOlderCommits,
    isGraphWindowLoading,
    pullRequestVersion,
    pullRequests,
    refreshGraph,
    refreshWorktreeStatus,
    remoteNames,
    remotes,
    repository,
    setGraphOffset,
    squashMergeInferences,
    stashes,
    stashesByBase,
    sync,
    worktreeState,
    worktrees,
    worktreesByHead,
  }
}
