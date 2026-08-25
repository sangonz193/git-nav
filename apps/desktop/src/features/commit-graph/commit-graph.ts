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

export type DisplayRef = {
  branch: string | null
  label: string
  checkedOut: boolean
  tag: boolean
  worktrees: CheckedOutWorktree[]
}

export type CommitSelection = {
  commits: Commit[]
  tip: Commit
  base: Commit | null
}

export const ROW_HEIGHT = 32
export const GRAPH_HEADER_HEIGHT = 32
export const GRAPH_WIDTH = 112
export const GRAPH_GUTTER = 18
export const LANE_WIDTH = 14
export const GRAPH_MIN_WIDTH = 46
export const GRAPH_MAX_WIDTH = 480
export const GRAPH_COLORS = ["#60a5fa", "#34d399", "#fbbf24", "#f472b6", "#a78bfa", "#22d3ee", "#fb923c"]
const REF_TAIL_LENGTH = 8

// The canvas is pinned below the sticky header, so a full viewport height would overflow the scrolled content and drag the canvas off that anchor at the end of the scroll.
export function graphCanvasHeight(viewportHeight: number) {
  return Math.max(0, viewportHeight - GRAPH_HEADER_HEIGHT)
}

export function clampGraphWidth(width: number) {
  return Math.round(Math.max(GRAPH_MIN_WIDTH, Math.min(GRAPH_MAX_WIDTH, width)))
}

export function fitGraphWidth(commits: Commit[]) {
  let lanes = 0
  for (const commit of commits) {
    lanes = Math.max(lanes, commit.laneCount, commit.lane + 1, commit.activeLanes.length)
    for (const lane of commit.parentLanes) {
      lanes = Math.max(lanes, lane + 1)
    }
    for (const lane of commit.incomingLanes) {
      lanes = Math.max(lanes, lane + 1)
    }
  }
  return clampGraphWidth(GRAPH_GUTTER + lanes * LANE_WIDTH)
}

export function isCurrentCheckout(refs: string[]) {
  return refs.some((ref) => ref === "HEAD" || ref.startsWith("HEAD -> "))
}

export function commitFromTuple([hash, parents, author, date, refs, subject, lane, parentLanes, laneCount, incomingLanes, activeLanes]: CommitBatch[number]): Commit {
  return { hash, parents, author, date, refs, subject, lane, parentLanes, laneCount, incomingLanes, activeLanes }
}

// The graph is topologically ordered, so a parent always sits at a higher index than its children.
export function ancestryPath(commits: Commit[], indexA: number, indexB: number) {
  const first = Math.min(indexA, indexB)
  const last = Math.max(indexA, indexB)
  const indexes = new Map<string, number>()
  for (let index = first; index <= last; index++) {
    indexes.set(commits[index].hash, index)
  }

  const reachesTip = new Array<boolean>(last - first + 1).fill(false)
  reachesTip[0] = true
  for (let index = first; index <= last; index++) {
    if (!reachesTip[index - first]) {
      continue
    }
    for (const parent of commits[index].parents) {
      const parentIndex = indexes.get(parent)
      if (parentIndex !== undefined) {
        reachesTip[parentIndex - first] = true
      }
    }
  }

  const reachesBase = new Array<boolean>(last - first + 1).fill(false)
  reachesBase[last - first] = true
  for (let index = last - 1; index >= first; index--) {
    reachesBase[index - first] = commits[index].parents.some((parent) => {
      const parentIndex = indexes.get(parent)
      return parentIndex !== undefined && reachesBase[parentIndex - first]
    })
  }

  const path: Commit[] = []
  for (let index = first; index <= last; index++) {
    if (reachesTip[index - first] && reachesBase[index - first]) {
      path.push(commits[index])
    }
  }
  return path
}

export function commitSelection(commits: Commit[], indexA: number, indexB: number): CommitSelection | null {
  const path = ancestryPath(commits, indexA, indexB)
  if (path.length === 0) {
    return null
  }
  const [baseHash] = path[path.length - 1].parents
  return { commits: path, tip: path[0], base: baseHash ? commits.find((commit) => commit.hash === baseHash) ?? null : null }
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

export function refName(ref: DisplayRef) {
  return ref.branch ?? ref.label
}

export function splitRefLabel(label: string) {
  return label.length <= REF_TAIL_LENGTH
    ? { start: label, end: "" }
    : { start: label.slice(0, -REF_TAIL_LENGTH), end: label.slice(-REF_TAIL_LENGTH) }
}

function refPriority(ref: DisplayRef) {
  if (ref.checkedOut) {
    return 0
  }
  if (ref.worktrees.length > 0) {
    return 1
  }
  if (ref.branch) {
    return 2
  }
  return ref.tag ? 4 : 3
}

export function displayRefs(refs: string[], checkedOutWorktrees: CheckedOutWorktree[] = []) {
  const checkedOut = refs.find((ref) => ref.startsWith("HEAD -> "))?.slice("HEAD -> ".length)
  const branchRefs = refs.filter((ref) => !ref.startsWith("HEAD -> ") && !ref.startsWith("tag: "))
  const localBranches = new Set(branchRefs.filter((ref) => !ref.startsWith("origin/")))
  if (checkedOut && !checkedOut.startsWith("origin/")) {
    localBranches.add(checkedOut)
  }
  const consumed = new Set<string>()
  const result: DisplayRef[] = []

  for (const branch of localBranches) {
    const remote = `origin/${branch}`
    const hasRemote = branchRefs.includes(remote)
    consumed.add(branch)
    if (hasRemote) {
      consumed.add(remote)
    }
    result.push({ branch, label: hasRemote ? `${branch} · origin` : branch, checkedOut: branch === checkedOut, tag: false, worktrees: checkedOutWorktrees.filter((worktree) => worktree.branch === branch) })
  }

  for (const ref of branchRefs) {
    if (!consumed.has(ref) && ref !== "origin/HEAD") {
      result.push({ branch: null, label: ref, checkedOut: ref === checkedOut, tag: false, worktrees: [] })
    }
  }

  for (const ref of refs) {
    if (ref.startsWith("tag: ")) {
      result.push({ branch: null, label: ref.slice("tag: ".length), checkedOut: false, tag: true, worktrees: [] })
    }
  }

  if (checkedOut?.startsWith("origin/")) {
    result.push({ branch: null, label: checkedOut, checkedOut: true, tag: false, worktrees: [] })
  }

  return result.sort((a, b) => refPriority(a) - refPriority(b))
}
