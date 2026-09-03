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

export const PENDING_OPERATION_LABELS = { bisect: "bisecting", cherryPick: "cherry-picking", merge: "merging", rebase: "rebasing" }
export type PendingOperation = keyof typeof PENDING_OPERATION_LABELS

// A worktree's identity and its state are one thing: which commit it sits on, whether it is mid-operation and
// how much uncommitted work it holds all belong to the same checkout.
export type RowWorktree = {
  branch: string | null
  changedFiles: number
  head: string
  isCurrent: boolean
  isOpen: boolean
  name: string
  path: string
  pendingOperation: PendingOperation | null
  untrackedFiles: number
}

export type BranchSync = {
  branch: string
  upstream: string | null
  ahead: number
  behind: number
  isGone: boolean
}

export type PullRequestState = "open" | "draft" | "merged" | "closed"

export type BranchPullRequest = {
  branch: string
  number: number
  state: PullRequestState
  title: string
  url: string
}

export type StashEntry = { base: string | null, branch: string | null, date: string, message: string, name: string, sha: string }

export type DisplayRef = {
  branch: string | null
  label: string
  checkedOut: boolean
  kind: RefKind
  pullRequest: BranchPullRequest | null
  // For a remote ref, the remote it lives on. For a local branch, the remote it is paired with, if any.
  remote: string | null
  sync: BranchSync | null
  worktrees: RowWorktree[]
}

export type RefKind = "branch" | "remote" | "tag"

// A stash is not a ref, but it occupies the same row and competes for the same width, so the two are ordered
// and collapsed as one list.
export type RowChip =
  | { entry: StashEntry, kind: "stash" }
  | { kind: RefKind, ref: DisplayRef }
  | { kind: "worktree", worktree: RowWorktree }

export type DisplayRefOptions = {
  branchSync?: Map<string, BranchSync>
  pullRequests?: Map<string, BranchPullRequest>
  remotes?: string[]
  worktrees?: RowWorktree[]
}

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
const DEFAULT_REMOTES = ["origin"]
// Local branches and stashes are what the graph is navigated by; remotes usually restate a local branch and
// tags are archival, so those are the ones that give up their place when a row runs out of width.
const CHIP_PRIORITY = { worktree: 2, branch: 3, stash: 4, remote: 5, tag: 6 }
// Border, padding, the kind icon and the gaps around it, none of which depend on the label.
const CHIP_FIXED_WIDTH = 32
const CHIP_CHARACTER_WIDTH = 6.6
const CHIP_HEAD_WIDTH = 34
const CHIP_ICON_WIDTH = 15
// The divider and its padding, the state glyph and the gap after it, none of which depend on the number.
const CHIP_PULL_REQUEST_WIDTH = 21
// A pull request number and a sync label are both drawn a size below the ref name they follow.
const CHIP_MARKER_CHARACTER_WIDTH = 5.2
const CHIP_MORE_WIDTH = 28
export const CHIP_GAP = 3
// Refs share the commit column with the subject, which keeps the rest of it.
export const REF_BUDGET_SHARE = 0.5

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

function isRemoteRef(ref: string, remotes: string[]) {
  const name = ref.startsWith("HEAD -> ") ? ref.slice("HEAD -> ".length) : ref
  return remotes.some((remote) => name.startsWith(`${remote}/`))
}

