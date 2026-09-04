import type { DiffPanelParams, DiffPanelUserPreferences, RepositoryPanelParams } from "@/lib/panel-params"
import { WORKTREE_REF } from "@/lib/repository-constants"
import type { SelectedRefs } from "./diff-title"

export const NARROW_DIFF_PANEL_WIDTH = 620
export const WIDE_DIFF_PANEL_WIDTH = 900

export type ChangedFile = {
  status: string
  oldPath: string | null
  newPath: string | null
  oldOid: string | null
  newOid: string | null
  additions: number
  deletions: number
  isBinary: boolean
  splitRows: number
  unifiedRows: number
  hunkRows: number
}

export function fileName(file: ChangedFile) {
  return file.newPath ?? file.oldPath ?? "Unknown file"
}

// A mark stands for the patch a file was read at, so everything the card shows belongs to it: both blobs,
// since a base moving under a branch rewrites the diff while the head blob sits still, and the status and
// source path the header names, since a rename that stops being one is not the entry that was read. A
// working tree file has no blob to be read at, which is why its mark is never written down.
export function fileIdentity(file: ChangedFile, headRef: string) {
  if (headRef === WORKTREE_REF || (!file.oldOid && !file.newOid)) {
    return ""
  }
  return JSON.stringify([file.status, file.oldPath, file.oldOid, file.newOid])
}

export function isViewedFile(file: ChangedFile, headRef: string, viewed: ReadonlyMap<string, string>) {
  return viewed.get(fileName(file)) === fileIdentity(file, headRef)
}

// A file that has been read is folded away, so a mark arriving after the comparison folds its file
// without a second pass over the list. A fold set by hand says what it is rather than what it differs
// from, since the mark it would be read against may not have arrived yet.
export function isFoldedFile(file: ChangedFile, headRef: string, viewed: ReadonlyMap<string, string>, folds: ReadonlyMap<string, boolean>, key: string) {
  return folds.get(key) ?? isViewedFile(file, headRef, viewed)
}

// The counts describe the comparison, whatever the filter is showing of it, so two numbers beside each
// other never read as a contradiction.
export function changedFilesLabel(shown: number, changed: number) {
  if (shown !== changed) {
    return `${shown.toLocaleString()} of ${changed.toLocaleString()} files`
  }
  return changed === 1 ? "1 file" : `${changed.toLocaleString()} files`
}

export function initialDiffLayout(width: number, preferences: DiffPanelUserPreferences) {
  return {
    fileTreeOpen: width >= NARROW_DIFF_PANEL_WIDTH && (preferences.fileTreeOpen ?? true),
    mode: preferences.mode ?? (width < WIDE_DIFF_PANEL_WIDTH ? "unified" as const : "split" as const),
    wrap: preferences.wrap ?? width < NARROW_DIFF_PANEL_WIDTH,
  }
}

export function toggledDiffFileTree(isOpen: boolean, isNarrow: boolean, preferences: DiffPanelUserPreferences) {
  const fileTreeOpen = !isOpen
  return {
    fileTreeOpen,
    preferences: isNarrow ? preferences : { ...preferences, fileTreeOpen },
  }
}

export function persistedDiffPanelParams(
  { name, path }: RepositoryPanelParams,
  refs: SelectedRefs,
  selectedFilePath: string | null,
  userPreferences: DiffPanelUserPreferences,
): DiffPanelParams {
  return {
    name,
    path,
    baseRef: refs.base,
    baseLabel: refs.baseLabel,
    headRef: refs.head,
    headLabel: refs.headLabel,
    mergeBase: refs.mergeBase,
    selectedFilePath,
    userPreferences: Object.keys(userPreferences).length > 0 ? userPreferences : undefined,
  }
}
