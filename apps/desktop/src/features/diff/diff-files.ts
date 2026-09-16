import { highlighter } from "@git-diff-view/lowlight"
import { DiffModeEnum } from "@git-diff-view/react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { type RefObject, useCallback, useEffect, useRef, useState } from "react"

import { imageUrl } from "@/lib/ipc"
import { observeAttachedElementRect } from "@/lib/tab-scroll"
import {
  fileName,
  isImagePath,
  isSvgPath,
  type ChangedFile,
} from "./diff-panel-state"

const MAX_CONCURRENT_DIFF_LOADS = 4
const LARGE_DIFF_LINES = 1200
// The library skips highlighting above 2000 lines, which hand-written sources routinely exceed.
const MAX_HIGHLIGHT_LINES = 10_000
// Monospace runs wider than the interface face, so it is set a step below the interface size to read as the
// same size beside it.
export const DIFF_FONT_SIZE = 12
const DIFF_ROW_HEIGHT = DIFF_FONT_SIZE * 1.6
const HUNK_ROW_HEIGHT = 30
const FILE_HEADER_HEIGHT = 34
const FILE_ROW_GAP = 12
const COLLAPSED_BODY_HEIGHT = 40
export const IMAGE_BODY_HEIGHT = 386

highlighter.setMaxLineToIgnoreSyntax(MAX_HIGHLIGHT_LINES)

export type BinaryContent = {
  size: number
  image: string | null
  dimensions: string | null
}

type ServedBinary = {
  size: number
  imageToken: string | null
  width: number | null
  height: number | null
}

export type FileDiff = {
  oldFileName: string | null
  newFileName: string | null
  oldContent: string | null
  newContent: string | null
  hunks: string[]
  isBinary: boolean
  oldBinary: ServedBinary | null
  newBinary: ServedBinary | null
}

function binaryContent(served: ServedBinary | null): BinaryContent | null {
  return (
    served && {
      size: served.size,
      image: served.imageToken === null ? null : imageUrl(served.imageToken),
      dimensions:
        served.width === null || served.height === null ?
          null
        : `${served.width}×${served.height}`,
    }
  )
}

type DiffData = {
  oldFile: { fileName: string | null; content: string | null }
  newFile: { fileName: string | null; content: string | null }
  hunks: string[]
}

export type DiffEntry =
  | { state: "loaded"; data: DiffData }
  | {
      state: "binary"
      oldBinary: BinaryContent | null
      newBinary: BinaryContent | null
    }
  | { state: "error"; message: string }

export type FileTreeNode = {
  name: string
  path: string
  file: ChangedFile | null
  children: FileTreeNode[]
}

export function statusLetter(file: ChangedFile) {
  return file.status.slice(0, 1).toUpperCase()
}

export function isLargeDiff(file: ChangedFile) {
  return file.additions + file.deletions > LARGE_DIFF_LINES
}

export function isSvgFile(file: ChangedFile) {
  return isSvgPath(file.oldPath) || isSvgPath(file.newPath)
}

export function estimatedBodyHeight(
  file: ChangedFile,
  mode: DiffModeEnum,
  collapsed = false,
) {
  if (collapsed) {
    return 0
  }
  if (file.isBinary) {
    return isImagePath(file.oldPath) || isImagePath(file.newPath) ?
        IMAGE_BODY_HEIGHT
      : COLLAPSED_BODY_HEIGHT
  }
  if (isLargeDiff(file)) {
    return COLLAPSED_BODY_HEIGHT
  }
  const rows = mode & DiffModeEnum.Split ? file.splitRows : file.unifiedRows
  return (
    Math.round(rows * DIFF_ROW_HEIGHT + file.hunkRows * HUNK_ROW_HEIGHT) +
    (isSvgFile(file) ? IMAGE_BODY_HEIGHT : 0)
  )
}

export function fileTree(files: ChangedFile[]) {
  const root: FileTreeNode = { name: "", path: "", file: null, children: [] }
  for (const file of files) {
    const parts = fileName(file).split("/")
    let node = root
    for (const [index, name] of parts.entries()) {
      const path = node.path ? `${node.path}/${name}` : name
      let child = node.children.find((candidate) => candidate.name === name)
      if (!child) {
        child = { name, path, file: null, children: [] }
        node.children.push(child)
      }
      if (index === parts.length - 1) {
        child.file = file
      }
      node = child
    }
  }
  const sort = (nodes: FileTreeNode[]) => {
    nodes.sort(
      (left, right) =>
        Number(left.file !== null) - Number(right.file !== null) ||
        left.name.localeCompare(right.name),
    )
    nodes.forEach((node) => sort(node.children))
  }
  sort(root.children)
  return root.children
}

