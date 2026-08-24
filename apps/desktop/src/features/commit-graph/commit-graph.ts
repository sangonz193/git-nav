export type Commit = {
  hash: string
  parents: string[]
  author: string
  date: string
  refs: string[]
  subject: string
  lane: number
  parentLanes: number[]
  laneCount: number
  incomingLanes: number[]
  activeLanes: boolean[]
}

export type CommitBatch = [string, string[], string, string, string[], string, number, number[], number, number[], boolean[]][]
export type SquashMergeInference = [branchHash: string, targetHash: string]

export type CheckedOutWorktree = {
  branch: string
  name: string
  path: string
  isOpen: boolean
}

export const ROW_HEIGHT = 32
export const GRAPH_WIDTH = 112
export const GRAPH_GUTTER = 18
export const LANE_WIDTH = 14
export const GRAPH_COLORS = ["#60a5fa", "#34d399", "#fbbf24", "#f472b6", "#a78bfa", "#22d3ee", "#fb923c"]

export function commitFromTuple([hash, parents, author, date, refs, subject, lane, parentLanes, laneCount, incomingLanes, activeLanes]: CommitBatch[number]): Commit {
  return { hash, parents, author, date, refs, subject, lane, parentLanes, laneCount, incomingLanes, activeLanes }
}

export function relativeDate(value: string) {
  const milliseconds = Date.parse(value)
  if (Number.isNaN(milliseconds)) {
    return value
  }

  const seconds = Math.round((milliseconds - Date.now()) / 1000)
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
    ["second", 1],
  ]
  const [unit, size] = units.find(([, size]) => Math.abs(seconds) >= size) ?? units.at(-1)!
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round(seconds / size), unit)
}

export function displayRefs(refs: string[], checkedOutWorktrees: CheckedOutWorktree[] = []) {
  const checkedOut = refs.find((ref) => ref.startsWith("HEAD -> "))?.slice("HEAD -> ".length)
  const branchRefs = refs.filter((ref) => !ref.startsWith("HEAD -> ") && !ref.startsWith("tag: "))
  const localBranches = new Set(branchRefs.filter((ref) => !ref.startsWith("origin/")))
  if (checkedOut && !checkedOut.startsWith("origin/")) {
    localBranches.add(checkedOut)
  }
  const consumed = new Set<string>()
  const result: { label: string; checkedOut: boolean; worktrees: CheckedOutWorktree[] }[] = []

  for (const branch of localBranches) {
    const remote = `origin/${branch}`
    const hasRemote = branchRefs.includes(remote)
    consumed.add(branch)
    if (hasRemote) {
      consumed.add(remote)
    }
    result.push({ label: hasRemote ? `${branch} · origin` : branch, checkedOut: branch === checkedOut, worktrees: checkedOutWorktrees.filter((worktree) => worktree.branch === branch) })
  }

  for (const ref of branchRefs) {
    if (!consumed.has(ref) && ref !== "origin/HEAD") {
      result.push({ label: ref, checkedOut: ref === checkedOut, worktrees: [] })
    }
  }

  for (const ref of refs) {
    if (ref.startsWith("tag: ")) {
      result.push({ label: ref.slice("tag: ".length), checkedOut: false, worktrees: [] })
    }
  }

  if (checkedOut?.startsWith("origin/")) {
    result.push({ label: checkedOut, checkedOut: true, worktrees: [] })
  }

  return result
}
