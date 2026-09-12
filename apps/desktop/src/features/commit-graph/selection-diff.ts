import { EMPTY_TREE_REF } from "@/lib/repository-constants"

import { refName, type CommitSelection, type Selection } from "./commit-graph"

// The commit before the range is known from the oldest commit's parents even when the graph window ends
// before it, which is enough to diff against.
export function rangeBaseHash(selection: CommitSelection) {
  const oldest = selection.commits.at(-1)
  return oldest ? (oldest.parents[0] ?? EMPTY_TREE_REF) : null
}

export function canDiffSelection(
  selection: Selection,
  defaultBranch: string | null | undefined,
) {
  if (selection.kind !== "commits") {
    return refName(selection.ref) !== defaultBranch
  }
  return rangeBaseHash(selection) !== null
}
