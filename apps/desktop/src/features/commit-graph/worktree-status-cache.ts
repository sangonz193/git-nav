import { invoke } from "@/lib/ipc"

import type { Project, Worktree } from "../repository/project"
import type { PendingOperation, StashEntry } from "./commit-graph"
import type { RepositoryState } from "./commit-operations"

type WorktreeStatus = {
  path: string
  branch: string
  head: string
  isDetached: boolean
  changedFiles: number
  untrackedFiles: number
  pendingOperation: PendingOperation | null
}
export type WorktreeStatusScope = "all" | "current"
type Snapshot = {
  projectWorktrees: Worktree[]
  worktreeStatuses: WorktreeStatus[]
  repository: RepositoryState | null
  stashes: StashEntry[]
}

function createWorktreeStatusCache(repoPath: string) {
  let snapshot: Snapshot = {
    projectWorktrees: [],
    worktreeStatuses: [],
    repository: null,
    stashes: [],
  }
  const listeners = new Set<() => void>()
  const requests: Partial<Record<WorktreeStatusScope, Promise<string | null>>> =
    {}

  function publish(update: Partial<Snapshot>) {
    snapshot = { ...snapshot, ...update }
    for (const listener of listeners) {
      listener()
    }
  }

  async function load(scope: WorktreeStatusScope) {
    const [error] = await Promise.all([
      invoke<Project>("project_snapshot", { path: repoPath })
        .then((project) => {
          publish({
            projectWorktrees: project.worktrees.filter(
              (worktree) => !worktree.isPrunable,
            ),
          })
          return null
        })
        .catch((message: unknown) => String(message)),
      invoke<WorktreeStatus[]>("worktree_status", {
        repoPath,
        worktreePaths: scope === "current" ? [repoPath] : undefined,
      })
        .then((statuses) => {
          if (scope === "all") {
            publish({ worktreeStatuses: statuses })
          } else {
            const merged = new Map(
              snapshot.worktreeStatuses.map((status) => [status.path, status]),
            )
            for (const status of statuses) {
              merged.set(status.path, status)
            }
            publish({ worktreeStatuses: [...merged.values()] })
          }
        })
        .catch(() => undefined),
      invoke<RepositoryState>("repository_state", { repoPath })
        .then((repository) => publish({ repository }))
        .catch(() => undefined),
      invoke<StashEntry[]>("stash_list", { repoPath })
        .then((stashes) => publish({ stashes }))
        .catch(() => undefined),
    ])
    return error
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    refresh(scope: WorktreeStatusScope = "all", afterOperation = false) {
      const existing = requests.all ?? requests[scope]
      if (existing && !afterOperation) {
        return existing
      }
      const preceding = requests.all ?? requests.current
      const request = (
        preceding ?
          preceding.then(() => load(scope))
        : load(scope)).finally(() => {
        if (requests[scope] === request) delete requests[scope]
      })
      requests[scope] = request
      return request
    },
  }
}

const caches = new Map<string, ReturnType<typeof createWorktreeStatusCache>>()

export function getWorktreeStatusCache(repoPath: string) {
  let cache = caches.get(repoPath)
  if (!cache) {
    cache = createWorktreeStatusCache(repoPath)
    caches.set(repoPath, cache)
  }
  return cache
}
