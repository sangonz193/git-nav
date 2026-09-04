import { WORKTREE_REF } from "@/lib/repository-constants"

export type SelectedRefs = {
  base: string
  head: string
  baseLabel: string
  headLabel: string
  /** Whether the base is where the two sides forked rather than the base ref itself. */
  mergeBase: boolean
}

export function rangeMarker({ mergeBase }: SelectedRefs) {
  return mergeBase ? "..." : ".."
}

// The default branch is named after whichever remote holds it, but the branch it names is the same one
// locally and on every other remote.
function isDefaultBranch(reference: string, defaultBranch: string | null, remotes: string[]) {
  const name = remotes.reduce((value, remote) => value.startsWith(`${remote}/`) ? value.slice(remote.length + 1) : value, defaultBranch ?? "")
  return name !== "" && (reference === name || remotes.some((remote) => reference === `${remote}/${name}`))
}

/**
 * A branch compared against where it forked from the default branch is named by the branch alone, the
 * way the tab reads when it is opened from a ref. The working tree keeps its base, because its name on
 * its own reads as the uncommitted changes rather than as everything the branch carries.
 */
export function diffTitle(refs: SelectedRefs, defaultBranch: string | null, remotes: string[]) {
  const baseLabel = refLabel(refs.base)
  const headLabel = refLabel(refs.head)
  return refs.mergeBase && refs.head !== WORKTREE_REF && isDefaultBranch(refs.base, defaultBranch, remotes)
    ? headLabel
    : `${baseLabel}${rangeMarker(refs)}${headLabel}`
}

/**
 * select_branch_range measures a branch from the primary reference, so its base is the default branch
 * whatever the repository names it, and the title never waits on the repository's metadata to say so.
 */
export function branchRangeTitle(range: SelectedRefs) {
  return diffTitle(range, range.base, [])
}

export function selectedRefs(base: string, head: string, mergeBase: boolean, baseLabel = refLabel(base), headLabel = refLabel(head)): SelectedRefs {
  return { base, head, baseLabel, headLabel, mergeBase }
}

export function refLabel(reference: string) {
  return reference === WORKTREE_REF ? "Working tree" : reference.replace(/^[0-9a-f]{40}(?:[0-9a-f]{24})?\b/i, (sha) => sha.slice(0, 8))
}
