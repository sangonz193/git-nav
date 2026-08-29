import { invoke } from "@/lib/ipc"
import { ArrowDownToLine, ArrowUpFromLine, Copy, GitBranch, GitGraph, GitMerge, LogIn, Pencil, Scissors, Tag, Trash2, Undo2 } from "lucide-react"
import type { ComponentType, ReactNode } from "react"

import { PENDING_OPERATION_LABELS, refName, remoteBranchName, type Commit, type CommitSelection, type PendingOperation, type RefSelection, type Selection, type StashEntry } from "./commit-graph"

export type Block = { reason: string }
export type Warning = { files?: string[], message: string }
export type RefUpdate = { after: string, before: string, reference: string }
export type CompletedOperation = { summary: string, updates: RefUpdate[] }
export type OperationResult = (CompletedOperation & { outcome: "completed" }) | { files: string[], message: string, outcome: "failed" }
export type RepositoryState = {
  currentBranch: string | null
  defaultBranch: string | null
  headSha: string | null
  isDetached: boolean
  isDirty: boolean
  pendingOperation: PendingOperation | null
  remote: string | null
  remotes: string[]
}
export type BranchOperationState = {
  exists: boolean
  isCurrentWorktree: boolean
  isDirty: boolean
  pendingOperation: PendingOperation | null
  sha: string | null
  worktreePath: string | null
}
export type ConflictPrediction =
  | { outcome: "clean" }
  | { commit: string, files: string[], outcome: "conflicts", subject: string }
  | { outcome: "unknown", reason: string }

export type Operand =
  | Selection
  | { entry: StashEntry, kind: "stash" }
  | { kind: "worktree" }
export type OperationRequest = {
  id: string
  repository: RepositoryState
  source: Selection | null
  target: Operand
}
export type Field =
  | { choices: { description?: string, label: string, value: string }[], key: string, kind: "choice", label: string }
  | { initial?: string, key: string, kind: "text", label: string, placeholder?: string }
  | { initial?: boolean, key: string, kind: "toggle", label: string }
export type Values = Record<string, string>
export type OperationState = {
  branch: BranchOperationState | null
  mergeBase: string | null
  prediction: ConflictPrediction | null
}
type Needs = { branch?: string, mergeBase?: [string, string], prediction?: PredictionRequest }
type PredictionRequest =
  | { branch: string, kind: "rebase", onto: string, upstream: string }
  | { into: string, kind: "merge", source: string }
export type Plan = {
  argv: string[]
  args: Record<string, unknown>
  command: string
}
// A menu names what it acts on once, in its header, so the operations on it read as verbs and group by what
// they do to the repository.
export const OPERATION_GROUPS = ["navigate", "sync", "integrate", "create", "modify", "danger"] as const
export type OperationGroup = (typeof OPERATION_GROUPS)[number]
export type Operation = {
  action: (request: OperationRequest, values: Values) => string
  applicable: (request: OperationRequest) => boolean
  blocks: (request: OperationRequest, state: OperationState, values: Values) => Block[]
  description: (request: OperationRequest, values: Values) => string
  destructive?: boolean
  fields?: (request: OperationRequest) => Field[]
  group: OperationGroup
  icon: ComponentType
  id: string
  label: (request: OperationRequest) => string
  needs?: (request: OperationRequest, values: Values) => Needs
  plan: (request: OperationRequest, values: Values, state: OperationState) => Plan
  warnings?: (request: OperationRequest, state: OperationState, values: Values) => Warning[]
}
export type RefMenuComponents = {
  Item: ComponentType<{ children: ReactNode, className?: string, disabled?: boolean, onSelect?: () => void, title?: string }>
  Label: ComponentType<{ children: ReactNode }>
  Separator: ComponentType
  Sub: ComponentType<{ children: ReactNode }>
  SubContent: ComponentType<{ children: ReactNode }>
  SubTrigger: ComponentType<{ children: ReactNode }>
}

function isRef(operand: Operand): operand is RefSelection {
  return operand.kind === "branch" || operand.kind === "remote" || operand.kind === "tag"
}

function isCommits(operand: Operand): operand is CommitSelection {
  return operand.kind === "commits"
}

export function operandName(operand: Operand) {
  if (isRef(operand)) {
    return refName(operand.ref)
  }
  if (operand.kind === "stash") {
    return operand.entry.name
  }
  if (operand.kind === "worktree") {
    return "the working tree"
  }
  return operand.commits.length === 1 ? operand.tip.hash.slice(0, 8) : `${operand.commits.length} commits`
}

