import { useCallback, useState } from "react"

import { detachedWorktrees, displayRefs, isCurrentCheckout, rowChips, type BranchPullRequest, type BranchSync, type Commit, type RowChip, type RowWorktree, type StashEntry } from "./commit-graph"

export type ChipKind = "branch" | "remote" | "stash" | "tag"
export type CleanOptions = { deleteMergedPullRequestBranches: boolean, deleteMergedBranches: boolean, deleteSquashMergedBranches: boolean }
export type ViewConfig = {
  chipKinds: Record<ChipKind, boolean>
  cleanOptions: CleanOptions
  collapseUnmarked: boolean
}

export const CHIP_KIND_LABELS: Record<ChipKind, string> = {
  branch: "Local branches",
  remote: "Remote branches",
  stash: "Stashes",
  tag: "Tags",
}

export const DEFAULT_VIEW_CONFIG: ViewConfig = {
  chipKinds: { branch: true, remote: true, stash: true, tag: true },
  cleanOptions: { deleteMergedPullRequestBranches: true, deleteMergedBranches: false, deleteSquashMergedBranches: false },
  collapseUnmarked: false,
}

const VIEW_CONFIG_KEY = "git-nav.commit-graph.view"
const DEFAULT_REMOTES = ["origin"]
const SEARCH_LIMIT = 12

export function parseViewConfig(stored: string | null): ViewConfig {
  if (!stored) {
    return DEFAULT_VIEW_CONFIG
  }
  try {
    const value = JSON.parse(stored) as Partial<ViewConfig>
    return {
      chipKinds: { ...DEFAULT_VIEW_CONFIG.chipKinds, ...value.chipKinds },
      cleanOptions: { ...DEFAULT_VIEW_CONFIG.cleanOptions, ...value.cleanOptions },
      collapseUnmarked: value.collapseUnmarked === true,
    }
  } catch {
    return DEFAULT_VIEW_CONFIG
  }
}

export function useViewConfig() {
  const [config, setConfig] = useState(() => parseViewConfig(localStorage.getItem(VIEW_CONFIG_KEY)))
  const updateConfig = useCallback((change: Partial<ViewConfig>) => {
    setConfig((current) => {
      const next = { ...current, ...change }
      localStorage.setItem(VIEW_CONFIG_KEY, JSON.stringify(next))
      return next
    })
  }, [])
  return [config, updateConfig] as const
}

export type ChipContext = {
  branchSync: Map<string, BranchSync>
  chipKinds: Record<ChipKind, boolean>
  pullRequests: Map<string, BranchPullRequest>
  remotes: string[] | undefined
  stashesByBase: Map<string, StashEntry[]>
  worktreesByHead: Map<string, RowWorktree[]>
}

// The checkout and its worktrees are where the graph is navigated from, so hiding a kind never hides those.
function isPinnedChip(chip: RowChip) {
  if (chip.kind === "worktree") {
    return true
  }
  return chip.kind !== "stash" && (chip.ref.checkedOut || chip.ref.worktrees.length > 0)
}

export function commitChips(commit: Commit, { branchSync, chipKinds, pullRequests, remotes, stashesByBase, worktreesByHead }: ChipContext) {
  const worktrees = worktreesByHead.get(commit.hash) ?? []
  const refs = displayRefs(commit.refs, { branchSync, pullRequests, remotes, worktrees })
  const chips = rowChips(refs, stashesByBase.get(commit.hash), detachedWorktrees(refs, worktrees))
  return chips.filter((chip) => chip.kind === "worktree" || isPinnedChip(chip) || chipKinds[chip.kind])
}

// A row is worth its own place when something points at it. Most commits carry nothing at all, which is the
// cheap answer, and the rest are answered by the chips the row would actually draw so that collapsing and
// drawing never disagree.
export function isMarkedCommit(commit: Commit, context: ChipContext) {
  if (isCurrentCheckout(commit.refs)) {
    return true
  }
  if (commit.refs.length === 0 && !context.stashesByBase.has(commit.hash) && !context.worktreesByHead.has(commit.hash)) {
    return false
  }
  return commitChips(commit, context).length > 0
}

export type GraphRow = { hidden: number, index: number, lanes: number }
export type GraphRows = { revealing: boolean, rows: GraphRow[] }

const ALL_LANES = -1

// Beyond the width a graph can show there is nothing left to draw, so the mask stops at the bits a number holds.
function activeLaneMask(activeLanes: boolean[]) {
  let mask = 0
  for (let lane = 0; lane < activeLanes.length && lane < 31; lane += 1) {
    if (activeLanes[lane]) {
      mask |= 1 << lane
    }
  }
  return mask
}

