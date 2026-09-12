import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@workspace/shadcn/components/context-menu"
import { Copy, FileDiff, GitBranch, GitCompareArrows } from "lucide-react"

import {
  chipName,
  type Commit,
  type CommitSelection,
  type RowChip,
} from "./commit-graph"
import { OperationMenuItems } from "./commit-operation-menu"
import { rangeBaseHash } from "./selection-diff"
import {
  chipMenuEntry,
  contextMenuComponents,
  DANGER_GROUPS,
  menuHeader,
  SAFE_GROUPS,
  type ChipMenuContext,
} from "./row-chips"

// Context menu content stays behind this boundary so its render cost does not grow with history depth.
export function RowContextMenuBody({
  canSelectRange,
  chips,
  commit,
  diffSelectedRange,
  index,
  menus,
  openCommitDiff,
  openRangeDiff,
  selectCommit,
  selectRangeTo,
  selected,
  targetForRow,
}: {
  canSelectRange: (index: number) => boolean
  chips: RowChip[]
  commit: Commit
  diffSelectedRange: CommitSelection | null
  index: number
  menus: ChipMenuContext
  openCommitDiff: (commit: Commit) => void
  openRangeDiff: (selection: CommitSelection) => void
  selectCommit: (commit: Commit) => void
  selectRangeTo: (commit: Commit) => void
  selected: boolean
  targetForRow: (index: number) => CommitSelection
}) {
  const target = targetForRow(index)
  return (
    <>
      {menuHeader(
        contextMenuComponents,
        target.commits.length === 1 ?
          target.tip.hash.slice(0, 8)
        : `${target.commits.length} commits`,
        commit.subject || "(no subject)",
      )}
      <ContextMenuItem onSelect={() => selectCommit(commit)}>
        <GitCompareArrows />
        Select commit
      </ContextMenuItem>
      {canSelectRange(index) && (
        <ContextMenuItem onSelect={() => selectRangeTo(commit)}>
          <GitCompareArrows />
          Select range to here
        </ContextMenuItem>
      )}
      <OperationMenuItems
        components={contextMenuComponents}
        groups={SAFE_GROUPS}
        onSelect={menus.setRequest}
        repository={menus.repository}
        source={menus.selection}
        target={target}
      />
      <ContextMenuItem
        disabled={commit.parents.length === 0}
        onSelect={() => openCommitDiff(commit)}
      >
        <FileDiff />
        Show commit diff
      </ContextMenuItem>
      {selected &&
        diffSelectedRange &&
        diffSelectedRange.commits.length > 1 && (
          <ContextMenuItem
            disabled={rangeBaseHash(diffSelectedRange) === null}
            onSelect={() => openRangeDiff(diffSelectedRange)}
          >
            <FileDiff />
            Diff selected range
          </ContextMenuItem>
        )}
      {chips.length === 1 &&
        chipMenuEntry(
          menus,
          chips[0],
          commit.hash,
          chipName(chips[0]),
          contextMenuComponents,
        )}
      {chips.length > 1 && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <GitBranch />
            Refs
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {chips.map((chip, index) =>
              chipMenuEntry(
                menus,
                chip,
                commit.hash,
                `${chipName(chip)}-${index}`,
                contextMenuComponents,
              ),
            )}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => menus.copyText(commit.hash)}>
        <Copy />
        Copy SHA
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => menus.copyText(commit.subject)}>
        <Copy />
        Copy commit subject
      </ContextMenuItem>
      <OperationMenuItems
        components={contextMenuComponents}
        groups={DANGER_GROUPS}
        onSelect={menus.setRequest}
        repository={menus.repository}
        separator="before"
        source={menus.selection}
        target={target}
      />
    </>
  )
}