// Every operand that git can name resolves to something it accepts on a command line.
function operandRef(operand: Operand) {
  if (isRef(operand)) {
    return refName(operand.ref)
  }
  if (operand.kind === "stash") {
    return operand.entry.name
  }
  return operand.kind === "commits" ? operand.tip.hash : ""
}

function operandSha(operand: Operand) {
  if (isRef(operand)) {
    return operand.sha
  }
  if (operand.kind === "stash") {
    return operand.entry.sha
  }
  return operand.kind === "commits" ? operand.tip.hash : ""
}

function commitCount(commits: Commit[]) {
  return `${commits.length} commit${commits.length === 1 ? "" : "s"}`
}

function sameOperand(left: Operand | null, right: Operand) {
  return Boolean(left) && operandName(left as Operand) === operandName(right) && operandSha(left as Operand) === operandSha(right)
}

export function flag(values: Values, key: string) {
  return values[key] === "true"
}

function worktreeBlocks(state: OperationState, name: string) {
  const blocks: Block[] = []
  if (state.branch?.pendingOperation) {
    blocks.push({ reason: `${name} is ${PENDING_OPERATION_LABELS[state.branch.pendingOperation]}` })
  }
  if (state.branch?.isDirty) {
    blocks.push({ reason: `${name} has uncommitted changes` })
  }
  return blocks
}

function predictionWarnings(state: OperationState) {
  const warnings: Warning[] = []
  if (state.prediction?.outcome === "conflicts") {
    warnings.push({ files: state.prediction.files, message: `Replaying ${state.prediction.commit.slice(0, 8)} “${state.prediction.subject}” is predicted to conflict in:` })
  }
  if (state.prediction?.outcome === "unknown") {
    warnings.push({ message: `Conflicts could not be predicted: ${state.prediction.reason}` })
  }
  return warnings
}

// A local branch is the only thing a rebase can move, and only a branch at the tip carries the whole selection with it.
function rebaseSource(request: OperationRequest, values?: Values) {
  const { source } = request
  if (source?.kind === "branch") {
    return { base: null, branch: refName(source.ref), commits: null }
  }
  if (source?.kind === "commits" && source.branches.length > 0) {
    const branch = source.branches.find((candidate) => candidate.branch === values?.branch) ?? source.branches[0]
    return { base: source.base, branch: branch.branch, commits: source.commits }
  }
  return null
}

function branchChoiceField(branches: { branch: string }[]): Field[] {
  return branches.length > 1
    ? [{ key: "branch", kind: "choice", label: "Branch to move", choices: branches.map(({ branch }) => ({ value: branch, label: branch })) }]
    : []
}

const checkout: Operation = {
  id: "checkout",
  icon: LogIn,
  group: "navigate",
  applicable: ({ target }) => isRef(target) || (isCommits(target) && target.commits.length === 1),
  label: ({ target }) => target.kind === "branch"
    ? "Check out"
    : target.kind === "remote"
      ? "Check out as a local branch"
      : "Check out (detached)",
  description: ({ repository, target }) => repository.isDirty
    ? `This moves the working tree to ${operandName(target)}, and the uncommitted changes have to go somewhere.`
    : `This moves the working tree to ${operandName(target)}.`,
  fields: ({ repository, target }) => [
    ...(target.kind === "remote"
      ? [{ initial: operandName(target).split("/").slice(1).join("/"), key: "name", kind: "text" as const, label: "Local branch name" }]
      : []),
    ...(repository.isDirty
      ? [{
        key: "changes",
        kind: "choice" as const,
        label: "Uncommitted changes",
        choices: [
          { value: "stash", label: "Set aside and restore after", description: "Stashes the changes, checks out, then reapplies them." },
          { value: "carry", label: "Carry across", description: "Leaves the changes in the working tree. Git refuses when a changed file differs between the two commits." },
        ],
      }]
      : []),
  ],
  blocks: ({ repository, target }, _state, values) => [
    ...(target.kind === "branch" && target.ref.checkedOut ? [{ reason: `${operandName(target)} is already checked out here` }] : []),
    ...(isRef(target) && target.ref.worktrees.length > 0 ? [{ reason: `${operandName(target)} is checked out at ${target.ref.worktrees[0].name}` }] : []),
    ...(repository.pendingOperation ? [{ reason: `this worktree is ${PENDING_OPERATION_LABELS[repository.pendingOperation]}` }] : []),
    ...(target.kind === "remote" && !values.name?.trim() ? [{ reason: "name the local branch" }] : []),
  ],
  warnings: ({ target }) => target.kind === "branch" || target.kind === "remote"
    ? []
    : [{ message: `A detached HEAD is not on a branch, so commits made from ${operandName(target)} belong to no branch until you create one.` }],
  action: () => "Check out",
  plan: ({ target }, values) => {
    const reference = operandRef(target)
    const create = target.kind === "remote" ? values.name.trim() : null
    const detach = target.kind === "tag" || isCommits(target)
    const stash = values.changes === "stash"
    return {
      argv: ["git", "switch", ...(detach ? ["--detach"] : create ? ["-c", create, "--track"] : []), reference],
      command: "checkout_ref",
      args: { reference, options: { create, track: Boolean(create), detach, stash } },
    }
  },
}

