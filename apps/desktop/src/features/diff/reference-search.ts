import {
  refRevision,
  type Commit,
  type RefKind,
  type StashEntry,
} from "../commit-graph/commit-graph"
import { searchGraph } from "../commit-graph/commit-graph-view"
import {
  worktreeBranch,
  worktreeDisplayName,
  worktreeName,
} from "../working-tree/working-tree-state"
import { WORKTREE_REF } from "@/lib/repository-constants"

const HIT_LIMIT = 50
// Anything that reads as a revision expression rather than a name to complete: `HEAD~1`, `main^2`,
// `origin/main@{1}` or a raw hash. A half-typed branch name never reaches git.
const REVISION_EXPRESSION = /[~^:@]|^[0-9a-f]{4,40}$/i

export type Reference = {
  date: string
  kind: RefKind
  name: string
  revision: string
  sha: string
  subject: string
}
export type ResolvedRevision = { sha: string; subject: string }

export type HitKind = RefKind | "commit" | "revision" | "stash" | "worktree"

export type ReferenceHit = {
  /** The ref name whose ahead range this hit can also be compared as, when it has one. */
  branch: string | null
  detail: string
  kind: HitKind
  label: string
  reference: string
  /** Set when the hit reads one worktree's state, so picking it moves the comparison to that worktree. */
  worktreePath?: string
}

export type WorktreeSource = {
  /** Null when detached, undefined until the worktree's HEAD is read. */
  branch: string | null | undefined
  isDetached?: boolean
  path: string
}

export type ReferenceSources = {
  /** Only the head of a comparison can be the working tree; git has no revision to read it as a base. */
  allowWorktree: boolean
  commits: Commit[]
  /** The worktree the diff is on, offered before the others and while they are still being read. */
  currentWorktree: WorktreeSource
  references: Reference[]
  revision: ResolvedRevision | null
  stashes: StashEntry[]
  worktrees: WorktreeSource[]
}

export function isRevisionExpression(query: string) {
  const revision = query.trim()
  return revision !== WORKTREE_REF && REVISION_EXPRESSION.test(revision)
}

export function worktreeRefLabel(
  reference: string,
  label: string,
  worktree: WorktreeSource,
) {
  return (
    reference === WORKTREE_REF ?
      `Working tree (${worktreeDisplayName(worktree)})`
    : reference === "HEAD" ? `HEAD (${worktreeDisplayName(worktree)})`
    : label
  )
}

function worktreeHit(worktree: WorktreeSource): ReferenceHit {
  return {
    branch: null,
    detail:
      worktreeBranch(worktree) ?
        `Uncommitted changes · ${worktreeName(worktree.path)}`
      : "Uncommitted changes",
    kind: "worktree",
    label: worktreeRefLabel(WORKTREE_REF, "", worktree),
    reference: WORKTREE_REF,
    worktreePath: worktree.path,
  }
}

function headHit(worktree: WorktreeSource): ReferenceHit {
  return {
    branch: "HEAD",
    detail:
      worktreeBranch(worktree) ? worktreeName(worktree.path) : "Detached head",
    kind: "branch",
    label: worktreeRefLabel("HEAD", "", worktree),
    reference: "HEAD",
    worktreePath: worktree.path,
  }
}

function referenceHit({ kind, name, revision, subject }: Reference) {
  return {
    branch: revision,
    detail: subject,
    kind,
    label: name,
    reference: revision,
  }
}

/**
 * Ranks what a diff side can be pointed at. Refs come from the repository rather than from the graph
 * window, so a branch whose tip is older than the commits on hand is still reachable; the graph's own
 * search then adds the commits and stashes behind the same query.
 */
export function searchReferences(
  query: string,
  {
    allowWorktree,
    commits,
    currentWorktree,
    references,
    revision,
    stashes,
    worktrees,
  }: ReferenceSources,
): ReferenceHit[] {
  const needle = query.trim().toLowerCase()
  const stashesByBase = new Map<string, StashEntry[]>()
  for (const entry of stashes) {
    if (entry.base) {
      stashesByBase.set(entry.base, [
        ...(stashesByBase.get(entry.base) ?? []),
        entry,
      ])
    }
  }

  const hits: ReferenceHit[] = []
  if (revision) {
    hits.push({
      branch: null,
      detail: `${revision.sha.slice(0, 8)} · ${revision.subject}`,
      kind: "revision",
      label: query.trim(),
      reference: query.trim(),
    })
  }
  const worktreesCurrentFirst = [
    currentWorktree,
    ...worktrees.filter((worktree) => worktree.path !== currentWorktree.path),
  ]
  const branchMatches: ReferenceHit[] = []
  function offerWorktree(
    keyword: string,
    worktree: WorktreeSource,
    hit: ReferenceHit,
  ) {
    if (
      keyword.includes(needle) ||
      worktreeName(worktree.path).toLowerCase().includes(needle)
    ) {
      hits.push(hit)
    } else if (worktreeBranch(worktree)?.toLowerCase().includes(needle)) {
      branchMatches.push(hit)
    }
  }
  if (allowWorktree) {
    for (const worktree of worktreesCurrentFirst) {
      offerWorktree("working tree", worktree, worktreeHit(worktree))
    }
  }
  for (const worktree of worktreesCurrentFirst) {
    if (worktreeBranch(worktree) !== undefined) {
      offerWorktree("head", worktree, headHit(worktree))
    }
  }

  const revisions = new Set(hits.map((hit) => hit.reference))
  for (const reference of references) {
    if (
      reference.name.toLowerCase().includes(needle) &&
      !revisions.has(reference.revision)
    ) {
      revisions.add(reference.revision)
      hits.push(referenceHit(reference))
    }
  }

  let afterRefs = hits.length
  // The graph's search covers what a ref list cannot: commit subjects, authors and stash messages.
  for (const hit of searchGraph(commits, query, { stashesByBase })) {
    const commit = commits[hit.commitIndex]
    if (hit.kind === "commit") {
      hits.push({
        branch: null,
        detail: hit.detail,
        kind: "commit",
        label: hit.label,
        reference: commit.hash,
      })
    } else if (hit.kind === "stash") {
      const entry = stashesByBase
        .get(commit.hash)
        ?.find((candidate) => candidate.name === hit.label)
      if (entry) {
        hits.push({
          branch: null,
          detail: hit.detail,
          kind: "stash",
          label: hit.label,
          reference: entry.sha,
        })
      }
    } else {
      const reference = refRevision({ kind: hit.kind, label: hit.label })
      if (!revisions.has(reference)) {
        revisions.add(reference)
        hits.push({
          branch: reference,
          detail: hit.detail,
          kind: hit.kind,
          label: hit.label,
          reference,
        })
        afterRefs = hits.length
      }
    }
  }

  hits.splice(afterRefs, 0, ...branchMatches)
  return hits.slice(0, HIT_LIMIT)
}
