import { invoke } from "@tauri-apps/api/core"
import { GitGraph, TriangleAlert } from "lucide-react"
import { type ComponentType, type ReactNode, useEffect, useMemo, useState } from "react"

import { displayRefs, refName, type CommitSelection, type DisplayRef } from "./commit-graph"

const PREDICTION_DEBOUNCE = 200
const PENDING_OPERATION_LABELS = { bisect: "bisect", cherryPick: "cherry-pick", merge: "merge", rebase: "rebase" }

export type Block = { reason: string }
export type Warning = { files?: string[], message: string }
export type OperationSource = CommitSelection
export type OperationTarget = { ref: DisplayRef, sha: string }
export type OperationChoice = { branch: string, sha: string }
export type OperationPlan = { argv: string[], branch: string, onto: string, upstream: string, warnings: Warning[] }
export type PendingOperation = keyof typeof PENDING_OPERATION_LABELS
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
export type OperationState = {
  branch: BranchOperationState | null
  candidates: OperationChoice[]
  choice: OperationChoice | null
  prediction: ConflictPrediction | null
}
export type Operation = {
  applicable: (source: OperationSource | null, target: OperationTarget) => boolean
  argv: (source: OperationSource, target: OperationTarget, choice: OperationChoice) => string[]
  blocks: (source: OperationSource | null, target: OperationTarget, state: OperationState) => Block[]
  label: (source: OperationSource | null, target: OperationTarget, choice: OperationChoice | null) => string
  warnings: (source: OperationSource | null, target: OperationTarget, state: OperationState) => Warning[]
}
export type RefUpdate = { after: string, before: string, reference: string }
export type RebaseResult =
  | { branch: string, headSha: string, outcome: "completed", updates: RefUpdate[] }
  | { files: string[], message: string, outcome: "failed" }
export type RefMenuComponents = {
  Item: ComponentType<{ children: ReactNode, className?: string, disabled?: boolean, onSelect?: () => void, title?: string }>
  Sub: ComponentType<{ children: ReactNode }>
  SubContent: ComponentType<{ children: ReactNode }>
  SubTrigger: ComponentType<{ children: ReactNode }>
}
type PredictionRequest = { branch: string, branchSha: string, onto: string, ontoSha: string, repoPath: string, upstream: string }
type OperationMenuItemsProps = {
  components: RefMenuComponents
  onConfirm: (plan: OperationPlan) => void
  repoPath: string
  source: OperationSource | null
  targetRef: DisplayRef
  targetSha: string
}

const predictionCache = new Map<string, ConflictPrediction>()
const predictionRequests = new Map<string, Promise<ConflictPrediction>>()

function predictionKey(ontoSha: string, upstream: string, branchSha: string) {
  return `${ontoSha} ${upstream} ${branchSha}`
}

function predictConflicts({ branch, branchSha, onto, ontoSha, repoPath, upstream }: PredictionRequest) {
  const key = predictionKey(ontoSha, upstream, branchSha)
  const cached = predictionCache.get(key)
  if (cached) {
    return Promise.resolve(cached)
  }
  const existing = predictionRequests.get(key)
  if (existing) {
    return existing
  }
  const request = invoke<ConflictPrediction>("predict_rebase_conflicts", { branch, onto, repoPath, upstream })
    .then((prediction) => {
      predictionCache.set(key, prediction)
      return prediction
    })
    .finally(() => predictionRequests.delete(key))
  predictionRequests.set(key, request)
  return request
}

function commitCount(source: OperationSource | null) {
  return source ? `${source.commits.length} commit${source.commits.length === 1 ? "" : "s"}` : "commits"
}

// A branch merely containing the tip would carry unselected commits along, so only refs at the tip qualify.
function rebaseCandidates(source: OperationSource | null) {
  return source
    ? displayRefs(source.tip.refs).flatMap((ref) => (ref.branch ? [{ branch: ref.branch, sha: source.tip.hash }] : []))
    : []
}