// Commits arrive in batches, so the rows already built are kept and only the new tail is scanned. A run at the
// end is reopened rather than carried over, since the commits that follow may still belong to it.
export function appendGraphRows(previous: GraphRows | null, commits: Commit[], isMarked: (commit: Commit) => boolean, isRevealed: (hash: string) => boolean): GraphRows {
  const rows = previous ? previous.rows.slice() : []
  let revealing = previous?.revealing ?? false
  let index = 0
  const last = rows[rows.length - 1]
  if (last && last.hidden > 0) {
    rows.pop()
    index = last.index
    revealing = false
  } else if (last) {
    index = last.index + 1
  }

  for (; index < commits.length; index += 1) {
    const commit = commits[index]
    if (isMarked(commit)) {
      revealing = false
      rows.push({ hidden: 0, index, lanes: 0 })
      continue
    }
    revealing ||= isRevealed(commit.hash)
    if (revealing) {
      rows.push({ hidden: 0, index, lanes: 0 })
      continue
    }
    const run = rows[rows.length - 1]
    if (run && run.hidden > 0) {
      run.hidden += 1
      run.lanes &= activeLaneMask(commit.activeLanes)
      continue
    }
    // A lane crosses the run when it is carrying a line on both sides of it, which is what the commit above
    // the run reports alongside the commits inside it.
    const above = index > 0 ? activeLaneMask(commits[index - 1].activeLanes) : ALL_LANES
    rows.push({ hidden: 1, index, lanes: activeLaneMask(commit.activeLanes) & above })
  }

  return { revealing, rows }
}

// Rows are ordered by the commit they start at, so the row holding a commit is the last one starting at or
// before it.
export function rowIndexOfCommit(rows: GraphRow[], commitIndex: number) {
  let low = 0
  let high = rows.length - 1
  let found = 0
  while (low <= high) {
    const middle = (low + high) >> 1
    if (rows[middle].index <= commitIndex) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return found
}

export type SearchHit = { commitIndex: number, detail: string, kind: ChipKind | "commit", label: string }

function refHit(ref: string, remotes: string[]): { kind: ChipKind, label: string } | null {
  if (ref.startsWith("tag: ")) {
    return { kind: "tag", label: ref.slice("tag: ".length) }
  }
  const name = ref.startsWith("HEAD -> ") ? ref.slice("HEAD -> ".length) : ref
  const remote = remotes.find((candidate) => name.startsWith(`${candidate}/`))
  if (name === "HEAD" || (remote && name === `${remote}/HEAD`)) {
    return null
  }
  return { kind: remote ? "remote" : "branch", label: name }
}

// Refs answer what the graph is navigated by, so they are ranked ahead of the commits carrying them. The walk
// is newest first, which is the useful order to cut at once both lists are full.
export function searchGraph(commits: Commit[], query: string, { remotes = DEFAULT_REMOTES, stashesByBase }: { remotes?: string[], stashesByBase?: Map<string, StashEntry[]> } = {}): SearchHit[] {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return []
  }
  const refs: SearchHit[] = []
  const subjects: SearchHit[] = []

  for (let index = 0; index < commits.length && (refs.length < SEARCH_LIMIT || subjects.length < SEARCH_LIMIT); index += 1) {
    const commit = commits[index]
    if (refs.length < SEARCH_LIMIT) {
      for (const ref of commit.refs) {
        const hit = refHit(ref, remotes)
        if (hit && hit.label.toLowerCase().includes(needle)) {
          refs.push({ commitIndex: index, detail: commit.subject, kind: hit.kind, label: hit.label })
        }
      }
      for (const entry of stashesByBase?.get(commit.hash) ?? []) {
        if (entry.name.toLowerCase().includes(needle) || entry.message.toLowerCase().includes(needle)) {
          refs.push({ commitIndex: index, detail: entry.message, kind: "stash", label: entry.name })
        }
      }
    }
    if (subjects.length < SEARCH_LIMIT && (commit.subject.toLowerCase().includes(needle) || commit.author.toLowerCase().includes(needle) || commit.hash.startsWith(needle))) {
      subjects.push({ commitIndex: index, detail: `${commit.hash.slice(0, 8)} · ${commit.author}`, kind: "commit", label: commit.subject || "(no subject)" })
    }
  }

  return [...refs.slice(0, SEARCH_LIMIT), ...subjects.slice(0, SEARCH_LIMIT)]
}
