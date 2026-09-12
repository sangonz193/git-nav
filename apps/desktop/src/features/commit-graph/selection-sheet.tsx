import { Hinted } from "@/components/hinted"
import { Button } from "@workspace/shadcn/components/button"
import { cn } from "@workspace/shadcn/lib/utils"
import { ChevronDown, ChevronUp, FileDiff, X } from "lucide-react"
import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type TransitionEvent,
} from "react"

import { refName, type Commit, type Selection } from "./commit-graph"
import { SELECTION_LABELS, type ChipMenuContext } from "./row-chips"
import { SelectionDetails } from "./selection-details"
import { canDiffSelection } from "./selection-diff"
import { snapExpanded, type SheetDrag } from "./selection-sheet-snap"

// Below this the sheet spans the panel; above it the sheet docks in the bottom-right corner.
export const NARROW_SHEET_PANEL_WIDTH = 720
const DRAG_THRESHOLD = 4
const CLOSE_FALLBACK_MS = 250
type Drag = SheetDrag & {
  origin: number
  start: number
}

function selectionSummary(selection: Selection) {
  return selection.kind === "commits" ?
      `${selection.commits.length} commit${selection.commits.length === 1 ? "" : "s"}${selection.branches[0] ? ` · ${selection.branches[0].branch}` : ""}`
    : `${SELECTION_LABELS[selection.kind]} · ${refName(selection.ref)}`
}

export const SelectionSheet = memo(function SelectionSheet({
  canSelectCommit,
  bottomOffset,
  clearSelection,
  expanded,
  isRangeDragging,
  maxBodyHeight,
  menus,
  narrow,
  onExpandedChange,
  onPeekHeightChange,
  openSelectionDiff,
  repoPath,
  refreshKey,
  selectCommit,
  selection,
  tipCommit,
}: {
  canSelectCommit: (hash: string) => boolean
  bottomOffset: number
  clearSelection: () => void
  expanded: boolean
  isRangeDragging: boolean
  maxBodyHeight: number
  menus: ChipMenuContext
  narrow: boolean
  onExpandedChange: (expanded: boolean) => void
  onPeekHeightChange: (height: number) => void
  openSelectionDiff: (selection: Selection, filePath?: string) => void
  repoPath: string
  refreshKey: number
  selectCommit: (hash: string) => void
  selection: Selection
  tipCommit: Commit | null
}) {
  const [drag, setDrag] = useState<Drag | null>(null)
  const [closing, setClosing] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const header = useRef<HTMLElement>(null)
  const sheetExpanded = expanded && !isRangeDragging
  const mounted =
    !isRangeDragging && (sheetExpanded || closing || drag !== null)
  // The open sheet is always the same height, so browsing selections does not pump it up and down.
  const bodyHeight =
    isRangeDragging ? 0
    : drag ? drag.height
    : sheetExpanded ? maxBodyHeight
    : 0
  const canDiff = canDiffSelection(selection, menus.repository?.defaultBranch)

  useLayoutEffect(() => {
    const element = header.current
    if (!element) {
      return
    }
    const update = () => onPeekHeightChange(element.offsetHeight)
    const observer = new ResizeObserver(update)
    observer.observe(element)
    update()
    return () => observer.disconnect()
  }, [onPeekHeightChange])

  useLayoutEffect(() => {
    if (isRangeDragging) {
      setDrag(null)
      setClosing(false)
    }
  }, [isRangeDragging])

  useEffect(() => {
    if (!closing) {
      return
    }
    const timeout = window.setTimeout(
      () => setClosing(false),
      CLOSE_FALLBACK_MS,
    )
    return () => window.clearTimeout(timeout)
  }, [closing])

  function setExpanded(next: boolean) {
    setClosing(!next && (body.current?.offsetHeight ?? 0) > 0)
    onExpandedChange(next)
  }

  function startDrag(event: ReactPointerEvent<HTMLElement>) {
    if (
      event.button !== 0 ||
      (event.target as HTMLElement).closest("button") !== null
    ) {
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrag({
      height: bodyHeight,
      moved: false,
      origin: event.clientY,
      start: bodyHeight,
      towardsOpen: !sheetExpanded,
    })
  }

  function moveDrag(event: ReactPointerEvent<HTMLElement>) {
    setDrag((current) => {
      if (!current) {
        return current
      }
      const offset = current.origin - event.clientY
      const moved = current.moved || Math.abs(offset) >= DRAG_THRESHOLD
      if (!moved) {
        return current
      }
      const height = Math.max(
        0,
        Math.min(maxBodyHeight, current.start + offset),
      )
      return {
        ...current,
        height,
        moved,
        towardsOpen:
          height === current.height ?
            current.towardsOpen
          : height > current.height,
      }
    })
  }

  function endDrag() {
    if (!drag) {
      return
    }
    setDrag(null)
    setExpanded(snapExpanded(drag, maxBodyHeight, sheetExpanded))
  }

  function cancelDrag() {
    setDrag(null)
  }

  function finishClosing(event: TransitionEvent<HTMLDivElement>) {
    if (
      event.target === event.currentTarget &&
      event.propertyName === "height"
    ) {
      setClosing(false)
    }
  }

  return (
    <aside
      aria-label="Selection"
      className={cn(
        "commit-graph-sheet",
        narrow ? "is-narrow" : "is-docked",
        drag && "is-dragging",
        isRangeDragging && "is-range-dragging",
        sheetExpanded && "is-expanded",
      )}
      style={{ bottom: bottomOffset }}
    >
      <header
        className="commit-graph-sheet-header"
        onPointerCancel={cancelDrag}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        ref={header}
      >
        <span aria-hidden className="commit-graph-sheet-grip" />
        <span className="commit-graph-sheet-summary">
          {selectionSummary(selection)}
        </span>
        <Hinted
          hint={
            selection.kind === "commits" ?
              "Diff the selected range"
            : `Diff ${refName(selection.ref)} against the default branch`
          }
        >
          <Button
            disabled={!canDiff}
            onClick={() => openSelectionDiff(selection)}
            size="sm"
            type="button"
            variant="outline"
          >
            <FileDiff />
            Diff
          </Button>
        </Hinted>
        <Hinted hint="Clear the selection">
          <Button
            aria-label="Clear the selection"
            onClick={clearSelection}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <X />
          </Button>
        </Hinted>
        <Hinted hint={sheetExpanded ? "Collapse" : "Show details and actions"}>
          <Button
            aria-expanded={sheetExpanded}
            aria-label={sheetExpanded ? "Collapse" : "Show details and actions"}
            onClick={() => setExpanded(!sheetExpanded)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            {sheetExpanded ?
              <ChevronDown />
            : <ChevronUp />}
          </Button>
        </Hinted>
      </header>
      <div
        className="commit-graph-sheet-body"
        onTransitionEnd={finishClosing}
        ref={body}
        style={{ height: bodyHeight }}
      >
        {mounted && (
          <div className="commit-graph-sheet-content">
            <SelectionDetails
              canSelectCommit={canSelectCommit}
              menus={menus}
              openSelectionDiff={openSelectionDiff}
              repoPath={repoPath}
              refreshKey={refreshKey}
              selectCommit={selectCommit}
              selection={selection}
              tipCommit={tipCommit}
            />
          </div>
        )}
      </div>
    </aside>
  )
})
