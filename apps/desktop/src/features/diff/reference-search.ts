import type { Commit, StashEntry } from "../commit-graph/commit-graph"
import { searchGraph } from "../commit-graph/commit-graph-view"
import { WORKTREE_REF } from "@/lib/repository-constants"

const HIT_LIMIT = 50
// Anything that reads as a revision expression rather than a name to complete: `HEAD~1`, `main^2`,
// `origin/main@{1}` or a raw hash. A half-typed branch name never reaches git.
const REVISION_EXPRESSION = /[~^:@]|^[0-9a-f]{4,40}$/i

export type Reference = { date: string, kind: RefKind, name: string, sha: string, subject: string }
export type ResolvedRevision = { sha: string, subject: string }

type RefKind = "branch" | "remote" | "tag"
export type HitKind = RefKind | "commit" | "revision" | "stash" | "worktree"

export type ReferenceHit = {
  /** The ref name whose ahead range this hit can also be compared as, when it has one. */
  branch: string | null
  detail: string
  kind: HitKind
  label: string
  reference: string
}

export type ReferenceSources = {
  /** Only the head of a comparison can be the working tree; git has no revision to read it as a base. */
  allowWorktree: boolean
  commits: Commit[]
  headDetail: string | null
  references: Reference[]
  remotes: string[] | undefined
  revision: ResolvedRevision | null
  stashes: StashEntry[]
}

export function isRevisionExpression(query: string) {
  return REVISION_EXPRESSION.test(query.trim())
}

function worktreeHit(): ReferenceHit {
  return { branch: null, detail: "Uncommitted changes in this worktree", kind: "worktree", label: "Working tree", reference: WORKTREE_REF }
}

function referenceHit({ kind, name, subject }: Reference): ReferenceHit {
  return { branch: name, detail: subject, kind, label: name, reference: name }
}

/**
 * Ranks what a diff side can be pointed at. Refs come from the repository rather than from the graph
 * window, so a branch whose tip is older than the commits on hand is still reachable; the graph's own
 * search then adds the commits and stashes behind the same query.
 */
export function searchReferences(query: string, { allowWorktree, commits, headDetail, references, remotes, revision, stashes }: ReferenceSources): ReferenceHit[] {
  const needle = query.trim().toLowerCase()
  const stashesByBase = new Map<string, StashEntry[]>()
  for (const entry of stashes) {
    if (entry.base) {
      stashesByBase.set(entry.base, [...(stashesByBase.get(entry.base) ?? []), entry])
    }
  }

  const hits: ReferenceHit[] = []
  if (revision) {
    hits.push({ branch: null, detail: `${revision.sha.slice(0, 8)} · ${revision.subject}`, kind: "revision", label: query.trim(), reference: query.trim() })
  }
  if (allowWorktree && "working tree".includes(needle)) {
    hits.push(worktreeHit())
  }
  if (headDetail && "head".includes(needle)) {
    hits.push({ branch: "HEAD", detail: headDetail, kind: "branch", label: "HEAD", reference: "HEAD" })
  }

  const named = new Set(hits.map((hit) => hit.reference))
  for (const reference of references) {
    if (reference.name.toLowerCase().includes(needle) && !named.has(reference.name)) {
      named.add(reference.name)
      hits.push(referenceHit(reference))
    }
  }

  // The graph's search covers what a ref list cannot: commit subjects, authors and stash messages.
  for (const hit of searchGraph(commits, query, { remotes, stashesByBase })) {
    const commit = commits[hit.commitIndex]
    if (hit.kind === "commit") {
      hits.push({ branch: null, detail: hit.detail, kind: "commit", label: hit.label, reference: commit.hash })
    } else if (hit.kind === "stash") {
      const entry = stashesByBase.get(commit.hash)?.find((candidate) => candidate.name === hit.label)
      if (entry) {
        hits.push({ branch: null, detail: hit.detail, kind: "stash", label: hit.label, reference: entry.sha })
      }
    } else if (!named.has(hit.label)) {
      named.add(hit.label)
      hits.push({ branch: hit.label, detail: hit.detail, kind: hit.kind, label: hit.label, reference: hit.label })
    }
  }

  return hits.slice(0, HIT_LIMIT)
}