const rebaseOnto: Operation = {
  applicable: () => true,
  argv: (source, target, choice) => ["git", "rebase", "--onto", refName(target.ref), source.base!.hash.slice(0, 8), choice.branch],
  blocks: (source, target, state) => {
    if (!source) {
      return [{ reason: "select commits to move first" }]
    }
    const { branch, candidates, choice, prediction } = state
    const blocks: Block[] = []
    if (!source.base) {
      blocks.push({ reason: "the oldest selected commit has no parent" })
    }
    if (candidates.length === 0) {
      blocks.push({ reason: "selection tip has no branch" })
    }
    if (source.commits.some((commit) => commit.hash === target.sha)) {
      blocks.push({ reason: "the target commit is inside the selection" })
    }
    if (source.base?.hash === target.sha) {
      blocks.push({ reason: "the selection already starts at the target" })
    }
    if (choice && branch) {
      if (branch.isDirty) {
        blocks.push({ reason: `${choice.branch} has uncommitted changes` })
      }
      if (branch.pendingOperation) {
        blocks.push({ reason: `${choice.branch} has a ${PENDING_OPERATION_LABELS[branch.pendingOperation]} in progress` })
      }
      if (branch.worktreePath && !branch.isCurrentWorktree && prediction?.outcome === "conflicts") {
        blocks.push({ reason: "conflicts would leave another worktree mid-rebase" })
      }
    }
    return blocks
  },
  label: (source, target, choice) => choice
    ? `Rebase ${choice.branch} (${commitCount(source)}) onto ${refName(target.ref)}`
    : `Rebase ${commitCount(source)} onto ${refName(target.ref)}`,
  warnings: (source, _target, { prediction }) => {
    if (!source) {
      return []
    }
    const warnings: Warning[] = []
    if (prediction?.outcome === "conflicts") {
      warnings.push({ files: prediction.files, message: `Replaying ${prediction.commit.slice(0, 8)} “${prediction.subject}” is predicted to conflict in:` })
    }
    if (prediction?.outcome === "unknown") {
      warnings.push({ message: `Conflicts could not be predicted: ${prediction.reason}` })
    }
    if (source.commits.some((commit) => commit.parents.length > 1)) {
      warnings.push({ message: "The selection contains a merge commit, which will be flattened into a linear sequence." })
    }
    return warnings
  },
}

export function OperationMenuItems({ components, onConfirm, repoPath, source, targetRef, targetSha }: OperationMenuItemsProps) {
  const { Item, Sub, SubContent, SubTrigger } = components
  const [branchStates, setBranchStates] = useState<Record<string, BranchOperationState>>({})
  const [predictions, setPredictions] = useState<Record<string, ConflictPrediction>>({})
  const candidates = useMemo(() => rebaseCandidates(source), [source])
  const onto = refName(targetRef)
  const upstream = source?.base?.hash ?? null
  const target = { ref: targetRef, sha: targetSha }

  useEffect(() => {
    let disposed = false
    for (const { branch } of candidates) {
      invoke<BranchOperationState>("branch_operation_state", { branch, repoPath })
        .then((state) => {
          if (!disposed) {
            setBranchStates((states) => ({ ...states, [branch]: state }))
          }
        })
        .catch(() => undefined)
    }
    return () => {
      disposed = true
    }
  }, [candidates, repoPath])

  useEffect(() => {
    if (!upstream) {
      return
    }
    let disposed = false
    const timeout = window.setTimeout(() => {
      for (const { branch, sha } of candidates) {
        predictConflicts({ branch, branchSha: sha, onto, ontoSha: targetSha, repoPath, upstream })
          .then((prediction) => {
            if (!disposed) {
              setPredictions((current) => ({ ...current, [predictionKey(targetSha, upstream, sha)]: prediction }))
            }
          })
          .catch(() => undefined)
      }
    }, PREDICTION_DEBOUNCE)
    return () => {
      disposed = true
      window.clearTimeout(timeout)
    }
  }, [candidates, onto, repoPath, targetSha, upstream])

  if (!rebaseOnto.applicable(source, target)) {
    return null
  }

  function operationItem(choice: OperationChoice | null, key: string) {
    const prediction = choice && upstream ? predictions[predictionKey(targetSha, upstream, choice.sha)] ?? null : null
    const state = { branch: choice ? branchStates[choice.branch] ?? null : null, candidates, choice, prediction }
    const blocks = rebaseOnto.blocks(source, target, state)
    const warnings = rebaseOnto.warnings(source, target, state)
    const blocked = blocks.length > 0
    return (
      <Item
        className="max-w-80"
        disabled={blocked}
        key={key}
        onSelect={() => {
          if (!source?.base || !choice) {
            return
          }
          onConfirm({ argv: rebaseOnto.argv(source, target, choice), branch: choice.branch, onto, upstream: source.base.hash, warnings })
        }}
        title={blocked ? blocks.map((block) => block.reason).join(", ") : undefined}
      >
        {!blocked && warnings.length > 0 ? <TriangleAlert /> : <GitGraph />}
        <span className="min-w-0 truncate">{blocked ? "Rebase unavailable" : rebaseOnto.label(source, target, choice)}</span>
        {blocked
          ? <span className="shrink-0 text-xs text-muted-foreground">Unavailable</span>
          : prediction === null && <span className="text-xs text-muted-foreground">Checking…</span>}
      </Item>
    )
  }

  if (candidates.length > 1) {
    return (
      <Sub>
        <SubTrigger>
          <GitGraph />
          {rebaseOnto.label(source, target, null)}
        </SubTrigger>
        <SubContent>{candidates.map((candidate) => operationItem(candidate, candidate.branch))}</SubContent>
      </Sub>
    )
  }
  return operationItem(candidates[0] ?? null, "rebase-onto")
}
