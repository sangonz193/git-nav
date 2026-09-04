import type { DiffPanelParams, DiffPanelUserPreferences, RepositoryPanelParams } from "../repository/repository-window"
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

// What the file is at, rather than where it sits, so a mark falls away the moment its contents move on.
// A working tree file has no blob to be read at, which is why its mark is never written down.
export function fileOid(file: ChangedFile, headRef: string) {
  if (headRef === WORKTREE_REF) {
    return ""
  }
  return file.newOid ?? file.oldOid ?? ""
}

export function isViewedFile(file: ChangedFile, headRef: string, viewed: ReadonlyMap<string, string>) {
  return viewed.get(fileName(file)) === fileOid(file, headRef)
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