const push: Operation = {
  id: "push",
  icon: ArrowUpFromLine,
  group: "sync",
  applicable: ({ repository, target }) => Boolean(repository.remote) && target.kind === "branch",
  label: ({ target }) => {
    const sync = isRef(target) ? target.ref.sync : null
    if (!sync?.upstream || sync.isGone) {
      return "Publish"
    }
    return sync.ahead > 0 ? `Push ${sync.ahead} commit${sync.ahead === 1 ? "" : "s"} to ${sync.upstream}` : "Push"
  },
  description: ({ repository, target }) => `This sends ${operandName(target)} to ${repository.remote}.`,
  fields: ({ target }) => {
    const sync = isRef(target) ? target.ref.sync : null
    return sync?.upstream && !sync.isGone && sync.behind > 0
      ? [{
        key: "mode",
        kind: "choice" as const,
        label: "Remote is ahead",
        choices: [
          { value: "push", label: "Push", description: `Git rejects this while ${sync.upstream} has commits you do not have.` },
          { value: "force", label: "Force push with lease", description: `Replaces ${sync.upstream} with your history, dropping its ${sync.behind} commit${sync.behind === 1 ? "" : "s"}. Refuses to run if the remote moved again.` },
        ],
      }]
      : []
  },
  blocks: ({ target }, _state, values) => {
    const sync = isRef(target) ? target.ref.sync : null
    return sync?.upstream && !sync.isGone && sync.ahead === 0 && sync.behind === 0 && values.mode !== "force"
      ? [{ reason: `${sync.upstream} already has these commits` }]
      : []
  },
  warnings: ({ target }, _state, values) => {
    const sync = isRef(target) ? target.ref.sync : null
    return values.mode === "force" && sync?.upstream
      ? [{ message: `Force pushing rewrites ${sync.upstream} for everyone who has it, and drops its ${sync.behind} commit${sync.behind === 1 ? "" : "s"}.` }]
      : []
  },
  action: () => "Push",
  plan: ({ repository, target }, values) => {
    const reference = operandName(target)
    const sync = isRef(target) ? target.ref.sync : null
    const setUpstream = !sync?.upstream || sync.isGone
    const force = values.mode === "force"
    const remote = repository.remote ?? "origin"
    return {
      argv: ["git", "push", ...(force ? ["--force-with-lease", "--force-if-includes"] : []), ...(setUpstream ? ["--set-upstream"] : []), remote, reference],
      command: "push_ref",
      args: { reference, options: { remote, force, setUpstream, delete: false } },
    }
  },
}

const pushTag: Operation = {
  id: "pushTag",
  icon: ArrowUpFromLine,
  group: "sync",
  applicable: ({ repository, target }) => Boolean(repository.remote) && target.kind === "tag",
  label: () => "Push tag",
  description: ({ repository, target }) => `This sends ${operandName(target)} to ${repository.remote}.`,
  blocks: () => [],
  action: () => "Push tag",
  plan: ({ repository, target }) => {
    const reference = `refs/tags/${operandName(target)}`
    const remote = repository.remote ?? "origin"
    return {
      argv: ["git", "push", remote, reference],
      command: "push_ref",
      args: { reference, options: { remote, force: false, setUpstream: false, delete: false } },
    }
  },
}

const pull: Operation = {
  id: "pull",
  icon: ArrowDownToLine,
  group: "sync",
  applicable: ({ target }) => target.kind === "branch" && Boolean(target.ref.sync?.upstream) && !target.ref.sync?.isGone,
  label: ({ target }) => `Fast-forward to ${isRef(target) ? target.ref.sync?.upstream : ""}`,
  description: ({ target }) => `This fetches ${isRef(target) ? target.ref.sync?.upstream : ""} and moves ${operandName(target)} up to it without creating a merge.`,
  blocks: ({ target }, state) => {
    const sync = isRef(target) ? target.ref.sync : null
    return [
      ...(sync && sync.behind === 0 ? [{ reason: `${operandName(target)} already has everything on ${sync.upstream}` }] : []),
      ...(sync && sync.ahead > 0 && sync.behind > 0 ? [{ reason: `${operandName(target)} and ${sync.upstream} have both moved, which needs a merge or a rebase` }] : []),
      ...worktreeBlocks(state, operandName(target)),
    ]
  },
  needs: ({ target }) => ({ branch: operandName(target) }),
  action: () => "Fast-forward",
  plan: ({ target }) => ({
    argv: ["git", "fetch", "&&", "git", "merge", "--ff-only", isRef(target) ? target.ref.sync?.upstream ?? "" : ""],
    command: "pull_branch",
    args: { branch: operandName(target) },
  }),
}

