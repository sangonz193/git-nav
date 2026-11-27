import { invoke } from "@/lib/ipc"

import type { Project, Worktree } from "../repository/project"
import { worktreeBranch } from "../working-tree/working-tree-state"
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
type RefreshScope = WorktreeStatusScope | "project" | "repository"
type Snapshot = {
  isLoaded: boolean
  projectHomePath: string | null
  projectWorktrees: Worktree[]
  worktreeStatuses: WorktreeStatus[]
  repository: RepositoryState | null
  stashes: StashEntry[]
}

type DiffSnapshot = {
  currentBranch: string | null | undefined
  defaultBranch: string | null
  remotes: string[]
  worktrees: Pick<Worktree, "path" | "branch" | "isDetached">[]
}

function createWorktreeStatusCache(repoPath: string) {
  let snapshot: Snapshot = {
    isLoaded: false,
    projectHomePath: null,
    projectWorktrees: [],
    worktreeStatuses: [],
    repository: null,
    stashes: [],
  }
  let diffSource = snapshot
  let diffSnapshot: DiffSnapshot = {
    currentBranch: undefined,
    defaultBranch: null,
    remotes: [],
    worktrees: [],
  }
  const listeners = new Set<() => void>()
  const requests: Partial<Record<RefreshScope, Promise<string | null>>> = {}
  let lastRequest: Promise<string | null> | undefined

  function getDiffSnapshot() {
    if (diffSource === snapshot) return diffSnapshot

    const { projectWorktrees, repository } = snapshot
    let { worktrees, remotes } = diffSnapshot
    if (
      projectWorktrees !== diffSource.projectWorktrees &&
      (projectWorktrees.length !== worktrees.length ||
        projectWorktrees.some(({ path, branch, isDetached }, index) => {
          const previous = worktrees[index]
          return (
            path !== previous.path ||
            branch !== previous.branch ||
            isDetached !== previous.isDetached
          )
        }))
    ) {
      worktrees = projectWorktrees.map(({ path, branch, isDetached }) => ({
        path,
        branch,
        isDetached,
      }))
    }
    if (
      repository &&
      repository !== diffSource.repository &&
      repository.remotes.join("\n") !== remotes.join("\n")
    ) {
      remotes = repository.remotes
    }
    const currentBranch =
      repository ?
        repository.currentBranch
      : worktreeBranch(worktrees.find(({ path }) => path === repoPath) ?? {})
    const defaultBranch = repository?.defaultBranch ?? null
    if (
      currentBranch !== diffSnapshot.currentBranch ||
      defaultBranch !== diffSnapshot.defaultBranch ||
      remotes !== diffSnapshot.remotes ||
      worktrees !== diffSnapshot.worktrees
    ) {
      diffSnapshot = { currentBranch, defaultBranch, remotes, worktrees }
    }
    diffSource = snapshot
    return diffSnapshot
  }

  function publish(update: Partial<Snapshot>) {
    snapshot = { ...snapshot, ...update }
    for (const listener of listeners) {
      listener()
    }
  }

  function loadProject() {
    return invoke<Project>("project_snapshot", { path: repoPath })
      .then((project) => {
        publish({
          projectHomePath: project.path,
          projectWorktrees: project.worktrees.filter(
            (worktree) => !worktree.isPrunable,
          ),
        })
        return null
      })
      .catch((message: unknown) => String(message))
  }

  function loadRepository() {
    return invoke<RepositoryState>("repository_state", { repoPath })
      .then((repository) => publish({ repository }))
      .catch(() => undefined)
  }

  async function load(scope: RefreshScope) {
    if (scope === "project") return loadProject()
    if (scope === "repository") {
      await loadRepository()
      return null
    }
    const [error] = await Promise.all([
      loadProject(),
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
      loadRepository(),
      invoke<StashEntry[]>("stash_list", { repoPath })
        .then((stashes) => publish({ stashes }))
        .catch(() => undefined),
    ])
    if (scope === "all" && !snapshot.isLoaded) {
      publish({ isLoaded: true })
    }
    return error
  }

  return {
    getDiffSnapshot,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    refresh(scope: RefreshScope = "all", afterOperation = false) {
      const existing =
        requests.all ??
        (scope === "all" ? undefined : (requests.current ?? requests[scope]))
      if (existing && !afterOperation) {
        return existing
      }
      const request = (
        lastRequest ?
          lastRequest.then(() => load(scope))
        : load(scope)).finally(() => {
        if (requests[scope] === request) delete requests[scope]
        if (lastRequest === request) lastRequest = undefined
      })
      requests[scope] = request
      lastRequest = request
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
