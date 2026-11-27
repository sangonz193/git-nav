import {
  EMPTY_TREE_REF,
  INDEX_REF,
  WORKTREE_REF,
} from "@/lib/repository-constants"

const REF_NAMESPACE = /^refs\/(?:heads|remotes|tags)\//
const HEAD_RELATIVE = /^(?:HEAD|@)(?:$|[~^:@{])/
const PER_WORKTREE_REF =
  /^(?:(?:ORIG_HEAD|MERGE_HEAD|FETCH_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|REBASE_HEAD)|refs\/(?:bisect|worktree)\/\S+?)(?:[~^]\d*)*$/

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

// Revisions relative to HEAD, and the pseudo-refs each worktree keeps for itself, resolve against whichever
// worktree the diff belongs to, so they read its state.
export function dependsOnWorktree({
  base,
  head,
}: {
  base: string
  head: string
}) {
  return [base, head].some(
    (reference) =>
      reference === WORKTREE_REF ||
      reference === INDEX_REF ||
      HEAD_RELATIVE.test(reference) ||
      PER_WORKTREE_REF.test(reference),
  )
}

// The default branch is named after whichever remote holds it, but the branch it names is the same one
// locally and on every other remote.
export function defaultBranchName(
  defaultBranch: string | null,
  remotes: string[],
) {
  const label = defaultBranch ? refLabel(defaultBranch) : ""
  if (defaultBranch?.startsWith("refs/heads/")) {
    return label
  }
  const remote = remotes.find((remote) => label.startsWith(`${remote}/`))
  return (
    remote ? label.slice(remote.length + 1)
    : defaultBranch?.startsWith("refs/remotes/") ?
      label.slice(label.indexOf("/") + 1)
    : label
  )
}

export function isDefaultBranch(
  reference: string,
  defaultBranch: string | null,
  remotes: string[],
) {
  if (!defaultBranch) {
    return false
  }
  const name = defaultBranchName(defaultBranch, remotes)
  const revisions = [
    defaultBranch,
    `refs/heads/${name}`,
    ...remotes.map((remote) => `refs/remotes/${remote}/${name}`),
  ]
  return (
    revisions.includes(reference) ||
    (!REF_NAMESPACE.test(reference) &&
      revisions.some((revision) => refLabel(revision) === reference))
  )
}

/**
 * A branch compared against where it forked from the default branch is named by the branch alone, the
 * way the tab reads when it is opened from a ref. The working tree keeps its base, because its name on
 * its own reads as the uncommitted changes rather than as everything the branch carries.
 */
export function diffTitle(
  refs: SelectedRefs,
  defaultBranch: string | null,
  remotes: string[],
) {
  const baseLabel = refLabel(refs.base)
  const headLabel = refLabel(refs.head)
  return (
      refs.mergeBase &&
        refs.head !== WORKTREE_REF &&
        isDefaultBranch(refs.base, defaultBranch, remotes)
    ) ?
      headLabel
    : `${baseLabel}${rangeMarker(refs)}${headLabel}`
}

/**
 * select_branch_range measures a branch from the primary reference, so its base is the default branch
 * whatever the repository names it, and the title never waits on the repository's metadata to say so.
 */
export function branchRangeTitle(range: SelectedRefs) {
  return diffTitle(range, range.base, [])
}

export function selectedRefs(
  base: string,
  head: string,
  mergeBase: boolean,
  baseLabel = refLabel(base),
  headLabel = refLabel(head),
): SelectedRefs {
  return { base, head, baseLabel, headLabel, mergeBase }
}

export function refLabel(reference: string) {
  return (
    reference === EMPTY_TREE_REF ? "empty"
    : reference === WORKTREE_REF ? "Working tree"
    : REF_NAMESPACE.test(reference) ? reference.replace(REF_NAMESPACE, "")
    : reference.replace(/^[0-9a-f]{40}(?:[0-9a-f]{24})?\b/i, (sha) =>
        sha.slice(0, 8),
      )
  )
}