const merge: Operation = {
  id: "merge",
  icon: GitMerge,
  group: "integrate",
  applicable: (request) => Boolean(mergeOperands(request)),
  // The header names the click, so the label names the operand it is being paired with.
  label: (request) => {
    const operands = mergeOperands(request)
    if (!operands) {
      return "Merge"
    }
    return request.source ? `Merge ${operands.name} here` : `Merge into ${operands.into}`
  },
  description: (request) => {
    const operands = mergeOperands(request)
    return `This replays ${operands?.name} on top of ${operands?.into} and records the result there.`
  },
  fields: () => [{
    key: "mode",
    kind: "choice",
    label: "Merge style",
    choices: [
      { value: "default", label: "Merge", description: "Fast-forwards when it can, otherwise records a merge commit." },
      { value: "noFastForward", label: "Always create a merge commit", description: "Keeps the merge visible in the graph even when a fast-forward was possible." },
      { value: "fastForwardOnly", label: "Fast-forward only", description: "Refuses the merge when it would need a merge commit." },
      { value: "squash", label: "Squash", description: "Stages the combined change without committing, leaving the history flat." },
    ],
  }],
  blocks: (request, state) => {
    const operands = mergeOperands(request)
    if (!operands) {
      return [{ reason: "nothing to merge" }]
    }
    return [
      ...(operands.name === operands.into ? [{ reason: "a branch cannot merge into itself" }] : []),
      ...(state.branch && !state.branch.worktreePath ? [{ reason: `${operands.into} is not checked out in any worktree` }] : []),
      ...worktreeBlocks(state, operands.into),
    ]
  },
  needs: (request) => {
    const operands = mergeOperands(request)
    return operands ? { branch: operands.into, prediction: { kind: "merge", source: operands.reference, into: operands.into } } : {}
  },
  warnings: (_request, state) => predictionWarnings(state),
  action: () => "Merge",
  plan: (request, values) => {
    const operands = mergeOperands(request)!
    const style = { default: [], noFastForward: ["--no-ff"], fastForwardOnly: ["--ff-only"], squash: ["--squash"] }[values.mode] ?? []
    return {
      argv: ["git", "merge", "--no-edit", ...style, operands.reference],
      command: "merge_ref",
      args: { source: operands.reference, into: operands.into, options: { mode: values.mode, message: null } },
    }
  },
}

// With a selection the click names the destination, and without one it names the branch to bring into the checkout.
function mergeOperands({ repository, source, target }: OperationRequest) {
  if (source && !sameOperand(source, target) && target.kind === "branch") {
    return { into: operandName(target), name: operandName(source), reference: operandRef(source) }
  }
  if (!source && repository.currentBranch && (isRef(target) || isCommits(target)) && operandName(target) !== repository.currentBranch) {
    return { into: repository.currentBranch, name: operandName(target), reference: operandRef(target) }
  }
  return null
}

