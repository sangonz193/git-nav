import type {
  DiffPanelParams,
  DiffPanelUserPreferences,
  RepositoryPanelParams,
} from "@/lib/panel-params"
import { WORKTREE_REF } from "@/lib/repository-constants"
import type { SelectedRefs } from "./diff-title"

export const NARROW_DIFF_PANEL_WIDTH = 620
export const WIDE_DIFF_PANEL_WIDTH = 900
export const IMAGE_PREVIEW_LIMIT = 64 * 1024 * 1024

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
  "svg",
])

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

export function isImagePath(path: string | null) {
  const fileName = path?.split("/").pop()
  const extension = fileName?.slice(fileName.lastIndexOf(".") + 1)
  return (
    fileName !== extension &&
    fileName !== `.${extension}` &&
    IMAGE_EXTENSIONS.has(extension?.toLowerCase() ?? "")
  )
}

export function isSvgPath(path: string | null) {
  const fileName = path?.split("/").pop()
  const extension = fileName?.slice(fileName.lastIndexOf(".") + 1)
  return (
    fileName !== extension &&
    fileName !== `.${extension}` &&
    extension?.toLowerCase() === "svg"
  )
}

export function svgContent(source: string | null) {
  if (source === null) {
    return null
  }
  const size = new TextEncoder().encode(source).length
  return {
    size,
    image:
      size <= IMAGE_PREVIEW_LIMIT ?
        `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`
      : null,
    dimensions: null,
  }
}

export function formatBytes(size: number) {
  const units = ["B", "KB", "MB", "GB"]
  let value = size
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
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

export function isViewedFile(
  file: ChangedFile,
  headRef: string,
  viewed: ReadonlyMap<string, string>,
) {
  return viewed.get(fileName(file)) === fileIdentity(file, headRef)
}

// A file that has been read is folded away, so a mark arriving after the comparison folds its file
// without a second pass over the list. A fold set by hand says what it is rather than what it differs
// from, since the mark it would be read against may not have arrived yet.
export function isFoldedFile(
  file: ChangedFile,
  headRef: string,
  viewed: ReadonlyMap<string, string>,
  folds: ReadonlyMap<string, boolean>,
  key: string,
) {
  return folds.get(key) ?? isViewedFile(file, headRef, viewed)
}

// A comparison read again still lists the files that were folded by hand, and rereading is no reason to
// open them, so their folds are carried over. A file that left the list takes its fold with it.
export function carriedFolds(
  folds: ReadonlyMap<string, boolean>,
  keys: Iterable<string>,
) {
  const next = new Map<string, boolean>()
  for (const key of keys) {
    const fold = folds.get(key)
    if (fold !== undefined) {
      next.set(key, fold)
    }
  }
  return next
}

// The counts describe the comparison, whatever the filter is showing of it, so two numbers beside each
// other never read as a contradiction.
export function changedFilesLabel(shown: number, changed: number) {
  if (shown !== changed) {
    return `${shown.toLocaleString()} of ${changed.toLocaleString()} files`
  }
  return changed === 1 ? "1 file" : `${changed.toLocaleString()} files`
}

export type DiffLayoutPreferences = Pick<
  DiffPanelUserPreferences,
  "fileTreeOpen" | "mode" | "wrap"
>

export function initialDiffLayout(
  width: number,
  preferences: DiffLayoutPreferences,
) {
  return {
    fileTreeOpen:
      width >= NARROW_DIFF_PANEL_WIDTH && (preferences.fileTreeOpen ?? true),
    mode:
      preferences.mode ??
      (width < WIDE_DIFF_PANEL_WIDTH ?
        ("unified" as const)
      : ("split" as const)),
    wrap: preferences.wrap ?? width < NARROW_DIFF_PANEL_WIDTH,
  }
}

export function toggledDiffFileTree<Preferences extends DiffLayoutPreferences>(
  isOpen: boolean,
  isNarrow: boolean,
  preferences: Preferences,
): { fileTreeOpen: boolean; preferences: Preferences & DiffLayoutPreferences } {
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
    userPreferences:
      Object.keys(userPreferences).length > 0 ? userPreferences : undefined,
  }
}
