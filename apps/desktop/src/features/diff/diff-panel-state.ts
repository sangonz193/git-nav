import type { DiffPanelParams, DiffPanelUserPreferences, RepositoryPanelParams } from "../repository/repository-window"
import type { SelectedRefs } from "./diff-title"

export const NARROW_DIFF_PANEL_WIDTH = 620
export const WIDE_DIFF_PANEL_WIDTH = 900

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