const rebaseOnto: Operation = {
  id: "rebaseOnto",
  icon: GitGraph,
  group: "integrate",
  applicable: (request) => Boolean(rebaseSource(request)) && (isRef(request.target) || isCommits(request.target)) && !sameOperand(request.source, request.target),
  label: (request) => {
    const source = rebaseSource(request)!
    const moved = source.commits ? ` (${commitCount(source.commits)})` : ""
    return `Rebase ${source.branch}${moved} onto here`
  },
  description: (request) => `This replays the moved commits on ${operandName(request.target)} and leaves ${rebaseSource(request)?.branch} on the result.`,
  fields: ({ source }) => branchChoiceField(source?.kind === "commits" ? source.branches : []),
  blocks: (request, state, values) => {
    const source = rebaseSource(request, values)!
    const { target } = request
    const blocks: Block[] = []
    if (source.commits && !source.base) {
      blocks.push({ reason: "the oldest selected commit has no parent" })
    }
    if (source.commits?.some((commit) => commit.hash === operandSha(target))) {
      blocks.push({ reason: "the target is inside the selection" })
    }
    if (source.base?.hash === operandSha(target)) {
      blocks.push({ reason: "the selection already starts at the target" })
    }
    if (!source.commits && state.mergeBase && state.mergeBase === operandSha(target)) {
      blocks.push({ reason: `${source.branch} already sits on ${operandName(target)}` })
    }
    if (state.branch?.worktreePath && !state.branch.isCurrentWorktree && state.prediction?.outcome === "conflicts") {
      blocks.push({ reason: "conflicts would leave another worktree mid-rebase" })
    }
    return [...blocks, ...worktreeBlocks(state, source.branch)]
  },
  needs: (request, values) => {
    const source = rebaseSource(request, values)!
    const onto = operandRef(request.target)
    const upstream = source.commits ? source.base?.hash : undefined
    return {
      branch: source.branch,
      ...(source.commits ? {} : { mergeBase: [source.branch, onto] as [string, string] }),
      ...(upstream ? { prediction: { kind: "rebase" as const, branch: source.branch, onto, upstream } } : {}),
    }
  },
  warnings: (request, state) => [
    ...predictionWarnings(state),
    ...(rebaseSource(request)?.commits?.some((commit) => commit.parents.length > 1)
      ? [{ message: "The selection contains a merge commit, which will be flattened into a linear sequence." }]
      : []),
  ],
  action: () => "Rebase",
  plan: (request, values, state) => {
    const source = rebaseSource(request, values)!
    const onto = operandRef(request.target)
    const upstream = source.commits ? source.base!.hash : state.mergeBase ?? ""
    return {
      argv: ["git", "rebase", "--onto", onto, upstream.slice(0, 8), source.branch],
      command: "rebase_onto",
      args: { onto, upstream, branch: source.branch },
    }
  },
}

const dropCommits: Operation = {
  id: "dropCommits",
  icon: Scissors,
  group: "integrate",
  destructive: true,
  applicable: ({ source, target }) => isCommits(target) && sameOperand(source, target) && target.branches.length > 0,
  label: ({ target }) => `Remove from ${(target as CommitSelection).branches[0].branch}`,
  description: ({ target }) => `This rewrites ${(target as CommitSelection).branches[0].branch} without the selected ${commitCount((target as CommitSelection).commits)}. Everything after them is replayed.`,
  fields: ({ target }) => branchChoiceField((target as CommitSelection).branches),
  blocks: ({ target }, state, values) => {
    const selection = target as CommitSelection
    return [
      ...(selection.base ? [] : [{ reason: "the oldest selected commit has no parent" }]),
      ...worktreeBlocks(state, droppedBranch(selection, values)),
    ]
  },
  needs: ({ target }, values) => ({ branch: droppedBranch(target as CommitSelection, values) }),
  warnings: ({ target }) => (target as CommitSelection).commits.some((commit) => commit.parents.length > 1)
    ? [{ message: "The selection contains a merge commit, which will be flattened into a linear sequence." }]
    : [],
  action: () => "Remove commits",
  plan: ({ target }, values) => {
    const selection = target as CommitSelection
    const branch = droppedBranch(selection, values)
    return {
      argv: ["git", "rebase", "--onto", selection.base!.hash.slice(0, 8), selection.tip.hash.slice(0, 8), branch],
      command: "rebase_onto",
      args: { onto: selection.base!.hash, upstream: selection.tip.hash, branch },
    }
  },
}

function droppedBranch(selection: CommitSelection, values: Values) {
  return selection.branches.find((candidate) => candidate.branch === values.branch)?.branch ?? selection.branches[0].branch
}

const cherryPick: Operation = {
  id: "cherryPick",
  icon: Copy,
  group: "integrate",
  applicable: ({ repository, target }) => isCommits(target) && Boolean(repository.currentBranch) && Boolean(target.base),
  label: ({ repository }) => `Copy onto ${repository.currentBranch}`,
  description: ({ repository, target }) => `This replays the selected ${commitCount((target as CommitSelection).commits)} as new commits on ${repository.currentBranch}.`,
  blocks: ({ repository, target }) => [
    ...(repository.isDirty ? [{ reason: "this worktree has uncommitted changes" }] : []),
    ...(repository.pendingOperation ? [{ reason: `this worktree is ${PENDING_OPERATION_LABELS[repository.pendingOperation]}` }] : []),
    ...((target as CommitSelection).commits.some((commit) => commit.hash === repository.headSha) ? [{ reason: "the selection is already checked out" }] : []),
  ],
  action: () => "Copy commits",
  plan: ({ target }) => {
    const selection = target as CommitSelection
    return {
      argv: ["git", "cherry-pick", `${selection.base!.hash.slice(0, 8)}..${selection.tip.hash.slice(0, 8)}`],
      command: "cherry_pick_range",
      args: { base: selection.base!.hash, tip: selection.tip.hash },
    }
  },
}