// A commit is pushed when a remote ref reaches it, and topological order puts every child before its
// parents, so one pass forward carries that reachability down without walking the graph twice.
export function unpushedHashes(commits: Commit[], remotes: string[] = DEFAULT_REMOTES) {
  const pushed = new Set<string>()
  const unpushed = new Set<string>()
  for (const commit of commits) {
    if (pushed.has(commit.hash) || commit.refs.some((ref) => isRemoteRef(ref, remotes))) {
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

export function commitSelection(commits: Commit[], indexA: number, indexB: number, remotes?: string[]): CommitSelection | null {
  const path = ancestryPath(commits, indexA, indexB)
  if (path.length === 0) {
    return null
  }
  const [baseHash] = path[path.length - 1].parents
  return {
    kind: "commits",
    branches: branchesContaining(commits, Math.min(indexA, indexB), remotes),
    commits: path,
    tip: path[0],
    base: baseHash ? commits.find((commit) => commit.hash === baseHash) ?? null : null,
  }
}

export function refSelection(ref: DisplayRef, sha: string): RefSelection {
  return { kind: ref.kind, ref, sha }
}

// Rewriting a range needs a branch that holds it, and a branch holds it when its tip still reaches the newest
// selected commit. The nearest such tip comes first because it carries the fewest unselected commits along.
export function branchesContaining(commits: Commit[], tipIndex: number, remotes?: string[]) {
  const branches: { branch: string, sha: string }[] = []
  const reachesTip = new Set([commits[tipIndex].hash])
  for (let index = tipIndex; index >= 0; index -= 1) {
    const commit = commits[index]
    if (index !== tipIndex && commit.parents.some((parent) => reachesTip.has(parent))) {
      reachesTip.add(commit.hash)
    }
    if (!reachesTip.has(commit.hash) || commit.refs.length === 0) {
      continue
    }
    for (const ref of displayRefs(commit.refs, { remotes })) {
      if (ref.branch) {
        branches.push({ branch: ref.branch, sha: commit.hash })
      }
    }
  }
  return branches
}

let relativeTimeFormatter: Intl.RelativeTimeFormat | null = null

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
  return (relativeTimeFormatter ??= new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })).format(Math.round(seconds / size), unit)
}

export function refName(ref: DisplayRef) {
  return ref.branch ?? ref.label
}

export function remoteBranchName(ref: DisplayRef) {
  return ref.remote && ref.label.startsWith(`${ref.remote}/`) ? ref.label.slice(ref.remote.length + 1) : null
}

export function worktreeChanges({ changedFiles, untrackedFiles }: RowWorktree) {
  return changedFiles + untrackedFiles
}

// A worktree is drawn inside the chip naming the branch it holds. One that holds no branch, which is what a
// rebase or a bisect leaves behind, has no such chip and becomes one of its own.
export function detachedWorktrees(refs: DisplayRef[], worktrees: RowWorktree[]) {
  const attached = new Set(refs.flatMap((ref) => ref.worktrees.map((worktree) => worktree.path)))
  return worktrees.filter((worktree) => !attached.has(worktree.path))
}

// Every chip on a row competes for the same width, so they are ordered and measured as one list.
export function rowChips(refs: DisplayRef[], stashes: StashEntry[] = [], worktrees: RowWorktree[] = []): RowChip[] {
  const chips: RowChip[] = [
    ...refs.map((ref): RowChip => ({ kind: ref.kind, ref })),
    ...stashes.map((entry): RowChip => ({ kind: "stash", entry })),
    ...worktrees.map((worktree): RowChip => ({ kind: "worktree", worktree })),
  ]
  return chips.sort((a, b) => chipPriority(a) - chipPriority(b))
}

function chipPriority(chip: RowChip) {
  if (chip.kind === "stash") {
    return CHIP_PRIORITY.stash
  }
  return chip.kind === "worktree" ? CHIP_PRIORITY.worktree : refPriority(chip.ref)
}

// A local branch, a checkout and a stash are what the graph is navigated by, so they keep their place even
// when the row runs out of width.
function isProtectedChip(chip: RowChip) {
  return chip.kind === "stash" || chip.kind === "worktree" || chip.kind === "branch" || chip.ref.checkedOut
}

// Measuring every row would force layout on each scroll frame, so width is estimated from the label instead.
// A chip never renders wider than the whole ref budget, so counting it above that would collapse chips that
// the row still has room for.
export function textChipWidth(label: string, maxWidth: number) {
  return Math.min(maxWidth, CHIP_FIXED_WIDTH + label.length * CHIP_CHARACTER_WIDTH)
}

