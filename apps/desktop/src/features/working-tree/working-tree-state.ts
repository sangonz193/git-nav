import type {
  RepositoryPanelParams,
  WorkingTreePanelParams,
  WorkingTreePanelUserPreferences,
} from "@/lib/panel-params"
import type { PendingOperation } from "../commit-graph/commit-graph"
import { fileName, type ChangedFile } from "../diff/diff-panel-state"

export type Area = "staged" | "unstaged"

export type WorkingTreeFile = ChangedFile & { area: Area }

export type WorkingTree = {
  branch: string | null
  headSha: string | null
  headMessage: string | null
  indexFingerprint: string
  pendingOperation: PendingOperation | null
  conflicted: string[]
  staged: ChangedFile[]
  unstaged: ChangedFile[]
}

export type WorktreeStatus = {
  path: string
  branch: string
  head: string
  isDetached: boolean
  changedFiles: number
  untrackedFiles: number
  pendingOperation: PendingOperation | null
}

export function worktreeName(path: string) {
  return path.split("/").filter(Boolean).at(-1) ?? path
}

// The same path can sit on both sides when only part of it is staged, so the side is part of the key.
export function workingTreeFileKey(file: WorkingTreeFile) {
  return `${file.area}:${file.status}:${file.oldPath}:${file.newPath}`
}

export function workingTreeFiles(tree: WorkingTree | null): WorkingTreeFile[] {
  if (!tree) {
    return []
  }
  return [
    ...tree.staged.map((file) => ({ ...file, area: "staged" as const })),
    ...tree.unstaged.map((file) => ({ ...file, area: "unstaged" as const })),
  ]
}

// A rename is two paths to git, and both have to move for the rename to move as one.
export function filePaths(files: ChangedFile[]) {
  const paths = new Set<string>()
  for (const file of files) {
    if (file.oldPath && file.status !== "copied") {
      paths.add(file.oldPath)
    }
    if (file.newPath) {
      paths.add(file.newPath)
    }
  }
  return [...paths]
}

export function areaLabel(area: Area, count: number) {
  const noun = area === "staged" ? "Staged" : "Changes"
  return count === 0 ? noun : `${noun} (${count.toLocaleString()})`
}

export function commitLabel(stagedCount: number, amend: boolean) {
  if (amend) {
    return "Amend last commit"
  }
  if (stagedCount === 0) {
    return "Commit"
  }
  return stagedCount === 1 ? "Commit 1 file" : (
      `Commit ${stagedCount.toLocaleString()} files`
    )
}

export function pendingOperationBlocksCommit(
  operation: PendingOperation | null | undefined,
) {
  return (
    operation === "rebase" ||
    operation === "cherryPick" ||
    operation === "bisect"
  )
}

export function canCommit(
  tree: WorkingTree | null,
  message: string,
  amend: boolean,
) {
  if (
    !tree ||
    message.trim() === "" ||
    tree.conflicted.length > 0 ||
    pendingOperationBlocksCommit(tree.pendingOperation)
  ) {
    return false
  }
  return amend ?
      tree.headSha !== null
    : tree.staged.length > 0 || tree.pendingOperation === "merge"
}

// An amend starts from the message the commit already has, unless one is already being written.
export function amendMessage(
  current: string,
  headMessage: string | null,
  amend: boolean,
  wasAmending = false,
) {
  if (!amend && wasAmending && current === headMessage) {
    return ""
  }
  if (!amend || current.trim() !== "") {
    return current
  }
  return headMessage ?? current
}

export function selectedFilePathOf(file: ChangedFile | null) {
  return file ? fileName(file) : null
}

export function persistedWorkingTreePanelParams(
  { name, path }: RepositoryPanelParams,
  selectedFilePath: string | null,
  userPreferences: WorkingTreePanelUserPreferences,
): WorkingTreePanelParams {
  return {
    name,
    path,
    selectedFilePath,
    userPreferences:
      Object.keys(userPreferences).length > 0 ? userPreferences : undefined,
  }
}