const revert: Operation = {
  id: "revert",
  icon: Undo2,
  group: "integrate",
  applicable: ({ repository, target }) => isCommits(target) && Boolean(repository.currentBranch) && Boolean(target.base),
  label: ({ repository }) => `Revert on ${repository.currentBranch}`,
  description: ({ repository, target }) => `This adds commits to ${repository.currentBranch} that undo the selected ${commitCount((target as CommitSelection).commits)}, leaving the originals in place.`,
  blocks: ({ repository, target }) => [
    ...(repository.isDirty ? [{ reason: "this worktree has uncommitted changes" }] : []),
    ...(repository.pendingOperation ? [{ reason: `this worktree is ${PENDING_OPERATION_LABELS[repository.pendingOperation]}` }] : []),
    ...((target as CommitSelection).commits.some((commit) => commit.parents.length > 1) ? [{ reason: "reverting a merge commit needs a mainline to keep" }] : []),
  ],
  action: () => "Revert",
  plan: ({ target }) => {
    const selection = target as CommitSelection
    return {
      argv: ["git", "revert", "--no-edit", `${selection.base!.hash.slice(0, 8)}..${selection.tip.hash.slice(0, 8)}`],
      command: "revert_range",
      args: { base: selection.base!.hash, tip: selection.tip.hash },
    }
  },
}

const resetCurrent: Operation = {
  id: "resetCurrent",
  group: "danger",
  icon: Undo2,
  destructive: true,
  applicable: ({ repository, target }) => Boolean(repository.currentBranch)
    && (isRef(target) || (isCommits(target) && target.commits.length === 1))
    && operandSha(target) !== repository.headSha,
  label: ({ repository }) => `Reset ${repository.currentBranch} to here`,
  description: ({ repository, target }) => `This moves ${repository.currentBranch} to ${operandName(target)} without replaying anything.`,
  fields: () => [{
    key: "mode",
    kind: "choice",
    label: "What happens to the difference",
    choices: [
      { value: "mixed", label: "Keep as uncommitted changes", description: "Leaves the files as they are and unstages them." },
      { value: "soft", label: "Keep staged", description: "Leaves the files as they are with the difference staged." },
      { value: "hard", label: "Discard", description: "Overwrites the working tree. Uncommitted work is lost and cannot be undone." },
    ],
  }],
  blocks: ({ repository }) => repository.pendingOperation
    ? [{ reason: `this worktree is ${PENDING_OPERATION_LABELS[repository.pendingOperation]}` }]
    : [],
  warnings: ({ repository }, _state, values) => values.mode === "hard" && repository.isDirty
    ? [{ message: "The uncommitted changes in this worktree will be discarded, and undo cannot bring them back." }]
    : [],
  action: () => "Reset",
  plan: ({ target }, values) => ({
    argv: ["git", "reset", `--${values.mode}`, operandRef(target)],
    command: "reset_current",
    args: { target: operandRef(target), mode: values.mode },
  }),
}

const createBranch: Operation = {
  id: "createBranch",
  icon: GitBranch,
  group: "create",
  applicable: ({ target }) => isRef(target) || (isCommits(target) && target.commits.length === 1),
  label: () => "Create branch here",
  description: ({ target }) => `The new branch starts at ${operandName(target)}.`,
  fields: () => [
    { key: "name", kind: "text", label: "Branch name", placeholder: "feature/name" },
    { initial: true, key: "checkout", kind: "toggle", label: "Check out the new branch" },
  ],
  blocks: ({ repository }, _state, values) => [
    ...(values.name.trim() ? [] : [{ reason: "name the branch" }]),
    ...(flag(values, "checkout") && repository.pendingOperation ? [{ reason: `this worktree is ${PENDING_OPERATION_LABELS[repository.pendingOperation]}` }] : []),
    ...(flag(values, "checkout") && repository.isDirty ? [{ reason: "this worktree has uncommitted changes" }] : []),
  ],
  action: () => "Create branch",
  plan: ({ target }, values) => {
    const name = values.name.trim()
    const startPoint = operandRef(target)
    const track = target.kind === "remote"
    const checkout = flag(values, "checkout")
    return {
      argv: checkout ? ["git", "switch", "-c", name, ...(track ? ["--track"] : []), startPoint] : ["git", "branch", ...(track ? ["--track"] : []), name, startPoint],
      command: "create_branch",
      args: { name, startPoint, options: { checkout, track } },
    }
  },
}

