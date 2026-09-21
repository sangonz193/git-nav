import { invoke, isDesktop, stream } from "@/lib/ipc"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  commitFromTuple,
  indexPullRequests,
  type BranchPullRequest,
  type BranchSync,
  type Commit,
  type CommitBatch,
  type PendingOperation,
  type RowWorktree,
  type SquashMergeInference,
  type StashEntry,
} from "./commit-graph"
import type { RepositoryState } from "./commit-operations"
import type {
  Project,
  Worktree as ProjectWorktree,
} from "../repository/project"
import type { SyncKind } from "./repository-sync"
import { useRepositorySync } from "./use-repository-sync"

export const BROWSER_GRAPH_WINDOW_SIZE = 2_000
const REPOSITORY_FINGERPRINT_INTERVAL = 1_500
const REPOSITORY_FOCUS_DEBOUNCE = 150
type WorktreeStatus = {
  path: string
  branch: string
  head: string
  isDetached: boolean
  changedFiles: number
  untrackedFiles: number
  pendingOperation: PendingOperation | null
}
type WorktreeStatusScope = "all" | "current"
type GraphWindowComplete = { hasMore: boolean }

export function useGraphData({
  onBeforeReload,
  onError,
  repoPath,
}: {
  onBeforeReload: () => void
  onError: (message: string | null) => void
  repoPath: string
}) {
  const [commits, setCommits] = useState<Commit[]>([])
  const [squashMergeInferences, setSquashMergeInferences] = useState<
    SquashMergeInference[]
  >([])
  const [graphVersion, setGraphVersion] = useState(0)
  const [graphOffset, setGraphOffset] = useState(0)
  const [hasOlderCommits, setHasOlderCommits] = useState(false)
  const [isGraphWindowLoading, setIsGraphWindowLoading] = useState(true)
  const [projectWorktrees, setProjectWorktrees] = useState<ProjectWorktree[]>(
    [],
  )
  const [branchSync, setBranchSync] = useState<Map<string, BranchSync>>(
    new Map(),
  )
  const [pullRequests, setPullRequests] = useState<
    Map<string, BranchPullRequest[]>
  >(new Map())
  const [pullRequestVersion, setPullRequestVersion] = useState(0)
  const [worktreeStatuses, setWorktreeStatuses] = useState<WorktreeStatus[]>([])
  const [repository, setRepository] = useState<RepositoryState | null>(null)
  const [stashes, setStashes] = useState<StashEntry[]>([])
  const fingerprint = useRef<string | null>(null)
  const fingerprintGeneration = useRef(0)
  const streamedRepoPath = useRef<string | null>(null)
  const squashMergeInferenceGeneration = useRef(0)
  const squashMergeInferenceRequest = useRef<{
    graphVersion: number
    path: string
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
  const refreshGraph = useCallback(() => {
    onError(null)
    onBeforeReload()
    // The next poll adopts whatever the re-stream lands on rather than refreshing again on top of it.
    fingerprint.current = null
    fingerprintGeneration.current += 1
    setGraphOffset(0)
    setGraphVersion((version) => version + 1)
  }, [onBeforeReload, onError])
  // HEAD moves with every commit, so these markers stay anchored to a stale commit until the refs are re-read.
  const refreshWorktreeStatus = useCallback(
    (scope: WorktreeStatusScope = "all", isDisposed?: () => boolean) => {
      return Promise.all([
        invoke<Project>("project_snapshot", { path: repoPath })
          .then((project) => {
            if (!isDisposed?.()) {
              setProjectWorktrees(
                project.worktrees.filter((worktree) => !worktree.isPrunable),
              )
            }
          })
          .catch((message: unknown) => {
            if (!isDisposed?.()) {
              onError(String(message))
            }
          }),
        invoke<WorktreeStatus[]>("worktree_status", {
          repoPath,
          worktreePaths: scope === "current" ? [repoPath] : undefined,
        })
          .then((statuses) => {
            setWorktreeStatuses((current) => {
              if (scope === "all") {
                return statuses
              }
              const merged = new Map(
                current.map((status) => [status.path, status]),
              )
              for (const status of statuses) {
                merged.set(status.path, status)
              }
              return [...merged.values()]
            })
          })
          .catch(() => undefined),
        invoke<RepositoryState>("repository_state", { repoPath })
          .then(setRepository)
          .catch(() => undefined),
        invoke<StashEntry[]>("stash_list", { repoPath })
          .then(setStashes)
          .catch(() => undefined),
      ])
    },
    [onError, repoPath],
  )
  // Until the repository reports its remotes, refs are classified against the conventional one rather than
  // against none, which would read every remote branch as a local one. Repository state is re-read on a timer,
  // so the list is held by its contents: a fresh array each poll would redraw the whole graph.
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
        isOpen: worktree.isOpen,
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

  useEffect(() => {
    let disposed = false
    let isReplaced = false
    let inferenceTimeout: number | null = null
    // The reset belongs to the stream that replaces the window, so it lives where that stream starts. Only
    // another repository is cleared outright: a refresh keeps the graph on screen until its replacement's first
    // rows land, so the panel never blanks between the two.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHasOlderCommits(false)
    setIsGraphWindowLoading(true)
    if (streamedRepoPath.current !== repoPath) {
      streamedRepoPath.current = repoPath
      setCommits([])
    }
    function refreshSquashMergeInferences() {
      if (document.hidden) {
        return
      }
      const current = squashMergeInferenceRequest.current
      const generation = squashMergeInferenceGeneration.current
      const request =
        current?.graphVersion === graphVersion && current.path === repoPath ?
          current.request
        : invoke<SquashMergeInference[]>("inferred_squash_merge_edges", {
            repoPath,
          }).catch(() => null)
      squashMergeInferenceRequest.current = {
        graphVersion,
        path: repoPath,
        request,
      }
      request.finally(() => {
        if (squashMergeInferenceRequest.current?.request === request) {
          squashMergeInferenceRequest.current = null
        }
      })
      return request.then((inferences) => {
        if (
          !disposed &&
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

    if (graphOffset === 0) {
      invoke<BranchSync[]>("branch_sync", { repoPath })
        .then((entries) => {
          if (!disposed) {
            setBranchSync(
              new Map(entries.map((entry) => [entry.branch, entry])),
            )
          }
        })
        .catch(() => undefined)
    }
    const stopStream = stream<CommitBatch>(
      "stream_commit_graph",
      isDesktop ?
        { repoPath }
      : {
          repoPath,
          offset: graphOffset,
          limit: BROWSER_GRAPH_WINDOW_SIZE,
        },
      (batch) => {
        if (!disposed) {
          const rows = batch.map(commitFromTuple)
          const replaces = !isReplaced
          isReplaced = true
          setCommits((existing) => (replaces ? rows : existing.concat(rows)))
          if (graphOffset === 0) {
            scheduleSquashMergeInferences()
          }
        }
      },
      (message) => {
        if (!disposed) {
          onError(message)
          setIsGraphWindowLoading(false)
        }
      },
      (data) => {
        if (!disposed) {
          if (
            !isDesktop &&
            typeof data === "object" &&
            data !== null &&
            "hasMore" in data
          ) {
            setHasOlderCommits((data as GraphWindowComplete).hasMore)
          }
          if (!isReplaced) {
            setCommits([])
          }
          setIsGraphWindowLoading(false)
        }
      },
    )
    return () => {
      disposed = true
      stopStream()
      if (inferenceTimeout !== null) {
        window.clearTimeout(inferenceTimeout)
      }
      refreshSquashMergeInferencesRef.current = null
      document.removeEventListener(
        "visibilitychange",
        refreshSquashMergeInferencesOnVisibility,
      )
    }
  }, [graphOffset, graphVersion, onError, repoPath, refreshWorktreeStatus])

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
  }, [graphVersion, pullRequestVersion, repoPath])

  return {
    branchSync,
    commits,
    graphOffset,
    graphVersion,
    hasOlderCommits,
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
    worktreesByHead,
  }
}
