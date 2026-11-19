import { EMPTY_TREE_REF } from "@/lib/repository-constants"
import { refLabel } from "../diff/diff-title"

import {
  refName,
  refRevision,
  type CommitSelection,
  type DisplayRef,
  type Selection,
} from "./commit-graph"

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
    return refRevision(selection.ref) !== defaultBranch
  }
  return rangeBaseHash(selection) !== null
}

export function divergenceTargets(
  ref: DisplayRef,
  defaultBranch: string | null | undefined,
) {
  const upstream = ref.sync?.isGone ? null : ref.sync?.upstream
  const reference = refName(ref)
  const targets =
    upstream ? [{ label: upstream, reference: `${reference}@{upstream}` }] : []
  if (defaultBranch != null && refRevision(ref) !== defaultBranch) {
    const label = refLabel(defaultBranch)
    const upstreamIsDefault =
      upstream === label ||
      (!defaultBranch.startsWith("refs/remotes/") &&
        ref.remote !== null &&
        upstream === `${ref.remote}/${label}`)
    if (!upstreamIsDefault) {
      targets.push({ label, reference: defaultBranch })
    }
  }
  return targets
}