const renameBranch: Operation = {
  id: "renameBranch",
  icon: Pencil,
  group: "modify",
  applicable: ({ target }) => target.kind === "branch",
  label: () => "Rename",
  description: ({ target }) => `Anything tracking ${operandName(target)} keeps pointing at the old name on the remote.`,
  fields: ({ target }) => [{ initial: operandName(target), key: "name", kind: "text", label: "New name" }],
  blocks: (_request, _state, values) => values.name.trim() ? [] : [{ reason: "name the branch" }],
  action: () => "Rename",
  plan: ({ target }, values) => ({
    argv: ["git", "branch", "--move", operandName(target), values.name.trim()],
    command: "rename_branch",
    args: { branch: operandName(target), name: values.name.trim() },
  }),
}

const createTag: Operation = {
  id: "createTag",
  icon: Tag,
  group: "create",
  applicable: ({ target }) => isRef(target) || (isCommits(target) && target.commits.length === 1),
  label: () => "Create tag here",
  description: ({ target }) => `The tag marks ${operandName(target)} and does not move with the branch.`,
  fields: () => [
    { key: "name", kind: "text", label: "Tag name", placeholder: "v1.0.0" },
    { key: "message", kind: "text", label: "Message", placeholder: "Leave empty for a lightweight tag" },
  ],
  blocks: (_request, _state, values) => values.name.trim() ? [] : [{ reason: "name the tag" }],
  action: () => "Create tag",
  plan: ({ target }, values) => {
    const name = values.name.trim()
    const message = values.message.trim()
    return {
      argv: ["git", "tag", ...(message ? ["--annotate", "--message", message] : []), name, operandRef(target)],
      command: "create_tag",
      args: { name, target: operandRef(target), message: message || null },
    }
  },
}

const deleteBranch: Operation = {
  id: "deleteBranch",
  icon: Trash2,
  group: "danger",
  destructive: true,
  applicable: ({ target }) => target.kind === "branch" && !target.ref.checkedOut && target.ref.worktrees.length === 0,
  label: () => "Delete branch",
  description: ({ target }) => `This deletes the local branch ${operandName(target)}. The commits stay until Git collects them.`,
  blocks: () => [],
  warnings: ({ target }) => {
    const sync = isRef(target) ? target.ref.sync : null
    const tracked = Boolean(sync?.upstream) && !sync?.isGone
    if (!sync || (tracked && sync.ahead === 0)) {
      return []
    }
    return [{
      message: tracked
        ? `${operandName(target)} has ${sync.ahead} commit${sync.ahead === 1 ? "" : "s"} that ${sync.upstream} does not have.`
        : `${operandName(target)} is not on any remote.`,
    }]
  },
  action: () => "Delete branch",
  plan: ({ target }) => ({
    argv: ["git", "branch", "--delete", "--force", operandName(target)],
    command: "delete_branch",
    args: { branch: operandName(target) },
  }),
}

const deleteTag: Operation = {
  id: "deleteTag",
  group: "danger",
  icon: Trash2,
  destructive: true,
  applicable: ({ target }) => target.kind === "tag",
  label: () => "Delete tag",
  description: ({ target }) => `This deletes the local tag ${operandName(target)}.`,
  blocks: () => [],
  action: () => "Delete tag",
  plan: ({ target }) => ({
    argv: ["git", "tag", "--delete", operandName(target)],
    command: "delete_tag",
    args: { name: operandName(target) },
  }),
}

const deleteRemoteRef: Operation = {
  id: "deleteRemoteRef",
  group: "danger",
  icon: Trash2,
  destructive: true,
  // The remote comes from the ref itself: with more than one remote configured, assuming the repository's
  // primary one would delete a same-named branch on the wrong remote.
  applicable: ({ target }) => target.kind === "remote" && remoteBranchName(target.ref) !== null && remoteBranchName(target.ref) !== "HEAD",
  label: () => "Delete from the remote",
  description: ({ target }) => `This deletes ${operandName(target)} for everyone who uses the remote.`,
  blocks: () => [],
  warnings: () => [{ message: "Deleting a branch on the remote cannot be undone from here." }],
  action: () => "Delete on remote",
  plan: ({ target }) => {
    const ref = (target as RefSelection).ref
    const remote = ref.remote ?? ""
    const branch = remoteBranchName(ref) ?? ""
    return {
      argv: ["git", "push", remote, "--delete", branch],
      command: "push_ref",
      args: { reference: branch, options: { remote, force: false, setUpstream: false, delete: true } },
    }
  },
}