export function changedLines(files: ChangedFile[]) {
  return files.reduce(
    (total, file) => ({
      additions: total.additions + file.additions,
      deletions: total.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  )
}

export function flattenTree(nodes: FileTreeNode[], files: ChangedFile[] = []) {
  for (const node of nodes) {
    if (node.file) {
      files.push(node.file)
    }
    flattenTree(node.children, files)
  }
  return files
}

type Loader = (file: ChangedFile) => Promise<FileDiff>

type LoaderState = {
  load: Loader | null
  queued: ChangedFile[]
  started: Set<string>
  inFlight: number
}

function freshLoader(load: Loader | null): LoaderState {
  return {
    load,
    queued: [],
    started: new Set(),
    inFlight: 0,
  }
}

const NO_ENTRIES: Record<string, DiffEntry> = {}

// A loaded diff belongs to the loader that read it, so handing over a new loader is what empties the cards.
export function useDiffLoader(
  keyOf: (file: ChangedFile) => string,
  load: Loader | null,
) {
  const [loaded, setLoaded] = useState<{
    load: Loader | null
    entries: Record<string, DiffEntry>
  }>({ load, entries: {} })
  const loader = useRef(freshLoader(load))
  const entries = loaded.load === load ? loaded.entries : NO_ENTRIES

  // A request replaces the queue, so files scrolled past before a worker picked them up free their slot.
  const request = useCallback(
    (files: ChangedFile[]) => {
      if (!load) {
        return
      }
      if (loader.current.load !== load) {
        loader.current = freshLoader(load)
      }
      const state = loader.current
      state.queued = files.filter((file) => !state.started.has(keyOf(file)))
      const drain = async () => {
        for (
          let file = state.queued.shift();
          file;
          file = state.queued.shift()
        ) {
          const key = keyOf(file)
          state.started.add(key)
          const entry = await load(file)
            .then((diff): DiffEntry =>
              diff.isBinary ?
                {
                  state: "binary",
                  oldBinary: binaryContent(diff.oldBinary),
                  newBinary: binaryContent(diff.newBinary),
                }
              : {
                  state: "loaded",
                  data: {
                    oldFile: {
                      fileName: diff.oldFileName,
                      content: diff.oldContent,
                    },
                    newFile: {
                      fileName: diff.newFileName,
                      content: diff.newContent,
                    },
                    hunks: diff.hunks,
                  },
                },
            )
            .catch((message: unknown): DiffEntry => ({
              state: "error",
              message: String(message),
            }))
          if (loader.current !== state) {
            return
          }
          setLoaded((current) => ({
            load,
            entries: {
              ...(current.load === load ? current.entries : {}),
              [key]: entry,
            },
          }))
        }
      }
      while (
        state.inFlight < MAX_CONCURRENT_DIFF_LOADS &&
        state.queued.length > 0
      ) {
        state.inFlight += 1
        void drain().finally(() => {
          state.inFlight -= 1
        })
      }
    },
    [keyOf, load],
  )

  return { entries, request }
}

/**
 * Lays the cards out in a virtual list and keeps the scroller steady while their heights move under it.
 * `resetKey` names the list being shown: a new one starts from the top with fresh measurements.
 */
export function useDiffCards({
  allExpanded,
  entries,
  expanded,
  files,
  isFolded,
  keyOf,
  mode,
  request,
  resetKey,
  scrollElement,
  wrap,
}: {
  allExpanded: ReadonlySet<string>
  entries: Record<string, DiffEntry>
  expanded: ReadonlySet<string>
  files: ChangedFile[]
  isFolded: (file: ChangedFile) => boolean
  keyOf: (file: ChangedFile) => string
  mode: DiffModeEnum
  request: (files: ChangedFile[]) => void
  resetKey: unknown
  scrollElement: RefObject<HTMLDivElement | null>
  wrap: boolean
}) {
  const pendingScroll = useRef<string | null>(null)
  const pendingAnchor = useRef<string | null>(null)
  const rowVirtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => scrollElement.current,
    estimateSize: (index) =>
      FILE_ROW_GAP +
      FILE_HEADER_HEIGHT +
      estimatedBodyHeight(files[index], mode, isFolded(files[index])),
    getItemKey: (index) => keyOf(files[index]),
    observeElementRect: observeAttachedElementRect,
    // A fast scroll or a jump from the file tree outruns two rows and shows empty slots for a frame.
    overscan: 4,
  })
  const virtualRows = rowVirtualizer.getVirtualItems()

  // Measured heights belong to the previous list or layout, so drop them and start over.
  useEffect(() => {
    rowVirtualizer.measure()
    rowVirtualizer.scrollToOffset(0)
  }, [resetKey, rowVirtualizer])

  // A fold or changed expanded context changes the heights the scroller was measured at, so they are
  // dropped and taken again. Dropping them leaves the cards still on screen at their estimates, which only
  // a resize would correct, so they are measured back right away, once the estimates have replaced the
  // sizes a measurement is compared against. Cards above the scroller stay at their estimates until they
  // come back, which would move everything below them by the difference, so the card at the top of the
  // scroller is put back where it was. A fold that moved what sits above the scroller asks for its own card
  // instead, and a file leaving the list takes its card out before it can be aimed at.
  useEffect(() => {
    const scrollTop = scrollElement.current?.scrollTop ?? 0
    const top = rowVirtualizer
      .getVirtualItems()
      .find((row) => row.end > scrollTop)
    const anchor =
      pendingAnchor.current !== null ? { key: pendingAnchor.current, offset: 0 }
      : top && files[top.index] ?
        { key: keyOf(files[top.index]), offset: top.start - scrollTop }
      : null
    pendingAnchor.current = null
    rowVirtualizer.measure()
    rowVirtualizer.getTotalSize()
    scrollElement.current
      ?.querySelectorAll<HTMLElement>(".diff-file-row")
      .forEach((row) => rowVirtualizer.measureElement(row))
    rowVirtualizer.getTotalSize()
    const index =
      anchor === null ? -1 : (
        files.findIndex((file) => keyOf(file) === anchor.key)
      )
    const start = rowVirtualizer.measurementsCache[index]?.start
    if (anchor !== null && start !== undefined) {
      rowVirtualizer.scrollToOffset(start - anchor.offset)
    }
  }, [
    allExpanded,
    files,
    isFolded,
    keyOf,
    mode,
    rowVirtualizer,
    scrollElement,
    wrap,
  ])

  useEffect(() => {
    request(
      virtualRows
        .map((row) => files[row.index])
        .filter(
          (file) =>
            !isFolded(file) &&
            (!isLargeDiff(file) || expanded.has(keyOf(file))),
        ),
    )
  }, [expanded, files, isFolded, keyOf, request, virtualRows])

  const scrollOffset = rowVirtualizer.scrollOffset ?? 0
  // Past the last card only the tail is left to scroll, and that still belongs to the last file.
  const activeIndex =
    virtualRows.find((row) => row.end > scrollOffset + 1)?.index ??
    (files.length > 0 ? files.length - 1 : undefined)
  const activeKey = activeIndex === undefined ? null : keyOf(files[activeIndex])

  const scrollToFile = useCallback(
    (file: ChangedFile) => {
      pendingScroll.current = keyOf(file)
      rowVirtualizer.scrollToIndex(files.indexOf(file), { align: "start" })
    },
    [files, keyOf, rowVirtualizer],
  )

  // The first scroll aims at estimated heights, so aim again once the target has rendered its real diff.
  useEffect(() => {
    const key = pendingScroll.current
    if (key && entries[key]) {
      pendingScroll.current = null
      rowVirtualizer.scrollToIndex(
        files.findIndex((file) => keyOf(file) === key),
        { align: "start" },
      )
    }
  }, [entries, files, keyOf, rowVirtualizer])

  const clearPendingScroll = useCallback(() => {
    pendingScroll.current = null
  }, [])

  // Folding only moves what sits under the card, so the scroller is left alone. The exception is a card
  // the scroller is already inside, where the sticky header stands in for a top that is far above.
  const anchorFold = useCallback(
    (file: ChangedFile) => {
      const key = keyOf(file)
      const row = virtualRows.find(
        (candidate) => keyOf(files[candidate.index]) === key,
      )
      pendingAnchor.current = row && row.start < scrollOffset ? key : null
    },
    [files, keyOf, scrollOffset, virtualRows],
  )

  const anchorAt = useCallback((key: string | null) => {
    pendingAnchor.current = key
  }, [])

  return {
    activeKey,
    anchorAt,
    anchorFold,
    clearPendingScroll,
    rowVirtualizer,
    scrollToFile,
    virtualRows,
  }
}
