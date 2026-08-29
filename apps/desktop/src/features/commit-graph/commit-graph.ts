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

export type BranchSync = {
  branch: string
  upstream: string | null
  ahead: number
  behind: number
  isGone: boolean
}

export type DisplayRef = {
  branch: string | null
  label: string
  checkedOut: boolean
  tag: boolean
  sync: BranchSync | null
  worktrees: CheckedOutWorktree[]
}

export type RefKind = "branch" | "remote" | "tag"

export type CommitSelection = {
  kind: "commits"
  branches: { branch: string, sha: string }[]
  commits: Commit[]
  tip: Commit
  base: Commit | null
}

export type RefSelection = {
  kind: RefKind
  ref: DisplayRef
  sha: string
}

export type Selection = CommitSelection | RefSelection

export const ROW_HEIGHT = 32
export const GRAPH_HEADER_HEIGHT = 32
export const GRAPH_WIDTH = 112
export const GRAPH_GUTTER = 18
export const LANE_WIDTH = 14
export const GRAPH_MIN_WIDTH = 46
export const GRAPH_MAX_WIDTH = 480
export const GRAPH_COLORS = ["#60a5fa", "#34d399", "#fbbf24", "#f472b6", "#a78bfa", "#22d3ee", "#fb923c"]
const REF_TAIL_LENGTH = 8

// The canvas is placed by hand on every scroll frame, so it reaches past the viewport to cover what a fast
// scroll uncovers before the next frame lands.
export const GRAPH_CANVAS_OVERSCAN = 2 * ROW_HEIGHT

export function graphCanvasHeight(viewportHeight: number, headerHeight = GRAPH_HEADER_HEIGHT) {
  const visible = Math.max(0, viewportHeight - headerHeight)
  return visible === 0 ? 0 : visible + 2 * GRAPH_CANVAS_OVERSCAN
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

export function laneColor(lane: number) {
  return GRAPH_COLORS[lane % GRAPH_COLORS.length]
}

// The first parent continues the line the commit is already on, and every other parent is the tip of a branch
// it merged in, which is drawn on the lane that parent lands on.
export function parentEdgeColor(commit: Commit, parentIndex: number, endLane: number) {
  return laneColor(parentIndex === 0 ? commit.lane : endLane)
}

export function isCurrentCheckout(refs: string[]) {
  return refs.some((ref) => ref === "HEAD" || ref.startsWith("HEAD -> "))
}

function isRemoteRef(ref: string) {
  return (ref.startsWith("HEAD -> ") ? ref.slice("HEAD -> ".length) : ref).startsWith("origin/")
}

// A commit is pushed when a remote ref reaches it, and topological order puts every child before its
// parents, so one pass forward carries that reachability down without walking the graph twice.
export function unpushedHashes(commits: Commit[]) {
  const pushed = new Set<string>()
  const unpushed = new Set<string>()
  for (const commit of commits) {
    if (pushed.has(commit.hash) || commit.refs.some(isRemoteRef)) {
      for (const parent of commit.parents) {
        pushed.add(parent)
      }
    } else {
      unpushed.add(commit.hash)
    }
  }
  return unpushed
}

// A merge edge can land on a lane that is already carrying a line, in which case it joins that line rather than
// opening it, and only the commit that opens a lane draws the segment leaving it.
export function startsLane(commits: Commit[], index: number, lane: number) {
  const commit = commits[index]
  return commit.parentLanes.includes(lane) && (lane === commit.lane || !commits[index - 1]?.activeLanes[lane])
}

// A lane keeps drawing the edge of the commit that last claimed it, so the rows it merely passes through
// belong to that commit and have to read the same as the rest of its line.
export function unpushedLanes(commits: Commit[], unpushed: Set<string>) {
  const owners: boolean[] = []
  return commits.map((commit, index) => {
    const local = unpushed.has(commit.hash)
    for (const lane of commit.parentLanes) {
      if (startsLane(commits, index, lane)) {
        owners[lane] = local
      }
    }
    let mask = 0
    // Beyond the width a graph can show there is nothing left to shade, so the mask stops at the bits a number holds.
    for (let lane = 0; lane < commit.activeLanes.length && lane < 31; lane += 1) {
      if (commit.activeLanes[lane] && owners[lane]) {
        mask |= 1 << lane
      }
    }
    return mask
  })
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
  return {
    kind: "commits",
    branches: branchesContaining(commits, Math.min(indexA, indexB)),
    commits: path,
    tip: path[0],
    base: baseHash ? commits.find((commit) => commit.hash === baseHash) ?? null : null,
  }
}

export function refKind(ref: DisplayRef): RefKind {
  return ref.tag ? "tag" : ref.branch ? "branch" : "remote"
}

export function refSelection(ref: DisplayRef, sha: string): RefSelection {
  return { kind: refKind(ref), ref, sha }
}

// Rewriting a range needs a branch that holds it, and a branch holds it when its tip still reaches the newest
// selected commit. The nearest such tip comes first because it carries the fewest unselected commits along.
export function branchesContaining(commits: Commit[], tipIndex: number) {
  const branches: { branch: string, sha: string }[] = []
  for (let index = tipIndex; index >= 0; index -= 1) {
    if (commits[index].refs.length === 0) {
      continue
    }
    for (const ref of displayRefs(commits[index].refs)) {
      if (ref.branch && ancestryPath(commits, index, tipIndex).length > 0) {
        branches.push({ branch: ref.branch, sha: commits[index].hash })
      }
    }
  }
  return branches
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

export function refSyncLabel({ sync }: DisplayRef) {
  if (!sync) {
    return null
  }
  if (sync.isGone) {
    return "gone"
  }
  if (!sync.upstream) {
    return "local"
  }
  const counts = [sync.ahead && `↑${sync.ahead}`, sync.behind && `↓${sync.behind}`].filter(Boolean)
  return counts.length > 0 ? counts.join(" ") : null
}

export function syncDescription({ sync }: DisplayRef) {
  if (!sync) {
    return null
  }
  if (sync.isGone) {
    return `${sync.upstream} is gone from the remote`
  }
  if (!sync.upstream) {
    return "Not pushed to a remote"
  }
  const counts = [sync.ahead && `${sync.ahead} ahead`, sync.behind && `${sync.behind} behind`].filter(Boolean)
  return counts.length > 0 ? `${sync.upstream}: ${counts.join(", ")}` : `In sync with ${sync.upstream}`
}

export function displayRefs(refs: string[], checkedOutWorktrees: CheckedOutWorktree[] = [], branchSync?: Map<string, BranchSync>) {
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
    result.push({ branch, label: hasRemote ? `${branch} · origin` : branch, checkedOut: branch === checkedOut, tag: false, sync: branchSync?.get(branch) ?? null, worktrees: checkedOutWorktrees.filter((worktree) => worktree.branch === branch) })
  }

  for (const ref of branchRefs) {
    if (!consumed.has(ref) && ref !== "origin/HEAD") {
      result.push({ branch: null, label: ref, checkedOut: ref === checkedOut, tag: false, sync: null, worktrees: [] })
    }
  }

  for (const ref of refs) {
    if (ref.startsWith("tag: ")) {
      result.push({ branch: null, label: ref.slice("tag: ".length), checkedOut: false, tag: true, sync: null, worktrees: [] })
    }
  }

  if (checkedOut?.startsWith("origin/")) {
    result.push({ branch: null, label: checkedOut, checkedOut: true, tag: false, sync: null, worktrees: [] })
  }

  return result.sort((a, b) => refPriority(a) - refPriority(b))
}