const stashChanges: Operation = {
  id: "stashChanges",
  icon: ArrowDownToLine,
  group: "create",
  applicable: ({ repository, target }) => target.kind === "worktree" && repository.isDirty,
  label: () => "Stash the uncommitted changes",
  description: () => "This sets the working tree back to the last commit and keeps the changes in the stash.",
  fields: () => [
    { key: "message", kind: "text", label: "Message", placeholder: "Describe the work in progress" },
    { key: "untracked", kind: "toggle", label: "Include untracked files" },
  ],
  blocks: ({ repository }) => repository.pendingOperation
    ? [{ reason: `this worktree is ${PENDING_OPERATION_LABELS[repository.pendingOperation]}` }]
    : [],
  action: () => "Stash",
  plan: (_request, values) => ({
    argv: ["git", "stash", "push", ...(flag(values, "untracked") ? ["--include-untracked"] : []), ...(values.message.trim() ? ["--message", values.message.trim()] : [])],
    command: "stash_changes",
    args: { message: values.message.trim() || null, includeUntracked: flag(values, "untracked") },
  }),
}

function stashOperation(id: string, action: string, label: string, describe: (name: string) => string, destructive?: boolean): Operation {
  return {
    id,
    icon: destructive ? Trash2 : ArrowUpFromLine,
    group: destructive ? "danger" : "integrate",
    destructive,
    applicable: ({ target }) => target.kind === "stash",
    label: () => label,
    description: ({ target }) => describe(operandName(target)),
    blocks: ({ repository }) => [
      ...(repository.pendingOperation ? [{ reason: `this worktree is ${PENDING_OPERATION_LABELS[repository.pendingOperation]}` }] : []),
      ...(action !== "drop" && repository.isDirty ? [{ reason: "this worktree has uncommitted changes" }] : []),
    ],
    action: () => label,
    plan: ({ target }) => ({
      argv: ["git", "stash", action, operandName(target)],
      command: "stash_action",
      args: { name: operandName(target), sha: operandSha(target), action },
    }),
  }
}

const OPERATIONS: Operation[] = [
  checkout,
  push,
  pushTag,
  pull,
  merge,
  rebaseOnto,
  dropCommits,
  cherryPick,
  revert,
  createBranch,
  createTag,
  renameBranch,
  resetCurrent,
  stashChanges,
  stashOperation("stashApply", "apply", "Apply", (name) => `This restores the changes in ${name} and keeps the entry.`),
  stashOperation("stashPop", "pop", "Restore", (name) => `This restores the changes in ${name} and removes the entry.`),
  stashOperation("stashDrop", "drop", "Drop", (name) => `This deletes ${name} without restoring anything.`, true),
  deleteBranch,
  deleteRemoteRef,
  deleteTag,
]

export function initialValues(operation: Operation, request: OperationRequest): Values {
  const values: Values = {}
  for (const field of operation.fields?.(request) ?? []) {
    values[field.key] = field.kind === "choice"
      ? field.choices[0].value
      : field.kind === "toggle"
        ? String(field.initial ?? false)
        : field.initial ?? ""
  }
  return values
}

export function applicableOperations(repository: RepositoryState, source: Selection | null, target: Operand) {
  return OPERATIONS
    .map((operation) => ({ operation, request: { id: operation.id, repository, source, target } }))
    .filter(({ operation, request }) => operation.applicable(request))
    .sort((left, right) => OPERATION_GROUPS.indexOf(left.operation.group) - OPERATION_GROUPS.indexOf(right.operation.group))
}

const predictionCache = new Map<string, ConflictPrediction>()

// Every prediction was made against refs that an operation may have just moved.
export function clearConflictPredictions() {
  predictionCache.clear()
}

function predictionKey(request: PredictionRequest) {
  return request.kind === "rebase"
    ? `rebase ${request.onto} ${request.upstream} ${request.branch}`
    : `merge ${request.source} ${request.into}`
}

function predict(repoPath: string, request: PredictionRequest) {
  const key = predictionKey(request)
  const cached = predictionCache.get(key)
  if (cached) {
    return Promise.resolve(cached)
  }
  const invocation = request.kind === "rebase"
    ? invoke<ConflictPrediction>("predict_rebase_conflicts", { repoPath, branch: request.branch, onto: request.onto, upstream: request.upstream })
    : invoke<ConflictPrediction>("predict_merge_conflicts", { repoPath, source: request.source, into: request.into })
  return invocation.then((prediction) => {
    predictionCache.set(key, prediction)
    return prediction
  })
}


export function operationById(id: string) {
  return OPERATIONS.find((operation) => operation.id === id)!
}

export function predictConflicts(repoPath: string, request: PredictionRequest) {
  return predict(repoPath, request)
}
