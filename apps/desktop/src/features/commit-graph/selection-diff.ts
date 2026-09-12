import { refName, type Selection } from "./commit-graph"

export function canDiffSelection(
  selection: Selection,
  defaultBranch: string | null | undefined,
) {
  if (selection.kind !== "commits") {
    return refName(selection.ref) !== defaultBranch
  }
  return selection.commits.length === 1 ?
      selection.tip.parents.length > 0
    : selection.base !== null
}