// A worktree marker is the icon plus, when it holds uncommitted work, a second icon and a count.
function worktreeMarkerWidth(worktrees: RowWorktree[]) {
  return worktrees.reduce((total, worktree) => {
    const changes = worktreeChanges(worktree)
    return total + CHIP_ICON_WIDTH + (changes > 0 ? CHIP_ICON_WIDTH + String(changes).length * CHIP_CHARACTER_WIDTH : 0)
  }, 0)
}

export function chipWidth(chip: RowChip, maxWidth: number) {
  if (chip.kind === "stash") {
    return textChipWidth(chipLabel(chip), maxWidth)
  }
  if (chip.kind === "worktree") {
    return Math.min(maxWidth, CHIP_FIXED_WIDTH + worktreeMarkerWidth([chip.worktree]) + chip.worktree.name.length * CHIP_CHARACTER_WIDTH)
  }
  const marker = chip.ref.checkedOut ? CHIP_HEAD_WIDTH : 0
  const pullRequest = pullRequestLabel(chip.ref)
  const badge = pullRequest ? CHIP_PULL_REQUEST_WIDTH + pullRequest.length * CHIP_MARKER_CHARACTER_WIDTH : 0
  const sync = (refSyncLabel(chip.ref)?.length ?? 0) * CHIP_MARKER_CHARACTER_WIDTH
  return Math.min(maxWidth, CHIP_FIXED_WIDTH + marker + badge + sync + worktreeMarkerWidth(chip.ref.worktrees) + chip.ref.label.length * CHIP_CHARACTER_WIDTH)
}

function chipsWidth(chips: RowChip[], maxWidth: number) {
  return chips.reduce((total, chip, index) => total + chipWidth(chip, maxWidth) + (index > 0 ? CHIP_GAP : 0), 0)
}

// How many of the chips fit in the budget, with the lowest priority ones collapsing into a count.
export function visibleChipCount(chips: RowChip[], budget: number) {
  if (chipsWidth(chips, budget) <= budget) {
    return chips.length
  }
  const remaining = budget - CHIP_MORE_WIDTH - CHIP_GAP
  let used = 0
  let count = 0
  for (const chip of chips) {
    used += chipWidth(chip, budget) + (count > 0 ? CHIP_GAP : 0)
    if (used > remaining && !isProtectedChip(chip)) {
      break
    }
    count += 1
  }
  // A row always shows something, even when its first chip alone is wider than the column allows.
  return Math.max(1, count)
}

export function chipName(chip: RowChip) {
  if (chip.kind === "stash") {
    return chip.entry.name
  }
  return chip.kind === "worktree" ? chip.worktree.name : refName(chip.ref)
}

export function chipLabel(chip: RowChip) {
  if (chip.kind === "stash") {
    return chip.entry.message || chip.entry.name
  }
  return chip.kind === "worktree" ? chip.worktree.name : chip.ref.label
}

export function worktreeDescription(worktree: RowWorktree) {
  const changes = [worktree.changedFiles && `${worktree.changedFiles} changed`, worktree.untrackedFiles && `${worktree.untrackedFiles} untracked`].filter(Boolean).join(", ")
  return [
    worktree.isCurrent ? `${worktree.name} is this window's worktree` : worktree.isOpen ? `${worktree.name} is open in another window` : `Checked out at ${worktree.name}`,
    worktree.branch ? null : "Not on a branch",
    worktree.pendingOperation && `Currently ${PENDING_OPERATION_LABELS[worktree.pendingOperation]}`,
    changes || null,
  ].filter(Boolean).join("\n")
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
  return CHIP_PRIORITY[ref.kind]
}

const PULL_REQUEST_STATE_LABELS: Record<PullRequestState, string> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" }

export function pullRequestLabel({ pullRequest }: DisplayRef) {
  return pullRequest ? `#${pullRequest.number}` : null
}

export function pullRequestDescription({ pullRequest }: DisplayRef) {
  return pullRequest ? `#${pullRequest.number} ${PULL_REQUEST_STATE_LABELS[pullRequest.state]} · ${pullRequest.title}` : null
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

// A pull request is raised from a branch name, which a ref that only exists on a remote carries behind the
// name of that remote.
function pullRequestOf(ref: string, remote: string | null, pullRequests: Map<string, BranchPullRequest> | undefined) {
  const branch = remote ? ref.slice(remote.length + 1) : ref
  return pullRequests?.get(branch) ?? null
}

// Which remote a ref belongs to can only be read from the remotes the repository actually has, since a remote
// is named freely and "upstream/main" is indistinguishable from a branch called that.
function remoteOf(ref: string, remotes: string[]) {
  return remotes.find((remote) => ref.startsWith(`${remote}/`)) ?? null
}

// The upstream a branch tracks is the pairing its ahead and behind counts are measured against, so a chip
// that reports those counts has to name that remote and not merely the first one carrying the same name.
function trackedRemote(branch: string, branchRefs: string[], remotes: string[], sync: BranchSync | null) {
  const upstream = sync?.upstream
  const tracked = upstream ? remoteOf(upstream, remotes) : null
  if (upstream && tracked && branchRefs.includes(upstream)) {
    return { remote: tracked, ref: upstream }
  }
  const remote = remotes.find((candidate) => branchRefs.includes(`${candidate}/${branch}`))
  return remote ? { remote, ref: `${remote}/${branch}` } : null
}

export function displayRefs(refs: string[], { branchSync, pullRequests, remotes = DEFAULT_REMOTES, worktrees = [] }: DisplayRefOptions = {}) {
  const checkedOut = refs.find((ref) => ref.startsWith("HEAD -> "))?.slice("HEAD -> ".length)
  const branchRefs = refs.filter((ref) => !ref.startsWith("HEAD -> ") && !ref.startsWith("tag: "))
  const localBranches = new Set(branchRefs.filter((ref) => !remoteOf(ref, remotes)))
  if (checkedOut && !remoteOf(checkedOut, remotes)) {
    localBranches.add(checkedOut)
  }
  const consumed = new Set<string>()
  const result: DisplayRef[] = []

  for (const branch of localBranches) {
    const sync = branchSync?.get(branch) ?? null
    const tracking = trackedRemote(branch, branchRefs, remotes, sync)
    consumed.add(branch)
    if (tracking) {
      consumed.add(tracking.ref)
    }
    result.push({ branch, label: tracking ? `${branch} · ${tracking.remote}` : branch, checkedOut: branch === checkedOut, kind: "branch", pullRequest: pullRequests?.get(branch) ?? null, remote: tracking?.remote ?? null, sync, worktrees: worktrees.filter((worktree) => worktree.branch === branch) })
  }

  for (const ref of branchRefs) {
    const remote = remoteOf(ref, remotes)
    if (!consumed.has(ref) && ref !== `${remote}/HEAD`) {
      result.push({ branch: null, label: ref, checkedOut: ref === checkedOut, kind: remote ? "remote" : "branch", pullRequest: pullRequestOf(ref, remote, pullRequests), remote, sync: null, worktrees: [] })
    }
  }

  for (const ref of refs) {
    if (ref.startsWith("tag: ")) {
      result.push({ branch: null, label: ref.slice("tag: ".length), checkedOut: false, kind: "tag", pullRequest: null, remote: null, sync: null, worktrees: [] })
    }
  }

  const checkedOutRemote = checkedOut && remoteOf(checkedOut, remotes)
  if (checkedOut && checkedOutRemote) {
    result.push({ branch: null, label: checkedOut, checkedOut: true, kind: "remote", pullRequest: pullRequestOf(checkedOut, checkedOutRemote, pullRequests), remote: checkedOutRemote, sync: null, worktrees: [] })
  }

  return result.sort((a, b) => refPriority(a) - refPriority(b))
}
